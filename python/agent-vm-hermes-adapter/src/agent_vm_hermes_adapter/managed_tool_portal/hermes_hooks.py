"""Typed Hermes lifecycle adapters for managed Tool Portal orientation."""

import logging
import typing as t

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from agent_vm_hermes_adapter.managed_framework_observability import ManagedFrameworkObservability
from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesProfileAdmissionError,
    HermesSessionSource,
)
from agent_vm_hermes_adapter.managed_tool_portal.cache import MarkInserted, PluginStateCache
from agent_vm_hermes_adapter.managed_tool_portal.hermes_approval_presenter import (
    HermesGatewayApprovalRouteStore,
)
from agent_vm_hermes_adapter.managed_tool_portal.inventory import InventoryCoordinator
from agent_vm_hermes_adapter.managed_tool_portal.inventory_contracts import InventoryProjection
from agent_vm_hermes_adapter.managed_tool_portal.models import (
    InjectionCacheKey,
    InjectionMarker,
    InventoryReadyValue,
    ReadyState,
    RenderedOrientation,
)
from agent_vm_hermes_adapter.managed_tool_portal_observability import HermesToolPortalTelemetry

_LOGGER = logging.getLogger(__name__)


class ProjectionResolver(t.Protocol):
    def __call__(self) -> CanonicalManagedAgentProjection: ...


class ManagedToolPortalHookRuntime(t.Protocol):
    @property
    def adapter(self) -> HermesManagedAdapter: ...

    @property
    def current_projection(self) -> ProjectionResolver: ...

    @property
    def framework_observability(self) -> ManagedFrameworkObservability: ...

    @property
    def telemetry(self) -> HermesToolPortalTelemetry: ...

    @property
    def inventory_coordinator(self) -> InventoryCoordinator: ...

    @property
    def injection_state_cache(self) -> PluginStateCache[InjectionCacheKey, InjectionMarker]: ...

    @property
    def gateway_epoch(self) -> str: ...

    @property
    def approval_routes(self) -> HermesGatewayApprovalRouteStore: ...


@t.runtime_checkable
class HermesGatewayMessageEvent(t.Protocol):
    """Minimum event shape required by the preserved admission hook."""

    source: HermesSessionSource


class _FrozenModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )


class PreLlmCall(_FrozenModel):
    """The exact session identity needed by the orientation hook."""

    session_id: str = Field(min_length=1)


def _inventory_projection(runtime: ManagedToolPortalHookRuntime) -> InventoryProjection:
    projection = runtime.current_projection()
    return InventoryProjection(
        gateway_epoch=runtime.gateway_epoch,
        profile_assignment_revision=projection.profile_assignment_revision,
        agent_id=projection.agent_id,
        profile_name=projection.framework_identity.profile_name,
        tool_portal_profile_id=projection.tool_portal_profile_id,
        namespace_names=projection.tool_portal_namespace_names,
    )


def _log_orientation_failure(hook_name: str, error: BaseException) -> None:
    _LOGGER.debug(
        "managed Tool Portal orientation hook %s failed with %s",
        hook_name,
        type(error).__name__,
    )


def _validated_hook_model[TModel: BaseModel](
    model_type: type[TModel],
    values: dict[str, object],
) -> TModel | None:
    try:
        return model_type.model_validate(values)
    except (ValidationError, TypeError, ValueError):
        return None


def _orientation_for_session(
    runtime: ManagedToolPortalHookRuntime,
    session_id: str,
) -> str | None:
    profile = _inventory_projection(runtime)
    snapshot = runtime.inventory_coordinator.read_snapshot(profile.cache_key())
    if not isinstance(snapshot, ReadyState):
        return None
    ready_value = snapshot.value
    if not isinstance(ready_value, InventoryReadyValue):
        return None
    orientation = ready_value.orientation
    if not isinstance(orientation, RenderedOrientation):
        return None
    if orientation.inventory_id != ready_value.inventory.inventory_id:
        return None
    injection_key = InjectionCacheKey(
        gateway_epoch=profile.gateway_epoch,
        profile_assignment_revision=profile.profile_assignment_revision,
        agent_id=profile.agent_id,
        profile_name=profile.profile_name,
        tool_portal_profile_id=profile.tool_portal_profile_id,
        session_id=session_id,
    )
    mark = runtime.injection_state_cache.mark_if_absent(
        injection_key,
        InjectionMarker(),
    )
    if not isinstance(mark, MarkInserted):
        return None
    return orientation.orientation


class _PreGatewayDispatchHook:
    def __init__(self, runtime: ManagedToolPortalHookRuntime) -> None:
        self._runtime = runtime

    def __call__(
        self,
        *,
        event: object = None,
        gateway: object = None,
        session_store: object = None,
        telemetry_schema_version: object = None,
    ) -> dict[str, str]:
        del session_store, telemetry_schema_version
        if not isinstance(event, HermesGatewayMessageEvent):
            return {
                "action": "skip",
                "reason": "managed Hermes profile origin was not admitted",
            }
        try:
            self._runtime.adapter.admit_session_source(event.source)
        except HermesProfileAdmissionError:
            return {
                "action": "skip",
                "reason": "managed Hermes profile origin was not admitted",
            }
        _ = self._runtime.approval_routes.capture(
            gateway=gateway,
            source=event.source,
        )
        return {"action": "allow"}


