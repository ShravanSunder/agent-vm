import importlib.metadata
import json
import typing as t
import unittest
from collections.abc import Mapping
from contextlib import contextmanager
from unittest.mock import patch

from agent_vm_agent_portal_sdk.contracts import get_portable_contract_json_schema
from agent_vm_agent_portal_sdk.gateway_runtime_client import (
    GatewayRuntimeClient,
    GatewayRuntimeTraceContext,
)
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from hermes_cli.tools_config import _get_platform_tools
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from pydantic import BaseModel
from tools.registry import registry as hermes_tool_registry

from agent_vm_hermes_adapter.managed_framework_observability import (
    ManagedFrameworkObservability,
    ProviderAttemptCompletedRecord,
    ProviderAttemptStartedRecord,
    ToolCallRecord,
    TurnCompletedRecord,
    TurnStartedRecord,
)
from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesManagedAdapterConfig,
    HermesProfileAdmissionError,
    ManagedFrameworkIdentity,
)
from agent_vm_hermes_adapter.managed_tool_portal.cache import PluginStateCache
from agent_vm_hermes_adapter.managed_tool_portal.hermes_hooks import (
    HermesToolCheck,
    HermesToolHandler,
    RegisteredHook,
    _ApiRequestErrorHook,
    _OnSessionEndHook,
    _PostApiRequestHook,
    _PostToolCallHook,
    _PreApiRequestHook,
    _PreGatewayDispatchHook,
    _PreLlmCallHook,
)
from agent_vm_hermes_adapter.managed_tool_portal.inventory import InventoryCoordinator
from agent_vm_hermes_adapter.managed_tool_portal.inventory_contracts import (
    InventoryListRequest,
    InventoryPortalListResult,
    InventoryProjection,
)
from agent_vm_hermes_adapter.managed_tool_portal.models import (
    InjectionCacheKey,
    InjectionMarker,
)
from agent_vm_hermes_adapter.managed_tool_portal_capability_tools import (
    MANAGED_TOOL_PORTAL_PLUGIN_NAME,
    MANAGED_TOOL_PORTAL_TOOL_NAMES,
    _invoke,
    _ManagedToolPortalPluginRuntime,
    clear_managed_tool_portal_plugin_configuration,
    configure_managed_tool_portal_plugin,
    register,
)
from agent_vm_hermes_adapter.managed_tool_portal_observability import HermesToolPortalTelemetry

