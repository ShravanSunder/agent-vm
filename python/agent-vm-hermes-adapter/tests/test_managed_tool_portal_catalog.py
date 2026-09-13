import asyncio
import base64
import concurrent.futures
import hashlib
import json
import threading
import typing as t
import unittest
from collections.abc import Mapping

from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import BaseModel, ConfigDict

from agent_vm_hermes_adapter.managed_framework_observability import ManagedFrameworkObservability
from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesManagedAdapterConfig,
    ManagedFrameworkIdentity,
)
from agent_vm_hermes_adapter.managed_tool_portal.cache import PluginStateCache, PopulationStarted
from agent_vm_hermes_adapter.managed_tool_portal.catalog import (
    ManagedCatalogCoordinator,
    ManagedCatalogPreparationError,
    ManagedCatalogTurnBindings,
    PreparedCatalogManifest,
)
from agent_vm_hermes_adapter.managed_tool_portal.hermes_hooks import (
    _OnSessionEndHook,
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
    InventoryCacheKey,
    InventoryReadyValue,
    NamespaceAvailability,
    NamespaceDiscovery,
    NamespaceInventory,
    RenderedOrientation,
)
from agent_vm_hermes_adapter.managed_tool_portal_capability_tools import (
    _ManagedToolPortalPluginRuntime,
)
from agent_vm_hermes_adapter.managed_tool_portal_observability import (
    create_hermes_tool_portal_telemetry_from_environment,
)


class PortableResult(BaseModel):
    model_config = ConfigDict(extra="allow")


def required_mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise AssertionError("expected mapping")
    return value


def required_string(value: object) -> str:
    if not isinstance(value, str):
        raise AssertionError("expected string")
    return value


def optional_string(value: object) -> str | None:
    if value is not None and not isinstance(value, str):
        raise AssertionError("expected optional string")
    return value


def projection(
    agent_id: str, *, mode: t.Literal["compact", "catalog"]
) -> CanonicalManagedAgentProjection:
    return CanonicalManagedAgentProjection(
        agent_id=agent_id,
        framework_identity=ManagedFrameworkIdentity(kind="hermes", profile_name=agent_id),
        tool_portal_catalog_mode=mode,
        profile_assignment_revision=f"revision-{agent_id}",
        tool_portal_namespaces=(NamespaceDiscovery(namespace="shared"),),
        tool_portal_profile_id=f"policy-{agent_id}",
    )


def manifest(fingerprint_character: str) -> PreparedCatalogManifest:
    fingerprint = fingerprint_character * 64
    return PreparedCatalogManifest.model_validate(
        {
            "definitionFingerprint": fingerprint,
            "bundleSha256": f"sha256:{fingerprint}",
            "bundleByteLength": 123,
            "files": [
                {
                    "byteLength": 87,
                    "namespace": "shared",
                    "path": "shared-a1b2c3d4.ts",
                    "sha256": "c" * 64,
                }
            ],
            "generatorVersion": "2",
            "namespaces": [
                {
                    "namespace": "shared",
                    "modulePath": "shared-a1b2c3d4.ts",
                    "exportedFactoryName": "bindSharedTools",
                }
            ],
            "sdkContractVersion": "1",
        }
    )


