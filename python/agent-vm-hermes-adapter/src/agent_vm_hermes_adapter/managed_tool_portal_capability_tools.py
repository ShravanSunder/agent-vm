"""Hermes pip plugin for the managed Tool Portal capability API."""

import threading
import typing as t
from collections.abc import Callable, Mapping

from agent_vm_agent_portal_sdk.contracts import (
    encode_canonical_json,
    get_portable_contract_json_schema,
)
from pydantic import BaseModel

from .managed_framework_observability import ManagedFrameworkObservability
from .managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesProfileAdmissionError,
    HermesSessionSource,
    _projection_profile_name,
    build_managed_trusted_context,
)
from .managed_tool_portal_observability import HermesToolPortalTelemetry

MANAGED_TOOL_PORTAL_PLUGIN_NAME = "agent-vm-tool-portal"
MANAGED_TOOL_PORTAL_TOOL_NAMES = (
    "tool_portal_list",
    "tool_portal_search",
    "tool_portal_describe",
    "tool_portal_call",
)
_MANAGED_TOOL_PORTAL_TOOLSET = "tool-portal"
_REQUEST_SCHEMA_ID_BY_TOOL_NAME = {
    "tool_portal_list": "portal.list.request",
    "tool_portal_search": "portal.search.request",
    "tool_portal_describe": "portal.describe.request",
    "tool_portal_call": "portal.call.request",
}


class HermesPluginContext(t.Protocol):
    def register_hook(
        self,
        hook_name: str,
        callback: Callable[..., object],
    ) -> None: ...

    def register_tool(
        self,
        name: str,
        toolset: str,
        schema: dict[str, object],
        handler: Callable[..., str],
        check_fn: Callable[..., bool] | None = None,
        requires_env: list[object] | None = None,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
        override: bool = False,
    ) -> None: ...


class HermesGatewayMessageEvent(t.Protocol):
    source: HermesSessionSource


class _ManagedToolPortalPluginRuntime(t.NamedTuple):
    adapter: HermesManagedAdapter
    current_projection: Callable[[], CanonicalManagedAgentProjection]
    framework_observability: ManagedFrameworkObservability
    telemetry: HermesToolPortalTelemetry


_CONFIGURATION_LOCK = threading.Lock()
_configured_runtime: _ManagedToolPortalPluginRuntime | None = None


def configure_managed_tool_portal_plugin(
    *,
    adapter: HermesManagedAdapter,
    current_projection: Callable[[], CanonicalManagedAgentProjection],
    telemetry: HermesToolPortalTelemetry,
) -> None:
    """Bind the installed plugin to the bootstrap-owned managed runtime."""
    global _configured_runtime
    with _CONFIGURATION_LOCK:
        if _configured_runtime is not None:
            raise RuntimeError("Managed Tool Portal Hermes plugin is already configured.")
        _configured_runtime = _ManagedToolPortalPluginRuntime(
            adapter=adapter,
            current_projection=current_projection,
            framework_observability=ManagedFrameworkObservability(
                sink=telemetry,
                max_inflight_observations=telemetry.max_inflight_observations,
            ),
            telemetry=telemetry,
        )


def clear_managed_tool_portal_plugin_configuration() -> None:
    """Remove process-local runtime authority after managed Gateway shutdown."""
    global _configured_runtime
    with _CONFIGURATION_LOCK:
        runtime = _configured_runtime
        _configured_runtime = None
    if runtime is not None:
        runtime.framework_observability.shutdown()


def _require_configured_runtime() -> _ManagedToolPortalPluginRuntime:
    with _CONFIGURATION_LOCK:
        runtime = _configured_runtime
    if runtime is None:
        raise RuntimeError(
            "Managed Tool Portal Hermes plugin requires bootstrap runtime configuration."
        )
    return runtime


def _description_for_tool(tool_name: str) -> str:
    if tool_name == "tool_portal_list":
        return "List authorized Tool Portal capabilities and compact tool summaries."
    if tool_name == "tool_portal_search":
        return "Search the caller-scoped Tool Portal capability index."
    if tool_name == "tool_portal_describe":
        return "Describe exact Tool Portal capability schemas and helper details."
    return "Validate and call an authorized Tool Portal capability by namespace and name."