class _PreLlmCallHook:
    def __init__(self, runtime: ManagedToolPortalHookRuntime) -> None:
        self._runtime = runtime

    def __call__(
        self,
        *,
        session_id: object = None,
        task_id: object = None,
        turn_id: object = None,
        user_message: object = None,
        conversation_history: object = None,
        is_first_turn: object = None,
        model: object = None,
        platform: object = None,
        parent_session_id: object = None,
        sender_id: object = None,
        telemetry_schema_version: object = None,
    ) -> dict[str, str] | None:
        del (
            task_id,
            user_message,
            conversation_history,
            is_first_turn,
            model,
            parent_session_id,
            sender_id,
            telemetry_schema_version,
        )
        context: dict[str, str] | None = None
        request = _validated_hook_model(PreLlmCall, {"session_id": session_id})
        try:
            if request is not None:
                orientation = _orientation_for_session(self._runtime, request.session_id)
                if orientation is not None:
                    context = {"context": orientation}
        except Exception as error:
            _log_orientation_failure("pre_llm_call", error)
        if self._runtime.telemetry.observer_hooks_enabled:
            self._runtime.framework_observability.on_pre_llm_call(
                turn_id=turn_id,
                platform=platform,
            )
        return context


class _PreApiRequestHook:
    """Preserve provider-attempt observability without provider confirmation."""

    def __init__(self, runtime: ManagedToolPortalHookRuntime) -> None:
        self._runtime = runtime

    def __call__(
        self,
        *,
        task_id: object = None,
        turn_id: object = None,
        api_request_id: object = None,
        session_id: object = None,
        user_message: object = None,
        conversation_history: object = None,
        platform: object = None,
        model: object = None,
        provider: object = None,
        base_url: object = None,
        api_mode: object = None,
        api_call_count: object = None,
        retry_count: object = None,
        request_messages: object = None,
        message_count: object = None,
        tool_count: object = None,
        approx_input_tokens: object = None,
        request_char_count: object = None,
        max_tokens: object = None,
        started_at: object = None,
        middleware_trace: object = None,
        request: object = None,
        telemetry_schema_version: object = None,
    ) -> None:
        del (
            task_id,
            session_id,
            user_message,
            conversation_history,
            base_url,
            retry_count,
            request_messages,
            message_count,
            tool_count,
            approx_input_tokens,
            request_char_count,
            max_tokens,
            started_at,
            middleware_trace,
            request,
            telemetry_schema_version,
        )
        if self._runtime.telemetry.observer_hooks_enabled:
            self._runtime.framework_observability.on_pre_api_request(
                turn_id=turn_id,
                api_request_id=api_request_id,
                model=model,
                provider=provider,
                api_mode=api_mode,
                api_call_count=api_call_count,
            )


class _PostApiRequestHook:
    def __init__(self, runtime: ManagedToolPortalHookRuntime) -> None:
        self._runtime = runtime

    def __call__(
        self,
        *,
        task_id: object = None,
        turn_id: object = None,
        api_request_id: object = None,
        session_id: object = None,
        platform: object = None,
        model: object = None,
        provider: object = None,
        base_url: object = None,
        api_mode: object = None,
        api_call_count: object = None,
        api_duration: object = None,
        started_at: object = None,
        ended_at: object = None,
        finish_reason: object = None,
        message_count: object = None,
        response_model: object = None,
        response: object = None,
        usage: object = None,
        assistant_message: object = None,
        assistant_content_chars: object = None,
        assistant_tool_call_count: object = None,
        telemetry_schema_version: object = None,
    ) -> None:
        del task_id, session_id, platform, base_url, api_mode, api_call_count, started_at, ended_at
        del message_count, response_model, response, assistant_message, assistant_content_chars
        del assistant_tool_call_count, telemetry_schema_version, model, provider
        self._runtime.framework_observability.on_post_api_request(
            turn_id=turn_id,
            api_request_id=api_request_id,
            api_duration=api_duration,
            finish_reason=finish_reason,
            usage=usage,
        )


