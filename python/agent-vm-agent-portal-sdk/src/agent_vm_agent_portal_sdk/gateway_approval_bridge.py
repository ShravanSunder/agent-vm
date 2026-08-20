"""Framework-neutral managed-Gateway approval presentation and exact retry."""

import json
import re
import typing as t
from collections.abc import Awaitable, Callable, Mapping

from pydantic import BaseModel

from .contracts import PORTABLE_CONTRACT_ADAPTERS

type JsonObject = dict[str, object]
type PortalCall = Callable[[Mapping[str, object]], Awaitable[BaseModel]]
type PresentApproval = Callable[[BaseModel], Awaitable[BaseModel]]
type DecideApproval = Callable[[Mapping[str, object]], Awaitable[BaseModel]]

_MAXIMUM_DISPLAY_DEPTH = 6
_MAXIMUM_DISPLAY_ENTRIES = 32
_MAXIMUM_DISPLAY_STRING_SCALARS = 256
_MAXIMUM_DISPLAY_BYTES = 4_096
_REDACTED_VALUE = "[REDACTED]"
_TRUNCATED_VALUE = "[TRUNCATED]"
_CREDENTIAL_KEY_PATTERN = re.compile(r"token|password|secret|authorization|cookie|api[ _-]?key|private[ _-]?key", re.IGNORECASE)
_CREDENTIAL_VALUE_PATTERN = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:bearer|basic)\s+\S+|\b(?:api[ _-]?key|token|password|secret|authorization|cookie)\s*[:=]\s*\S+",
    re.IGNORECASE,
)


def _truncation_marker(omitted_count: int) -> JsonObject:
    return {"omittedCount": omitted_count, "value": _TRUNCATED_VALUE}


def _sanitize_value(value: object, *, depth: int) -> object:  # noqa: PLR0911
    if depth >= _MAXIMUM_DISPLAY_DEPTH:
        return _truncation_marker(1)
    if value is None or isinstance(value, bool | int | float):
        return value
    if isinstance(value, str):
        if _CREDENTIAL_VALUE_PATTERN.search(value):
            return _REDACTED_VALUE
        if len(value) <= _MAXIMUM_DISPLAY_STRING_SCALARS:
            return value
        return _truncation_marker(len(value) - _MAXIMUM_DISPLAY_STRING_SCALARS)
    if isinstance(value, list | tuple):
        included_count = min(len(value), _MAXIMUM_DISPLAY_ENTRIES)
        sanitized = [_sanitize_value(item, depth=depth + 1) for item in value[:included_count]]
        if len(value) > _MAXIMUM_DISPLAY_ENTRIES:
            sanitized[-1] = _truncation_marker(len(value) - (_MAXIMUM_DISPLAY_ENTRIES - 1))
        return sanitized
    if isinstance(value, Mapping):
        sorted_items = sorted((str(key), child_value) for key, child_value in value.items())
        requires_truncation = len(sorted_items) > _MAXIMUM_DISPLAY_ENTRIES
        included_count = _MAXIMUM_DISPLAY_ENTRIES - 1 if requires_truncation else _MAXIMUM_DISPLAY_ENTRIES
        sanitized_mapping: JsonObject = {
            key: _REDACTED_VALUE if _CREDENTIAL_KEY_PATTERN.search(key) else _sanitize_value(child_value, depth=depth + 1)
            for key, child_value in sorted_items[:included_count]
        }
        if requires_truncation:
            sanitized_mapping["$truncated"] = _truncation_marker(len(sorted_items) - included_count)
        return sanitized_mapping
    return str(value)


