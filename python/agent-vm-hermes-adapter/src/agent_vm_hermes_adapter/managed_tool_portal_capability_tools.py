"""Typed Hermes boundary for the managed Tool Portal capability API."""

import threading
import typing as t

from agent_vm_agent_portal_sdk.contracts import (
    PORTABLE_CONTRACT_ADAPTERS,
    encode_canonical_json,
    get_portable_contract_json_schema,
)
from agent_vm_agent_portal_sdk.gateway_approval_bridge import (
    execute_portal_call_with_approval,
)
from pydantic import BaseModel

from .managed_framework_observability import ManagedFrameworkObservability
from .managed_profile_adapter import (
    HermesManagedAdapter,
    _projection_profile_name,
    build_managed_trusted_context,
)
from .managed_tool_portal.cache import PluginStateCache
from .managed_tool_portal.hermes_approval_presenter import (
    HermesGatewayApprovalPresenter,
    HermesGatewayApprovalRouteStore,
)
from .managed_tool_portal.hermes_hooks import (
    HermesPluginContext,
    ProjectionResolver,
    register_managed_tool_portal_hooks,
)
from .managed_tool_portal.inventory import InventoryCoordinator
from .managed_tool_portal.models import InjectionCacheKey, InjectionMarker
from .managed_tool_portal_observability import HermesToolPortalTelemetry

MANAGED_TOOL_PORTAL_PLUGIN_NAME = "agent-vm-tool-portal"
type ManagedToolName = t.Literal[
    "tool_portal_list",
    "tool_portal_search",
    "tool_portal_describe",
    "tool_portal_call",
]
MANAGED_TOOL_PORTAL_TOOL_NAMES: tuple[ManagedToolName, ...] = (
    "tool_portal_list",
    "tool_portal_search",
    "tool_portal_describe",
    "tool_portal_call",
)
_MANAGED_TOOL_PORTAL_TOOLSET = "tool-portal"
_REQUEST_SCHEMA_ID_BY_TOOL_NAME: dict[ManagedToolName, str] = {
    "tool_portal_list": "portal.list.request",
    "tool_portal_search": "portal.search.request",
    "tool_portal_describe": "portal.describe.request",
    "tool_portal_call": "portal.call.request",
}


class _ManagedToolPortalPluginRuntime:
    __slots__ = (
        "adapter",
        "current_projection",
        "framework_observability",
        "telemetry",
        "inventory_coordinator",
        "injection_state_cache",
        "gateway_epoch",
        "approval_presenter",
        "approval_routes",
    )

    def __init__(
        self,
        *,
        adapter: HermesManagedAdapter,
        current_projection: ProjectionResolver,
        framework_observability: ManagedFrameworkObservability,
        telemetry: HermesToolPortalTelemetry,
        inventory_coordinator: InventoryCoordinator,
        injection_state_cache: PluginStateCache[InjectionCacheKey, InjectionMarker],
        gateway_epoch: str,
    ) -> None:
        self.adapter = adapter
        self.current_projection = current_projection
        self.framework_observability = framework_observability
        self.telemetry = telemetry
        self.inventory_coordinator = inventory_coordinator
        self.injection_state_cache = injection_state_cache
        self.gateway_epoch = gateway_epoch
        self.approval_routes = HermesGatewayApprovalRouteStore()
        self.approval_presenter = HermesGatewayApprovalPresenter(self.approval_routes)


def _safe_model_dump(model: BaseModel) -> dict[str, object]:
    dumped = model.model_dump(
        by_alias=True,
        mode="json",
        exclude_none=True,
    )
    if not isinstance(dumped, dict):
        raise TypeError("validated model did not produce a JSON object")
    if not all(isinstance(key, str) for key in dumped):
        raise TypeError("validated model produced a JSON object with a non-string key")
    return {key: value for key, value in dumped.items() if isinstance(key, str)}


def _validate_tool_name(value: str) -> ManagedToolName:
    if value == "tool_portal_list":
        return value
    if value == "tool_portal_search":
        return value
    if value == "tool_portal_describe":
        return value
    if value == "tool_portal_call":
        return value
    raise ValueError(f"unknown managed Tool Portal tool {value!r}")


def _validated_tool_request(
    tool_name: ManagedToolName,
    raw_request: object,
) -> dict[str, object]:
    """Validate Hermes's dynamic tool payload before it reaches Portal code."""
    adapter = PORTABLE_CONTRACT_ADAPTERS[_REQUEST_SCHEMA_ID_BY_TOOL_NAME[tool_name]]
    validated = adapter.validate_python(raw_request)
    if not isinstance(validated, BaseModel):
        raise TypeError(f"{tool_name} request did not produce a typed model")
    return _safe_model_dump(validated)


def _description_for_tool(tool_name: ManagedToolName) -> str:
    if tool_name == "tool_portal_list":
        return "List authorized Tool Portal capabilities and compact tool summaries."
    if tool_name == "tool_portal_search":
        return "Search the caller-scoped Tool Portal capability index."
    if tool_name == "tool_portal_describe":
        return "Describe exact Tool Portal capability schemas and helper details."
    return "Validate and call an authorized Tool Portal capability by namespace and name."


