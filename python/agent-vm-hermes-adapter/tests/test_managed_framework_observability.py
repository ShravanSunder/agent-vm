import dataclasses
import threading
import typing as t
import unittest

from agent_vm_hermes_adapter.managed_framework_observability import (
    ApiMode,
    FrameworkObservationSink,
    ManagedFrameworkObservability,
    ProviderAttemptCompletedRecord,
    ProviderAttemptResultClass,
    ProviderAttemptStartedRecord,
    ToolCallRecord,
    ToolCategory,
    ToolResultClass,
    TurnCompletedRecord,
    TurnResultClass,
    TurnStartedRecord,
)

CONTENT_CANARY = "PRIVATE-CONTENT-CANARY"


class _RecordingSink(FrameworkObservationSink):
    def __init__(self) -> None:
        self._next_handle = 0
        self.turn_starts: list[tuple[object, TurnStartedRecord]] = []
        self.turn_completions: list[tuple[object, TurnCompletedRecord]] = []
        self.provider_starts: list[tuple[object | None, object, ProviderAttemptStartedRecord]] = []
        self.provider_completions: list[tuple[object, ProviderAttemptCompletedRecord]] = []
        self.tool_calls: list[tuple[object | None, ToolCallRecord]] = []

    def _handle(self, kind: str) -> object:
        self._next_handle += 1
        return (kind, self._next_handle)

    @t.override
    def start_turn(self, record: TurnStartedRecord) -> object | None:
        handle = self._handle("turn")
        self.turn_starts.append((handle, record))
        return handle

    @t.override
    def complete_turn(self, handle: object, record: TurnCompletedRecord) -> None:
        self.turn_completions.append((handle, record))

    @t.override
    def start_provider_attempt(
        self,
        parent_handle: object | None,
        record: ProviderAttemptStartedRecord,
    ) -> object | None:
        handle = self._handle("provider")
        self.provider_starts.append((parent_handle, handle, record))
        return handle

    @t.override
    def complete_provider_attempt(
        self,
        handle: object,
        record: ProviderAttemptCompletedRecord,
    ) -> None:
        self.provider_completions.append((handle, record))

    @t.override
    def emit_tool_call(
        self,
        parent_handle: object | None,
        record: ToolCallRecord,
    ) -> None:
        self.tool_calls.append((parent_handle, record))


class _ExplosiveString:
    @t.override
    def __str__(self) -> str:
        raise AssertionError("mapper called str() on an arbitrary hook object")


def _all_record_values(sink: _RecordingSink) -> list[object]:
    records: list[object] = []
    for collection in (
        sink.turn_starts,
        sink.turn_completions,
        sink.provider_starts,
        sink.provider_completions,
        sink.tool_calls,
    ):
        for item in collection:
            for value in item:
                if not isinstance(value, type) and dataclasses.is_dataclass(value):
                    records.extend(dataclasses.asdict(value).values())
    return records


