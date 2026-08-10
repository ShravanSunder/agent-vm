"""Profile-scoped eager Tool Portal namespace inventory coordination."""

import asyncio
import enum
import time
import typing as t

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .cache import (
    CacheSnapshot,
    EvictionReason,
    PluginStateCache,
    PopulationAlreadyStarted,
    PopulationFailureClass,
    PopulationStarted,
)
from .inventory_contracts import (
    PORTAL_BATCH_MAX_ITEMS,
    InventoryListItemRequest,
    InventoryListRequest,
    InventoryPortalListItemResult,
    InventoryPortalListResult,
    InventoryPortalListValue,
    InventoryPortalToolSummary,
    InventoryProjection,
    validate_inventory_portal_list_result,
)
from .models import (
    InventoryCacheKey,
    InventoryReadyValue,
    NamespaceAvailability,
    NamespaceInventory,
)
from .renderer import render_orientation

INVENTORY_DEADLINE_SECONDS = 60.0
INVENTORY_ATTEMPT_SLICE_ENDS: tuple[float, float, float] = (20.0, 40.0, 60.0)
INVENTORY_MAX_ATTEMPTS = 3


class _FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class InventoryFailureClass(enum.StrEnum):
    """Closed redacted classes for one failed Portal attempt."""

    TRANSPORT = "transport"
    TIMEOUT = "timeout"
    MALFORMED_RESPONSE = "malformed_response"
    AUTHORITY = "authority"


class InventoryRetryDisposition(enum.StrEnum):
    """Disposition recorded after one attempt fails."""

    RETRY = "retry"
    EXHAUSTED = "exhausted"
    TERMINAL = "terminal"


class InventoryAttemptLog(_FrozenModel):
    """Bounded structured evidence for one failed inventory attempt."""

    gateway_epoch: str = Field(min_length=1)
    profile_name: str = Field(min_length=1)
    attempt_number: int = Field(ge=1, le=INVENTORY_MAX_ATTEMPTS)
    failure_class: InventoryFailureClass
    retry_disposition: InventoryRetryDisposition


class InventoryGatewayPort(t.Protocol):
    """Explicit background Portal request seam."""

    async def list_for_projection(
        self,
        projection: InventoryProjection,
        request: InventoryListRequest,
        *,
        timeout_seconds: float,
    ) -> InventoryPortalListResult: ...


class InventoryMonotonicClock(t.Protocol):
    """Monotonic clock seam for deadline and state publication evidence."""

    def __call__(self) -> float: ...


class InventoryDeadlineScheduler(t.Protocol):
    """Cancellation timer seam; tests provide an explicit event scheduler."""

    async def wait_until(self, deadline_monotonic: float) -> None: ...


class InventoryAttemptLogSink(t.Protocol):
    """Redacted attempt-log consumer."""

    def record_inventory_attempt(self, record: InventoryAttemptLog) -> None: ...


class InventoryAuthorityError(RuntimeError):
    """A projection authority failure that must not be retried."""


class _NullInventoryAttemptLogSink:
    def record_inventory_attempt(self, record: InventoryAttemptLog) -> None:
        del record


class _RealInventoryDeadlineScheduler:
    async def wait_until(self, deadline_monotonic: float) -> None:
        delay_seconds = deadline_monotonic - time.monotonic()
        if delay_seconds > 0:
            await asyncio.sleep(delay_seconds)


class _AttemptFailure(Exception):
    def __init__(self, failure_class: InventoryFailureClass) -> None:
        super().__init__()
        self.failure_class = failure_class


def _inventory_id(projection: InventoryProjection) -> str:
    return ":".join(
        (
            "inventory",
            projection.gateway_epoch,
            projection.profile_assignment_revision,
            projection.agent_id,
            projection.profile_name,
            projection.tool_portal_profile_id,
        ),
    )


def _cancel_task(task: asyncio.Task[object]) -> None:
    if not task.done():
        task.cancel()
    task.add_done_callback(_consume_task_result)


