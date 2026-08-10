import unittest

from pydantic import BaseModel, ConfigDict, ValidationError

from agent_vm_hermes_adapter.managed_tool_portal.cache import (
    CacheSnapshot,
    CacheTransitionError,
    EvictedState,
    EvictionReason,
    PluginStateCache,
    PopulatingState,
    PopulationAlreadyStarted,
    PopulationStarted,
    ReadyState,
    UnresolvedState,
)
from agent_vm_hermes_adapter.managed_tool_portal.models import (
    InventoryCacheKey,
    PopulationHandle,
)


class _InventoryValue(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    marker: str


def _require_started(
    result: PopulationStarted[InventoryCacheKey, _InventoryValue]
    | PopulationAlreadyStarted[InventoryCacheKey, _InventoryValue],
) -> PopulationStarted[InventoryCacheKey, _InventoryValue]:
    if not isinstance(result, PopulationStarted):
        raise AssertionError("expected a newly started population")
    return result


def _require_populating(
    snapshot: CacheSnapshot[InventoryCacheKey, _InventoryValue],
) -> PopulatingState:
    if not isinstance(snapshot, PopulatingState):
        raise AssertionError("expected a populating snapshot")
    return snapshot


def _require_ready(
    snapshot: CacheSnapshot[InventoryCacheKey, _InventoryValue],
) -> ReadyState[_InventoryValue]:
    if not isinstance(snapshot, ReadyState):
        raise AssertionError("expected a ready snapshot")
    return snapshot


def _inventory_key(epoch: str = "epoch-a") -> InventoryCacheKey:
    return InventoryCacheKey(
        gateway_epoch=epoch,
        profile_assignment_revision="revision-a",
        agent_id="agent-a",
        profile_name="profile-a",
        tool_portal_profile_id="portal-a",
    )


class ManagedToolPortalStateCacheTests(unittest.TestCase):
    def test_mark_if_absent_inserts_once_and_rejects_closed_cache(self) -> None:
        cache = PluginStateCache[InventoryCacheKey, _InventoryValue](
            key_model=InventoryCacheKey,
            value_model=_InventoryValue,
        )
        key = _inventory_key()

        first_mark = cache.mark_if_absent(key, _InventoryValue(marker="marked"))
        second_mark = cache.mark_if_absent(key, _InventoryValue(marker="duplicate"))
        self.assertTrue(first_mark.inserted)
        self.assertFalse(second_mark.inserted)
        self.assertEqual(_require_ready(cache.read_snapshot(key)).value.marker, "marked")

        cache.close(EvictionReason.RUNTIME_SHUTDOWN)
        closed_mark = cache.mark_if_absent(key, _InventoryValue(marker="closed"))

        self.assertFalse(closed_mark.inserted)
        self.assertIsInstance(cache.read_snapshot(key), EvictedState)

    def test_new_key_reads_unresolved_and_duplicate_population_is_single_flight(self) -> None:
        cache = PluginStateCache[InventoryCacheKey, _InventoryValue](
            key_model=InventoryCacheKey,
            value_model=_InventoryValue,
            monotonic_clock=lambda: 10.0,
        )
        key = _inventory_key()

        initial_snapshot = cache.read_snapshot(key)
        first_population = _require_started(cache.start_population(key))
        duplicate_population = cache.start_population(key)

        self.assertIsInstance(initial_snapshot, UnresolvedState)
        self.assertIsInstance(first_population, PopulationStarted)
        self.assertIsInstance(duplicate_population, PopulationAlreadyStarted)
        self.assertEqual(_require_populating(cache.read_snapshot(key)).attempt_number, 1)
        self.assertNotIn("terminal_future", PopulationStarted.model_fields)

        published = cache.publish_ready(
            first_population.handle,
            _InventoryValue(marker="ready"),
        )

        self.assertTrue(published.accepted)
        self.assertEqual(_require_ready(published.snapshot).value.marker, "ready")

    def test_generation_fence_rejects_late_publication_after_epoch_shutdown(self) -> None:
        cache = PluginStateCache[InventoryCacheKey, _InventoryValue](
            key_model=InventoryCacheKey,
            value_model=_InventoryValue,
            monotonic_clock=lambda: 10.0,
        )
        key = _inventory_key()
        first_population = _require_started(cache.start_population(key))
        close_records = cache.close(EvictionReason.RUNTIME_SHUTDOWN)

        stale_publication = cache.publish_ready(
            first_population.handle,
            _InventoryValue(marker="stale"),
        )

        self.assertFalse(stale_publication.accepted)
        self.assertIsInstance(stale_publication.snapshot, EvictedState)
        self.assertEqual(len(close_records), 1)
        self.assertEqual(close_records[0].reason, EvictionReason.RUNTIME_SHUTDOWN)

    def test_invalid_transition_does_not_mutate_state(self) -> None:
        cache = PluginStateCache[InventoryCacheKey, _InventoryValue](
            key_model=InventoryCacheKey,
            value_model=_InventoryValue,
        )
        key = _inventory_key()
        population = _require_started(cache.start_population(key))

        with self.assertRaises(CacheTransitionError):
            cache.set_population_attempt(population.handle, attempt_number=0)
        with self.assertRaises(CacheTransitionError):
            cache.set_population_attempt(
                PopulationHandle(key=key, generation=population.handle.generation + 1),
                attempt_number=2,
            )

        snapshot = _require_populating(cache.read_snapshot(key))
        self.assertEqual(snapshot.attempt_number, 1)

    def test_invalid_consumer_model_is_rejected_before_cache_publication(self) -> None:
        with self.assertRaises(ValidationError):
            _InventoryValue.model_validate({"marker": 1})

    def test_close_eviction_journal_is_typed_and_bounded(self) -> None:
        cache = PluginStateCache[InventoryCacheKey, _InventoryValue](
            key_model=InventoryCacheKey,
            value_model=_InventoryValue,
            monotonic_clock=lambda: 12.5,
            eviction_journal_limit=2,
        )
        first_key = _inventory_key("epoch-a")
        second_key = _inventory_key("epoch-b")
        first_population = _require_started(cache.start_population(first_key))
        cache.publish_ready(first_population.handle, _InventoryValue(marker="first"))
        second_population = _require_started(cache.start_population(second_key))
        cache.publish_ready(second_population.handle, _InventoryValue(marker="second"))
        third_key = _inventory_key("epoch-c")
        third_population = _require_started(cache.start_population(third_key))
        cache.publish_ready(third_population.handle, _InventoryValue(marker="third"))

        close_records = cache.close(EvictionReason.RUNTIME_SHUTDOWN)
        journal = cache.eviction_journal()

        self.assertEqual(len(close_records), 3)
        self.assertEqual(len(journal), 2)
        self.assertTrue(
            all(record.reason == EvictionReason.RUNTIME_SHUTDOWN for record in journal),
        )
        self.assertTrue(all(record.sequence_number > 0 for record in journal))
        self.assertIsInstance(cache.read_snapshot(first_key), EvictedState)
        self.assertIsInstance(cache.read_snapshot(second_key), EvictedState)
        self.assertIsInstance(cache.read_snapshot(third_key), EvictedState)
        self.assertEqual(cache.close(EvictionReason.RUNTIME_SHUTDOWN), ())

    def test_invalid_key_model_is_rejected_before_cache_state(self) -> None:
        with self.assertRaises(ValidationError):
            InventoryCacheKey.model_validate(
                {
                    "gateway_epoch": "epoch-a",
                    "profile_assignment_revision": "revision-a",
                }
            )
