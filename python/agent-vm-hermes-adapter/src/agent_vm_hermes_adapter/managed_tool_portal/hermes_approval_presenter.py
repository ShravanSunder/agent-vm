"""Hermes-native presenter bound to the originating managed Gateway session."""

import asyncio
import datetime as dt
import threading
import typing as t

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from pydantic import BaseModel

from agent_vm_hermes_adapter.managed_profile_adapter import HermesSessionSource


@t.runtime_checkable
class HermesApprovalPlatformAdapter(t.Protocol):
    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: list[str],
        clarify_id: str,
        session_key: str,
        metadata: dict[str, object] | None = None,
    ) -> "HermesApprovalSendResult": ...


@t.runtime_checkable
class HermesApprovalSendResult(t.Protocol):
    success: bool


@t.runtime_checkable
class HermesApprovalSessionSource(HermesSessionSource, t.Protocol):
    chat_id: str


@t.runtime_checkable
class HermesApprovalGateway(t.Protocol):
    def _adapter_for_source(
        self,
        source: HermesApprovalSessionSource,
    ) -> HermesApprovalPlatformAdapter | None: ...

    def _is_user_authorized(self, source: HermesApprovalSessionSource) -> bool: ...

    def _session_key_for_source(self, source: HermesApprovalSessionSource) -> str: ...


class HermesGatewayApprovalRoute:
    """Bounded session route; native actor identity never leaves Hermes."""

    __slots__ = ("adapter", "gateway_loop", "session_key", "source")

    def __init__(
        self,
        *,
        adapter: HermesApprovalPlatformAdapter,
        gateway_loop: asyncio.AbstractEventLoop,
        session_key: str,
        source: HermesApprovalSessionSource,
    ) -> None:
        self.adapter = adapter
        self.gateway_loop = gateway_loop
        self.session_key = session_key
        self.source = source


class HermesGatewayApprovalRouteStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._routes_by_session_key: dict[str, HermesGatewayApprovalRoute] = {}

    def capture(
        self,
        *,
        gateway: object,
        source: HermesSessionSource,
    ) -> HermesGatewayApprovalRoute | None:
        if not isinstance(gateway, HermesApprovalGateway) or not isinstance(
            source, HermesApprovalSessionSource
        ):
            return None
        if not gateway._is_user_authorized(source):
            return None
        adapter = gateway._adapter_for_source(source)
        if adapter is None:
            return None
        session_key = gateway._session_key_for_source(source)
        if not session_key:
            return None
        try:
            gateway_loop = asyncio.get_running_loop()
        except RuntimeError:
            return None
        route = HermesGatewayApprovalRoute(
            adapter=adapter,
            gateway_loop=gateway_loop,
            session_key=session_key,
            source=source,
        )
        with self._lock:
            self._routes_by_session_key[session_key] = route
        return route

    def read(self, session_key: str) -> HermesGatewayApprovalRoute | None:
        with self._lock:
            return self._routes_by_session_key.get(session_key)

    def clear(self, session_key: str) -> None:
        with self._lock:
            _ = self._routes_by_session_key.pop(session_key, None)

    def close(self) -> None:
        with self._lock:
            self._routes_by_session_key.clear()


def _presentation_question(request: dict[str, object]) -> str:
    display = request.get("display")
    arguments_preview = display.get("argumentsPreview", "{}") if isinstance(display, dict) else "{}"
    return (
        f"Approve {request['namespace']}.{request['name']} once?\n"
        f"Arguments: {arguments_preview}\n"
        f"Expires: {request['expiresAt']}"
    )


def _remaining_timeout_seconds(expires_at: object) -> float:
    if not isinstance(expires_at, str):
        return 0.0
    try:
        expiry = dt.datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    return max(0.0, (expiry - dt.datetime.now(dt.UTC)).total_seconds())


def _send_and_wait_for_native_response(
    route: HermesGatewayApprovalRoute,
    request: dict[str, object],
) -> str | None:
    from tools.clarify_gateway import (
        register,
        resolve_gateway_clarify,
        wait_for_response,
    )

    clarify_id = f"gwappr-{request['challengeId']}"
    _ = register(
        clarify_id,
        route.session_key,
        _presentation_question(request),
        ["Approve", "Deny"],
    )
    send_future = asyncio.run_coroutine_threadsafe(
        route.adapter.send_clarify(
            route.source.chat_id,
            _presentation_question(request),
            ["Approve", "Deny"],
            clarify_id,
            route.session_key,
        ),
        route.gateway_loop,
    )
    try:
        send_result = send_future.result(timeout=30)
    except Exception:
        _ = resolve_gateway_clarify(clarify_id, "")
        _ = wait_for_response(clarify_id, 1)
        return None
    if send_result.success is not True:
        _ = resolve_gateway_clarify(clarify_id, "")
        _ = wait_for_response(clarify_id, 1)
        return None
    return wait_for_response(
        clarify_id,
        _remaining_timeout_seconds(request.get("expiresAt")),
    )


class HermesGatewayApprovalPresenter:
    def __init__(self, routes: HermesGatewayApprovalRouteStore) -> None:
        self._routes = routes

    async def present(self, session_key: str, request: BaseModel) -> BaseModel:
        route = self._routes.read(session_key)
        if route is None:
            return _approval_outcome({"kind": "unavailable", "reason": "presenter-missing"})
        request_mapping = request.model_dump(
            by_alias=True,
            exclude_none=True,
            mode="json",
        )
        if not isinstance(request_mapping, dict):
            raise TypeError("Hermes approval request did not produce a JSON object.")
        response = await asyncio.to_thread(
            _send_and_wait_for_native_response,
            route,
            request_mapping,
        )
        if response is None:
            return _approval_outcome(
                {"kind": "unavailable", "reason": "presentation-failed"},
            )
        if response.casefold() == "approve":
            return _approval_outcome({"kind": "approved"})
        if response.casefold() == "deny":
            return _approval_outcome({"kind": "denied"})
        if self._routes.read(session_key) is None:
            return _approval_outcome(
                {"kind": "cancelled", "reason": "session-ended"},
            )
        if _remaining_timeout_seconds(request_mapping.get("expiresAt")) <= 0:
            return _approval_outcome(
                {"kind": "cancelled", "reason": "challenge-expired"},
            )
        return _approval_outcome(
            {"kind": "cancelled", "reason": "user-cancelled"},
        )


def _approval_outcome(value: dict[str, object]) -> BaseModel:
    outcome = PORTABLE_CONTRACT_ADAPTERS["gateway.approval.presentation-outcome"].validate_python(
        value
    )
    if not isinstance(outcome, BaseModel):
        raise TypeError("Hermes approval outcome did not produce a typed model.")
    return outcome
