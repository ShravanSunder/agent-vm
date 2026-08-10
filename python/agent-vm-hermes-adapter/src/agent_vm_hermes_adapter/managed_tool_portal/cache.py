"""Generic, process-local typed state cache for managed Tool Portal state."""

import threading
import time
import typing as t
from collections import deque

from pydantic import BaseModel, ConfigDict

from .models import (
    EvictedState,
    EvictionReason,
    EvictionRecord,
    ExhaustedState,
    PopulatingState,
    PopulationFailureClass,
    PopulationHandle,
    ReadyState,
    UnresolvedState,
)


class MonotonicClock(t.Protocol):
    """Clock seam used by deterministic cache tests."""

    def __call__(self) -> float: ...


type CacheSnapshot[TKey: BaseModel, TValue: BaseModel] = (
    UnresolvedState | PopulatingState | ReadyState[TValue] | ExhaustedState | EvictedState[TKey]
)


class _ResultModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class CacheTransitionError(RuntimeError):
    """A generation or state transition was not valid for the cache entry."""


class CacheClosedError(RuntimeError):
    """The process-local cache has already been closed."""


class PopulationStarted[TKey: BaseModel, TValue: BaseModel](_ResultModel):
    """The caller owns a newly started population generation."""

    handle: PopulationHandle[TKey]


class PopulationAlreadyStarted[TKey: BaseModel, TValue: BaseModel](_ResultModel):
    """A duplicate start observes state but does not join the owner's work."""

    snapshot: CacheSnapshot[TKey, TValue]


class TransitionResult[TKey: BaseModel, TValue: BaseModel](_ResultModel):
    """Result of an accepted cache transition."""

    accepted: bool
    snapshot: CacheSnapshot[TKey, TValue]


class PublicationResult[TKey: BaseModel, TValue: BaseModel](_ResultModel):
    """Result of an attempted generation-fenced terminal publication."""

    accepted: bool
    snapshot: CacheSnapshot[TKey, TValue]


class MarkInserted(_ResultModel):
    """The atomic mark created a new ready entry."""

    kind: t.Literal["inserted"] = "inserted"
    inserted: t.Literal[True] = True


class MarkAlreadyPresent(_ResultModel):
    """The atomic mark observed an existing entry."""

    kind: t.Literal["already-present"] = "already-present"
    inserted: t.Literal[False] = False


class MarkClosed(_ResultModel):
    """The cache was closed before an atomic mark could be created."""

    kind: t.Literal["closed"] = "closed"
    inserted: t.Literal[False] = False


type MarkIfAbsentResult = MarkInserted | MarkAlreadyPresent | MarkClosed


class _CacheEntry[TKey: BaseModel, TValue: BaseModel]:
    __slots__ = ("generation", "snapshot")

    def __init__(
        self,
        *,
        generation: int,
        snapshot: CacheSnapshot[TKey, TValue],
    ) -> None:
        self.generation = generation
        self.snapshot = snapshot