def sanitize_gateway_approval_arguments(arguments: object) -> str:
    """Return the deterministic bounded approval argument preview."""
    preview = json.dumps(_sanitize_value(arguments, depth=0), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    encoded_preview = preview.encode()
    if len(encoded_preview) <= _MAXIMUM_DISPLAY_BYTES:
        return preview
    return json.dumps(
        _truncation_marker(len(encoded_preview) - _MAXIMUM_DISPLAY_BYTES),
        separators=(",", ":"),
        sort_keys=True,
    )


def _model_mapping(model: BaseModel) -> JsonObject:
    return t.cast("JsonObject", model.model_dump(by_alias=True, exclude_none=True, mode="json"))


def _terminal_error_item(
    original_item: Mapping[str, object],
    *,
    code: str,
    message: str,
) -> JsonObject:
    return {
        "error": {"code": code, "message": message},
        "id": original_item["id"],
        "operationId": original_item["operationId"],
        "outcome": original_item["outcome"],
        "owningGeneration": original_item["owningGeneration"],
        "status": "error",
    }


def _project_non_dispatch_result(
    original_item: Mapping[str, object],
    *,
    code: str,
) -> JsonObject:
    safe_message_by_code = {
        "cancelled": "Approval presentation was cancelled.",
        "capability_denied": "The requested capability was denied.",
        "not_authorized": "Approval authority did not match the request.",
        "not_found": "The approval challenge was not found.",
        "provider_unavailable": "The approval presenter was unavailable.",
        "timeout": "The approval challenge expired.",
    }
    return _terminal_error_item(
        original_item,
        code=code,
        message=safe_message_by_code[code],
    )


def _decision_rejection_code(reason: object) -> str:
    if reason == "not-found":
        return "not_found"
    if reason == "expired":
        return "timeout"
    return "not_authorized"


async def execute_portal_call_with_approval(
    request: Mapping[str, object],
    *,
    call_portal: PortalCall,
    decide_approval: DecideApproval,
    present_approval: PresentApproval,
) -> BaseModel:
    """Run one Portal call, present protected items, and retry only approved items."""
    validated_request = PORTABLE_CONTRACT_ADAPTERS["portal.call.request"].validate_python(request)
    if not isinstance(validated_request, BaseModel):
        raise TypeError("Portal call request did not produce a typed model.")
    request_mapping = _model_mapping(validated_request)
    original_calls = t.cast("list[JsonObject]", request_mapping["calls"])
    call_by_id = {t.cast("str", call["id"]): call for call in original_calls}
    initial_result = await call_portal(request_mapping)
    initial_mapping = _model_mapping(initial_result)
    final_items: list[JsonObject] = []

    for untyped_item in t.cast("list[JsonObject]", initial_mapping["items"]):
        item = dict(untyped_item)
        if item.get("status") != "approval_required":
            final_items.append(item)
            continue
        item_id = t.cast("str", item["id"])
        original_call = call_by_id[item_id]
        challenge = t.cast("JsonObject", item["approvalChallenge"])
        presentation_request_value: JsonObject = {
            "allowedDecisions": ["approve", "deny"],
            "challengeId": challenge["challengeId"],
            "display": {"argumentsPreview": sanitize_gateway_approval_arguments(original_call["arguments"])},
            "expiresAt": challenge["expiresAt"],
            "itemId": item_id,
            "name": original_call["name"],
            "namespace": original_call["namespace"],
        }
        presentation_request = PORTABLE_CONTRACT_ADAPTERS["gateway.approval.presentation-request"].validate_python(
            presentation_request_value,
        )
        if not isinstance(presentation_request, BaseModel):
            raise TypeError("Approval presentation request did not produce a typed model.")
        presentation_outcome = await present_approval(presentation_request)
        outcome = _model_mapping(presentation_outcome)
        outcome_kind = outcome["kind"]
        if outcome_kind == "cancelled":
            final_items.append(
                _project_non_dispatch_result(
                    item,
                    code="timeout" if outcome.get("reason") == "challenge-expired" else "cancelled",
                ),
            )
            continue
        if outcome_kind == "unavailable":
            final_items.append(_project_non_dispatch_result(item, code="provider_unavailable"))
            continue

        decision_name = "approve" if outcome_kind == "approved" else "deny"
        decision_request: JsonObject = {"challengeId": challenge["challengeId"], "decision": decision_name}
        try:
            decision_result = _model_mapping(await decide_approval(decision_request))
        except Exception:
            if decision_name != "approve":
                final_items.append(_project_non_dispatch_result(item, code="not_authorized"))
                continue
            decision_result = {"kind": "rejected", "reason": "already-decided"}

        if decision_name == "approve" and (decision_result.get("kind") == "recorded" or decision_result.get("reason") == "already-decided"):
            retry_request = {**request_mapping, "calls": [original_call]}
            retry_result = _model_mapping(await call_portal(retry_request))
            retry_items = t.cast("list[JsonObject]", retry_result["items"])
            if len(retry_items) != 1 or retry_items[0].get("id") != item_id:
                raise ValueError("Approved Portal retry did not return the exact protected item.")
            final_items.append(retry_items[0])
            continue
        if decision_name == "deny" and decision_result.get("kind") == "recorded":
            final_items.append(_project_non_dispatch_result(item, code="capability_denied"))
            continue
        final_items.append(
            _project_non_dispatch_result(
                item,
                code=_decision_rejection_code(decision_result.get("reason")),
            ),
        )

    final_result = {"items": final_items, "ok": all(item.get("status") == "ok" for item in final_items)}
    validated_result = PORTABLE_CONTRACT_ADAPTERS["portal.call.result"].validate_python(final_result)
    if not isinstance(validated_result, BaseModel):
        raise TypeError("Approval bridge result did not produce a typed model.")
    return validated_result