def _tool_schema(tool_name: str) -> dict[str, object]:
    request_schema_id = _REQUEST_SCHEMA_ID_BY_TOOL_NAME[tool_name]
    return {
        "name": tool_name,
        "description": _description_for_tool(tool_name),
        "parameters": get_portable_contract_json_schema(request_schema_id),
    }


def _result_json(result: BaseModel) -> str:
    return encode_canonical_json(
        result.model_dump(
            by_alias=True,
            mode="json",
            exclude_none=True,
        )
    )


def _invoke(
    runtime: _ManagedToolPortalPluginRuntime,
    tool_name: str,
    request: Mapping[str, object],
) -> str:
    with runtime.telemetry.observe_tool_operation(tool_name):
        projection = runtime.current_projection()
        profile_name = _projection_profile_name(projection)
        client = runtime.adapter.gateway_runtime_client_for_profile(profile_name)
        trusted_context = build_managed_trusted_context(projection)
        if tool_name == "tool_portal_list":
            operation = client.portal.list(request, trusted_context=trusted_context)
        elif tool_name == "tool_portal_search":
            operation = client.portal.search(request, trusted_context=trusted_context)
        elif tool_name == "tool_portal_describe":
            operation = client.portal.describe(request, trusted_context=trusted_context)
        else:
            operation = client.portal.call(request, trusted_context=trusted_context)
        return _result_json(runtime.adapter.run_gateway_runtime_coroutine(operation))


def _observe_post_tool_call(
    runtime: _ManagedToolPortalPluginRuntime,
    *,
    duration_ms: object,
    status: object,
    tool_name: object,
    **hook_fields: object,
) -> None:
    runtime.framework_observability.on_post_tool_call(
        duration_ms=duration_ms,
        status=status,
        tool_name=tool_name,
        **hook_fields,
    )
    runtime.telemetry.observe_post_tool_call(
        duration_milliseconds=duration_ms,
        status=status,
        tool_name=tool_name,
    )


def _admit_managed_gateway_event(
    runtime: _ManagedToolPortalPluginRuntime,
    *,
    event: HermesGatewayMessageEvent,
    **_kwargs: object,
) -> dict[str, str]:
    try:
        runtime.adapter.admit_session_source(event.source)
    except HermesProfileAdmissionError:
        return {
            "action": "skip",
            "reason": "managed Hermes profile origin was not admitted",
        }
    return {"action": "allow"}


def register(context: HermesPluginContext) -> None:
    """Hermes entry-point hook registering the managed capability toolset."""
    runtime = _require_configured_runtime()
    context.register_hook(
        "pre_gateway_dispatch",
        lambda **kwargs: _admit_managed_gateway_event(runtime, **kwargs),
    )
    context.register_hook(
        "post_tool_call",
        lambda **kwargs: _observe_post_tool_call(runtime, **kwargs),
    )
    for hook_name, callback in (
        ("pre_llm_call", runtime.framework_observability.on_pre_llm_call),
        ("post_llm_call", runtime.framework_observability.on_post_llm_call),
        ("pre_api_request", runtime.framework_observability.on_pre_api_request),
        ("post_api_request", runtime.framework_observability.on_post_api_request),
        ("api_request_error", runtime.framework_observability.on_api_request_error),
        ("on_session_end", runtime.framework_observability.on_session_end),
    ):
        context.register_hook(hook_name, callback)
    for tool_name in MANAGED_TOOL_PORTAL_TOOL_NAMES:
        context.register_tool(
            name=tool_name,
            toolset=_MANAGED_TOOL_PORTAL_TOOLSET,
            schema=_tool_schema(tool_name),
            handler=lambda args, _tool_name=tool_name, **_kwargs: _invoke(
                runtime,
                _tool_name,
                args,
            ),
            description=_description_for_tool(tool_name),
            emoji="🧰",
        )