def _tool_schema(tool_name: ManagedToolName) -> dict[str, object]:
    return {
        "name": tool_name,
        "description": _description_for_tool(tool_name),
        "parameters": get_portable_contract_json_schema(
            _REQUEST_SCHEMA_ID_BY_TOOL_NAME[tool_name],
        ),
    }


def _result_json(result: BaseModel) -> str:
    return encode_canonical_json(_safe_model_dump(result))


def _result_requires_approval(result: BaseModel) -> bool:
    items = _safe_model_dump(result).get("items")
    return isinstance(items, list) and any(
        isinstance(item, dict) and item.get("status") == "approval_required" for item in items
    )


def _invoke(
    runtime: _ManagedToolPortalPluginRuntime,
    tool_name: ManagedToolName,
    request: object,
    session_id: str | None = None,
) -> str:
    validated_request = _validated_tool_request(tool_name, request)
    with runtime.telemetry.observe_tool_operation(tool_name):
        projection = runtime.current_projection()
        profile_name = _projection_profile_name(projection)
        client = runtime.adapter.gateway_runtime_client_for_profile(profile_name)
        trusted_context = _safe_model_dump(
            build_managed_trusted_context(projection, session_id=session_id)
        )
        if tool_name == "tool_portal_list":
            operation = client.portal.list(
                validated_request,
                trusted_context=trusted_context,
            )
        elif tool_name == "tool_portal_search":
            operation = client.portal.search(
                validated_request,
                trusted_context=trusted_context,
            )
        elif tool_name == "tool_portal_describe":
            operation = client.portal.describe(
                validated_request,
                trusted_context=trusted_context,
            )
        else:
            initial_result = runtime.adapter.run_gateway_runtime_coroutine(
                client.portal.call(
                    validated_request,
                    trusted_context=trusted_context,
                )
            )
            if not _result_requires_approval(initial_result):
                return _result_json(initial_result)
            operation = execute_portal_call_with_approval(
                validated_request,
                call_portal=lambda retry_request: client.portal.call(
                    retry_request,
                    trusted_context=trusted_context,
                ),
                decide_approval=lambda decision_request: client.approvals.decide(
                    decision_request,
                    trusted_context=trusted_context,
                ),
                initial_result=initial_result,
                present_approval=lambda presentation_request: runtime.approval_presenter.present(
                    session_id or "",
                    presentation_request,
                ),
            )
        return _result_json(runtime.adapter.run_gateway_runtime_coroutine(operation))


class _ToolHandler:
    def __init__(
        self,
        runtime: _ManagedToolPortalPluginRuntime,
        tool_name: ManagedToolName,
    ) -> None:
        self._runtime = runtime
        self._tool_name = tool_name

    def __call__(
        self,
        args: object,
        *,
        task_id: object = None,
        session_id: object = None,
        user_task: object = None,
    ) -> str:
        del task_id, user_task
        return _invoke(
            self._runtime,
            self._tool_name,
            args,
            session_id=session_id if isinstance(session_id, str) and session_id else None,
        )


_CONFIGURATION_LOCK = threading.Lock()
_configured_runtime: _ManagedToolPortalPluginRuntime | None = None


def configure_managed_tool_portal_plugin(
    *,
    adapter: HermesManagedAdapter,
    current_projection: ProjectionResolver,
    telemetry: HermesToolPortalTelemetry,
    inventory_coordinator: InventoryCoordinator,
    injection_state_cache: PluginStateCache[InjectionCacheKey, InjectionMarker],
    gateway_epoch: str,
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
            inventory_coordinator=inventory_coordinator,
            injection_state_cache=injection_state_cache,
            gateway_epoch=gateway_epoch,
        )


def clear_managed_tool_portal_plugin_configuration() -> None:
    """Remove process-local runtime authority after managed Gateway shutdown."""
    global _configured_runtime
    with _CONFIGURATION_LOCK:
        runtime = _configured_runtime
        _configured_runtime = None
    if runtime is not None:
        runtime.approval_routes.close()
        runtime.framework_observability.shutdown()


def _require_configured_runtime() -> _ManagedToolPortalPluginRuntime:
    with _CONFIGURATION_LOCK:
        runtime = _configured_runtime
    if runtime is None:
        raise RuntimeError(
            "Managed Tool Portal Hermes plugin requires bootstrap runtime configuration."
        )
    return runtime


def register(context: object) -> None:
    """Register the managed tools and typed lifecycle adapters with Hermes."""
    if not isinstance(context, HermesPluginContext):
        raise TypeError("Hermes plugin registration requires a compatible PluginContext")
    runtime = _require_configured_runtime()
    register_managed_tool_portal_hooks(context, runtime)
    for tool_name in MANAGED_TOOL_PORTAL_TOOL_NAMES:
        context.register_tool(
            name=tool_name,
            toolset=_MANAGED_TOOL_PORTAL_TOOLSET,
            schema=_tool_schema(tool_name),
            handler=_ToolHandler(runtime, tool_name),
            description=_description_for_tool(tool_name),
            emoji="🧰",
        )