PROJECTION_COHORT_DIGEST = (
    "projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)
GATEWAY_EPOCH = "gateway-epoch-1"
REQUEST_SCHEMA_ID_BY_TOOL_NAME = {
    "tool_portal_list": "portal.list.request",
    "tool_portal_search": "portal.search.request",
    "tool_portal_describe": "portal.describe.request",
    "tool_portal_call": "portal.call.request",
}


def valid_request_for(tool_name: str) -> dict[str, object]:
    if tool_name == "tool_portal_list":
        return {"requests": [{"id": "list-1"}]}
    if tool_name == "tool_portal_search":
        return {"requests": [{"id": "search-1", "query": "issue"}]}
    if tool_name == "tool_portal_describe":
        return {
            "requests": [
                {
                    "id": "describe-1",
                    "tools": [{"name": "get_issue", "namespace": "github"}],
                }
            ]
        }
    if tool_name == "tool_portal_call":
        return {
            "requestId": "request-1",
            "calls": [
                {
                    "arguments": {},
                    "id": "call-1",
                    "name": "get_issue",
                    "namespace": "github",
                }
            ],
        }
    raise AssertionError(f"unknown tool {tool_name}")


def build_projection(*, agent_id: str) -> CanonicalManagedAgentProjection:
    return CanonicalManagedAgentProjection(
        agent_id=agent_id,
        framework_identity=ManagedFrameworkIdentity(kind="hermes", profile_name=agent_id),
        profile_assignment_revision=f"revision-{agent_id}",
        tool_portal_namespace_names=("filesystem", "github"),
        tool_portal_profile_id=f"policy-{agent_id}",
    )


class PortalResult(BaseModel):
    agent_id: str
    operation: str


class FakeHermesSessionSource(BaseModel):
    profile: str | None


class FakeHermesMessageEvent(BaseModel):
    source: FakeHermesSessionSource


class PortalCall(BaseModel):
    operation: str
    client_identity: object
    request: dict[str, object]
    trusted_context: dict[str, object]


class FakePortalOperations:
    def __init__(self, client_identity: object) -> None:
        self.client_identity = client_identity
        self.calls: list[PortalCall] = []

    async def _record(
        self,
        operation: str,
        request: dict[str, object],
        *,
        trusted_context: dict[str, object],
    ) -> BaseModel:
        principal = trusted_context.get("principal")
        if not isinstance(principal, dict):
            raise AssertionError("trusted context principal was not a JSON object")
        agent_id = principal.get("agentId")
        if not isinstance(agent_id, str):
            raise AssertionError("trusted context principal omitted agentId")
        self.calls.append(
            PortalCall(
                operation=operation,
                client_identity=self.client_identity,
                request=request,
                trusted_context=trusted_context,
            )
        )
        return PortalResult(agent_id=agent_id, operation=operation)

    async def list(
        self,
        request: dict[str, object],
        *,
        trusted_context: dict[str, object],
    ) -> BaseModel:
        return await self._record("list", request, trusted_context=trusted_context)

    async def search(
        self,
        request: dict[str, object],
        *,
        trusted_context: dict[str, object],
    ) -> BaseModel:
        return await self._record("search", request, trusted_context=trusted_context)

    async def describe(
        self,
        request: dict[str, object],
        *,
        trusted_context: dict[str, object],
    ) -> BaseModel:
        return await self._record("describe", request, trusted_context=trusted_context)

    async def call(
        self,
        request: dict[str, object],
        *,
        trusted_context: dict[str, object],
    ) -> BaseModel:
        return await self._record("call", request, trusted_context=trusted_context)


class FakeGatewayRuntimeClient(GatewayRuntimeClient):
    portal: FakePortalOperations

    def __init__(self) -> None:
        self.identity = object()
        self.portal = FakePortalOperations(self.identity)

    @t.override
    async def connect(self) -> None:
        return None

    @t.override
    async def disconnect(self) -> None:
        return None


class RegisteredTool:
    __slots__ = ("handler", "name", "schema", "toolset")

    def __init__(
        self,
        *,
        name: str,
        toolset: str,
        schema: dict[str, object],
        handler: HermesToolHandler,
    ) -> None:
        self.name = name
        self.toolset = toolset
        self.schema = schema
        self.handler = handler


class FakeHookRegistry:
    def __init__(self) -> None:
        self.pre_gateway_dispatch: _PreGatewayDispatchHook | None = None
        self.pre_llm_call: _PreLlmCallHook | None = None
        self.pre_api_request: _PreApiRequestHook | None = None
        self.post_api_request: _PostApiRequestHook | None = None
        self.api_request_error: _ApiRequestErrorHook | None = None
        self.post_tool_call: _PostToolCallHook | None = None
        self.on_session_end: _OnSessionEndHook | None = None

    def register(self, hook_name: str, callback: RegisteredHook) -> None:
        if hook_name == "pre_gateway_dispatch":
            self._set_pre_gateway_dispatch(callback)
        elif hook_name == "pre_llm_call":
            self._set_pre_llm_call(callback)
        elif hook_name == "pre_api_request":
            self._set_pre_api_request(callback)
        elif hook_name == "post_api_request":
            self._set_post_api_request(callback)
        elif hook_name == "api_request_error":
            self._set_api_request_error(callback)
        elif hook_name == "post_tool_call":
            self._set_post_tool_call(callback)
        elif hook_name == "on_session_end":
            self._set_on_session_end(callback)
        else:
            raise AssertionError(f"unexpected hook {hook_name}")

    def names(self) -> set[str]:
        return {
            name
            for name, callback in (
                ("pre_gateway_dispatch", self.pre_gateway_dispatch),
                ("pre_llm_call", self.pre_llm_call),
                ("pre_api_request", self.pre_api_request),
                ("post_api_request", self.post_api_request),
                ("api_request_error", self.api_request_error),
                ("post_tool_call", self.post_tool_call),
                ("on_session_end", self.on_session_end),
            )
            if callback is not None
        }

    def _set_pre_gateway_dispatch(self, callback: RegisteredHook) -> None:
        if not isinstance(callback, _PreGatewayDispatchHook):
            raise AssertionError("pre_gateway_dispatch callback type mismatch")
        self.pre_gateway_dispatch = callback

    def _set_pre_llm_call(self, callback: RegisteredHook) -> None:
        if not isinstance(callback, _PreLlmCallHook):
            raise AssertionError("pre_llm_call callback type mismatch")
        self.pre_llm_call = callback

    def _set_pre_api_request(self, callback: RegisteredHook) -> None:
        if not isinstance(callback, _PreApiRequestHook):
            raise AssertionError("pre_api_request callback type mismatch")
        self.pre_api_request = callback

    def _set_post_api_request(self, callback: RegisteredHook) -> None:
        if not isinstance(callback, _PostApiRequestHook):
            raise AssertionError("post_api_request callback type mismatch")
        self.post_api_request = callback

    def _set_api_request_error(self, callback: RegisteredHook) -> None:
        if not isinstance(callback, _ApiRequestErrorHook):
            raise AssertionError("api_request_error callback type mismatch")
        self.api_request_error = callback

    def _set_post_tool_call(self, callback: RegisteredHook) -> None:
        if not isinstance(callback, _PostToolCallHook):
            raise AssertionError("post_tool_call callback type mismatch")
        self.post_tool_call = callback

    def _set_on_session_end(self, callback: RegisteredHook) -> None:
        if not isinstance(callback, _OnSessionEndHook):
            raise AssertionError("on_session_end callback type mismatch")
        self.on_session_end = callback


class FakeHermesPluginContext:
    def __init__(self) -> None:
        self.hooks = FakeHookRegistry()
        self.tools: list[RegisteredTool] = []

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
    ) -> None:
        del check_fn, requires_env, is_async, description, emoji, override
        self.tools.append(
            RegisteredTool(
                name=name,
                toolset=toolset,
                schema=schema,
                handler=handler,
            )
        )

    def register_hook(
        self,
        hook_name: str,
        callback: RegisteredHook,
    ) -> None:
        self.hooks.register(hook_name, callback)

    def handler_for(self, tool_name: str) -> HermesToolHandler:
        for registered_tool in self.tools:
            if registered_tool.name == tool_name:
                return registered_tool.handler
        raise AssertionError(f"tool {tool_name} was not registered")

    def schema_for(self, tool_name: str) -> dict[str, object]:
        for registered_tool in self.tools:
            if registered_tool.name == tool_name:
                return registered_tool.schema
        raise AssertionError(f"tool {tool_name} was not registered")

    def toolset_names(self) -> set[str]:
        return {registered_tool.toolset for registered_tool in self.tools}


