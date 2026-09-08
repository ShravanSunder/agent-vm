"""Trusted callback boundary for guest requests, independent of any framework."""

import asyncio
import typing as t
from collections.abc import Mapping

from pydantic import BaseModel, ValidationError

from .contracts import PORTABLE_CONTRACT_ADAPTERS
from .portal_invocation_scope import PortalInvocationScope, PortalScopeClosedError
from .portal_relay_protocol import RelayRequest

type InvokePortal = t.Callable[[str, Mapping[str, object]], t.Awaitable[BaseModel]]
_MAX_PENDING_REQUESTS = 16


class PortalExecutionBridge:
    """Bind public guest payloads to callbacks captured by a trusted embedding.

    No guest field selects the callback's profile, principal, or destination.
    Approval orchestration belongs in the supplied trusted call implementation.
    """

    def __init__(self, *, invoke: InvokePortal, deadline_monotonic: float | None = None) -> None:
        self.scope = PortalInvocationScope(deadline_monotonic=deadline_monotonic)
        self._invoke = invoke
        self._active: dict[str, asyncio.Task[BaseModel]] = {}

    @staticmethod
    def _error(request_id: str, code: str, dispatch: str) -> dict[str, object]:
        return {"kind": "error", "requestId": request_id, "code": code, "dispatch": dispatch}

    async def execute(self, message: Mapping[str, object]) -> dict[str, object]:
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or not request_id:
            raise ValueError("Portal bridge request has no valid correlation ID.")
        try:
            incoming = RelayRequest.model_validate(message)
            schema_id = "portal.artifact.read-request" if incoming.operation == "artifact-read" else f"portal.{incoming.operation}.request"
            validated = PORTABLE_CONTRACT_ADAPTERS[schema_id].validate_python(incoming.request)
            if not isinstance(validated, BaseModel):
                raise TypeError("Portal request did not produce a typed model.")
            request: dict[str, object] = validated.model_dump(by_alias=True, exclude_none=True, mode="json")
        except (ValidationError, TypeError):
            return self._error(request_id, "invalid-request", "not-dispatched")
        if request_id in self._active or len(self._active) >= _MAX_PENDING_REQUESTS:
            return self._error(request_id, "request-capacity-or-collision", "not-dispatched")
        caller_ids: dict[str, str] = {}
        try:
            if incoming.operation == "call":
                calls = t.cast("list[dict[str, object]]", request["calls"])
                for call in calls:
                    caller_id = t.cast("str", call["id"])
                    qualified_id = self.scope.qualify_call_id(caller_id)
                    caller_ids[qualified_id] = caller_id
                    call["id"] = qualified_id
            task = self.scope.admit(lambda: self._invoke(incoming.operation, request))
        except PortalScopeClosedError:
            return self._error(request_id, "execution-ended", "not-dispatched")
        self._active[request_id] = task
        return await self._complete(incoming, task, caller_ids)

    async def _complete(
        self,
        incoming: RelayRequest,
        task: asyncio.Task[BaseModel],
        caller_ids: Mapping[str, str],
    ) -> dict[str, object]:
        request_id = incoming.request_id
        try:
            result = await task
            result_id = "portal.artifact.read-result" if incoming.operation == "artifact-read" else f"portal.{incoming.operation}.result"
            normalized = PORTABLE_CONTRACT_ADAPTERS[result_id].validate_python(result.model_dump(by_alias=True, mode="json", exclude_none=True))
            if not isinstance(normalized, BaseModel):
                raise TypeError("Portal result did not produce a typed model.")
            payload: dict[str, object] = normalized.model_dump(by_alias=True, mode="json", exclude_none=True)
            if caller_ids:
                for item in t.cast("list[dict[str, object]]", payload["items"]):
                    item["id"] = caller_ids[t.cast("str", item["id"])]
            return {"kind": "result", "requestId": request_id, "result": payload}
        except PortalScopeClosedError:
            return self._error(request_id, "execution-ended", "not-dispatched")
        except asyncio.CancelledError:
            return self._error(request_id, "cancelled", "uncertain")
        except Exception:
            return self._error(request_id, "portal-call-failed", "uncertain")
        finally:
            self._active.pop(request_id, None)

    def cancel(self, request_id: str) -> None:
        operation = self._active.get(request_id)
        if operation is not None:
            operation.cancel()

    def close(self) -> None:
        self.scope.close()
