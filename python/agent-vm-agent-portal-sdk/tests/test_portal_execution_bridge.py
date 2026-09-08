import asyncio
import typing as t
from collections.abc import Mapping

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from agent_vm_agent_portal_sdk.portal_execution_bridge import PortalExecutionBridge
from pydantic import BaseModel


def test_bridge_validates_guest_request_before_calling_trusted_port() -> None:
    async def scenario() -> None:
        called: list[str] = []

        async def invoke(operation: str, request: Mapping[str, object]) -> BaseModel:
            called.append(operation)
            raise AssertionError("Invalid request must not reach trusted dispatch")

        bridge = PortalExecutionBridge(invoke=invoke)
        response = await bridge.execute({"kind": "request", "requestId": "one", "operation": "call", "request": {"principal": "other"}})
        assert response == {"kind": "error", "requestId": "one", "code": "invalid-request", "dispatch": "not-dispatched"}
        assert called == []
        bridge.close()

    asyncio.run(scenario())


def test_closed_bridge_never_calls_trusted_port() -> None:
    async def scenario() -> None:
        called: list[str] = []

        async def invoke(operation: str, request: Mapping[str, object]) -> BaseModel:
            called.append(operation)
            raise AssertionError("Closed scope cannot dispatch")

        bridge = PortalExecutionBridge(invoke=invoke)
        bridge.close()
        response = await bridge.execute({"kind": "request", "requestId": "one", "operation": "list", "request": {"requests": [{"id": "list"}]}})
        assert response["dispatch"] == "not-dispatched"
        assert called == []

    asyncio.run(scenario())


def test_bridge_qualifies_call_ids_but_preserves_arguments_and_caller_result_ids() -> None:
    async def scenario() -> None:
        observed: list[Mapping[str, object]] = []

        async def invoke(operation: str, request: Mapping[str, object]) -> BaseModel:
            assert operation == "call"
            observed.append(request)
            calls = t.cast("list[dict[str, object]]", request["calls"])
            result = PORTABLE_CONTRACT_ADAPTERS["portal.call.result"].validate_python(
                {
                    "ok": True,
                    "items": [
                        {
                            "id": calls[0]["id"],
                            "status": "ok",
                            "operationId": "opaque-operation",
                            "owningGeneration": "generation",
                            "outcome": {"kind": "completed", "certainty": "proven", "completion": "succeeded", "retryClass": "forbidden"},
                            "value": {"received": calls[0]["arguments"]},
                        },
                    ],
                },
            )
            assert isinstance(result, BaseModel)
            return result

        bridge = PortalExecutionBridge(invoke=invoke)
        response = await bridge.execute(
            {
                "kind": "request",
                "requestId": "one",
                "operation": "call",
                "request": {"calls": [{"id": "caller", "namespace": "files", "name": "read", "arguments": {"path": "data.json"}}]},
            },
        )
        forwarded = t.cast("list[dict[str, object]]", observed[0]["calls"])[0]
        assert str(forwarded["id"]).startswith("bridge-")
        assert forwarded["arguments"] == {"path": "data.json"}
        item = t.cast("list[dict[str, object]]", t.cast("dict[str, object]", response["result"])["items"])[0]
        assert item["id"] == "caller"
        assert item["operationId"] == "opaque-operation"
        bridge.close()

    asyncio.run(scenario())