class FakeCatalogOperations:
    def __init__(self, manifests: Mapping[str, PreparedCatalogManifest]) -> None:
        self._manifests = dict(manifests)
        self._tools_by_agent: Mapping[str, tuple[str, ...]] = {}
        self._prepared: dict[tuple[str, str], tuple[PreparedCatalogManifest, bytes]] = {}
        self._offered_content: dict[str, bytes] = {}
        self.events: list[str] = []
        self.offers: list[tuple[str, str | None, str | None, str]] = []
        self.releases: list[tuple[str, str | None, str | None, str]] = []
        self.release_error: Exception | None = None
        self.turn_offer_barrier: threading.Barrier | None = None

    def set_tools(self, tools_by_agent: Mapping[str, tuple[str, ...]]) -> None:
        self._tools_by_agent = tools_by_agent

    def _snapshot(self, agent_id: str, fingerprint: str) -> tuple[PreparedCatalogManifest, bytes]:
        key = (agent_id, fingerprint)
        existing = self._prepared.get(key)
        if existing is not None:
            return existing
        native_tools = [
            {
                "description": f"Call {tool_name}",
                "inputSchema": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                },
                "namespace": "shared",
                "registeredName": f"shared__{tool_name}",
                "toolName": tool_name,
            }
            for tool_name in sorted(self._tools_by_agent.get(agent_id, ()))
        ]
        content = json.dumps(
            {
                "definitionFingerprint": fingerprint,
                "files": [],
                "manifest": {
                    "definitionFingerprint": fingerprint,
                    "generatorVersion": "2",
                    "namespaces": [],
                    "sdkContractVersion": "1",
                    "tools": [],
                },
                "nativeTools": native_tools,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        selected = PreparedCatalogManifest.model_validate(
            {
                "definitionFingerprint": fingerprint,
                "bundleSha256": f"sha256:{hashlib.sha256(content).hexdigest()}",
                "bundleByteLength": len(content),
                "files": [],
                "generatorVersion": "2",
                "namespaces": [],
                "sdkContractVersion": "1",
            }
        )
        snapshot = (selected, content)
        self._prepared[key] = snapshot
        return snapshot

    @staticmethod
    def _identity(trusted_context: Mapping[str, object]) -> tuple[str, str | None, str | None]:
        principal = required_mapping(trusted_context["principal"])
        correlation = required_mapping(trusted_context.get("correlation", {}))
        return (
            required_string(principal["agentId"]),
            optional_string(correlation.get("sessionId")),
            optional_string(correlation.get("turnId")),
        )

    async def prepare(
        self, request: Mapping[str, object], *, trusted_context: Mapping[str, object]
    ) -> BaseModel:
        del request
        self.events.append("prepare")
        agent_id, _session_id, _turn_id = self._identity(trusted_context)
        selected = self._manifests.get(agent_id)
        if selected is None:
            return PortableResult.model_validate(
                {"kind": "incomplete", "reason": "catalog-incomplete", "diagnostics": []}
            )
        prepared_manifest, _content = self._snapshot(agent_id, selected.definition_fingerprint)
        return PortableResult.model_validate(
            {
                "kind": "complete",
                "cacheDisposition": "prepared",
                "manifest": prepared_manifest.model_dump(by_alias=True),
            }
        )

    async def offer(
        self, request: Mapping[str, object], *, trusted_context: Mapping[str, object]
    ) -> BaseModel:
        agent_id, session_id, turn_id = self._identity(trusted_context)
        self.events.append("offer")
        if session_id is not None and self.turn_offer_barrier is not None:
            self.turn_offer_barrier.wait()
        fingerprint = required_string(request["definitionFingerprint"])
        self.offers.append((agent_id, session_id, turn_id, fingerprint))
        selected, content = self._snapshot(agent_id, fingerprint)
        offer_id = f"offer-{agent_id}-{session_id or 'startup'}-{turn_id or 'startup'}"
        self._offered_content[offer_id] = content
        return PortableResult.model_validate(
            {
                "kind": "offered",
                "offerId": offer_id,
                "manifest": selected.model_dump(by_alias=True),
            }
        )

    async def read(
        self, request: Mapping[str, object], *, trusted_context: Mapping[str, object]
    ) -> BaseModel:
        del trusted_context
        self.events.append("read")
        offer_id = required_string(request["offerId"])
        content = self._offered_content[offer_id]
        offset = request["offset"]
        length = request["length"]
        assert isinstance(offset, int) and isinstance(length, int)
        chunk = content[offset : offset + length]
        return PortableResult.model_validate(
            {
                "kind": "content",
                "byteLength": len(chunk),
                "contentBase64": base64.b64encode(chunk).decode(),
                "eof": offset + len(chunk) == len(content),
                "totalLength": len(content),
            }
        )

    async def release(
        self, request: Mapping[str, object], *, trusted_context: Mapping[str, object]
    ) -> BaseModel:
        agent_id, session_id, turn_id = self._identity(trusted_context)
        self.events.append("release")
        self.releases.append(
            (agent_id, session_id, turn_id, required_string(request["definitionFingerprint"]))
        )
        if self.release_error is not None:
            raise self.release_error
        return PortableResult.model_validate({"kind": "released"})


class RejectingPortalOperations:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def list(
        self, request: Mapping[str, object], *, trusted_context: Mapping[str, object]
    ) -> BaseModel:
        del request, trusted_context
        self.calls.append("list")
        raise AssertionError("Managed startup must not perform a second Portal list.")

    async def describe(
        self, request: Mapping[str, object], *, trusted_context: Mapping[str, object]
    ) -> BaseModel:
        del request, trusted_context
        self.calls.append("describe")
        raise AssertionError("Managed startup must not perform a second Portal describe.")


class UnusedInventoryGateway:
    async def list_for_projection(
        self,
        projection: InventoryProjection,
        request: InventoryListRequest,
        *,
        timeout_seconds: float,
    ) -> InventoryPortalListResult:
        del projection, request, timeout_seconds
        raise AssertionError("catalog hook tests must not start inventory I/O")


class FakeClient(GatewayRuntimeClient):
    def __init__(
        self,
        *,
        catalogs: FakeCatalogOperations,
        tools_by_agent: Mapping[str, tuple[str, ...]],
    ) -> None:
        catalogs.set_tools(tools_by_agent)
        self.catalog = catalogs
        self.recorded_portal = RejectingPortalOperations()
        self.portal = self.recorded_portal


class FakeAdapter:
    def __init__(
        self, profiles: tuple[CanonicalManagedAgentProjection, ...], client: FakeClient
    ) -> None:
        self.profiles = profiles
        self._client = client

    def gateway_runtime_client_for_profile(self, profile_name: str) -> GatewayRuntimeClient:
        if profile_name not in {
            projection.framework_identity.profile_name for projection in self.profiles
        }:
            raise AssertionError("unadmitted profile")
        return self._client

    def run_gateway_runtime_coroutine[TResult](
        self, coroutine: t.Coroutine[object, object, TResult], *, timeout: float | None = None
    ) -> TResult:
        del timeout
        return asyncio.run(coroutine)


@t.final
class ManagedCatalogCoordinatorTests(unittest.TestCase):
    def test_outer_turn_end_releases_binding_without_reinjecting_session_guidance(self) -> None:
        profile = projection("researcher", mode="catalog")
        catalogs = FakeCatalogOperations({"researcher": manifest("a")})
        adapter = HermesManagedAdapter(
            config=HermesManagedAdapterConfig(
                profiles=(profile,),
                projection_cohort_digest=(
                    "projection-cohort:"
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                ),
                protected_hermes_home="/var/lib/agent-vm/hermes",
            ),
            gateway_runtime_client=FakeClient(
                catalogs=catalogs,
                tools_by_agent={"researcher": ("overlap",)},
            ),
        )
        catalog_coordinator = ManagedCatalogCoordinator(adapter=adapter)
        asyncio.run(catalog_coordinator.prepare_all())
        bindings = ManagedCatalogTurnBindings(adapter=adapter, catalogs=catalog_coordinator)
        inventory = NamespaceInventory(
            inventory_id="inventory-a",
            namespaces=(NamespaceAvailability(namespace="shared", status="available"),),
        )
        orientation = "Tool Portal orientation"
        inventory_cache = PluginStateCache[InventoryCacheKey, InventoryReadyValue](
            key_model=InventoryCacheKey,
            value_model=InventoryReadyValue,
        )
        inventory_projection = InventoryProjection(
            gateway_epoch="epoch-a",
            profile_assignment_revision=profile.profile_assignment_revision,
            agent_id=profile.agent_id,
            profile_name=profile.framework_identity.profile_name,
            tool_portal_profile_id=profile.tool_portal_profile_id,
            namespaces=profile.tool_portal_namespaces,
        )
        population = inventory_cache.start_population(inventory_projection.cache_key())
        self.assertIsInstance(population, PopulationStarted)
        assert isinstance(population, PopulationStarted)
        publication = inventory_cache.publish_ready(
            population.handle,
            InventoryReadyValue(
                inventory=inventory,
                orientation=RenderedOrientation(
                    inventory_id=inventory.inventory_id,
                    orientation=orientation,
                    utf8_byte_count=len(orientation.encode("utf-8")),
                    displayed_count=1,
                    total_count=1,
                    omitted_count=0,
                ),
            ),
        )
        self.assertTrue(publication.accepted)
        telemetry = create_hermes_tool_portal_telemetry_from_environment()
        runtime = _ManagedToolPortalPluginRuntime(
            adapter=adapter,
            current_projection=lambda: profile,
            framework_observability=ManagedFrameworkObservability(
                sink=telemetry,
                max_inflight_observations=telemetry.max_inflight_observations,
            ),
            telemetry=telemetry,
            inventory_coordinator=InventoryCoordinator(
                cache=inventory_cache,
                gateway=UnusedInventoryGateway(),
            ),
            injection_state_cache=PluginStateCache[InjectionCacheKey, InjectionMarker](
                key_model=InjectionCacheKey,
                value_model=InjectionMarker,
            ),
            gateway_epoch="epoch-a",
            catalog_coordinator=catalog_coordinator,
            catalog_turn_bindings=bindings,
        )
        pre_llm_call = _PreLlmCallHook(runtime)
        on_session_end = _OnSessionEndHook(runtime)

        first_turn = pre_llm_call(session_id="session-1", turn_id="turn-1")
        on_session_end(
            session_id="session-1",
            turn_id="turn-1",
            completed=True,
            interrupted=False,
        )
        second_turn = pre_llm_call(session_id="session-1", turn_id="turn-2")

        self.assertIsNotNone(first_turn)
        self.assertIsNone(second_turn)
        self.assertEqual(
            [(offer[1], offer[2]) for offer in catalogs.offers if offer[1] is not None],
            [("session-1", "turn-1"), ("session-1", "turn-2")],
        )
        second_binding = bindings.acquire(profile, session_id="session-1", turn_id="turn-2")
        self.assertIsNotNone(second_binding)
        assert second_binding is not None
        bindings.release_invocation(profile, second_binding)
        bindings.close_session(profile, "session-1")
        adapter.close(disconnect_gateway_runtime=False)

    def test_real_adapter_prepares_compact_and_catalog_profiles_through_admitted_accessor(
        self,
    ) -> None:
        profiles = (
            projection("compact-agent", mode="compact"),
            projection("catalog-agent", mode="catalog"),
        )
        catalogs = FakeCatalogOperations(
            {"compact-agent": manifest("a"), "catalog-agent": manifest("b")}
        )
        client = FakeClient(
            catalogs=catalogs,
            tools_by_agent={"compact-agent": ("compact-tool",), "catalog-agent": ()},
        )
        adapter = HermesManagedAdapter(
            config=HermesManagedAdapterConfig(
                profiles=profiles,
                projection_cohort_digest=(
                    "projection-cohort:"
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                ),
                protected_hermes_home="/var/lib/agent-vm/hermes",
            ),
            gateway_runtime_client=client,
        )
        coordinator = ManagedCatalogCoordinator(adapter=adapter)

        asyncio.run(coordinator.prepare_all())

        self.assertIsNotNone(coordinator.read_profile("compact-agent"))
        self.assertIsNotNone(coordinator.read_profile("catalog-agent"))
        self.assertEqual(catalogs.events, ["prepare", "offer", "read", "release"] * 2)
        self.assertEqual(client.recorded_portal.calls, [])

    def test_manifest_requires_the_complete_canonical_shape_and_rejects_schema_drift(
        self,
    ) -> None:
        complete = manifest("a").model_dump(by_alias=True, mode="json")
        missing_files = dict(complete)
        del missing_files["files"]
        with self.assertRaisesRegex(ValueError, "files"):
            PreparedCatalogManifest.model_validate(missing_files)

        unknown_field = {**complete, "futureUnreviewedField": True}
        with self.assertRaisesRegex(ValueError, "futureUnreviewedField"):
            PreparedCatalogManifest.model_validate(unknown_field)

        mismatched_module = dict(complete)
        mismatched_module["namespaces"] = [
            {
                "namespace": "shared",
                "modulePath": "missing.ts",
                "exportedFactoryName": "bindSharedTools",
            }
        ]
        with self.assertRaisesRegex(ValueError, "module path"):
            PreparedCatalogManifest.model_validate(mismatched_module)

    def test_prepares_profile_local_overlapping_tools_and_keeps_hidden_names_absent(self) -> None:
        profiles = (
            projection("researcher", mode="catalog"),
            projection("reviewer", mode="compact"),
        )
        catalogs = FakeCatalogOperations({"researcher": manifest("a"), "reviewer": manifest("b")})
        adapter = FakeAdapter(
            profiles,
            FakeClient(
                catalogs=catalogs,
                tools_by_agent={
                    "researcher": ("overlap", "research-only"),
                    "reviewer": ("overlap", "review-only"),
                },
            ),
        )
        coordinator = ManagedCatalogCoordinator(adapter=adapter)

        asyncio.run(coordinator.prepare_all())

        researcher = coordinator.read_profile("researcher")
        reviewer = coordinator.read_profile("reviewer")
        assert researcher is not None and reviewer is not None
        self.assertEqual(
            {(tool.namespace, tool.tool_name) for tool in researcher.native_tools},
            {("shared", "overlap"), ("shared", "research-only")},
        )
        self.assertNotIn("review-only", {tool.tool_name for tool in researcher.native_tools})
        self.assertEqual(len({tool.registered_name for tool in researcher.native_tools}), 2)
        self.assertEqual(adapter._client.recorded_portal.calls, [])

    def test_catalog_mode_refuses_incomplete_preparation_while_compact_can_fall_back(self) -> None:
        compact = projection("compact-agent", mode="compact")
        compact_adapter = FakeAdapter(
            (compact,),
            FakeClient(catalogs=FakeCatalogOperations({}), tools_by_agent={"compact-agent": ()}),
        )
        asyncio.run(ManagedCatalogCoordinator(adapter=compact_adapter).prepare_all())

        catalog = projection("catalog-agent", mode="catalog")
        catalog_adapter = FakeAdapter(
            (catalog,),
            FakeClient(catalogs=FakeCatalogOperations({}), tools_by_agent={"catalog-agent": ()}),
        )
        with self.assertRaisesRegex(ManagedCatalogPreparationError, "catalog-agent"):
            asyncio.run(ManagedCatalogCoordinator(adapter=catalog_adapter).prepare_all())

    def test_gateway_lifetime_keeps_f1_and_restart_prepares_f2(self) -> None:
        profile = projection("researcher", mode="compact")
        catalogs = FakeCatalogOperations({"researcher": manifest("a")})
        adapter = FakeAdapter(
            (profile,),
            FakeClient(catalogs=catalogs, tools_by_agent={"researcher": ("overlap",)}),
        )
        coordinator = ManagedCatalogCoordinator(adapter=adapter)
        asyncio.run(coordinator.prepare_all())
        bindings = ManagedCatalogTurnBindings(adapter=adapter, catalogs=coordinator)

        first, first_changed = bindings.offer_for_turn(
            profile, session_id="session-1", turn_id="turn-1"
        )
        assert first is not None
        self.assertTrue(first_changed)
        acquired_first = bindings.acquire(profile, session_id="session-1", turn_id="turn-1")
        self.assertIs(acquired_first, first)

        catalogs._manifests["researcher"] = manifest("b")
        second, second_changed = bindings.offer_for_turn(
            profile, session_id="session-1", turn_id="turn-2"
        )
        assert second is not None
        self.assertFalse(second_changed)
        self.assertEqual(first.source.identity.definition_fingerprint, "a" * 64)
        self.assertEqual(second.source.identity.definition_fingerprint, "a" * 64)
        self.assertEqual(
            catalogs.releases,
            [("researcher", None, None, "a" * 64)],
        )
        prepared_before_restart = coordinator.read_profile("researcher")
        assert prepared_before_restart is not None
        self.assertEqual(
            [tool.tool_name for tool in prepared_before_restart.native_tools],
            ["overlap"],
        )

        bindings.release_invocation(profile, first)
        self.assertEqual(
            catalogs.releases[-1],
            ("researcher", "session-1", "turn-1", "a" * 64),
        )
        bindings.close_session(profile, "session-1")
        self.assertEqual(
            catalogs.releases[-1],
            ("researcher", "session-1", "turn-2", "a" * 64),
        )

        restarted_coordinator = ManagedCatalogCoordinator(adapter=adapter)
        catalogs.set_tools({"researcher": ("changed-after-restart",)})
        asyncio.run(restarted_coordinator.prepare_all())
        restarted = restarted_coordinator.read_profile("researcher")
        assert restarted is not None
        self.assertEqual(restarted.manifest.definition_fingerprint, "b" * 64)
        self.assertEqual(
            [tool.tool_name for tool in restarted.native_tools],
            ["changed-after-restart"],
        )
        restarted_bindings = ManagedCatalogTurnBindings(
            adapter=adapter, catalogs=restarted_coordinator
        )
        after_restart, after_restart_changed = restarted_bindings.offer_for_turn(
            profile, session_id="session-1", turn_id="turn-3"
        )
        assert after_restart is not None
        self.assertTrue(after_restart_changed)
        self.assertEqual(after_restart.source.identity.definition_fingerprint, "b" * 64)
        restarted_bindings.close_session(profile, "session-1")

    def test_completed_turn_bindings_are_reclaimed_while_active_turns_remain_retained(
        self,
    ) -> None:
        profile = projection("researcher", mode="compact")
        catalogs = FakeCatalogOperations({"researcher": manifest("a")})
        adapter = FakeAdapter(
            (profile,),
            FakeClient(catalogs=catalogs, tools_by_agent={"researcher": ("overlap",)}),
        )
        coordinator = ManagedCatalogCoordinator(adapter=adapter)
        asyncio.run(coordinator.prepare_all())
        bindings = ManagedCatalogTurnBindings(adapter=adapter, catalogs=coordinator)

        active, _changed = bindings.offer_for_turn(
            profile, session_id="session-1", turn_id="turn-active"
        )
        assert active is not None
        self.assertIs(
            bindings.acquire(profile, session_id="session-1", turn_id="turn-active"), active
        )

        current, _changed = bindings.offer_for_turn(
            profile, session_id="session-1", turn_id="turn-0"
        )
        assert current is not None
        self.assertEqual(len(bindings._bindings), 2)
        for turn_number in range(1, 100):
            current, _changed = bindings.offer_for_turn(
                profile, session_id="session-1", turn_id=f"turn-{turn_number}"
            )
            assert current is not None
            self.assertEqual(len(bindings._bindings), 2)

        bindings.release_invocation(profile, active)
        self.assertEqual(len(bindings._bindings), 1)
        self.assertIs(bindings.acquire(profile, session_id="session-1", turn_id="turn-99"), current)
        bindings.release_invocation(profile, current)
        bindings.close_session(profile, "session-1")
        self.assertEqual(bindings._bindings, {})

    def test_release_failure_propagates_after_local_binding_and_session_marker_cleanup(
        self,
    ) -> None:
        profile = projection("researcher", mode="compact")
        catalogs = FakeCatalogOperations({"researcher": manifest("a")})
        adapter = FakeAdapter(
            (profile,),
            FakeClient(catalogs=catalogs, tools_by_agent={"researcher": ("overlap",)}),
        )
        coordinator = ManagedCatalogCoordinator(adapter=adapter)
        asyncio.run(coordinator.prepare_all())
        bindings = ManagedCatalogTurnBindings(adapter=adapter, catalogs=coordinator)

        offered, changed = bindings.offer_for_turn(
            profile, session_id="session-1", turn_id="turn-1"
        )
        assert offered is not None
        self.assertTrue(changed)
        catalogs.release_error = RuntimeError("release failed")

        with self.assertRaisesRegex(RuntimeError, "release failed"):
            bindings.close_session(profile, "session-1")

        self.assertEqual(bindings._bindings, {})
        catalogs.release_error = None
        replacement, replacement_changed = bindings.offer_for_turn(
            profile, session_id="session-1", turn_id="turn-1"
        )
        assert replacement is not None
        self.assertIsNot(replacement, offered)
        self.assertTrue(replacement_changed)
        bindings.close_session(profile, "session-1")

    def test_concurrent_duplicate_release_does_not_remove_the_installed_binding(self) -> None:
        profile = projection("researcher", mode="compact")
        catalogs = FakeCatalogOperations({"researcher": manifest("a")})
        adapter = FakeAdapter(
            (profile,),
            FakeClient(catalogs=catalogs, tools_by_agent={"researcher": ("overlap",)}),
        )
        coordinator = ManagedCatalogCoordinator(adapter=adapter)
        asyncio.run(coordinator.prepare_all())
        bindings = ManagedCatalogTurnBindings(adapter=adapter, catalogs=coordinator)
        catalogs.turn_offer_barrier = threading.Barrier(2)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            first_future = executor.submit(
                bindings.offer_for_turn,
                profile,
                session_id="session-1",
                turn_id="turn-1",
            )
            second_future = executor.submit(
                bindings.offer_for_turn,
                profile,
                session_id="session-1",
                turn_id="turn-1",
            )
            first, _first_changed = first_future.result()
            second, _second_changed = second_future.result()

        assert first is not None and second is not None
        self.assertIs(first, second)
        self.assertEqual(len(bindings._bindings), 1)
        acquired = bindings.acquire(profile, session_id="session-1", turn_id="turn-1")
        self.assertIs(acquired, first)
        bindings.release_invocation(profile, first)
        bindings.close_session(profile, "session-1")


if __name__ == "__main__":
    unittest.main()
