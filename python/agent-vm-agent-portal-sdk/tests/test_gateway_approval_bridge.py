import asyncio
import typing as t
from collections.abc import Mapping

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from agent_vm_agent_portal_sdk.gateway_approval_bridge import (
    execute_portal_call_with_approval,
    sanitize_gateway_approval_arguments,
)
from pydantic import BaseModel

type JsonObject = dict[str, object]

REQUEST: JsonObject = {
    "calls": [
        {"arguments": {"path": "README.md"}, "id": "free", "name": "read", "namespace": "files"},
        {"arguments": {"token": "secret", "path": "state.json"}, "id": "protected", "name": "write", "namespace": "files"},
    ],
    "requestId": "request-a",
}
NOT_DISPATCHED: JsonObject = {"certainty": "proven", "kind": "not-dispatched", "retryClass": "safe-before-dispatch"}
INITIAL_RESULT: JsonObject = {
    "items": [
        {
            "id": "free",
            "operationId": "operation-free",
            "outcome": {"certainty": "proven", "completion": "succeeded", "kind": "completed", "retryClass": "forbidden"},
            "owningGeneration": "generation-a",
            "status": "ok",
            "value": {"content": "ready"},
        },
        {
            "approvalChallenge": {
                "challengeId": "11111111-1111-4111-8111-111111111111",
                "context": {
                    "bypassableWithinToolVm": True,
                    "kind": "tool_vm_advisory_hint",
                    "scope": "tool_portal_call_only",
                },
                "expiresAt": "2026-08-20T21:00:00.000Z",
            },
            "error": {"code": "approval_required", "message": "Approval is required."},
            "id": "protected",
            "operationId": "operation-protected",
            "outcome": NOT_DISPATCHED,
            "owningGeneration": "generation-a",
            "status": "approval_required",
        },
    ],
    "ok": False,
}
RETRY_RESULT: JsonObject = {
    "items": [
        {
            "id": "protected",
            "operationId": "operation-protected",
            "outcome": {"certainty": "proven", "completion": "succeeded", "kind": "completed", "retryClass": "forbidden"},
            "owningGeneration": "generation-a",
            "status": "ok",
            "value": {"written": True},
        },
    ],
    "ok": True,
}


def _model(schema_id: str, value: Mapping[str, object]) -> BaseModel:
    model = PORTABLE_CONTRACT_ADAPTERS[schema_id].validate_python(value)
    assert isinstance(model, BaseModel)
    return model


def test_bridge_preserves_free_item_and_retries_only_the_exact_approved_item() -> None:
    calls: list[JsonObject] = []
    presentations: list[JsonObject] = []
    decisions: list[JsonObject] = []

    async def call_portal(request: Mapping[str, object]) -> BaseModel:
        calls.append(dict(request))
        return _model("portal.call.result", INITIAL_RESULT if len(calls) == 1 else RETRY_RESULT)

    async def present(request: BaseModel) -> BaseModel:
        presentations.append(t.cast("JsonObject", request.model_dump(by_alias=True, mode="json")))
        return _model("gateway.approval.presentation-outcome", {"kind": "approved"})

    async def decide(request: Mapping[str, object]) -> BaseModel:
        decisions.append(dict(request))
        return _model("gateway.approval.decision-result", {"kind": "recorded", "state": "approved"})

    result = asyncio.run(
        execute_portal_call_with_approval(
            REQUEST,
            call_portal=call_portal,
            decide_approval=decide,
            present_approval=present,
        ),
    )

    result_mapping = result.model_dump(by_alias=True, exclude_none=True, mode="json")
    initial_items = t.cast("list[JsonObject]", INITIAL_RESULT["items"])
    retry_items = t.cast("list[JsonObject]", RETRY_RESULT["items"])
    assert result_mapping == {"items": [initial_items[0], retry_items[0]], "ok": True}
    assert t.cast("list[JsonObject]", calls[1]["calls"]) == [t.cast("list[JsonObject]", REQUEST["calls"])[1]]
    assert t.cast("JsonObject", presentations[0]["display"])["argumentsPreview"] == '{"path":"state.json","token":"[REDACTED]"}'
    assert presentations[0]["context"] == {
        "bypassableWithinToolVm": True,
        "kind": "tool_vm_advisory_hint",
        "scope": "tool_portal_call_only",
    }
    assert decisions == [{"challengeId": "11111111-1111-4111-8111-111111111111", "decision": "approve"}]


def test_bridge_denial_records_no_retry_and_projects_proven_not_dispatched() -> None:
    call_count = 0

    async def call_portal(_request: Mapping[str, object]) -> BaseModel:
        nonlocal call_count
        call_count += 1
        return _model("portal.call.result", INITIAL_RESULT)

    async def present(_request: BaseModel) -> BaseModel:
        return _model("gateway.approval.presentation-outcome", {"kind": "denied"})

    async def decide(_request: Mapping[str, object]) -> BaseModel:
        return _model("gateway.approval.decision-result", {"kind": "recorded", "state": "denied"})

    result = asyncio.run(
        execute_portal_call_with_approval(
            REQUEST,
            call_portal=call_portal,
            decide_approval=decide,
            present_approval=present,
        ),
    )

    result_mapping = result.model_dump(by_alias=True, exclude_none=True, mode="json")
    assert call_count == 1
    assert t.cast("list[JsonObject]", result_mapping["items"])[1]["status"] == "error"
    assert t.cast("JsonObject", t.cast("list[JsonObject]", result_mapping["items"])[1]["error"])["code"] == "capability_denied"


def test_bridge_contains_presenter_failure_to_the_protected_item() -> None:
    async def call_portal(_request: Mapping[str, object]) -> BaseModel:
        return _model("portal.call.result", INITIAL_RESULT)

    async def present(_request: BaseModel) -> BaseModel:
        raise RuntimeError("native presenter failed")

    async def decide(_request: Mapping[str, object]) -> BaseModel:
        raise AssertionError("presenter failure must not submit a decision")

    result = asyncio.run(
        execute_portal_call_with_approval(
            REQUEST,
            call_portal=call_portal,
            decide_approval=decide,
            present_approval=present,
        ),
    )

    result_mapping = result.model_dump(by_alias=True, exclude_none=True, mode="json")
    result_items = t.cast("list[JsonObject]", result_mapping["items"])
    initial_items = t.cast("list[JsonObject]", INITIAL_RESULT["items"])
    assert result_items[0] == initial_items[0]
    assert result_items[1]["status"] == "error"
    assert t.cast("JsonObject", result_items[1]["error"])["code"] == "provider_unavailable"


def test_display_sanitizer_is_deterministic_and_bounded() -> None:
    oversized = {f"field-{index:02}": "x" * 300 for index in range(40)}
    first = sanitize_gateway_approval_arguments(oversized)
    second = sanitize_gateway_approval_arguments(oversized)

    assert first == second
    assert "[TRUNCATED]" in first
    assert len(first.encode()) <= 4_096
