import contextlib
import threading
import unittest
from collections.abc import Iterator, Mapping

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
    ManagedFrameworkIdentity,
)
from agent_vm_hermes_adapter.managed_tool_portal.cache import (
    CacheSnapshot,
    PluginStateCache,
    PopulationStarted,
    ReadyState,
)
from agent_vm_hermes_adapter.managed_tool_portal.hermes_hooks import (
    _PreLlmCallHook,
)
from agent_vm_hermes_adapter.managed_tool_portal.inventory import InventoryCoordinator
from agent_vm_hermes_adapter.managed_tool_portal.inventory_contracts import (
    InventoryListRequest,
    InventoryPortalListResult,
    InventoryProjection,
)
from agent_vm_hermes_adapter.managed_tool_portal.models import (
    ExhaustedState,
    InjectionCacheKey,
    InjectionMarker,
    InventoryCacheKey,
    InventoryReadyValue,
    NamespaceAvailability,
    NamespaceInventory,
    PopulationFailureClass,
    RenderedOrientation,
)


def _projection(*, agent_id: str = "agent-a") -> CanonicalManagedAgentProjection:
    return CanonicalManagedAgentProjection(
        agent_id=agent_id,
        framework_identity=ManagedFrameworkIdentity(kind="hermes", profile_name=agent_id),
        profile_assignment_revision=f"revision-{agent_id}",
        tool_portal_namespace_names=("filesystem", "github"),
        tool_portal_profile_id=f"portal-{agent_id}",
    )


def _inventory_projection(
    *,
    epoch: str = "epoch-a",
    selected_projection: CanonicalManagedAgentProjection | None = None,
) -> InventoryProjection:
    selected = _projection() if selected_projection is None else selected_projection
    return InventoryProjection(
        gateway_epoch=epoch,
        profile_assignment_revision=selected.profile_assignment_revision,
        agent_id=selected.agent_id,
        profile_name=selected.framework_identity.profile_name,
        tool_portal_profile_id=selected.tool_portal_profile_id,
        namespace_names=selected.tool_portal_namespace_names,
    )


def _ready_value() -> InventoryReadyValue:
    inventory = NamespaceInventory(
        inventory_id="inventory-a",
        namespaces=(
            NamespaceAvailability(namespace="filesystem", status="available"),
            NamespaceAvailability(namespace="github", status="unavailable"),
        ),
    )
    orientation = "Tool Portal orientation"
    return InventoryReadyValue(
        inventory=inventory,
        orientation=RenderedOrientation(
            inventory_id=inventory.inventory_id,
            orientation=orientation,
            utf8_byte_count=len(orientation.encode("utf-8")),
            displayed_count=2,
            total_count=2,
            omitted_count=0,
        ),
    )


class _Telemetry:
    max_inflight_observations = 0
    observer_hooks_enabled = False

    @contextlib.contextmanager
    def observe_tool_operation(self, tool_name: str) -> Iterator[None]:
        del tool_name
        yield

    def observe_post_tool_call(
        self,
        *,
        duration_milliseconds: object,
        status: object,
        tool_name: object,
    ) -> None:
        del duration_milliseconds, status, tool_name

    def trace_context_provider(self) -> Mapping[str, object] | None:
        return None

    def shutdown(self) -> None:
        return None

    def start_turn(self, record: TurnStartedRecord) -> object | None:
        del record
        return None

    def complete_turn(self, handle: object, record: TurnCompletedRecord) -> None:
        del handle, record

    def start_provider_attempt(
        self,
        parent_handle: object | None,
        record: ProviderAttemptStartedRecord,
    ) -> object | None:
        del parent_handle, record
        return None

    def complete_provider_attempt(
        self,
        handle: object,
        record: ProviderAttemptCompletedRecord,
    ) -> None:
        del handle, record

    def emit_tool_call(
        self,
        parent_handle: object | None,
        record: ToolCallRecord,
    ) -> None:
        del parent_handle, record


class _AdapterStub(HermesManagedAdapter):
    def __init__(self) -> None:
        pass


class _UnusedInventoryGateway:
    async def list_for_projection(
        self,
        projection: InventoryProjection,
        request: InventoryListRequest,
        *,
        timeout_seconds: float,
    ) -> InventoryPortalListResult:
        del projection, request, timeout_seconds
        raise AssertionError("hook tests must not start inventory I/O")


def _build_inventory_coordinator(
    *,
    epoch: str,
    selected_projection: CanonicalManagedAgentProjection,
    snapshot: CacheSnapshot[InventoryCacheKey, InventoryReadyValue],
) -> InventoryCoordinator:
    cache = PluginStateCache[InventoryCacheKey, InventoryReadyValue](
        key_model=InventoryCacheKey,
        value_model=InventoryReadyValue,
    )
    cache_key = _inventory_projection(
        epoch=epoch,
        selected_projection=selected_projection,
    ).cache_key()
    if isinstance(snapshot, (ReadyState, ExhaustedState)):
        population = cache.start_population(cache_key)
        if not isinstance(population, PopulationStarted):
            raise AssertionError("expected a fresh inventory population")
        if isinstance(snapshot, ReadyState):
            publication = cache.publish_ready(population.handle, snapshot.value)
        else:
            publication = cache.publish_exhausted(
                population.handle,
                snapshot.failure_class,
            )
        if not publication.accepted:
            raise AssertionError("expected inventory population publication to succeed")
    elif snapshot.kind != "unresolved":
        raise AssertionError(f"unsupported hook-test inventory state {snapshot.kind!r}")
    return InventoryCoordinator(
        cache=cache,
        gateway=_UnusedInventoryGateway(),
    )