class FakeToolOperationTelemetry:
    def __init__(self, *, observer_hooks_enabled: bool = True) -> None:
        self.observer_hooks_enabled = observer_hooks_enabled
        self.max_inflight_observations = 8
        self.active_operations: list[str] = []
        self.framework_records: list[tuple[str, object, object | None]] = []
        self.post_tool_call_records: list[tuple[object, object, object]] = []

    @contextmanager
    def observe_tool_operation(self, tool_name: str) -> t.Iterator[None]:
        self.active_operations.append(tool_name)
        yield

    def observe_post_tool_call(
        self,
        *,
        duration_milliseconds: object,
        status: object,
        tool_name: object,
    ) -> None:
        self.post_tool_call_records.append((duration_milliseconds, status, tool_name))

    def trace_context_provider(self) -> dict[str, object] | None:
        return None

    def shutdown(self) -> None:
        return None

    def start_turn(self, record: TurnStartedRecord) -> object:
        handle = object()
        self.framework_records.append(("turn.started", record, handle))
        return handle

    def complete_turn(
        self,
        handle: object,
        record: TurnCompletedRecord,
    ) -> None:
        self.framework_records.append(("turn.completed", record, handle))

    def start_provider_attempt(
        self,
        parent_handle: object | None,
        record: ProviderAttemptStartedRecord,
    ) -> object:
        handle = object()
        self.framework_records.append(("provider.started", record, parent_handle))
        return handle

    def complete_provider_attempt(
        self,
        handle: object,
        record: ProviderAttemptCompletedRecord,
    ) -> None:
        self.framework_records.append(("provider.completed", record, handle))

    def emit_tool_call(
        self,
        parent_handle: object | None,
        record: ToolCallRecord,
    ) -> None:
        self.framework_records.append(("tool.completed", record, parent_handle))


