import importlib.metadata
import json
import typing as t
import unittest
from collections.abc import Callable, Mapping
from types import MappingProxyType
from unittest.mock import patch

from agent_vm_agent_portal_sdk.contracts import get_portable_contract_json_schema
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from hermes_cli.tools_config import _get_platform_tools
from pydantic import BaseModel
from tools.registry import registry as hermes_tool_registry

from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesManagedAdapterConfig,
    HermesProfileAdmissionError,
)
from agent_vm_hermes_adapter.managed_tool_portal_capability_tools import (
    MANAGED_TOOL_PORTAL_PLUGIN_NAME,
    MANAGED_TOOL_PORTAL_TOOL_NAMES,
    clear_managed_tool_portal_plugin_configuration,
    configure_managed_tool_portal_plugin,
    register,
)

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
) -> None:
    configure_managed_tool_portal_plugin(
        adapter=adapter,
        current_projection=lambda: current_projection[0],
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