class _Runtime:
    def __init__(
        self,
        *,
        epoch: str = "epoch-a",
        selected_projection: CanonicalManagedAgentProjection | None = None,
        inventory_snapshot: CacheSnapshot[InventoryCacheKey, InventoryReadyValue],
        injection_state_cache: PluginStateCache[InjectionCacheKey, InjectionMarker] | None = None,
    ) -> None:
        self.adapter = _AdapterStub()
        self.selected_projection = (
            _projection() if selected_projection is None else selected_projection
        )
        self.telemetry = _Telemetry()
        self.framework_observability = ManagedFrameworkObservability(
            sink=self.telemetry,
            max_inflight_observations=self.telemetry.max_inflight_observations,
        )
        self.inventory_coordinator = _build_inventory_coordinator(
            epoch=epoch,
            selected_projection=self.selected_projection,
            snapshot=inventory_snapshot,
        )
        self.injection_state_cache = injection_state_cache or PluginStateCache(
            key_model=InjectionCacheKey,
            value_model=InjectionMarker,
        )
        self.gateway_epoch = epoch

    def current_projection(self) -> CanonicalManagedAgentProjection:
        return self.selected_projection

    def replace_inventory_snapshot(
        self,
        snapshot: CacheSnapshot[InventoryCacheKey, InventoryReadyValue],
    ) -> None:
        self.inventory_coordinator.close()
        self.inventory_coordinator = _build_inventory_coordinator(
            epoch=self.gateway_epoch,
            selected_projection=self.selected_projection,
            snapshot=snapshot,
        )


def _call_hook(runtime: _Runtime, *, session_id: str = "session-a") -> dict[str, str] | None:
    return _PreLlmCallHook(runtime)(
        session_id=session_id,
        turn_id="turn-a",
        user_message={"private": "content is not inspected"},
    )


class ManagedToolPortalHermesHookBoundaryTests(unittest.TestCase):
    def test_ready_first_turn_returns_orientation_and_marks_exact_identity(self) -> None:
        runtime = _Runtime(inventory_snapshot=_ready_snapshot())

        first = _call_hook(runtime)
        second = _call_hook(runtime)

        self.assertEqual(first, {"context": "Tool Portal orientation"})
        self.assertIsNone(second)

    def test_unresolved_inventory_does_not_mark_and_later_ready_turn_can_inject(self) -> None:
        runtime = _Runtime(inventory_snapshot=_unresolved_snapshot())

        self.assertIsNone(_call_hook(runtime))
        runtime.replace_inventory_snapshot(_ready_snapshot())

        self.assertEqual(
            _call_hook(runtime),
            {"context": "Tool Portal orientation"},
        )

    def test_failed_inventory_does_not_mark_identity(self) -> None:
        runtime = _Runtime(
            inventory_snapshot=ExhaustedState(
                failure_class=PopulationFailureClass.INVALID_AUTHORITY,
                completed_at_monotonic=60.0,
            ),
        )

        self.assertIsNone(_call_hook(runtime))
        injection_key = InjectionCacheKey(
            gateway_epoch="epoch-a",
            profile_assignment_revision="revision-agent-a",
            agent_id="agent-a",
            profile_name="agent-a",
            tool_portal_profile_id="portal-agent-a",
            session_id="session-a",
        )
        self.assertEqual(
            runtime.injection_state_cache.read_snapshot(injection_key).kind,
            "unresolved",
        )

    def test_session_profile_and_epoch_identities_are_independent(self) -> None:
        shared_cache = PluginStateCache[InjectionCacheKey, InjectionMarker](
            key_model=InjectionCacheKey,
            value_model=InjectionMarker,
        )
        first_runtime = _Runtime(
            epoch="epoch-a",
            inventory_snapshot=_ready_snapshot(),
            injection_state_cache=shared_cache,
        )
        second_runtime = _Runtime(
            epoch="epoch-b",
            selected_projection=_projection(agent_id="agent-b"),
            inventory_snapshot=_ready_snapshot(),
            injection_state_cache=shared_cache,
        )

        self.assertIsNotNone(_call_hook(first_runtime, session_id="session-a"))
        self.assertIsNone(_call_hook(first_runtime, session_id="session-a"))
        self.assertIsNotNone(_call_hook(first_runtime, session_id="session-b"))
        self.assertIsNotNone(_call_hook(second_runtime, session_id="session-a"))

    def test_concurrent_first_turns_return_exactly_one_orientation(self) -> None:
        runtime = _Runtime(inventory_snapshot=_ready_snapshot())
        barrier = threading.Barrier(8)
        results: list[dict[str, str] | None] = []

        def call_once() -> None:
            barrier.wait()
            results.append(_call_hook(runtime))

        threads = [threading.Thread(target=call_once) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(
            sum(result is not None for result in results),
            1,
        )


def _ready_snapshot() -> CacheSnapshot[InventoryCacheKey, InventoryReadyValue]:
    store = PluginStateCache[InventoryCacheKey, InventoryReadyValue](
        key_model=InventoryCacheKey,
        value_model=InventoryReadyValue,
    )
    cache_key = _inventory_projection().cache_key()
    population = store.start_population(cache_key)
    if not isinstance(population, PopulationStarted):
        raise AssertionError("expected a fresh inventory population")
    publication = store.publish_ready(population.handle, _ready_value())
    if not publication.accepted:
        raise AssertionError("expected inventory population publication to succeed")
    return store.read_snapshot(cache_key)


def _unresolved_snapshot() -> CacheSnapshot[InventoryCacheKey, InventoryReadyValue]:
    store = PluginStateCache[InventoryCacheKey, InventoryReadyValue](
        key_model=InventoryCacheKey,
        value_model=InventoryReadyValue,
    )
    return store.read_snapshot(_inventory_projection().cache_key())


if __name__ == "__main__":
    unittest.main()
