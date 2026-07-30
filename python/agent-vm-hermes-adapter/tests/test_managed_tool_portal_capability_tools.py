import importlib.metadata
import json
import typing as t
import unittest
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from types import MappingProxyType
from unittest.mock import patch

from agent_vm_agent_portal_sdk.contracts import get_portable_contract_json_schema
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
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
REQUEST_SCHEMA_ID_BY_TOOL_NAME = {
    "tool_portal_list": "portal.list.request",
    "tool_portal_search": "portal.search.request",
    "tool_portal_describe": "portal.describe.request",
    "tool_portal_call": "portal.call.request",
}


def build_projection(*, agent_id: str) -> dict[str, object]:
    return {
        "agentId": agent_id,
        "frameworkIdentity": {"kind": "hermes", "profileName": agent_id},
        "profileAssignmentRevision": f"revision-{agent_id}",
        "toolPortalProfileId": f"policy-{agent_id}",
    }


class PortalResult(BaseModel):
    agent_id: str
    operation: str


class FakeHermesSessionSource(BaseModel):
    profile: str | None


class FakeHermesMessageEvent(BaseModel):
    source: FakeHermesSessionSource


class FakePortalOperations:
    def __init__(self, client_identity: object) -> None:
        self.client_identity = client_identity
        self.calls: list[tuple[str, object, object, dict[str, object]]] = []

    async def _record(
        self,
        operation: str,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        principal = t.cast("Mapping[str, object]", trusted_context["principal"])
        agent_id = t.cast("str", principal["agentId"])
        self.calls.append((operation, self.client_identity, request, dict(trusted_context)))
        return PortalResult(agent_id=agent_id, operation=operation)

    async def list(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._record("list", request, trusted_context=trusted_context)

    async def search(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._record("search", request, trusted_context=trusted_context)

    async def describe(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._record("describe", request, trusted_context=trusted_context)

    async def call(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._record("call", request, trusted_context=trusted_context)


class FakeGatewayRuntimeClient:
    def __init__(self) -> None:
        self.identity = object()
        self.portal = FakePortalOperations(self.identity)

    async def connect(self) -> None:
        return None

    async def disconnect(self) -> None:
        return None


class FakeHermesPluginContext:
    def __init__(self) -> None:
        self.handlers: dict[str, Callable[..., str]] = {}
        self.hooks: dict[str, Callable[..., object]] = {}
        self.schemas: dict[str, dict[str, object]] = {}
        self.toolsets: dict[str, str] = {}

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
    ) -> None:
        del check_fn, requires_env, is_async, description, emoji, override
        self.handlers[name] = handler
        self.schemas[name] = schema
        self.toolsets[name] = toolset

    def register_hook(
        self,
        hook_name: str,
        callback: Callable[..., object],
    ) -> None:
        self.hooks[hook_name] = callback


class FakeToolOperationTelemetry:
    def __init__(self) -> None:
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

    def trace_context_provider(self) -> Mapping[str, object] | None:
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
    def trace_context_provider(self) -> Mapping[str, object] | None:
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
        self.request_parameters: Mapping[str, object] | None = None

    async def connect(self, socket_path: str) -> None:
        del socket_path

    async def handshake(self, attachment: Mapping[str, object]) -> Mapping[str, object]:
        del attachment
        return {"kind": "accepted"}

    async def request(
        self,
        method: str,
        params: Mapping[str, object],
    ) -> Mapping[str, object]:
        del method
        self.request_parameters = dict(params)
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
        gateway_runtime_client=t.cast(
            "GatewayRuntimeClient",
            t.cast("object", client),
        ),
    )
    return adapter, client


def configure_plugin_for_profile(
    adapter: HermesManagedAdapter,
    current_projection: list[CanonicalManagedAgentProjection],
    telemetry: HermesToolPortalTelemetry | None = None,
) -> None:
    configure_managed_tool_portal_plugin(
        adapter=adapter,
        current_projection=lambda: current_projection[0],
        telemetry=FakeToolOperationTelemetry() if telemetry is None else telemetry,
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

        self.assertEqual(tuple(context.handlers), MANAGED_TOOL_PORTAL_TOOL_NAMES)
        self.assertEqual(set(context.toolsets.values()), {"tool-portal"})
        for tool_name, schema_id in REQUEST_SCHEMA_ID_BY_TOOL_NAME.items():
            with self.subTest(tool_name=tool_name):
                self.assertEqual(context.schemas[tool_name]["name"], tool_name)
                self.assertEqual(
                    context.schemas[tool_name]["parameters"],
                    get_portable_contract_json_schema(schema_id),
                )

    def test_pre_gateway_dispatch_admits_only_explicit_managed_profiles(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        context = FakeHermesPluginContext()
        configure_plugin_for_profile(adapter, [projection])

        try:
            register(context)
            admission_hook = context.hooks["pre_gateway_dispatch"]

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
            set(context.hooks),
            {
                "api_request_error",
                "on_session_end",
                "post_api_request",
                "post_llm_call",
                "post_tool_call",
                "pre_api_request",
                "pre_gateway_dispatch",
                "pre_llm_call",
            },
        )
        self.assertNotIn("pre_tool_call", context.hooks)

    def test_framework_hooks_return_none_and_discard_content_canaries(self) -> None:
        adapter, _client = build_adapter()
        projection = adapter.projection_for_profile("researcher")
        context = FakeHermesPluginContext()
        telemetry = FakeToolOperationTelemetry()
        configure_managed_tool_portal_plugin(
            adapter=adapter,
            current_projection=lambda: projection,
            telemetry=telemetry,
        )
        register(context)

        canary = "forbidden-content-canary"
        try:
            self.assertIsNone(
                context.hooks["pre_llm_call"](
                    turn_id="turn-1",
                    platform="discord",
                    user_message=canary,
                )
            )
            self.assertIsNone(
                context.hooks["pre_api_request"](
                    turn_id="turn-1",
                    api_request_id="request-1",
                    model="model",
                    provider="provider",
                    api_mode="chat_completions",
                    request_messages=canary,
                )
            )
            self.assertIsNone(
                context.hooks["api_request_error"](
                    turn_id="turn-1",
                    api_request_id="request-1",
                    api_duration=0.25,
                    reason="unknown",
                    error=canary,
                )
            )
            self.assertIsNone(
                context.hooks["post_tool_call"](
                    turn_id="turn-1",
                    tool_name="terminal",
                    duration_ms=12,
                    status="ok",
                    args=canary,
                    result=canary,
                )
            )
            self.assertIsNone(
                context.hooks["on_session_end"](
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
        )

        try:
            register(context)
            context.handlers["tool_portal_list"]({"secret": "must-not-leave-handler"})
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
        )

        try:
            register(context)
            context.hooks["post_tool_call"](
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
        )
        adapter.connect_gateway_runtime()

        try:
            with self.assertRaises(Exception):
                _invoke(runtime, "tool_portal_list", {"requests": [{"id": "request-1"}]})
        finally:
            adapter.close()

        self.assertIsNotNone(transport.request_parameters)
        request_parameters = t.cast("Mapping[str, object]", transport.request_parameters)
        trace_context = request_parameters["traceContext"]
        self.assertIsInstance(trace_context, dict)
        self.assertRegex(
            t.cast("dict[str, str]", trace_context)["traceparent"],
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
                    result = json.loads(context.handlers[tool_name]({"requests": []}))
                    self.assertEqual(result["agent_id"], agent_id)
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(len(client.portal.calls), 8)
        self.assertTrue(
            all(
                call_client_identity is client.identity
                for _, call_client_identity, _, _ in client.portal.calls
            )
        )
        observed_agent_ids = [
            t.cast("dict[str, object]", trusted_context["principal"])["agentId"]
            for _, _, _, trusted_context in client.portal.calls
        ]
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
        )
        register(context)
        try:
            with self.assertRaisesRegex(HermesProfileAdmissionError, "explicit admitted profile"):
                context.handlers["tool_portal_list"]({"requests": []})
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(client.portal.calls, [])

    def test_preserves_the_immutable_projection_object_from_the_resolver(self) -> None:
        adapter, _client = build_adapter()
        context = FakeHermesPluginContext()
        projection = adapter.projection_for_profile("researcher")
        self.assertIsInstance(projection, MappingProxyType)
        observed_projection: list[CanonicalManagedAgentProjection] = []

        def resolve_projection() -> CanonicalManagedAgentProjection:
            observed_projection.append(projection)
            return projection

        configure_managed_tool_portal_plugin(
            adapter=adapter,
            current_projection=resolve_projection,
            telemetry=FakeToolOperationTelemetry(),
        )
        register(context)
        try:
            _ = context.handlers["tool_portal_list"]({"requests": []})
        finally:
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(observed_projection, [projection])
        self.assertIs(observed_projection[0], projection)


if __name__ == "__main__":
    unittest.main()
