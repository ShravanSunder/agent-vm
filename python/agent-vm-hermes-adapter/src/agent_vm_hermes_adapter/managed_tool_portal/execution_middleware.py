"""Hermes invocation lifetime for managed Tool VM Portal composition."""

import asyncio
import contextvars
import logging
import math
import typing as t
from collections.abc import Awaitable, Callable
from time import monotonic

from agent_vm_agent_portal_sdk.gateway_portal_session import (
    GatewayPortalSession,
    GatewayPortalSessionConfig,
)
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from agent_vm_agent_portal_sdk.local_tool_portal_transport import (
    PortalConnectionUnavailableError,
)
from pydantic import BaseModel, ConfigDict, Field

from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
)

_LOGGER = logging.getLogger(__name__)


class HermesPortalInvocationIdentity(BaseModel):
    """Immutable trusted identity captured at Hermes's outer tool dispatcher."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    projection: CanonicalManagedAgentProjection
    task_id: str | None = Field(default=None, min_length=1)
    session_id: str = Field(min_length=1)
    tool_call_id: str | None = Field(default=None, min_length=1)
    turn_id: str | None = Field(default=None, min_length=1)
    api_request_id: str | None = Field(default=None, min_length=1)
    deadline_monotonic: float = Field(gt=0)


type PresentApproval = Callable[[BaseModel], Awaitable[BaseModel]]


class _GatewayRuntimeLoop(t.Protocol):
    def run_gateway_runtime_coroutine[TResult](
        self,
        coroutine: t.Coroutine[object, object, TResult],
        *,
        timeout: float | None = None,
    ) -> TResult: ...


class _ApprovalPresenter(t.Protocol):
    async def present(self, session_id: str, request: BaseModel) -> BaseModel: ...


class _PortalExecutionRuntime(t.Protocol):
    @property
    def adapter(self) -> _GatewayRuntimeLoop: ...

    @property
    def approval_presenter(self) -> _ApprovalPresenter: ...

    def current_projection(self) -> CanonicalManagedAgentProjection: ...


class _PortalSession(t.Protocol):
    @property
    def socket_path(self) -> str: ...

    async def open(self) -> None: ...

    async def close(self) -> None: ...


class PortalSessionFactory(t.Protocol):
    def __call__(
        self,
        *,
        client: GatewayRuntimeClient,
        config: GatewayPortalSessionConfig,
        present_approval: PresentApproval,
    ) -> _PortalSession: ...


class HermesPortalInvocationScope:
    """Own one immutable invocation and one relay session per environment generation."""

    def __init__(
        self,
        *,
        identity: HermesPortalInvocationIdentity,
        present_approval: PresentApproval,
        session_factory: PortalSessionFactory | None = None,
    ) -> None:
        self.identity = identity
        self._present_approval = present_approval
        self._session_factory = GatewayPortalSession if session_factory is None else session_factory
        self._loop: asyncio.AbstractEventLoop | None = None
        self._opening_by_generation: dict[str, asyncio.Task[_PortalSession]] = {}
        self._sessions_by_generation: dict[str, _PortalSession] = {}
        self._unavailable_by_generation: dict[str, PortalConnectionUnavailableError] = {}
        self._closed = False

    def _require_loop(self) -> None:
        running_loop = asyncio.get_running_loop()
        if self._loop is None:
            self._loop = running_loop
        elif running_loop is not self._loop:
            raise RuntimeError("Hermes Portal invocation scope belongs to another event loop.")

    def remaining_runtime_milliseconds(self) -> int:
        remaining_seconds = self.identity.deadline_monotonic - monotonic()
        if remaining_seconds <= 0:
            raise RuntimeError("The originating Hermes Portal invocation deadline expired.")
        return max(1, math.ceil(remaining_seconds * 1_000))

    @staticmethod
    async def _close_opening_session(session: _PortalSession) -> str | None:
        cleanup_results = await asyncio.gather(session.close(), return_exceptions=True)
        cleanup_result = cleanup_results[0]
        return type(cleanup_result).__name__ if isinstance(cleanup_result, BaseException) else None

    @staticmethod
    def _log_cleanup_failure(cleanup_failure: str | None) -> None:
        if cleanup_failure is not None:
            _LOGGER.warning(
                "Managed Tool Portal relay cleanup could not be confirmed: failure=%s",
                cleanup_failure,
            )

    async def _open_session(
        self,
        *,
        client: GatewayRuntimeClient,
        owning_generation: str,
        config: GatewayPortalSessionConfig,
    ) -> _PortalSession:
        session = self._session_factory(
            client=client,
            config=config,
            present_approval=self._present_approval,
        )
        try:
            await session.open()
        except asyncio.CancelledError:
            cleanup_failure = await self._close_opening_session(session)
            self._log_cleanup_failure(cleanup_failure)
            raise
        except Exception as error:
            cleanup_failure = await self._close_opening_session(session)
            if self._closed:
                self._log_cleanup_failure(cleanup_failure)
                raise RuntimeError("The originating Hermes Portal invocation has ended.") from error
            try:
                _ = self.remaining_runtime_milliseconds()
            except RuntimeError:
                self._log_cleanup_failure(cleanup_failure)
                raise
            cleanup_status = "confirmed" if cleanup_failure is None else cleanup_failure
            raise PortalConnectionUnavailableError(
                f"Managed Tool Portal relay did not become available; cleanup={cleanup_status}."
            ) from error
        if self._closed:
            cleanup_failure = await self._close_opening_session(session)
            self._log_cleanup_failure(cleanup_failure)
            raise RuntimeError("The originating Hermes Portal invocation has ended.")
        self._sessions_by_generation[owning_generation] = session
        return session

    async def socket_path_for_environment(
        self,
        *,
        client: GatewayRuntimeClient,
        owning_generation: str,
        config: GatewayPortalSessionConfig,
    ) -> str:
        self._require_loop()
        if self._closed:
            raise RuntimeError("The originating Hermes Portal invocation has ended.")
        unavailable = self._unavailable_by_generation.get(owning_generation)
        if unavailable is not None:
            raise unavailable
        session = self._sessions_by_generation.get(owning_generation)
        if session is None:
            opening = self._opening_by_generation.get(owning_generation)
            if opening is None:
                opening = asyncio.create_task(
                    self._open_session(
                        client=client,
                        owning_generation=owning_generation,
                        config=config,
                    )
                )
                self._opening_by_generation[owning_generation] = opening
            try:
                session = await opening
            except PortalConnectionUnavailableError as error:
                if owning_generation not in self._unavailable_by_generation:
                    self._unavailable_by_generation[owning_generation] = error
                    _LOGGER.warning(
                        "Managed Tool Portal relay is unavailable for this invocation and "
                        "environment generation; ordinary execution continues without Portal "
                        "context: failure=%s %s",
                        type(error.__cause__).__name__,
                        str(error),
                    )
                raise
            finally:
                if opening.done():
                    self._opening_by_generation.pop(owning_generation, None)
        return session.socket_path

    async def close(self) -> None:
        self._require_loop()
        if self._closed:
            return
        self._closed = True
        opening_sessions = tuple(self._opening_by_generation.values())
        for opening_session in opening_sessions:
            if not opening_session.done():
                opening_session.cancel()
        if opening_sessions:
            _ = await asyncio.gather(*opening_sessions, return_exceptions=True)
        sessions = tuple(self._sessions_by_generation.values())
        self._opening_by_generation.clear()
        self._sessions_by_generation.clear()
        self._unavailable_by_generation.clear()
        if sessions:
            _ = await asyncio.gather(
                *(session.close() for session in sessions),
                return_exceptions=True,
            )


_CURRENT_HERMES_PORTAL_INVOCATION_SCOPE: contextvars.ContextVar[
    HermesPortalInvocationScope | None
] = contextvars.ContextVar(
    "agent_vm_hermes_portal_invocation_scope",
    default=None,
)


def current_hermes_portal_invocation_scope() -> HermesPortalInvocationScope | None:
    """Return only the scope inherited from the current trusted Hermes invocation."""

    return _CURRENT_HERMES_PORTAL_INVOCATION_SCOPE.get()


def _required_identifier(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _positive_timeout_seconds(value: object, *, tool_name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"Hermes {tool_name} timeout must be a positive integer.")
    return value


def _resolve_invocation_timeout_seconds(
    tool_name: str,
    args: dict[str, object],
) -> int:
    if tool_name == "terminal":
        requested_timeout = args.get("timeout")
        if requested_timeout is not None:
            return _positive_timeout_seconds(requested_timeout, tool_name=tool_name)
        from tools.terminal_tool import _get_env_config

        return _positive_timeout_seconds(
            _get_env_config().get("timeout"),
            tool_name=tool_name,
        )
    if tool_name == "execute_code":
        from tools.code_execution_tool import DEFAULT_TIMEOUT, _load_config

        configured_timeout = _load_config().get("timeout", DEFAULT_TIMEOUT)
        return _positive_timeout_seconds(configured_timeout, tool_name=tool_name)
    raise ValueError(f"Unsupported Hermes Portal execution tool {tool_name!r}.")


class HermesToolExecutionMiddleware:
    """Wrap supported stock tools without replacing their guard or continuation."""

    def __init__(self, runtime: _PortalExecutionRuntime) -> None:
        self._runtime = runtime

    def build_identity(
        self,
        *,
        task_id: object,
        session_id: object,
        tool_call_id: object,
        turn_id: object,
        api_request_id: object,
        tool_name: str,
        args: dict[str, object],
    ) -> HermesPortalInvocationIdentity | None:
        normalized_task_id = _required_identifier(task_id)
        normalized_session_id = _required_identifier(session_id)
        normalized_tool_call_id = _required_identifier(tool_call_id)
        normalized_turn_id = _required_identifier(turn_id)
        normalized_api_request_id = _required_identifier(api_request_id)
        if normalized_session_id is None:
            return None
        try:
            projection = self._runtime.current_projection()
            invocation_timeout_seconds = _resolve_invocation_timeout_seconds(tool_name, args)
        except Exception as error:
            _LOGGER.debug(
                "Hermes Portal invocation projection was unavailable: failure=%s",
                type(error).__name__,
            )
            return None
        return HermesPortalInvocationIdentity(
            projection=projection,
            task_id=normalized_task_id,
            session_id=normalized_session_id,
            tool_call_id=normalized_tool_call_id,
            turn_id=normalized_turn_id,
            api_request_id=normalized_api_request_id,
            deadline_monotonic=monotonic() + invocation_timeout_seconds,
        )

    @staticmethod
    def _supports_invocation(tool_name: str, args: dict[str, object]) -> bool:
        if tool_name == "execute_code":
            return True
        return tool_name == "terminal" and args.get("background") is not True

    def __call__(
        self,
        *,
        tool_name: str,
        args: dict[str, object],
        original_args: dict[str, object],
        task_id: object = None,
        session_id: object = None,
        tool_call_id: object = None,
        turn_id: object = None,
        api_request_id: object = None,
        telemetry_schema_version: object = None,
        middleware_schema_version: object = None,
        next_call: Callable[[dict[str, object]], object],
    ) -> object:
        del original_args, telemetry_schema_version, middleware_schema_version
        if not self._supports_invocation(tool_name, args):
            return next_call(args)
        if current_hermes_portal_invocation_scope() is not None:
            return next_call(args)
        identity = self.build_identity(
            task_id=task_id,
            session_id=session_id,
            tool_call_id=tool_call_id,
            turn_id=turn_id,
            api_request_id=api_request_id,
            tool_name=tool_name,
            args=args,
        )
        if identity is None:
            return next_call(args)

        async def present_approval(request: BaseModel) -> BaseModel:
            return await self._runtime.approval_presenter.present(
                identity.session_id,
                request,
            )

        scope = HermesPortalInvocationScope(
            identity=identity,
            present_approval=present_approval,
        )
        scope_token = _CURRENT_HERMES_PORTAL_INVOCATION_SCOPE.set(scope)
        try:
            return next_call(args)
        finally:
            _CURRENT_HERMES_PORTAL_INVOCATION_SCOPE.reset(scope_token)
            try:
                self._runtime.adapter.run_gateway_runtime_coroutine(scope.close())
            except Exception as error:
                _LOGGER.warning(
                    "Hermes Portal invocation cleanup failed: failure=%s",
                    type(error).__name__,
                )


__all__ = (
    "HermesPortalInvocationIdentity",
    "HermesPortalInvocationScope",
    "HermesToolExecutionMiddleware",
    "current_hermes_portal_invocation_scope",
)
