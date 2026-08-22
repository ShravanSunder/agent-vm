import asyncio
import unittest
from typing import override

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from pydantic import ValidationError

from agent_vm_hermes_adapter.managed_tool_portal.cache import (
    CacheSnapshot,
    EvictedState,
    ExhaustedState,
    PopulationFailureClass,
    ReadyState,
    UnresolvedState,
)
from agent_vm_hermes_adapter.managed_tool_portal.inventory import (
    InventoryAttemptLog,
    InventoryAuthorityError,
    InventoryCoordinator,
    InventoryFailureClass,
    InventoryListRequest,
    InventoryPortalListItemResult,
    InventoryPortalListResult,
    InventoryPortalListValue,
    InventoryPortalToolSummary,
    InventoryProjection,
    InventoryRetryDisposition,
    validate_inventory_portal_list_result,
)
from agent_vm_hermes_adapter.managed_tool_portal.models import (
    InventoryCacheKey,
    InventoryReadyValue,
    NamespaceDiscovery,
)

ResponseScriptValue = InventoryPortalListResult | dict[str, object] | BaseException


class FakeClock:
    def __init__(self, value: float = 0.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value

    def advance_to(self, value: float) -> None:
        self.value = value


class ManualDeadlineScheduler:
    def __init__(self, clock: FakeClock) -> None:
        self._clock = clock
        self._waiters: list[tuple[float, asyncio.Event]] = []

    async def wait_until(self, deadline_monotonic: float) -> None:
        event = asyncio.Event()
        self._waiters.append((deadline_monotonic, event))
        await event.wait()

    def release_next(self, *, at: float | None = None) -> None:
        if not self._waiters:
            raise AssertionError("no pending deadline waiter")
        deadline, event = self._waiters.pop(0)
        self._clock.advance_to(deadline if at is None else at)
        event.set()


class ScriptedGateway:
    def __init__(self, responses: list[ResponseScriptValue]) -> None:
        self.responses = responses
        self.calls: list[tuple[InventoryProjection, InventoryListRequest, float]] = []
        self.started = asyncio.Event()
        self.cancelled_call_count = 0

    async def list_for_projection(
        self,
        projection: InventoryProjection,
        request: InventoryListRequest,
        *,
        timeout_seconds: float,
    ) -> InventoryPortalListResult:
        self.calls.append((projection, request, timeout_seconds))
        self.started.set()
        if not self.responses:
            raise AssertionError("scripted gateway ran out of responses")
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        if isinstance(response, dict):
            return validate_inventory_portal_list_result(response)
        return response


class BlockingLateGateway:
    def __init__(self, late_response: InventoryPortalListResult) -> None:
        self.late_response = late_response
        self.started = asyncio.Event()
        self.release_late_response = asyncio.Event()
        self.calls: list[tuple[InventoryProjection, InventoryListRequest, float]] = []
        self.cancelled_call_count = 0
        self.late_result_returned = asyncio.Event()

    async def list_for_projection(
        self,
        projection: InventoryProjection,
        request: InventoryListRequest,
        *,
        timeout_seconds: float,
    ) -> InventoryPortalListResult:
        self.calls.append((projection, request, timeout_seconds))
        self.started.set()
        try:
            await self.release_late_response.wait()
        except asyncio.CancelledError:
            self.cancelled_call_count += 1
            await self.release_late_response.wait()
            self.late_result_returned.set()
            return self.late_response
        self.late_result_returned.set()
        return self.late_response


class LogSink:
    def __init__(self) -> None:
        self.records: list[InventoryAttemptLog] = []

    def record_inventory_attempt(self, record: InventoryAttemptLog) -> None:
        self.records.append(record)


def _projection(
    *,
    epoch: str = "epoch-a",
    profile_name: str = "profile-a",
    namespaces: tuple[str, ...] = ("alpha", "beta"),
) -> InventoryProjection:
    return InventoryProjection(
        gateway_epoch=epoch,
        profile_assignment_revision=f"revision-{profile_name}",
        agent_id=f"agent-{profile_name}",
        profile_name=profile_name,
        tool_portal_profile_id=f"portal-{profile_name}",
        namespaces=tuple(NamespaceDiscovery(namespace=namespace) for namespace in namespaces),
    )


def _tool(namespace: str, name: str = "probe") -> InventoryPortalToolSummary:
    return InventoryPortalToolSummary(namespace=namespace, name=name)


def _success_item(
    item_id: str,
    namespace: str,
    *,
    tool: bool,
    namespaces: tuple[str, ...] | None = None,
) -> InventoryPortalListItemResult:
    return InventoryPortalListItemResult(
        id=item_id,
        status="ok",
        value=InventoryPortalListValue(
            namespaces=(namespace,) if namespaces is None and tool else namespaces or (),
            tools=(_tool(namespace),) if tool else (),
        ),
    )


def _success_result(
    items: tuple[InventoryPortalListItemResult, ...] | list[InventoryPortalListItemResult],
) -> InventoryPortalListResult:
    return InventoryPortalListResult(items=tuple(items), ok=True)


def _raw_diagnostic() -> dict[str, object]:
    return {
        "code": "provider_unavailable",
        "level": "warn",
        "safeMessage": "raw diagnostic must not cross the inventory boundary",
        "safeParams": {"namespace": "alpha"},
    }


def _raw_probe_item(
    item_id: str,
    namespace: str,
    *,
    tool: bool,
    diagnostics: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    item: dict[str, object] = {
        "id": item_id,
        "status": "ok",
        "value": {
            "namespaceDiscovery": [{"namespace": namespace}],
            "namespaces": [namespace] if tool else [],
            "tools": [
                {
                    "input": {
                        "optional": [],
                        "propertyCount": 0,
                        "required": [],
                        "type": "object",
                    },
                    "name": "probe",
                    "namespace": namespace,
                    "safety": {
                        "destructiveHint": False,
                        "readOnlyHint": True,
                    },
                    "toolRef": f"{namespace}/probe",
                }
            ]
            if tool
            else [],
        },
    }
    if diagnostics is not None:
        item["diagnostics"] = diagnostics
    return item


def _raw_result(
    items: list[dict[str, object]],
    *,
    diagnostics: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    result: dict[str, object] = {"items": items, "ok": True}
    if diagnostics is not None:
        result["diagnostics"] = diagnostics
    return result


def _error_item(item_id: str) -> InventoryPortalListItemResult:
    return InventoryPortalListItemResult(id=item_id, status="error")


def _require_task(
    task: asyncio.Task[CacheSnapshot[InventoryCacheKey, InventoryReadyValue]] | None,
) -> asyncio.Task[CacheSnapshot[InventoryCacheKey, InventoryReadyValue]]:
    if task is None:
        raise AssertionError("expected a started population task")
    return task


def _require_ready(
    snapshot: CacheSnapshot[InventoryCacheKey, InventoryReadyValue],
) -> InventoryReadyValue:
    if not isinstance(snapshot, ReadyState):
        raise AssertionError(f"expected ready state, got {snapshot!r}")
    if not isinstance(snapshot.value, InventoryReadyValue):
        raise AssertionError("expected InventoryReadyValue")
    return snapshot.value


def _require_item_value(item: InventoryPortalListItemResult) -> InventoryPortalListValue:
    if item.value is None:
        raise AssertionError("expected a successful Portal list item value")
    return item.value


class ManagedToolPortalInventoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_portal_wire_result_is_validated_into_named_boundary_model(self) -> None:
        raw_result = {
            "items": [
                {
                    "id": "probe-1-0",
                    "status": "ok",
                    "value": {
                        "namespaceDiscovery": [{"namespace": "alpha"}],
                        "namespaces": ["alpha"],
                        "tools": [
                            {
                                "input": {
                                    "optional": [],
                                    "propertyCount": 0,
                                    "required": [],
                                    "type": "object",
                                },
                                "name": "probe",
                                "namespace": "alpha",
                                "safety": {
                                    "destructiveHint": False,
                                    "readOnlyHint": True,
                                },
                                "toolRef": "alpha/probe",
                            },
                        ],
                    },
                },
            ],
            "ok": True,
        }

        result = validate_inventory_portal_list_result(raw_result)

        portable_result = PORTABLE_CONTRACT_ADAPTERS["portal.list.result"].validate_python(
            raw_result
        )
        model_result = validate_inventory_portal_list_result(portable_result)

        self.assertIsInstance(result, InventoryPortalListResult)
        self.assertEqual(model_result, result)
        value = _require_item_value(result.items[0])
        self.assertEqual(value.tools[0].namespace, "alpha")
        self.assertEqual(value.tools[0].name, "probe")
        with self.assertRaises(ValidationError):
            validate_inventory_portal_list_result(
                {"items": [{"id": "probe-1-0", "status": "ok"}], "ok": True},
            )
        with self.assertRaises(ValueError):
            validate_inventory_portal_list_result(
                {"items": [], "ok": True, 1: "non-string object key"},
            )

    async def test_validated_aggregate_diagnostics_retain_only_closed_evidence(self) -> None:
        result = validate_inventory_portal_list_result(
            _raw_result(
                [_raw_probe_item("probe-1-0", "alpha", tool=False)],
                diagnostics=[_raw_diagnostic()],
            ),
        )

        self.assertEqual(
            result.model_dump()["diagnostics"],
            ({"code": "provider_unavailable", "level": "warn"},),
        )
        self.assertNotIn("safeMessage", result.model_dump_json())
        self.assertNotIn("safeParams", result.model_dump_json())

    async def test_validated_item_diagnostics_retain_only_closed_evidence(self) -> None:
        result = validate_inventory_portal_list_result(
            _raw_result(
                [
                    _raw_probe_item(
                        "probe-1-0",
                        "alpha",
                        tool=False,
                        diagnostics=[_raw_diagnostic()],
                    ),
                ],
            ),
        )

        self.assertEqual(
            result.model_dump()["items"][0]["diagnostics"],
            ({"code": "provider_unavailable", "level": "warn"},),
        )
        self.assertNotIn("safeMessage", result.model_dump_json())
        self.assertNotIn("safeParams", result.model_dump_json())

    async def test_nonempty_aggregate_or_item_diagnostics_invalidate_attempt(self) -> None:
        for diagnostic_result in (
            _raw_result(
                [_raw_probe_item("probe-1-0", "alpha", tool=True)],
                diagnostics=[_raw_diagnostic()],
            ),
            _raw_result(
                [
                    _raw_probe_item(
                        "probe-1-0",
                        "alpha",
                        tool=True,
                        diagnostics=[_raw_diagnostic()],
                    ),
                ],
            ),
        ):
            with self.subTest(diagnostic_result=diagnostic_result):
                gateway = ScriptedGateway([diagnostic_result] * 3)
                logs = LogSink()
                coordinator = InventoryCoordinator(gateway=gateway, log_sink=logs)
                projection = _projection(namespaces=("alpha",))

                task = coordinator.start_population(projection)
                self.assertIsNotNone(task)
                await _require_task(task)

                ready = _require_ready(coordinator.read_snapshot(projection.cache_key()))
                self.assertEqual(ready.inventory.namespaces[0].status, "unavailable")
                self.assertEqual(len(gateway.calls), 3)
                self.assertEqual(
                    tuple(record.failure_class for record in logs.records),
                    (InventoryFailureClass.MALFORMED_RESPONSE,) * 3,
                )

    async def test_mixed_batch_diagnostic_discards_positive_observation_before_exhaustion(
        self,
    ) -> None:
        diagnostic_batch = _raw_result(
            [
                _raw_probe_item("probe-1-0", "alpha", tool=True),
                _raw_probe_item(
                    "probe-1-1",
                    "beta",
                    tool=False,
                    diagnostics=[_raw_diagnostic()],
                ),
            ],
        )
        gateway = ScriptedGateway([diagnostic_batch] * 3)
        logs = LogSink()
        coordinator = InventoryCoordinator(gateway=gateway, log_sink=logs)
        projection = _projection()

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        await _require_task(task)

        ready = _require_ready(coordinator.read_snapshot(projection.cache_key()))
        self.assertEqual(
            tuple(item.status for item in ready.inventory.namespaces),
            ("unavailable", "unavailable"),
        )
        self.assertEqual(len(gateway.calls), 3)
        self.assertEqual(
            tuple(record.retry_disposition for record in logs.records),
            (
                InventoryRetryDisposition.RETRY,
                InventoryRetryDisposition.RETRY,
                InventoryRetryDisposition.EXHAUSTED,
            ),
        )

    async def test_successful_probe_classifies_available_and_zero_tool_unavailable(self) -> None:
        clock = FakeClock()
        gateway = ScriptedGateway(
            [
                _success_result(
                    [
                        _success_item("probe-1-0", "alpha", tool=True),
                        _success_item("probe-1-1", "beta", tool=False),
                    ],
                ),
            ],
        )
        coordinator = InventoryCoordinator(
            gateway=gateway,
            monotonic_clock=clock,
        )
        projection = _projection()

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        await _require_task(task)

        ready = _require_ready(coordinator.read_snapshot(projection.cache_key()))
        self.assertEqual(
            tuple((item.namespace, item.status) for item in ready.inventory.namespaces),
            (("alpha", "available"), ("beta", "unavailable")),
        )
        self.assertIsNotNone(ready.orientation)
        self.assertEqual(len(gateway.calls), 1)
        request = gateway.calls[0][1]
        self.assertEqual(
            tuple((item.id, item.namespaces, item.limit) for item in request.requests),
            (("probe-1-0", ("alpha",), 1), ("probe-1-1", ("beta",), 1)),
        )

    async def test_requested_namespace_zero_tool_result_is_unavailable_without_retry(self) -> None:
        clock = FakeClock()
        gateway = ScriptedGateway(
            [
                _success_result(
                    [
                        _success_item("probe-1-0", "alpha", tool=True),
                        _success_item(
                            "probe-1-1",
                            "beta",
                            tool=False,
                            namespaces=("beta",),
                        ),
                    ],
                ),
            ],
        )
        coordinator = InventoryCoordinator(
            gateway=gateway,
            monotonic_clock=clock,
        )
        projection = _projection()

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        await _require_task(task)

        ready = _require_ready(coordinator.read_snapshot(projection.cache_key()))
        self.assertEqual(
            tuple((item.namespace, item.status) for item in ready.inventory.namespaces),
            (("alpha", "available"), ("beta", "unavailable")),
        )
        self.assertEqual(len(gateway.calls), 1)

    async def test_deadline_starts_before_population_task_is_scheduled(self) -> None:
        clock = FakeClock()
        gateway = ScriptedGateway([])
        coordinator = InventoryCoordinator(
            gateway=gateway,
            monotonic_clock=clock,
        )
        projection = _projection(namespaces=("alpha",))

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        clock.advance_to(60.0)
        await _require_task(task)

        ready = _require_ready(coordinator.read_snapshot(projection.cache_key()))
        self.assertEqual(ready.inventory.namespaces[0].status, "unavailable")
        self.assertEqual(len(gateway.calls), 0)

    async def test_profile_scoping_and_duplicate_start_use_one_single_flight_per_key(self) -> None:
        gateway = ScriptedGateway(
            [
                _success_result([_success_item("probe-1-0", "alpha", tool=True)]),
                _success_result([_success_item("probe-1-0", "alpha", tool=False)]),
            ],
        )
        coordinator = InventoryCoordinator(gateway=gateway)
        first_projection = _projection(namespaces=("alpha",))
        second_projection = _projection(
            profile_name="profile-b",
            namespaces=("alpha",),
        )

        first_task = coordinator.start_population(first_projection)
        duplicate_task = coordinator.start_population(first_projection)
        second_task = coordinator.start_population(second_projection)
        self.assertIsNotNone(first_task)
        self.assertIsNone(duplicate_task)
        self.assertIsNotNone(second_task)

        await asyncio.gather(_require_task(first_task), _require_task(second_task))

        first_ready = _require_ready(coordinator.read_snapshot(first_projection.cache_key()))
        second_ready = _require_ready(coordinator.read_snapshot(second_projection.cache_key()))
        self.assertEqual(first_ready.inventory.namespaces[0].status, "available")
        self.assertEqual(second_ready.inventory.namespaces[0].status, "unavailable")
        self.assertEqual(len(gateway.calls), 2)

    async def test_large_admitted_set_uses_sequential_batches_of_fifty(self) -> None:
        namespaces = tuple(f"namespace-{index:02d}" for index in range(51))
        projection = _projection(namespaces=namespaces)
        first_batch = tuple(
            _success_item(f"probe-1-{index}", namespace, tool=False)
            for index, namespace in enumerate(namespaces[:50])
        )
        second_batch = (_success_item("probe-1-50", namespaces[50], tool=True),)
        gateway = ScriptedGateway(
            [_success_result(first_batch), _success_result(second_batch)],
        )
        coordinator = InventoryCoordinator(gateway=gateway)

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        await _require_task(task)

        ready = _require_ready(coordinator.read_snapshot(projection.cache_key()))
        self.assertEqual(len(gateway.calls), 2)
        self.assertEqual(len(gateway.calls[0][1].requests), 50)
        self.assertEqual(len(gateway.calls[1][1].requests), 1)
        self.assertEqual(gateway.calls[0][1].requests[0].namespaces, (namespaces[0],))
        self.assertEqual(gateway.calls[1][1].requests[0].namespaces, (namespaces[50],))
        self.assertEqual(ready.inventory.namespaces[-1].status, "available")

    async def test_malformed_partial_missing_mismatched_and_cross_namespace_attempt_is_discarded(
        self,
    ) -> None:
        clock = FakeClock()
        gateway = ScriptedGateway(
            [
                _success_result([_success_item("probe-1-0", "alpha", tool=True)]),
                _success_result(
                    [
                        _success_item("probe-2-0", "alpha", tool=False),
                        _success_item("probe-2-1", "beta", tool=False),
                    ],
                ),
            ],
        )
        coordinator = InventoryCoordinator(
            gateway=gateway,
            monotonic_clock=clock,
        )
        projection = _projection()

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        await _require_task(task)

        ready = _require_ready(coordinator.read_snapshot(projection.cache_key()))
        self.assertEqual(
            tuple(item.status for item in ready.inventory.namespaces),
            ("unavailable", "unavailable"),
        )

        malformed_responses: tuple[InventoryPortalListResult, ...] = (
            _success_result(
                [
                    _success_item("probe-1-0", "alpha", tool=True),
                    _success_item("probe-1-0", "beta", tool=True),
                ],
            ),
            _success_result(
                [
                    _success_item("wrong-id", "alpha", tool=True),
                    _success_item("probe-1-1", "beta", tool=True),
                ],
            ),
            _success_result(
                [
                    InventoryPortalListItemResult(
                        id="probe-1-0",
                        status="ok",
                        value=InventoryPortalListValue(
                            namespaces=("alpha",),
                            tools=(_tool("beta"),),
                        ),
                    ),
                    _success_item("probe-1-1", "beta", tool=True),
                ],
            ),
            InventoryPortalListResult(
                items=(_error_item("probe-1-0"),),
                ok=False,
            ),
        )
        for malformed_response in malformed_responses:
            fresh_gateway = ScriptedGateway([malformed_response] * 3)
            fresh_coordinator = InventoryCoordinator(gateway=fresh_gateway)
            fresh_task = fresh_coordinator.start_population(projection)
            self.assertIsNotNone(fresh_task)
            await _require_task(fresh_task)
            fresh_snapshot = _require_ready(
                fresh_coordinator.read_snapshot(projection.cache_key()),
            )
            self.assertEqual(
                tuple(item.status for item in fresh_snapshot.inventory.namespaces),
                ("unavailable", "unavailable"),
            )

    async def test_retry_budget_is_three_attempts_with_one_bounded_log_per_failure(self) -> None:
        gateway = ScriptedGateway(
            [
                RuntimeError("transport secret"),
                RuntimeError("transport secret"),
                RuntimeError("transport secret"),
            ],
        )
        logs = LogSink()
        coordinator = InventoryCoordinator(gateway=gateway, log_sink=logs)
        projection = _projection(namespaces=("alpha",))

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        await _require_task(task)

        snapshot = _require_ready(coordinator.read_snapshot(projection.cache_key()))
        self.assertEqual(snapshot.inventory.namespaces[0].status, "unavailable")
        self.assertEqual(len(gateway.calls), 3)
        self.assertEqual(len(logs.records), 3)
        self.assertEqual(
            tuple(record.attempt_number for record in logs.records),
            (1, 2, 3),
        )
        self.assertEqual(
            tuple(record.failure_class for record in logs.records),
            (InventoryFailureClass.TRANSPORT,) * 3,
        )
        self.assertEqual(
            tuple(record.retry_disposition for record in logs.records),
            (
                InventoryRetryDisposition.RETRY,
                InventoryRetryDisposition.RETRY,
                InventoryRetryDisposition.EXHAUSTED,
            ),
        )
        self.assertNotIn("secret", logs.records[0].model_dump_json())

    async def test_invalid_authority_is_terminal_after_one_attempt_without_orientation(
        self,
    ) -> None:
        gateway = ScriptedGateway([InventoryAuthorityError("authority details")])
        logs = LogSink()
        coordinator = InventoryCoordinator(gateway=gateway, log_sink=logs)
        projection = _projection(namespaces=("alpha",))

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        await _require_task(task)

        snapshot = coordinator.read_snapshot(projection.cache_key())
        self.assertIsInstance(snapshot, ExhaustedState)
        if not isinstance(snapshot, ExhaustedState):
            self.fail("expected invalid authority to publish an exhausted snapshot")
        self.assertEqual(snapshot.failure_class, PopulationFailureClass.INVALID_AUTHORITY)
        self.assertNotIn("orientation", snapshot.model_dump())
        self.assertEqual(len(gateway.calls), 1)
        self.assertEqual(
            logs.records,
            [
                InventoryAttemptLog(
                    gateway_epoch="epoch-a",
                    profile_name="profile-a",
                    attempt_number=1,
                    failure_class=InventoryFailureClass.AUTHORITY,
                    retry_disposition=InventoryRetryDisposition.TERMINAL,
                )
            ],
        )

    async def test_deadline_precedence_prevents_successor_attempt(self) -> None:
        clock = FakeClock()

        class DeadlineAdvancingGateway(ScriptedGateway):
            @override
            async def list_for_projection(
                self,
                projection: InventoryProjection,
                request: InventoryListRequest,
                *,
                timeout_seconds: float,
            ) -> InventoryPortalListResult:
                result = await super().list_for_projection(
                    projection,
                    request,
                    timeout_seconds=timeout_seconds,
                )
                clock.advance_to(60.0)
                return result

        gateway = DeadlineAdvancingGateway(
            [_success_result([_success_item("probe-1-0", "alpha", tool=True)])],
        )
        logs = LogSink()
        coordinator = InventoryCoordinator(
            gateway=gateway,
            monotonic_clock=clock,
            log_sink=logs,
        )
        projection = _projection(namespaces=("alpha",))

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        await _require_task(task)

        snapshot = _require_ready(coordinator.read_snapshot(projection.cache_key()))
        self.assertEqual(snapshot.inventory.namespaces[0].status, "unavailable")
        self.assertEqual(len(gateway.calls), 1)
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(logs.records[0].failure_class, InventoryFailureClass.TIMEOUT)

    async def test_deadline_cancellation_fences_late_result_before_retry(self) -> None:
        clock = FakeClock()
        scheduler = ManualDeadlineScheduler(clock)
        late_gateway = BlockingLateGateway(
            _success_result([_success_item("probe-1-0", "alpha", tool=True)]),
        )
        retry_gateway = ScriptedGateway(
            [
                _success_result([_success_item("probe-2-0", "alpha", tool=False)]),
            ],
        )

        class CombinedGateway:
            def __init__(self) -> None:
                self.calls: list[tuple[InventoryProjection, InventoryListRequest, float]] = []
                self.invocation_count = 0

            async def list_for_projection(
                self,
                projection: InventoryProjection,
                request: InventoryListRequest,
                *,
                timeout_seconds: float,
            ) -> InventoryPortalListResult:
                self.invocation_count += 1
                if self.invocation_count == 1:
                    result = await late_gateway.list_for_projection(
                        projection,
                        request,
                        timeout_seconds=timeout_seconds,
                    )
                else:
                    result = await retry_gateway.list_for_projection(
                        projection,
                        request,
                        timeout_seconds=timeout_seconds,
                    )
                self.calls.append((projection, request, timeout_seconds))
                return result

        gateway = CombinedGateway()
        logs = LogSink()
        coordinator = InventoryCoordinator(
            gateway=gateway,
            monotonic_clock=clock,
            deadline_scheduler=scheduler,
            log_sink=logs,
        )
        projection = _projection(namespaces=("alpha",))

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        await late_gateway.started.wait()
        scheduler.release_next()
        await _require_task(task)

        snapshot = _require_ready(coordinator.read_snapshot(projection.cache_key()))
        self.assertEqual(snapshot.inventory.namespaces[0].status, "unavailable")
        self.assertEqual(gateway.invocation_count, 2)
        self.assertEqual(len(retry_gateway.calls), 1)
        self.assertEqual(late_gateway.cancelled_call_count, 1)
        late_gateway.release_late_response.set()
        await late_gateway.late_result_returned.wait()
        late_snapshot = _require_ready(coordinator.read_snapshot(projection.cache_key()))
        self.assertEqual(late_snapshot.inventory.namespaces[0].status, "unavailable")
        self.assertEqual(late_snapshot.inventory.inventory_id, snapshot.inventory.inventory_id)

    async def test_projection_is_strict_and_unresolved_state_is_nonblocking_before_start(
        self,
    ) -> None:
        with self.assertRaises(ValidationError):
            InventoryProjection(
                gateway_epoch="epoch-a",
                profile_assignment_revision="revision-a",
                agent_id="agent-a",
                profile_name="profile-a",
                tool_portal_profile_id="portal-a",
                namespaces=(
                    NamespaceDiscovery(namespace="beta"),
                    NamespaceDiscovery(namespace="alpha"),
                ),
            )
        with self.assertRaises(ValidationError):
            InventoryProjection(
                gateway_epoch="epoch-a",
                profile_assignment_revision="revision-a",
                agent_id="agent-a",
                profile_name="profile-a",
                tool_portal_profile_id="portal-a",
                namespaces=(
                    NamespaceDiscovery(namespace="alpha"),
                    NamespaceDiscovery(namespace="alpha"),
                ),
            )

        coordinator = InventoryCoordinator(gateway=ScriptedGateway([]))
        snapshot = coordinator.read_snapshot(_projection().cache_key())
        self.assertIsInstance(snapshot, UnresolvedState)

    async def test_shutdown_evicts_population_and_late_completion_cannot_publish(self) -> None:
        clock = FakeClock()
        scheduler = ManualDeadlineScheduler(clock)
        gateway = BlockingLateGateway(
            _success_result([_success_item("probe-1-0", "alpha", tool=True)]),
        )
        coordinator = InventoryCoordinator(
            gateway=gateway,
            monotonic_clock=clock,
            deadline_scheduler=scheduler,
        )
        projection = _projection(namespaces=("alpha",))

        task = coordinator.start_population(projection)
        self.assertIsNotNone(task)
        await gateway.started.wait()
        coordinator.close()
        gateway.release_late_response.set()
        await _require_task(task)

        self.assertIsInstance(coordinator.read_snapshot(projection.cache_key()), EvictedState)


if __name__ == "__main__":
    unittest.main()