class _ApiRequestErrorHook:
    def __init__(self, runtime: ManagedToolPortalHookRuntime) -> None:
        self._runtime = runtime

    def __call__(
        self,
        *,
        task_id: object = None,
        turn_id: object = None,
        api_request_id: object = None,
        session_id: object = None,
        platform: object = None,
        model: object = None,
        provider: object = None,
        base_url: object = None,
        api_mode: object = None,
        api_call_count: object = None,
        api_duration: object = None,
        started_at: object = None,
        ended_at: object = None,
        status_code: object = None,
        retry_count: object = None,
        max_retries: object = None,
        retryable: object = None,
        reason: object = None,
        error: object = None,
        request: object = None,
        telemetry_schema_version: object = None,
    ) -> None:
        del task_id, session_id, platform, model, provider, base_url, api_mode, api_call_count
        del started_at, ended_at, max_retries, error, request, telemetry_schema_version
        self._runtime.framework_observability.on_api_request_error(
            turn_id=turn_id,
            api_request_id=api_request_id,
            api_duration=api_duration,
            reason=reason,
            status_code=status_code,
            retryable=retryable,
            retry_count=retry_count,
        )


class _PostToolCallHook:
    def __init__(self, runtime: ManagedToolPortalHookRuntime) -> None:
        self._runtime = runtime

    def __call__(
        self,
        *,
        tool_name: object = None,
        args: object = None,
        result: object = None,
        task_id: object = None,
        session_id: object = None,
        tool_call_id: object = None,
        turn_id: object = None,
        api_request_id: object = None,
        duration_ms: object = None,
        status: object = None,
        error_type: object = None,
        error_message: object = None,
        middleware_trace: object = None,
        telemetry_schema_version: object = None,
    ) -> None:
        del args, result, task_id, session_id, tool_call_id, api_request_id
        del error_type, error_message, middleware_trace, telemetry_schema_version
        self._runtime.framework_observability.on_post_tool_call(
            duration_ms=duration_ms,
            status=status,
            tool_name=tool_name,
            turn_id=turn_id,
        )
        self._runtime.telemetry.observe_post_tool_call(
            duration_milliseconds=duration_ms,
            status=status,
            tool_name=tool_name,
        )


class _OnSessionEndHook:
    """Preserve turn observability without session cleanup state."""

    def __init__(self, runtime: ManagedToolPortalHookRuntime) -> None:
        self._runtime = runtime

    def __call__(
        self,
        *,
        session_id: object = None,
        task_id: object = None,
        turn_id: object = None,
        api_request_id: object = None,
        completed: object = None,
        failed: object = None,
        interrupted: object = None,
        turn_exit_reason: object = None,
        model: object = None,
        platform: object = None,
        reason: object = None,
        conversation_history: object = None,
        telemetry_schema_version: object = None,
    ) -> None:
        del (
            task_id,
            api_request_id,
            failed,
            turn_exit_reason,
            model,
            platform,
            reason,
            conversation_history,
            telemetry_schema_version,
        )
        if isinstance(session_id, str) and session_id:
            self._runtime.approval_routes.clear(session_id)
        if self._runtime.telemetry.observer_hooks_enabled:
            self._runtime.framework_observability.on_session_end(
                turn_id=turn_id,
                completed=completed,
                interrupted=interrupted,
            )


class HermesToolHandler(t.Protocol):
    def __call__(
        self,
        args: object,
        *,
        task_id: object = None,
        session_id: object = None,
        user_task: object = None,
    ) -> str: ...


class HermesToolCheck(t.Protocol):
    def __call__(self) -> bool: ...


type RegisteredHook = (
    _PreGatewayDispatchHook
    | _PreLlmCallHook
    | _PreApiRequestHook
    | _PostApiRequestHook
    | _ApiRequestErrorHook
    | _PostToolCallHook
    | _OnSessionEndHook
)


@t.runtime_checkable
class HermesPluginContext(t.Protocol):
    def register_hook(self, hook_name: str, callback: RegisteredHook) -> None: ...

    def register_tool(
        self,
        name: str,
        toolset: str,
        schema: dict[str, object],
        handler: HermesToolHandler,
        check_fn: HermesToolCheck | None = None,
        requires_env: list[object] | None = None,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
        override: bool = False,
    ) -> None: ...


def register_managed_tool_portal_hooks(
    context: HermesPluginContext,
    runtime: ManagedToolPortalHookRuntime,
) -> None:
    """Install managed Tool Portal hooks and independent observer hooks."""
    context.register_hook("pre_gateway_dispatch", _PreGatewayDispatchHook(runtime))
    context.register_hook("pre_llm_call", _PreLlmCallHook(runtime))
    context.register_hook("pre_api_request", _PreApiRequestHook(runtime))
    context.register_hook("on_session_end", _OnSessionEndHook(runtime))
    if runtime.telemetry.observer_hooks_enabled:
        context.register_hook("post_api_request", _PostApiRequestHook(runtime))
        context.register_hook("api_request_error", _ApiRequestErrorHook(runtime))
        context.register_hook("post_tool_call", _PostToolCallHook(runtime))


__all__ = (
    "HermesGatewayMessageEvent",
    "HermesPluginContext",
    "HermesToolHandler",
    "ManagedToolPortalHookRuntime",
    "PreLlmCall",
    "ProjectionResolver",
    "RegisteredHook",
    "register_managed_tool_portal_hooks",
)