@t.final
class PluginStateCache[TKey: BaseModel, TValue: BaseModel]:
    """Atomic keyed state with generation fencing and bounded eviction evidence."""

    def __init__(
        self,
        *,
        key_model: type[TKey],
        value_model: type[TValue],
        monotonic_clock: MonotonicClock | None = None,
        eviction_journal_limit: int = 256,
    ) -> None:
        if eviction_journal_limit < 1:
            raise ValueError("eviction_journal_limit must be positive")
        self._key_model = key_model
        self._value_model = value_model
        self._clock = monotonic_clock or time.monotonic
        self._entries: dict[TKey, _CacheEntry[TKey, TValue]] = {}
        self._journal: deque[EvictionRecord[TKey]] = deque(maxlen=eviction_journal_limit)
        self._sequence_number = 0
        self._lock = threading.RLock()
        self._closed = False

    def _validate_key(self, key: TKey) -> None:
        if not isinstance(key, self._key_model):
            raise TypeError(f"cache key must be {self._key_model.__name__}")

    def _validate_value(self, value: TValue) -> None:
        if not isinstance(value, self._value_model):
            raise TypeError(f"cache value must be {self._value_model.__name__}")

    def _require_open(self) -> None:
        if self._closed:
            raise CacheClosedError("plugin state cache is closed")

    def _record_eviction(self, key: TKey, reason: EvictionReason) -> EvictionRecord[TKey]:
        self._sequence_number += 1
        record = EvictionRecord(
            key=key,
            reason=reason,
            sequence_number=self._sequence_number,
            evicted_at_monotonic=self._clock(),
        )
        self._journal.append(record)
        return record

    def _current_snapshot(self, key: TKey) -> CacheSnapshot[TKey, TValue]:
        entry = self._entries.get(key)
        if entry is None:
            return UnresolvedState()
        return entry.snapshot

    def read_snapshot(self, key: TKey) -> CacheSnapshot[TKey, TValue]:
        """Read one validated snapshot without waiting or starting work."""
        self._validate_key(key)
        with self._lock:
            return self._current_snapshot(key)

    def start_population(
        self,
        key: TKey,
    ) -> PopulationStarted[TKey, TValue] | PopulationAlreadyStarted[TKey, TValue]:
        """Start one generation, or return a snapshot without joining existing work."""
        self._validate_key(key)
        with self._lock:
            self._require_open()
            existing_entry = self._entries.get(key)
            if existing_entry is not None and not isinstance(
                existing_entry.snapshot,
                (UnresolvedState, EvictedState),
            ):
                return PopulationAlreadyStarted(snapshot=existing_entry.snapshot)
            generation = 1 if existing_entry is None else existing_entry.generation + 1
            started_at = self._clock()
            handle = PopulationHandle(key=key, generation=generation)
            snapshot = PopulatingState(
                attempt_number=1,
                started_at_monotonic=started_at,
            )
            self._entries[key] = _CacheEntry(
                generation=generation,
                snapshot=snapshot,
            )
            return PopulationStarted(handle=handle)

    def _require_active_population(
        self,
        handle: PopulationHandle[TKey],
    ) -> _CacheEntry[TKey, TValue]:
        self._validate_key(handle.key)
        entry = self._entries.get(handle.key)
        if entry is None or entry.generation != handle.generation:
            raise CacheTransitionError("population handle is stale")
        if not isinstance(entry.snapshot, PopulatingState):
            raise CacheTransitionError("population generation is not populating")
        return entry

    def set_population_attempt(
        self,
        handle: PopulationHandle[TKey],
        *,
        attempt_number: int,
    ) -> TransitionResult[TKey, TValue]:
        """Advance an active generation to a strictly newer attempt."""
        if attempt_number < 1:
            raise CacheTransitionError("population attempt number must be positive")
        with self._lock:
            entry = self._require_active_population(handle)
            population_snapshot = entry.snapshot
            if not isinstance(population_snapshot, PopulatingState):
                raise CacheTransitionError("population generation is not populating")
            if attempt_number <= population_snapshot.attempt_number:
                raise CacheTransitionError("population attempt must advance monotonically")
            entry.snapshot = PopulatingState(
                attempt_number=attempt_number,
                started_at_monotonic=population_snapshot.started_at_monotonic,
            )
            return TransitionResult(accepted=True, snapshot=entry.snapshot)

    def publish_ready(
        self,
        handle: PopulationHandle[TKey],
        value: TValue,
    ) -> PublicationResult[TKey, TValue]:
        """Publish a ready value if the handle still owns the active generation."""
        self._validate_value(value)
        with self._lock:
            try:
                entry = self._require_active_population(handle)
            except CacheTransitionError:
                return PublicationResult(
                    accepted=False,
                    snapshot=self._current_snapshot(handle.key),
                )
            entry.snapshot = ReadyState(
                value=value,
                published_at_monotonic=self._clock(),
            )
            return PublicationResult(accepted=True, snapshot=entry.snapshot)

    def publish_exhausted(
        self,
        handle: PopulationHandle[TKey],
        failure_class: PopulationFailureClass,
    ) -> PublicationResult[TKey, TValue]:
        """Publish a terminal population failure if the generation is current."""
        with self._lock:
            try:
                entry = self._require_active_population(handle)
            except CacheTransitionError:
                return PublicationResult(
                    accepted=False,
                    snapshot=self._current_snapshot(handle.key),
                )
            entry.snapshot = ExhaustedState(
                failure_class=failure_class,
                completed_at_monotonic=self._clock(),
            )
            return PublicationResult(accepted=True, snapshot=entry.snapshot)

    def mark_if_absent(self, key: TKey, value: TValue) -> MarkIfAbsentResult:
        """Atomically insert one ready value when the key has no live entry."""
        self._validate_key(key)
        self._validate_value(value)
        with self._lock:
            if self._closed:
                return MarkClosed()
            existing_entry = self._entries.get(key)
            if existing_entry is not None and not isinstance(
                existing_entry.snapshot,
                (UnresolvedState, EvictedState),
            ):
                return MarkAlreadyPresent()
            generation = 1 if existing_entry is None else existing_entry.generation + 1
            snapshot = ReadyState(value=value, published_at_monotonic=self._clock())
            self._entries[key] = _CacheEntry(generation=generation, snapshot=snapshot)
            return MarkInserted()

    def eviction_journal(self) -> tuple[EvictionRecord[TKey], ...]:
        """Return the bounded immutable eviction journal."""
        with self._lock:
            return tuple(self._journal)

    def close(self, reason: EvictionReason) -> tuple[EvictionRecord[TKey], ...]:
        """Evict all active entries exactly once and close this epoch's cache."""
        with self._lock:
            if self._closed:
                return ()
            records: list[EvictionRecord[TKey]] = []
            for key, entry in tuple(self._entries.items()):
                if isinstance(entry.snapshot, EvictedState):
                    continue
                eviction = self._record_eviction(key, reason)
                entry.snapshot = EvictedState(eviction=eviction)
                records.append(eviction)
            self._closed = True
            return tuple(records)