class ThreadBoundaryToolOperationTelemetry(FakeToolOperationTelemetry):
    def __init__(self) -> None:
        super().__init__()
        self._tracer = TracerProvider().get_tracer("test-hermes-tool-portal")

    @contextmanager
    @t.override
    def observe_tool_operation(self, tool_name: str) -> t.Iterator[None]:
        self.active_operations.append(tool_name)
        with self._tracer.start_as_current_span("test.hermes.tool_portal"):
            yield

    @t.override
    def trace_context_provider(self) -> dict[str, object] | None:
        span_context = trace.get_current_span().get_span_context()
        if not span_context.is_valid:
            return None
        return {
            "traceparent": (
                f"00-{span_context.trace_id:032x}-{span_context.span_id:016x}"
                f"-{int(span_context.trace_flags):02x}"
            )
        }


class RecordingGatewayRuntimeTransport:
    def __init__(self) -> None:
        self.trace_context: GatewayRuntimeTraceContext | None = None

    async def connect(self, socket_path: str) -> None:
        del socket_path

    async def handshake(
        self,
        attachment: Mapping[str, object],
    ) -> Mapping[str, object]:
        del attachment
        return {"kind": "accepted"}

    async def request(
        self,
        method: str,
        params: Mapping[str, object],
    ) -> Mapping[str, object]:
        del method
        raw_trace_context = params.get("traceContext")
        if not isinstance(raw_trace_context, Mapping):
            raise AssertionError("trace context was not a mapping")
        self.trace_context = GatewayRuntimeTraceContext.model_validate(raw_trace_context)
        return {}

    async def disconnect(self) -> None:
        return None


def build_adapter() -> tuple[HermesManagedAdapter, FakeGatewayRuntimeClient]:
    client = FakeGatewayRuntimeClient()
    adapter = HermesManagedAdapter(
        config=HermesManagedAdapterConfig(
            profiles=(
                build_projection(agent_id="researcher"),
                build_projection(agent_id="reviewer"),
            ),
            projection_cohort_digest=PROJECTION_COHORT_DIGEST,
            protected_hermes_home="/home/hermes/.hermes",
        ),
        gateway_runtime_client=client,
    )
    return adapter, client


class _UnusedInventoryGateway:
    async def list_for_projection(
        self,
        projection: InventoryProjection,
        request: InventoryListRequest,
        *,
        timeout_seconds: float,
    ) -> InventoryPortalListResult:
        del projection, request, timeout_seconds
        raise AssertionError("capability-tool tests must not start inventory I/O")


def build_inventory_coordinator() -> InventoryCoordinator:
    return InventoryCoordinator(gateway=_UnusedInventoryGateway())