def _consume_task_result(task: asyncio.Task[object]) -> None:
    try:
        task.result()
    except BaseException:
        pass


@t.final
class InventoryCoordinator:
    """One eager, profile-scoped inventory single flight per Gateway epoch."""

    def __init__(
        self,
        *,
        gateway: InventoryGatewayPort,
        cache: PluginStateCache[InventoryCacheKey, InventoryReadyValue] | None = None,
        monotonic_clock: InventoryMonotonicClock | None = None,
        deadline_scheduler: InventoryDeadlineScheduler | None = None,
        log_sink: InventoryAttemptLogSink | None = None,
    ) -> None:
        self._gateway = gateway
        self._cache = cache or PluginStateCache(
            key_model=InventoryCacheKey,
            value_model=InventoryReadyValue,
            monotonic_clock=monotonic_clock,
        )
        self._clock = monotonic_clock or time.monotonic
        self._deadline_scheduler = deadline_scheduler or _RealInventoryDeadlineScheduler()
        self._log_sink = log_sink or _NullInventoryAttemptLogSink()
        self._tasks: dict[
            InventoryCacheKey, asyncio.Task[CacheSnapshot[InventoryCacheKey, InventoryReadyValue]]
        ] = {}
        self._closed = False

    def read_snapshot(
        self,
        key: InventoryCacheKey,
    ) -> CacheSnapshot[InventoryCacheKey, InventoryReadyValue]:
        """Read one profile snapshot without starting or joining population."""
        return self._cache.read_snapshot(key)

    def start_population(
        self,
        projection: InventoryProjection,
    ) -> asyncio.Task[CacheSnapshot[InventoryCacheKey, InventoryReadyValue]] | None:
        """Start one background population; duplicate starts return no task."""
        if self._closed:
            return None
        key = projection.cache_key()
        population = self._cache.start_population(key)
        if isinstance(population, PopulationAlreadyStarted):
            return None
        if not isinstance(population, PopulationStarted):
            raise TypeError("inventory cache returned an unknown population result")
        started_at = self._clock()
        overall_deadline = started_at + INVENTORY_DEADLINE_SECONDS
        task = asyncio.create_task(
            self._populate(
                projection,
                population,
                started_at=started_at,
                overall_deadline=overall_deadline,
            ),
        )
        self._tasks[key] = task
        task.add_done_callback(lambda completed: self._tasks.pop(key, None))
        return task

    async def _populate(
        self,
        projection: InventoryProjection,
        population: PopulationStarted[InventoryCacheKey, InventoryReadyValue],
        *,
        started_at: float,
        overall_deadline: float,
    ) -> CacheSnapshot[InventoryCacheKey, InventoryReadyValue]:
        key = projection.cache_key()
        try:
            if not projection.namespace_names:
                return self._publish_inventory(population, projection, ())

            for attempt_number, slice_end_offset in enumerate(
                INVENTORY_ATTEMPT_SLICE_ENDS,
                start=1,
            ):
                now = self._clock()
                if now >= overall_deadline:
                    return self._publish_all_unavailable(population, projection)
                attempt_deadline = min(started_at + slice_end_offset, overall_deadline)
                try:
                    observations = await self._run_attempt(
                        projection,
                        attempt_number=attempt_number,
                        attempt_deadline=attempt_deadline,
                    )
                except _AttemptFailure as failure:
                    retry_possible = (
                        failure.failure_class != InventoryFailureClass.AUTHORITY
                        and attempt_number < INVENTORY_MAX_ATTEMPTS
                        and self._clock() < overall_deadline
                    )
                    disposition = (
                        InventoryRetryDisposition.RETRY
                        if retry_possible
                        else (
                            InventoryRetryDisposition.TERMINAL
                            if failure.failure_class == InventoryFailureClass.AUTHORITY
                            else InventoryRetryDisposition.EXHAUSTED
                        )
                    )
                    self._log_sink.record_inventory_attempt(
                        InventoryAttemptLog(
                            gateway_epoch=projection.gateway_epoch,
                            profile_name=projection.profile_name,
                            attempt_number=attempt_number,
                            failure_class=failure.failure_class,
                            retry_disposition=disposition,
                        ),
                    )
                    if failure.failure_class == InventoryFailureClass.AUTHORITY:
                        exhausted = self._cache.publish_exhausted(
                            population.handle,
                            PopulationFailureClass.INVALID_AUTHORITY,
                        )
                        return exhausted.snapshot
                    if not retry_possible:
                        return self._publish_all_unavailable(population, projection)
                    self._cache.set_population_attempt(
                        population.handle,
                        attempt_number=attempt_number + 1,
                    )
                    continue
                return self._publish_inventory(population, projection, observations)
            return self._publish_all_unavailable(population, projection)
        except asyncio.CancelledError:
            return self._cache.read_snapshot(key)
        finally:
            self._tasks.pop(key, None)

    async def _run_attempt(
        self,
        projection: InventoryProjection,
        *,
        attempt_number: int,
        attempt_deadline: float,
    ) -> tuple[tuple[str, bool], ...]:
        observations: list[tuple[str, bool]] = []
        batches = tuple(
            projection.namespace_names[offset : offset + PORTAL_BATCH_MAX_ITEMS]
            for offset in range(0, len(projection.namespace_names), PORTAL_BATCH_MAX_ITEMS)
        )
        for batch_number, namespace_batch in enumerate(batches):
            if self._clock() >= attempt_deadline:
                raise _AttemptFailure(InventoryFailureClass.TIMEOUT)
            requests = tuple(
                InventoryListItemRequest(
                    id=f"probe-{attempt_number}-{batch_number * PORTAL_BATCH_MAX_ITEMS + offset}",
                    namespaces=(namespace,),
                )
                for offset, namespace in enumerate(namespace_batch)
            )
            request = InventoryListRequest(
                requestId=f"inventory-{attempt_number}-{batch_number}",
                requests=requests,
            )
            raw_result = await self._run_batch(
                projection,
                request,
                attempt_deadline=attempt_deadline,
            )
            try:
                result = validate_inventory_portal_list_result(raw_result)
            except (ValidationError, TypeError, ValueError, _AttemptFailure) as error:
                raise _AttemptFailure(InventoryFailureClass.MALFORMED_RESPONSE) from error
            if result.diagnostics or any(item.diagnostics for item in result.items):
                raise _AttemptFailure(InventoryFailureClass.MALFORMED_RESPONSE)
            aggregate_ok = result.ok
            items = result.items
            if not aggregate_ok:
                raise _AttemptFailure(InventoryFailureClass.MALFORMED_RESPONSE)
            expected_ids = tuple(item.id for item in requests)
            actual_ids = tuple(item.id for item in items)
            if len(actual_ids) != len(set(actual_ids)) or actual_ids != expected_ids:
                raise _AttemptFailure(InventoryFailureClass.MALFORMED_RESPONSE)
            for requested_item, result_item in zip(requests, items, strict=True):
                requested_namespace = requested_item.namespaces[0]
                if result_item.status != "ok":
                    raise _AttemptFailure(InventoryFailureClass.MALFORMED_RESPONSE)
                if result_item.value is None:
                    raise _AttemptFailure(InventoryFailureClass.MALFORMED_RESPONSE)
                if len(result_item.value.tools) > 1:
                    raise _AttemptFailure(InventoryFailureClass.MALFORMED_RESPONSE)
                if result_item.value.tools:
                    if result_item.value.namespaces != (requested_namespace,):
                        raise _AttemptFailure(InventoryFailureClass.MALFORMED_RESPONSE)
                    if result_item.value.tools[0].namespace != requested_namespace:
                        raise _AttemptFailure(InventoryFailureClass.MALFORMED_RESPONSE)
                elif result_item.value.namespaces not in ((), (requested_namespace,)):
                    raise _AttemptFailure(InventoryFailureClass.MALFORMED_RESPONSE)
                observations.append(
                    (requested_namespace, bool(result_item.value.tools)),
                )
        return tuple(observations)

    async def _run_batch(
        self,
        projection: InventoryProjection,
        request: InventoryListRequest,
        *,
        attempt_deadline: float,
    ) -> InventoryPortalListResult:
        remaining_seconds = attempt_deadline - self._clock()
        if remaining_seconds <= 0:
            raise _AttemptFailure(InventoryFailureClass.TIMEOUT)
        request_task = asyncio.create_task(
            self._gateway.list_for_projection(
                projection,
                request,
                timeout_seconds=remaining_seconds,
            ),
        )
        deadline_task = asyncio.create_task(
            self._deadline_scheduler.wait_until(attempt_deadline),
        )
        try:
            done, _ = await asyncio.wait(
                (request_task, deadline_task),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if request_task in done:
                _cancel_task(deadline_task)
                try:
                    raw_result = request_task.result()
                except InventoryAuthorityError as error:
                    raise _AttemptFailure(InventoryFailureClass.AUTHORITY) from error
                except TimeoutError as error:
                    raise _AttemptFailure(InventoryFailureClass.TIMEOUT) from error
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    raise _AttemptFailure(InventoryFailureClass.TRANSPORT) from error
                if self._clock() >= attempt_deadline:
                    raise _AttemptFailure(InventoryFailureClass.TIMEOUT)
                return raw_result

            _cancel_task(request_task)
            raise _AttemptFailure(InventoryFailureClass.TIMEOUT)
        except asyncio.CancelledError:
            _cancel_task(request_task)
            _cancel_task(deadline_task)
            raise
        finally:
            if not request_task.done():
                _cancel_task(request_task)
            if not deadline_task.done():
                _cancel_task(deadline_task)

    def _publish_inventory(
        self,
        population: PopulationStarted[InventoryCacheKey, InventoryReadyValue],
        projection: InventoryProjection,
        observations: tuple[tuple[str, bool], ...],
    ) -> CacheSnapshot[InventoryCacheKey, InventoryReadyValue]:
        availability_by_name = {namespace: has_tool for namespace, has_tool in observations}
        inventory = NamespaceInventory(
            inventory_id=_inventory_id(projection),
            namespaces=tuple(
                NamespaceAvailability(
                    namespace=namespace,
                    status="available"
                    if availability_by_name.get(namespace, False)
                    else "unavailable",
                )
                for namespace in projection.namespace_names
            ),
        )
        ready_value = InventoryReadyValue(
            inventory=inventory,
            orientation=render_orientation(inventory),
        )
        return self._cache.publish_ready(population.handle, ready_value).snapshot

    def _publish_all_unavailable(
        self,
        population: PopulationStarted[InventoryCacheKey, InventoryReadyValue],
        projection: InventoryProjection,
    ) -> CacheSnapshot[InventoryCacheKey, InventoryReadyValue]:
        return self._publish_inventory(population, projection, ())

    def close(self, reason: EvictionReason = EvictionReason.RUNTIME_SHUTDOWN) -> None:
        """Fence the epoch, evict active state, and cancel in-flight requests."""
        if self._closed:
            return
        self._closed = True
        self._cache.close(reason)
        for task in tuple(self._tasks.values()):
            _cancel_task(task)


__all__ = (
    "INVENTORY_ATTEMPT_SLICE_ENDS",
    "INVENTORY_DEADLINE_SECONDS",
    "INVENTORY_MAX_ATTEMPTS",
    "InventoryAttemptLog",
    "InventoryAttemptLogSink",
    "InventoryAuthorityError",
    "InventoryCoordinator",
    "InventoryDeadlineScheduler",
    "InventoryFailureClass",
    "InventoryGatewayPort",
    "InventoryListItemRequest",
    "InventoryListRequest",
    "InventoryMonotonicClock",
    "InventoryPortalListItemResult",
    "InventoryPortalListResult",
    "InventoryPortalListValue",
    "InventoryPortalToolSummary",
    "InventoryProjection",
    "InventoryRetryDisposition",
    "PORTAL_BATCH_MAX_ITEMS",
    "validate_inventory_portal_list_result",
)