@t.final
class ManagedFrameworkObservabilityTests(unittest.TestCase):
    def test_all_callbacks_return_none_and_emit_closed_records(self) -> None:
        sink = _RecordingSink()
        mapper = ManagedFrameworkObservability(
            sink=sink,
            max_inflight_observations=8,
        )

        self.assertIsNone(
            mapper.on_pre_llm_call(
                turn_id="turn-1",
                platform="Discord_2",
                user_message=CONTENT_CANARY,
                conversation_history=[CONTENT_CANARY],
            )
        )
        self.assertIsNone(
            mapper.on_pre_api_request(
                turn_id="turn-1",
                api_request_id="api-1",
                model="model-a",
                provider="provider-a",
                api_mode="chat_completions",
                api_call_count=3,
                request={CONTENT_CANARY: CONTENT_CANARY},
            )
        )
        self.assertIsNone(
            mapper.on_post_api_request(
                turn_id="turn-1",
                api_request_id="api-1",
                api_duration=1.25,
                finish_reason="tool_calls",
                usage={"input_tokens": 11, "output_tokens": 7, "raw": CONTENT_CANARY},
                response=CONTENT_CANARY,
            )
        )
        self.assertIsNone(
            mapper.on_post_tool_call(
                turn_id="turn-1",
                tool_name="web_search",
                duration_ms=12,
                status="ok",
                args={"query": CONTENT_CANARY},
                result=CONTENT_CANARY,
                error_message=CONTENT_CANARY,
            )
        )
        self.assertIsNone(
            mapper.on_session_end(
                turn_id="turn-1",
                completed=True,
                interrupted=False,
                assistant_response=CONTENT_CANARY,
            )
        )
        self.assertIsNone(
            mapper.on_api_request_error(
                turn_id="turn-2",
                api_request_id="api-2",
                api_duration=0.5,
                reason="timeout",
                status_code=503,
                retryable=True,
                retry_count=2,
                error={"message": CONTENT_CANARY},
            )
        )
        self.assertIsNone(
            mapper.on_session_end(
                turn_id="turn-2",
                completed=False,
                interrupted=True,
                user_message=CONTENT_CANARY,
            )
        )

        self.assertEqual(
            sink.turn_starts[0][1],
            TurnStartedRecord(platform_class="discord_2"),
        )
        self.assertEqual(
            sink.provider_starts[0][2],
            ProviderAttemptStartedRecord(
                api_call_count=3,
                api_mode=ApiMode.CHAT_COMPLETIONS,
                model="model-a",
                provider="provider-a",
            ),
        )
        self.assertEqual(
            sink.provider_completions[0][1],
            ProviderAttemptCompletedRecord(
                duration_milliseconds=1250.0,
                finish_reason_class="tool_calls",
                result_class=ProviderAttemptResultClass.SUCCESS,
                usage_input_tokens=11,
                usage_output_tokens=7,
            ),
        )
        self.assertEqual(
            sink.tool_calls[0][1],
            ToolCallRecord(
                duration_milliseconds=12.0,
                result_class=ToolResultClass.SUCCESS,
                tool_category=ToolCategory.HERMES_TOOL,
                tool_name="web_search",
            ),
        )
        self.assertEqual(
            sink.turn_completions[0][1],
            TurnCompletedRecord(result_class=TurnResultClass.SUCCESS),
        )
        self.assertNotIn(CONTENT_CANARY, _all_record_values(sink))

    def test_api_failure_maps_only_bounded_failure_metadata(self) -> None:
        sink = _RecordingSink()
        mapper = ManagedFrameworkObservability(
            sink=sink,
            max_inflight_observations=4,
        )
        mapper.on_pre_llm_call(turn_id="turn", platform="cli")
        mapper.on_pre_api_request(
            turn_id="turn",
            api_request_id="api",
            model="m" * 300,
            provider="p" * 200,
            api_mode="not-real",
            api_call_count=2**40,
        )

        mapper.on_api_request_error(
            turn_id="turn",
            api_request_id="api",
            api_duration=float("inf"),
            reason="timeout",
            status_code=429,
            retryable=True,
            retry_count=-1,
            error=_ExplosiveString(),
        )

        started = sink.provider_starts[0][2]
        completed = sink.provider_completions[0][1]
        self.assertEqual(len(t.cast("str", started.model)), 256)
        self.assertEqual(len(t.cast("str", started.provider)), 128)
        self.assertEqual(started.api_mode, ApiMode.UNKNOWN)
        self.assertIsNone(started.api_call_count)
        self.assertEqual(
            completed,
            ProviderAttemptCompletedRecord(
                duration_milliseconds=0.0,
                failover_reason="timeout",
                http_status_class="4xx",
                result_class=ProviderAttemptResultClass.FAILURE,
                retryable=True,
            ),
        )

    def test_malformed_values_never_use_arbitrary_string_conversion(self) -> None:
        explosive = _ExplosiveString()
        sink = _RecordingSink()
        mapper = ManagedFrameworkObservability(
            sink=sink,
            max_inflight_observations=3,
        )

        mapper.on_pre_llm_call(turn_id="turn", platform=explosive)
        mapper.on_pre_api_request(
            turn_id="turn",
            api_request_id="api",
            model=explosive,
            provider=explosive,
            api_mode=explosive,
            api_call_count=explosive,
        )
        mapper.on_post_api_request(
            turn_id="turn",
            api_request_id="api",
            api_duration=explosive,
            finish_reason=explosive,
            usage={
                "input_tokens": explosive,
                "output_tokens": explosive,
            },
        )
        mapper.on_post_tool_call(
            turn_id="turn",
            tool_name=explosive,
            duration_ms=explosive,
            status=explosive,
            args=explosive,
            result=explosive,
        )

        self.assertEqual(sink.turn_starts[0][1].platform_class, "unknown")
        self.assertEqual(
            sink.provider_starts[0][2],
            ProviderAttemptStartedRecord(api_mode=ApiMode.UNKNOWN),
        )
        self.assertEqual(
            sink.provider_completions[0][1],
            ProviderAttemptCompletedRecord(
                duration_milliseconds=0.0,
                finish_reason_class="unknown",
                result_class=ProviderAttemptResultClass.SUCCESS,
            ),
        )
        self.assertEqual(
            sink.tool_calls[0][1],
            ToolCallRecord(
                duration_milliseconds=0.0,
                result_class=ToolResultClass.UNKNOWN,
                tool_category=ToolCategory.UNKNOWN,
            ),
        )

    def test_tool_result_classes_and_duration_bounds_use_post_hook_only(self) -> None:
        cases = (
            ("ok", ToolResultClass.SUCCESS, -1, 0.0),
            ("error", ToolResultClass.FAILURE, 2, 2.0),
            ("blocked", ToolResultClass.BLOCKED, 86_400_001, 86_400_000.0),
            ("cancelled", ToolResultClass.CANCELLED, 3.5, 3.5),
            ("timeout", ToolResultClass.TIMEOUT, float("nan"), 0.0),
            ("other", ToolResultClass.UNKNOWN, True, 0.0),
        )
        for index, (status, result_class, duration, expected_duration) in enumerate(cases):
            with self.subTest(status=status):
                sink = _RecordingSink()
                mapper = ManagedFrameworkObservability(
                    sink=sink,
                    max_inflight_observations=1,
                )
                mapper.on_post_tool_call(
                    turn_id=f"turn-{index}",
                    tool_name="tool_portal_call" if index == 0 else "terminal",
                    duration_ms=duration,
                    status=status,
                )
                record = sink.tool_calls[0][1]
                self.assertEqual(record.result_class, result_class)
                self.assertEqual(record.duration_milliseconds, expected_duration)
                self.assertEqual(
                    record.tool_category,
                    ToolCategory.TOOL_PORTAL if index == 0 else ToolCategory.HERMES_TOOL,
                )

    def test_maps_drop_n_plus_one_without_evicting_and_reuse_capacity_after_match(self) -> None:
        sink = _RecordingSink()
        mapper = ManagedFrameworkObservability(
            sink=sink,
            max_inflight_observations=2,
        )
        mapper.on_pre_llm_call(turn_id="turn-1", platform="cli")
        mapper.on_pre_llm_call(turn_id="turn-2", platform="cli")
        mapper.on_pre_llm_call(turn_id="turn-3", platform="cli")
        mapper.on_pre_api_request(turn_id="turn-1", api_request_id="api-1")
        mapper.on_pre_api_request(turn_id="turn-2", api_request_id="api-2")
        mapper.on_pre_api_request(turn_id="turn-3", api_request_id="api-3")

        self.assertEqual(len(sink.turn_starts), 2)
        self.assertEqual(len(sink.provider_starts), 2)

        mapper.on_session_end(turn_id="turn-1", completed=True, interrupted=False)
        mapper.on_api_request_error(
            turn_id="turn-2",
            api_request_id="api-2",
            api_duration=1,
        )
        mapper.on_pre_llm_call(turn_id="turn-3", platform="cli")
        mapper.on_pre_api_request(turn_id="turn-3", api_request_id="api-3")

        self.assertEqual(len(sink.turn_starts), 3)
        self.assertEqual(len(sink.provider_starts), 3)
        mapper.on_session_end(turn_id="turn-2", completed=True, interrupted=False)
        self.assertEqual(
            [record.result_class for _, record in sink.turn_completions],
            [TurnResultClass.SUCCESS, TurnResultClass.SUCCESS],
        )

    def test_completion_requires_matching_turn_and_api_identifiers(self) -> None:
        sink = _RecordingSink()
        mapper = ManagedFrameworkObservability(
            sink=sink,
            max_inflight_observations=2,
        )
        mapper.on_pre_llm_call(turn_id="turn", platform="cli")
        mapper.on_pre_api_request(turn_id="turn", api_request_id="api")

        mapper.on_post_api_request(
            turn_id="wrong-turn",
            api_request_id="api",
            api_duration=1,
        )
        mapper.on_session_end(turn_id="missing", completed=True, interrupted=False)
        self.assertEqual(sink.provider_completions, [])
        self.assertEqual(sink.turn_completions, [])

        mapper.on_post_api_request(
            turn_id="turn",
            api_request_id="api",
            api_duration=1,
        )
        mapper.on_post_api_request(
            turn_id="turn",
            api_request_id="api",
            api_duration=1,
        )
        mapper.on_session_end(turn_id="turn", completed=True, interrupted=False)
        mapper.on_session_end(turn_id="turn", completed=True, interrupted=False)
        self.assertEqual(len(sink.provider_completions), 1)
        self.assertEqual(len(sink.turn_completions), 1)

    def test_on_session_end_closes_only_matching_turn_and_its_attempts(self) -> None:
        sink = _RecordingSink()
        mapper = ManagedFrameworkObservability(
            sink=sink,
            max_inflight_observations=4,
        )
        mapper.on_pre_llm_call(turn_id="turn-a", platform="cli")
        mapper.on_pre_llm_call(turn_id="turn-b", platform="discord")
        mapper.on_pre_api_request(turn_id="turn-a", api_request_id="api-a")
        mapper.on_pre_api_request(turn_id="turn-b", api_request_id="api-b")

        mapper.on_session_end(completed=False, interrupted=True)
        self.assertEqual(sink.turn_completions, [])
        self.assertEqual(sink.provider_completions, [])

        mapper.on_session_end(
            turn_id="turn-a",
            completed=False,
            interrupted=True,
        )
        self.assertEqual(
            sink.turn_completions[0][1].result_class,
            TurnResultClass.INTERRUPTED,
        )
        self.assertEqual(
            sink.provider_completions[0][1].result_class,
            ProviderAttemptResultClass.UNKNOWN,
        )
        mapper.on_session_end(turn_id="turn-b", completed=True, interrupted=False)
        mapper.on_post_api_request(
            turn_id="turn-b",
            api_request_id="api-b",
            api_duration=1,
        )
        self.assertEqual(len(sink.turn_completions), 2)
        self.assertEqual(len(sink.provider_completions), 2)

    def test_on_session_end_preserves_authoritative_failure_outcome(self) -> None:
        sink = _RecordingSink()
        mapper = ManagedFrameworkObservability(
            sink=sink,
            max_inflight_observations=2,
        )
        mapper.on_pre_llm_call(turn_id="turn", platform="cli")

        mapper.on_session_end(
            turn_id="turn",
            completed=False,
            interrupted=False,
        )

        self.assertEqual(
            sink.turn_completions,
            [
                (
                    sink.turn_starts[0][0],
                    TurnCompletedRecord(result_class=TurnResultClass.FAILURE),
                )
            ],
        )

    def test_shutdown_snapshots_then_drains_attempts_and_turns(self) -> None:
        sink = _RecordingSink()
        mapper = ManagedFrameworkObservability(
            sink=sink,
            max_inflight_observations=3,
        )
        mapper.on_pre_llm_call(turn_id="turn", platform="cli")
        mapper.on_pre_api_request(turn_id="turn", api_request_id="api")

        self.assertIsNone(mapper.shutdown())
        self.assertEqual(
            sink.provider_completions[0][1].result_class,
            ProviderAttemptResultClass.UNKNOWN,
        )
        self.assertEqual(
            sink.turn_completions[0][1].result_class,
            TurnResultClass.ABANDONED,
        )
        self.assertIsNone(mapper.shutdown())
        self.assertEqual(len(sink.provider_completions), 1)
        self.assertEqual(len(sink.turn_completions), 1)

    def test_interleaved_turns_and_attempts_keep_parent_and_attributes_isolated(self) -> None:
        sink = _RecordingSink()
        mapper = ManagedFrameworkObservability(
            sink=sink,
            max_inflight_observations=4,
        )
        first_started = threading.Event()
        release_first = threading.Event()

        def first_turn() -> None:
            mapper.on_pre_llm_call(turn_id="turn-a", platform="discord")
            mapper.on_pre_api_request(
                turn_id="turn-a",
                api_request_id="api-a",
                provider="provider-a",
                model="model-a",
            )
            first_started.set()
            release_first.wait()
            mapper.on_post_api_request(
                turn_id="turn-a",
                api_request_id="api-a",
                api_duration=1,
            )
            mapper.on_session_end(turn_id="turn-a", completed=True, interrupted=False)

        worker = threading.Thread(target=first_turn)
        worker.start()
        self.assertTrue(first_started.wait(timeout=5))
        mapper.on_pre_llm_call(turn_id="turn-b", platform="slack")
        mapper.on_pre_api_request(
            turn_id="turn-b",
            api_request_id="api-b",
            provider="provider-b",
            model="model-b",
        )
        mapper.on_post_tool_call(
            turn_id="turn-a",
            tool_name="terminal",
            duration_ms=1,
            status="ok",
        )
        mapper.on_post_tool_call(
            turn_id="turn-b",
            tool_name="web_search",
            duration_ms=1,
            status="error",
        )
        release_first.set()
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())

        turn_handles = {record.platform_class: handle for handle, record in sink.turn_starts}
        provider_parents = {
            t.cast("str", record.provider): parent for parent, _, record in sink.provider_starts
        }
        tool_parents = {
            t.cast("str", record.tool_name): parent for parent, record in sink.tool_calls
        }
        self.assertEqual(provider_parents["provider-a"], turn_handles["discord"])
        self.assertEqual(provider_parents["provider-b"], turn_handles["slack"])
        self.assertEqual(tool_parents["terminal"], turn_handles["discord"])
        self.assertEqual(tool_parents["web_search"], turn_handles["slack"])

    def test_sink_failures_are_isolated_from_hook_callbacks(self) -> None:
        class _FailingSink(_RecordingSink):
            @t.override
            def start_turn(self, record: TurnStartedRecord) -> object | None:
                del record
                raise RuntimeError(CONTENT_CANARY)

            @t.override
            def emit_tool_call(
                self,
                parent_handle: object | None,
                record: ToolCallRecord,
            ) -> None:
                del parent_handle, record
                raise RuntimeError(CONTENT_CANARY)

        mapper = ManagedFrameworkObservability(
            sink=_FailingSink(),
            max_inflight_observations=1,
        )
        self.assertIsNone(mapper.on_pre_llm_call(turn_id="turn", platform="cli"))
        self.assertIsNone(
            mapper.on_post_tool_call(
                turn_id="turn",
                tool_name="terminal",
                duration_ms=1,
                status="ok",
            )
        )


if __name__ == "__main__":
    unittest.main()