def build_injection_state_cache() -> PluginStateCache[InjectionCacheKey, InjectionMarker]:
    return PluginStateCache(
        key_model=InjectionCacheKey,
        value_model=InjectionMarker,
    )


def configure_plugin_for_profile(
    adapter: HermesManagedAdapter,
    current_projection: list[CanonicalManagedAgentProjection],
    telemetry: HermesToolPortalTelemetry | None = None,
) -> None:
    configure_managed_tool_portal_plugin(
        adapter=adapter,
        current_projection=lambda: current_projection[0],
        telemetry=FakeToolOperationTelemetry() if telemetry is None else telemetry,
        inventory_coordinator=build_inventory_coordinator(),
        injection_state_cache=build_injection_state_cache(),
        gateway_epoch=GATEWAY_EPOCH,
    )


@t.final
class ManagedToolPortalCapabilityToolsTests(unittest.TestCase):
    @t.override
    def tearDown(self) -> None:
        clear_managed_tool_portal_plugin_configuration()

    def test_package_exposes_real_hermes_plugin_entrypoint(self) -> None:
        distribution = importlib.metadata.distribution("agent-vm-hermes-adapter")
        entrypoints = {
            entrypoint.name: entrypoint.value
            for entrypoint in distribution.entry_points
            if entrypoint.group == "hermes_agent.plugins"
        }

        self.assertEqual(
            entrypoints,
            {
                MANAGED_TOOL_PORTAL_PLUGIN_NAME: (
                    "agent_vm_hermes_adapter.managed_tool_portal_capability_tools"
                )
            },
        )

    def test_registers_exact_portable_request_schemas_through_plugin_context(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        context = FakeHermesPluginContext()
        configure_plugin_for_profile(adapter, [projection])

        try:
            register(context)
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(
            tuple(registered_tool.name for registered_tool in context.tools),
            MANAGED_TOOL_PORTAL_TOOL_NAMES,
        )
        self.assertEqual(context.toolset_names(), {"tool-portal"})
        for tool_name, schema_id in REQUEST_SCHEMA_ID_BY_TOOL_NAME.items():
            with self.subTest(tool_name=tool_name):
                schema = context.schema_for(tool_name)
                self.assertEqual(schema["name"], tool_name)
                self.assertEqual(
                    schema["parameters"],
                    get_portable_contract_json_schema(schema_id),
                )

    def test_registered_handlers_accept_normal_hermes_model_dispatch_keywords(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        context = FakeHermesPluginContext()
        configure_plugin_for_profile(adapter, [projection])
        register(context)

        try:
            for tool_name in MANAGED_TOOL_PORTAL_TOOL_NAMES:
                with self.subTest(tool_name=tool_name):
                    result = context.handler_for(tool_name)(
                        valid_request_for(tool_name),
                        task_id="task-1",
                        session_id="session-1",
                        user_task="user request",
                    )
                    self.assertEqual(json.loads(result)["agent_id"], "researcher")
        finally:
            adapter.close(disconnect_gateway_runtime=False)

    def test_pre_gateway_dispatch_admits_only_explicit_managed_profiles(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        context = FakeHermesPluginContext()
        configure_plugin_for_profile(adapter, [projection])

        try:
            register(context)
            admission_hook = context.hooks.pre_gateway_dispatch
            self.assertIsNotNone(admission_hook)
            assert admission_hook is not None

            for profile_name in ("researcher", "reviewer"):
                with self.subTest(profile_name=profile_name):
                    event = FakeHermesMessageEvent(
                        source=FakeHermesSessionSource(profile=profile_name)
                    )
                    self.assertEqual(admission_hook(event=event), {"action": "allow"})

            for profile_name in (None, "default", "unknown"):
                with self.subTest(profile_name=profile_name):
                    event = FakeHermesMessageEvent(
                        source=FakeHermesSessionSource(profile=profile_name)
                    )
                    self.assertEqual(
                        admission_hook(event=event),
                        {
                            "action": "skip",
                            "reason": "managed Hermes profile origin was not admitted",
                        },
                    )
        finally:
            adapter.close(disconnect_gateway_runtime=False)

    def test_registers_post_tool_call_observer_for_bounded_telemetry(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        context = FakeHermesPluginContext()
        configure_plugin_for_profile(adapter, [projection])

        try:
            register(context)
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(
            context.hooks.names(),
            {
                "api_request_error",
                "on_session_end",
                "post_api_request",
                "post_tool_call",
                "pre_api_request",
                "pre_gateway_dispatch",
                "pre_llm_call",
            },
        )
        self.assertNotIn("pre_tool_call", context.hooks.names())

    def test_disabled_telemetry_still_registers_orientation_hooks(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        context = FakeHermesPluginContext()
        configure_managed_tool_portal_plugin(
            adapter=adapter,
            current_projection=lambda: projection,
            telemetry=FakeToolOperationTelemetry(observer_hooks_enabled=False),
            inventory_coordinator=build_inventory_coordinator(),
            injection_state_cache=build_injection_state_cache(),
            gateway_epoch=GATEWAY_EPOCH,
        )

        try:
            register(context)
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(
            context.hooks.names(),
            {
                "on_session_end",
                "pre_api_request",
                "pre_gateway_dispatch",
                "pre_llm_call",
            },
        )

    def test_framework_hooks_return_none_and_discard_content_canaries(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        context = FakeHermesPluginContext()
        telemetry = FakeToolOperationTelemetry()
        configure_managed_tool_portal_plugin(
            adapter=adapter,
            current_projection=lambda: projection,
            telemetry=telemetry,
            inventory_coordinator=build_inventory_coordinator(),
            injection_state_cache=build_injection_state_cache(),
            gateway_epoch=GATEWAY_EPOCH,
        )
        register(context)
        pre_llm_call = context.hooks.pre_llm_call
        pre_api_request = context.hooks.pre_api_request
        api_request_error = context.hooks.api_request_error
        post_tool_call = context.hooks.post_tool_call
        on_session_end = context.hooks.on_session_end
        self.assertIsNotNone(pre_llm_call)
        self.assertIsNotNone(pre_api_request)
        self.assertIsNotNone(api_request_error)
        self.assertIsNotNone(post_tool_call)
        self.assertIsNotNone(on_session_end)
        assert pre_llm_call is not None
        assert pre_api_request is not None
        assert api_request_error is not None
        assert post_tool_call is not None
        assert on_session_end is not None

        canary = "forbidden-content-canary"
        try:
            self.assertIsNone(
                pre_llm_call(
                    turn_id="turn-1",
                    platform="discord",
                    user_message=canary,
                )
            )
            self.assertIsNone(
                pre_api_request(
                    turn_id="turn-1",
                    api_request_id="request-1",
                    model="model",
                    provider="provider",
                    api_mode="chat_completions",
                    request_messages=canary,
                )
            )
            self.assertIsNone(
                api_request_error(
                    turn_id="turn-1",
                    api_request_id="request-1",
                    api_duration=0.25,
                    reason="unknown",
                    error=canary,
                )
            )
            self.assertIsNone(
                post_tool_call(
                    turn_id="turn-1",
                    tool_name="terminal",
                    duration_ms=12,
                    status="ok",
                    args=canary,
                    result=canary,
                )
            )
            self.assertIsNone(
                on_session_end(
                    turn_id="turn-1",
                    completed=False,
                    interrupted=True,
                    conversation_history=canary,
                )
            )
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertNotIn(canary, repr(telemetry.framework_records))
        self.assertNotIn(canary, repr(telemetry.post_tool_call_records))

    def test_observes_managed_tool_portal_handler_without_request_content(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        context = FakeHermesPluginContext()
        telemetry = FakeToolOperationTelemetry()
        configure_managed_tool_portal_plugin(
            adapter=adapter,
            current_projection=lambda: projection,
            telemetry=telemetry,
            inventory_coordinator=build_inventory_coordinator(),
            injection_state_cache=build_injection_state_cache(),
            gateway_epoch=GATEWAY_EPOCH,
        )

        try:
            register(context)
            context.handler_for("tool_portal_list")(valid_request_for("tool_portal_list"))
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(telemetry.active_operations, ["tool_portal_list"])

    def test_post_tool_call_discards_content_bearing_hook_fields(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        context = FakeHermesPluginContext()
        telemetry = FakeToolOperationTelemetry()
        configure_managed_tool_portal_plugin(
            adapter=adapter,
            current_projection=lambda: projection,
            telemetry=telemetry,
            inventory_coordinator=build_inventory_coordinator(),
            injection_state_cache=build_injection_state_cache(),
            gateway_epoch=GATEWAY_EPOCH,
        )

        try:
            register(context)
            post_tool_call = context.hooks.post_tool_call
            self.assertIsNotNone(post_tool_call)
            assert post_tool_call is not None
            post_tool_call(
                args={"credential": "must-not-export"},
                duration_ms=41,
                error_message="must-not-export",
                result="must-not-export",
                session_id="must-not-export",
                status="ok",
                task_id="must-not-export",
                tool_call_id="must-not-export",
                tool_name="tool_portal_list",
            )
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(telemetry.post_tool_call_records, [(41, "ok", "tool_portal_list")])

    def test_handler_span_reaches_gateway_runtime_transport_across_client_loop_thread(self) -> None:
        telemetry = ThreadBoundaryToolOperationTelemetry()
        transport = RecordingGatewayRuntimeTransport()
        client = GatewayRuntimeClient(
            attachment={
                "attachmentGeneration": 1,
                "clientKind": "hermes-managed-plugin",
                "configuredAgentIds": ["researcher", "reviewer"],
                "frameworkEpoch": "framework-epoch",
                "gatewayEpoch": "gateway-epoch",
                "protocolVersion": 1,
                "projectionCohortDigest": PROJECTION_COHORT_DIGEST,
                "runtimeEpoch": "runtime-epoch",
                "schemaVersion": 1,
            },
            trace_context_provider=telemetry.trace_context_provider,
            transport=transport,
        )
        adapter = HermesManagedAdapter(
            config=HermesManagedAdapterConfig(
                profiles=(
                    build_projection(agent_id="researcher"),
                    build_projection(agent_id="reviewer"),
                ),
                projection_cohort_digest=PROJECTION_COHORT_DIGEST,
                protected_hermes_home="/home/hermes/.hermes",
            ),
            gateway_runtime_client=client,
        )
        projection = adapter.projection_for_profile("researcher")
        runtime = _ManagedToolPortalPluginRuntime(
            adapter=adapter,
            current_projection=lambda: projection,
            framework_observability=ManagedFrameworkObservability(
                sink=telemetry,
                max_inflight_observations=telemetry.max_inflight_observations,
            ),
            telemetry=telemetry,
            inventory_coordinator=build_inventory_coordinator(),
            injection_state_cache=build_injection_state_cache(),
            gateway_epoch=GATEWAY_EPOCH,
        )
        adapter.connect_gateway_runtime()

        try:
            with self.assertRaises(Exception):
                _invoke(runtime, "tool_portal_list", {"requests": [{"id": "request-1"}]})
        finally:
            adapter.close()

        self.assertIsNotNone(transport.trace_context)
        trace_context = transport.trace_context
        assert trace_context is not None
        traceparent = trace_context.traceparent
        self.assertRegex(
            traceparent,
            r"^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$",
        )

    def test_plugin_context_tracking_makes_toolset_visible_to_platform_resolution(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        manager = PluginManager()
        context = PluginContext(
            PluginManifest(
                name=MANAGED_TOOL_PORTAL_PLUGIN_NAME,
                key=MANAGED_TOOL_PORTAL_PLUGIN_NAME,
                source="entrypoint",
            ),
            manager,
        )
        configure_plugin_for_profile(adapter, [projection])

        try:
            register(context)
            with (
                patch("hermes_cli.plugins.get_plugin_manager", return_value=manager),
                patch("hermes_cli.plugins.discover_plugins"),
            ):
                enabled_toolsets = _get_platform_tools({}, "discord")
        finally:
            for tool_name in MANAGED_TOOL_PORTAL_TOOL_NAMES:
                hermes_tool_registry.deregister(tool_name)
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(manager._plugin_tool_names, set(MANAGED_TOOL_PORTAL_TOOL_NAMES))
        self.assertIn("tool-portal", enabled_toolsets)

    def test_routes_every_operation_with_the_current_profiles_agent_identity(self) -> None:
        adapter, client = build_adapter()
        current_projection = [adapter.projection_for_profile("researcher")]
        context = FakeHermesPluginContext()
        configure_plugin_for_profile(adapter, current_projection)
        register(context)

        try:
            for agent_id in ("researcher", "reviewer"):
                current_projection[0] = adapter.projection_for_profile(agent_id)
                for tool_name in MANAGED_TOOL_PORTAL_TOOL_NAMES:
                    result = json.loads(
                        context.handler_for(tool_name)(valid_request_for(tool_name))
                    )
                    self.assertEqual(result["agent_id"], agent_id)
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(len(client.portal.calls), 8)
        self.assertTrue(
            all(
                portal_call.client_identity is client.identity
                for portal_call in client.portal.calls
            )
        )
        observed_agent_ids: list[object] = []
        for portal_call in client.portal.calls:
            principal = portal_call.trusted_context["principal"]
            self.assertIsInstance(principal, dict)
            assert isinstance(principal, dict)
            observed_agent_ids.append(principal["agentId"])
        self.assertEqual(observed_agent_ids, ["researcher"] * 4 + ["reviewer"] * 4)

    def test_has_no_unconfigured_default_or_unknown_profile_fallback(self) -> None:
        context = FakeHermesPluginContext()
        with self.assertRaisesRegex(RuntimeError, "requires bootstrap runtime configuration"):
            register(context)

        adapter, client = build_adapter()

        def reject_unadmitted_profile() -> CanonicalManagedAgentProjection:
            raise HermesProfileAdmissionError("explicit admitted profile required")

        configure_managed_tool_portal_plugin(
            adapter=adapter,
            current_projection=reject_unadmitted_profile,
            telemetry=FakeToolOperationTelemetry(),
            inventory_coordinator=build_inventory_coordinator(),
            injection_state_cache=build_injection_state_cache(),
            gateway_epoch=GATEWAY_EPOCH,
        )
        register(context)
        try:
            with self.assertRaisesRegex(HermesProfileAdmissionError, "explicit admitted profile"):
                context.handler_for("tool_portal_list")(valid_request_for("tool_portal_list"))
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(client.portal.calls, [])

    def test_preserves_the_immutable_projection_model_from_the_resolver(self) -> None:
        adapter, _client = build_adapter()
        context = FakeHermesPluginContext()
        projection = adapter.projection_for_profile("researcher")
        self.assertIsInstance(projection, CanonicalManagedAgentProjection)
        observed_projection: list[CanonicalManagedAgentProjection] = []

        def resolve_projection() -> CanonicalManagedAgentProjection:
            observed_projection.append(projection)
            return projection

        configure_managed_tool_portal_plugin(
            adapter=adapter,
            current_projection=resolve_projection,
            telemetry=FakeToolOperationTelemetry(),
            inventory_coordinator=build_inventory_coordinator(),
            injection_state_cache=build_injection_state_cache(),
            gateway_epoch=GATEWAY_EPOCH,
        )
        register(context)
        try:
            _ = context.handler_for("tool_portal_list")(valid_request_for("tool_portal_list"))
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(observed_projection, [projection])
        self.assertIs(observed_projection[0], projection)


if __name__ == "__main__":
    unittest.main()
