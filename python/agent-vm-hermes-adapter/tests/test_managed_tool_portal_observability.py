import os
import threading
import typing as t
import unittest
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

from opentelemetry import trace
from opentelemetry.sdk._logs import ReadableLogRecord
from opentelemetry.sdk._logs.export import LogRecordExporter, LogRecordExportResult
from opentelemetry.sdk.metrics.export import MetricExporter, MetricExportResult, MetricsData
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from agent_vm_hermes_adapter.managed_framework_observability import (
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
from agent_vm_hermes_adapter.managed_tool_portal_observability import (
    _approved_resource_attributes,
    _build_telemetry_resource,
    _duration_milliseconds,
    _encoded_log_record_size,
    _encoded_metric_record_size,
    _encoded_trace_record_size,
    create_hermes_tool_portal_telemetry_from_environment,
)

BASE_ENVIRONMENT = {
    "AGENT_VM_HERMES_OTEL_MAX_INFLIGHT_OBSERVATIONS": "256",
    "AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES": "65536",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel-collector.observability.vm.host:4318",
    "OTEL_LOGS_EXPORTER": "none",
    "OTEL_METRICS_EXPORTER": "none",
    "OTEL_RESOURCE_ATTRIBUTES": (
        "dev.release.channel=beta,"
        "dev.repo.hash=0123456789abcdef,"
        "dev.runtime.flavor=beta,"
        "dev.worktree.hash=fedcba9876543210"
    ),
    "OTEL_SERVICE_NAME": "agent-vm-hermes",
    "OTEL_TRACES_EXPORTER": "none",
}


@contextmanager
def telemetry_environment(**overrides: str) -> Iterator[None]:
    with patch.dict(os.environ, {**BASE_ENVIRONMENT, **overrides}, clear=True):
        yield


class _BlockingSpanExporter(SpanExporter):
    def __init__(self, *, entered: threading.Event, release: threading.Event) -> None:
        self._entered = entered
        self._release = release

    @t.override
    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        del spans
        self._entered.set()
        self._release.wait()
        return SpanExportResult.SUCCESS

    @t.override
    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        del timeout_millis
        return True

    @t.override
    def shutdown(self) -> None:
        return None


class _BlockingLogExporter(LogRecordExporter):
    def __init__(self, *, entered: threading.Event, release: threading.Event) -> None:
        self._entered = entered
        self._release = release

    @t.override
    def export(self, batch: Sequence[ReadableLogRecord]) -> LogRecordExportResult:
        del batch
        self._entered.set()
        self._release.wait()
        return LogRecordExportResult.SUCCESS

    @t.override
    def force_flush(self, timeout_millis: int = 10_000) -> bool:
        del timeout_millis
        return True

    @t.override
    def shutdown(self) -> None:
        return None


class _BlockingMetricExporter(MetricExporter):
    def __init__(self, *, entered: threading.Event, release: threading.Event) -> None:
        super().__init__()
        self._entered = entered
        self._release = release

    @t.override
    def export(
        self,
        metrics_data: MetricsData,
        timeout_millis: float = 10_000,
        **kwargs: object,
    ) -> MetricExportResult:
        del metrics_data, timeout_millis, kwargs
        self._entered.set()
        self._release.wait()
        return MetricExportResult.SUCCESS

    @t.override
    def force_flush(self, timeout_millis: float = 10_000) -> bool:
        del timeout_millis
        return True

    @t.override
    def shutdown(self, timeout_millis: float = 30_000, **kwargs: object) -> None:
        del timeout_millis, kwargs


class _RecordingSpanExporter(SpanExporter):
    def __init__(self) -> None:
        self.spans: list[ReadableSpan] = []

    @t.override
    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS

    @t.override
    def shutdown(self) -> None:
        return None


class _RecordingLogExporter(LogRecordExporter):
    def __init__(self) -> None:
        self.records: list[ReadableLogRecord] = []

    @t.override
    def export(self, batch: Sequence[ReadableLogRecord]) -> LogRecordExportResult:
        self.records.extend(batch)
        return LogRecordExportResult.SUCCESS

    @t.override
    def force_flush(self, timeout_millis: int = 10_000) -> bool:
        del timeout_millis
        return True

    @t.override
    def shutdown(self) -> None:
        return None


class _RecordingMetricExporter(MetricExporter):
    def __init__(self) -> None:
        super().__init__()
        self.exports: list[MetricsData] = []

    @t.override
    def export(
        self,
        metrics_data: MetricsData,
        timeout_millis: float = 10_000,
        **kwargs: object,
    ) -> MetricExportResult:
        del timeout_millis, kwargs
        self.exports.append(metrics_data)
        return MetricExportResult.SUCCESS

    @t.override
    def force_flush(self, timeout_millis: float = 10_000) -> bool:
        del timeout_millis
        return True

    @t.override
    def shutdown(self, timeout_millis: float = 30_000, **kwargs: object) -> None:
        del timeout_millis, kwargs


@t.final
class ManagedToolPortalObservabilityTests(unittest.TestCase):
    def test_absent_managed_contract_is_disabled_without_otel_construction(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=True),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.TracerProvider",
                side_effect=AssertionError("disabled telemetry constructed a tracer provider"),
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.MeterProvider",
                side_effect=AssertionError("disabled telemetry constructed a meter provider"),
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.LoggerProvider",
                side_effect=AssertionError("disabled telemetry constructed a logger provider"),
            ),
        ):
            telemetry = create_hermes_tool_portal_telemetry_from_environment()

        self.assertIsNone(telemetry.trace_context_provider())
        self.assertIsNone(telemetry.shutdown())

    def test_all_signals_disabled_constructs_no_otel_runtime(self) -> None:
        with (
            telemetry_environment(),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.TracerProvider",
                side_effect=AssertionError("disabled telemetry constructed a tracer provider"),
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.MeterProvider",
                side_effect=AssertionError("disabled telemetry constructed a meter provider"),
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.LoggerProvider",
                side_effect=AssertionError("disabled telemetry constructed a logger provider"),
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability._encoded_record_size",
                side_effect=AssertionError("disabled telemetry serialized a record"),
                create=True,
            ),
        ):
            telemetry = create_hermes_tool_portal_telemetry_from_environment()

        with telemetry.observe_tool_operation("tool_portal_list"):
            pass
        telemetry.observe_post_tool_call(
            duration_milliseconds=1,
            status="ok",
            tool_name="tool_portal_list",
        )

        self.assertIsNone(telemetry.trace_context_provider())
        self.assertIsNone(telemetry.shutdown())

    def test_signal_selectors_require_exact_explicit_values(self) -> None:
        for environment_name, environment_value in (
            ("OTEL_TRACES_EXPORTER", ""),
            ("OTEL_TRACES_EXPORTER", "otlp,console"),
            ("OTEL_METRICS_EXPORTER", "console"),
            ("OTEL_LOGS_EXPORTER", "OTLP"),
        ):
            with self.subTest(
                environment_name=environment_name,
                environment_value=environment_value,
            ):
                with telemetry_environment(**{environment_name: environment_value}):
                    with self.assertRaisesRegex(
                        ValueError,
                        environment_name,
                    ):
                        create_hermes_tool_portal_telemetry_from_environment()

    def test_signal_selectors_must_be_present(self) -> None:
        for environment_name in (
            "OTEL_TRACES_EXPORTER",
            "OTEL_METRICS_EXPORTER",
            "OTEL_LOGS_EXPORTER",
        ):
            environment = dict(BASE_ENVIRONMENT)
            del environment[environment_name]
            with self.subTest(environment_name=environment_name):
                with patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(
                        ValueError,
                        environment_name,
                    ):
                        create_hermes_tool_portal_telemetry_from_environment()

    def test_any_partial_lifecycle_contract_requires_signal_selectors(self) -> None:
        for environment_name in (
            "OTEL_BSP_MAX_QUEUE_SIZE",
            "OTEL_BLRP_MAX_QUEUE_SIZE",
            "OTEL_METRIC_EXPORT_INTERVAL",
            "OTEL_TRACES_SAMPLER",
            "OTEL_RESOURCE_ATTRIBUTES",
        ):
            with self.subTest(environment_name=environment_name):
                with patch.dict(os.environ, {environment_name: "test-value"}, clear=True):
                    with self.assertRaisesRegex(ValueError, "OTEL_TRACES_EXPORTER"):
                        create_hermes_tool_portal_telemetry_from_environment()

    def test_rejects_sdk_disabled_and_invalid_admission_limits(self) -> None:
        for environment_name, environment_value in (
            ("OTEL_SDK_DISABLED", "true"),
            ("AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES", "-1"),
            ("AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES", "not-an-integer"),
            ("AGENT_VM_HERMES_OTEL_MAX_INFLIGHT_OBSERVATIONS", "-1"),
            ("AGENT_VM_HERMES_OTEL_MAX_INFLIGHT_OBSERVATIONS", ""),
        ):
            with self.subTest(
                environment_name=environment_name,
                environment_value=environment_value,
            ):
                with telemetry_environment(**{environment_name: environment_value}):
                    with self.assertRaisesRegex(
                        ValueError,
                        environment_name,
                    ):
                        create_hermes_tool_portal_telemetry_from_environment()

    def test_constructs_only_enabled_signal_providers(self) -> None:
        for enabled_signal, environment_overrides in (
            (
                "traces",
                {
                    "OTEL_LOGS_EXPORTER": "none",
                    "OTEL_METRICS_EXPORTER": "none",
                    "OTEL_TRACES_EXPORTER": "otlp",
                },
            ),
            (
                "metrics",
                {
                    "OTEL_LOGS_EXPORTER": "none",
                    "OTEL_METRICS_EXPORTER": "otlp",
                    "OTEL_TRACES_EXPORTER": "none",
                },
            ),
            (
                "logs",
                {
                    "OTEL_LOGS_EXPORTER": "otlp",
                    "OTEL_METRICS_EXPORTER": "none",
                    "OTEL_TRACES_EXPORTER": "none",
                },
            ),
        ):
            with self.subTest(enabled_signal=enabled_signal):
                logger_provider = MagicMock()
                meter_provider = MagicMock()
                tracer_provider = MagicMock()
                with (
                    telemetry_environment(**environment_overrides),
                    patch(
                        "agent_vm_hermes_adapter.managed_tool_portal_observability.LoggerProvider",
                        return_value=logger_provider,
                    ) as logger_provider_constructor,
                    patch(
                        "agent_vm_hermes_adapter.managed_tool_portal_observability.MeterProvider",
                        return_value=meter_provider,
                    ) as meter_provider_constructor,
                    patch(
                        "agent_vm_hermes_adapter.managed_tool_portal_observability.TracerProvider",
                        return_value=tracer_provider,
                    ) as tracer_provider_constructor,
                    patch(
                        "agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPLogExporter"
                    ),
                    patch(
                        "agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPMetricExporter"
                    ),
                    patch(
                        "agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPSpanExporter"
                    ),
                    patch(
                        "agent_vm_hermes_adapter.managed_tool_portal_observability.BatchLogRecordProcessor"
                    ),
                    patch(
                        "agent_vm_hermes_adapter.managed_tool_portal_observability.PeriodicExportingMetricReader"
                    ),
                    patch(
                        "agent_vm_hermes_adapter.managed_tool_portal_observability.BatchSpanProcessor"
                    ),
                ):
                    telemetry = create_hermes_tool_portal_telemetry_from_environment()

                self.assertEqual(
                    logger_provider_constructor.call_count,
                    int(enabled_signal == "logs"),
                )
                self.assertEqual(
                    meter_provider_constructor.call_count,
                    int(enabled_signal == "metrics"),
                )
                self.assertEqual(
                    tracer_provider_constructor.call_count,
                    int(enabled_signal == "traces"),
                )
                telemetry.shutdown()

    def test_provider_initialization_failure_disables_only_that_signal(self) -> None:
        meter_provider = MagicMock()
        tracer_provider = MagicMock()
        with (
            telemetry_environment(
                OTEL_LOGS_EXPORTER="otlp",
                OTEL_METRICS_EXPORTER="otlp",
                OTEL_TRACES_EXPORTER="otlp",
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.LoggerProvider",
                side_effect=RuntimeError("test-only log provider failure"),
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.MeterProvider",
                return_value=meter_provider,
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.TracerProvider",
                return_value=tracer_provider,
            ),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPLogExporter"),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPMetricExporter"),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPSpanExporter"),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.BatchLogRecordProcessor"
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.PeriodicExportingMetricReader"
            ),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.BatchSpanProcessor"),
        ):
            telemetry = create_hermes_tool_portal_telemetry_from_environment()

        telemetry.observe_post_tool_call(
            duration_milliseconds=1,
            status="ok",
            tool_name="tool_portal_list",
        )

        meter = meter_provider.get_meter.return_value
        meter.create_counter.return_value.add.assert_called_once()
        meter.create_histogram.return_value.record.assert_called_once()
        tracer_provider.get_tracer.assert_called_once()

    def test_admits_only_closed_controller_resource_attributes(self) -> None:
        resource_environment = (
            "dev.release.channel=beta,"
            "dev.repo.hash=0123456789abcdef,"
            "dev.runtime.flavor=beta,"
            "dev.worktree.hash=fedcba9876543210,"
            "service.name=untrusted-service,"
            "secret.token=secret-canary"
        )
        with telemetry_environment(OTEL_RESOURCE_ATTRIBUTES=resource_environment):
            resource = _build_telemetry_resource("agent-vm-hermes")

        self.assertEqual(
            dict(resource.attributes),
            {
                "dev.release.channel": "beta",
                "dev.repo.hash": "0123456789abcdef",
                "dev.runtime.flavor": "beta",
                "dev.worktree.hash": "fedcba9876543210",
                "service.name": "agent-vm-hermes",
                "telemetry.sdk.language": "python",
                "telemetry.sdk.name": "opentelemetry",
                "telemetry.sdk.version": resource.attributes["telemetry.sdk.version"],
            },
        )

    def test_omits_malformed_and_duplicate_resource_attributes(self) -> None:
        attributes = _approved_resource_attributes(
            "dev.release.channel=beta,"
            "dev.release.channel=duplicate,"
            "dev.repo.hash=not-a-hash,"
            "dev.runtime.flavor=invalid%20value,"
            "dev.worktree.hash=fedcba9876543210,"
            "malformed"
        )

        self.assertEqual(attributes, {"dev.worktree.hash": "fedcba9876543210"})
        for duplicate_entries in (
            "dev.release.channel=beta,dev.release.channel=INVALID%20SECRET",
            "dev.release.channel=INVALID%20SECRET,dev.release.channel=beta",
        ):
            with self.subTest(duplicate_entries=duplicate_entries):
                self.assertEqual(_approved_resource_attributes(duplicate_entries), {})

    def test_tool_duration_is_finite_and_bounded(self) -> None:
        for value, expected in (
            (float("nan"), 0.0),
            (float("inf"), 0.0),
            (-1, 0.0),
            (86_400_000, 86_400_000.0),
            (86_400_001, 86_400_000.0),
        ):
            with self.subTest(value=value):
                self.assertEqual(_duration_milliseconds(value), expected)

    def test_enforces_record_size_before_log_and_metric_admission(self) -> None:
        logger_provider = MagicMock()
        meter_provider = MagicMock()
        with (
            telemetry_environment(
                AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES="10",
                OTEL_LOGS_EXPORTER="otlp",
                OTEL_METRICS_EXPORTER="otlp",
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.LoggerProvider",
                return_value=logger_provider,
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.MeterProvider",
                return_value=meter_provider,
            ),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPLogExporter"),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPMetricExporter"),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.BatchLogRecordProcessor"
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.PeriodicExportingMetricReader"
            ),
        ):
            telemetry = create_hermes_tool_portal_telemetry_from_environment()

        logger = logger_provider.get_logger.return_value
        meter = meter_provider.get_meter.return_value
        counter = meter.create_counter.return_value
        histogram = meter.create_histogram.return_value
        attributes = {
            "agent_vm.operation.category": "tool_portal",
            "agent_vm.operation.name": "tool_portal_list",
            "agent_vm.result.class": "success",
        }
        signal_cases = (
            (
                "log",
                _encoded_log_record_size(
                    "hermes.tool_portal.operation.completed",
                    attributes,
                ),
                logger.emit,
            ),
            (
                "counter",
                _encoded_metric_record_size(
                    "hermes.tool_portal.operations_total",
                    1,
                    attributes,
                    unit="1",
                ),
                counter.add,
            ),
            (
                "histogram",
                _encoded_metric_record_size(
                    "hermes.tool_portal.operation.duration",
                    1.0,
                    attributes,
                    unit="ms",
                ),
                histogram.record,
            ),
        )
        for signal_name, encoded_size, signal_method in signal_cases:
            for configured_limit, expected_call_count in (
                (encoded_size - 1, 0),
                (encoded_size, 1),
            ):
                with self.subTest(
                    signal_name=signal_name,
                    configured_limit=configured_limit,
                ):
                    setattr(telemetry, "_max_record_bytes", configured_limit)
                    logger.reset_mock()
                    counter.reset_mock()
                    histogram.reset_mock()
                    telemetry.observe_post_tool_call(
                        duration_milliseconds=1,
                        status="ok",
                        tool_name="tool_portal_list",
                    )
                    self.assertEqual(signal_method.call_count, expected_call_count)

    def test_enforces_record_size_before_trace_admission(self) -> None:
        tracer_provider = MagicMock()
        with (
            telemetry_environment(OTEL_TRACES_EXPORTER="otlp"),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.TracerProvider",
                return_value=tracer_provider,
            ),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPSpanExporter"),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.BatchSpanProcessor"),
        ):
            telemetry = create_hermes_tool_portal_telemetry_from_environment()

        attributes = {
            "agent_vm.operation.category": "tool_portal",
            "agent_vm.operation.name": "tool_portal_list",
        }
        encoded_size = _encoded_trace_record_size(
            "hermes.tool_portal.operation",
            attributes,
        )
        tracer = tracer_provider.get_tracer.return_value
        for configured_limit, expected_call_count in (
            (encoded_size - 1, 0),
            (encoded_size, 1),
        ):
            with self.subTest(configured_limit=configured_limit):
                setattr(telemetry, "_max_record_bytes", configured_limit)
                tracer.reset_mock()
                with telemetry.observe_tool_operation("tool_portal_list"):
                    pass
                self.assertEqual(
                    tracer.start_as_current_span.call_count,
                    expected_call_count,
                )

    def test_shutdown_attempts_each_action_and_provider_after_failures(self) -> None:
        providers = [MagicMock(), MagicMock(), MagicMock()]
        for provider in providers:
            provider.force_flush.side_effect = RuntimeError("test-only flush failure")
            provider.shutdown.side_effect = RuntimeError("test-only shutdown failure")
        with (
            telemetry_environment(
                OTEL_LOGS_EXPORTER="otlp",
                OTEL_METRICS_EXPORTER="otlp",
                OTEL_TRACES_EXPORTER="otlp",
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.LoggerProvider",
                return_value=providers[0],
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.MeterProvider",
                return_value=providers[1],
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.TracerProvider",
                return_value=providers[2],
            ),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPLogExporter"),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPMetricExporter"),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPSpanExporter"),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.BatchLogRecordProcessor"
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.PeriodicExportingMetricReader"
            ),
            patch("agent_vm_hermes_adapter.managed_tool_portal_observability.BatchSpanProcessor"),
        ):
            telemetry = create_hermes_tool_portal_telemetry_from_environment()

        telemetry.shutdown()

        for provider in providers:
            provider.force_flush.assert_called_once()
            provider.shutdown.assert_called_once()

    def test_callbacks_return_while_all_exporters_are_blocked(self) -> None:
        baseline_otel_thread_ids = {
            thread.ident for thread in threading.enumerate() if thread.name.startswith("Otel")
        }
        release_exporters = threading.Event()
        trace_export_entered = threading.Event()
        metric_export_entered = threading.Event()
        log_export_entered = threading.Event()
        callback_completed = threading.Event()
        with (
            telemetry_environment(
                OTEL_BLRP_SCHEDULE_DELAY="10",
                OTEL_BSP_SCHEDULE_DELAY="10",
                OTEL_LOGS_EXPORTER="otlp",
                OTEL_METRIC_EXPORT_INTERVAL="10",
                OTEL_METRICS_EXPORTER="otlp",
                OTEL_TRACES_EXPORTER="otlp",
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPSpanExporter",
                return_value=_BlockingSpanExporter(
                    entered=trace_export_entered,
                    release=release_exporters,
                ),
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPMetricExporter",
                return_value=_BlockingMetricExporter(
                    entered=metric_export_entered,
                    release=release_exporters,
                ),
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPLogExporter",
                return_value=_BlockingLogExporter(
                    entered=log_export_entered,
                    release=release_exporters,
                ),
            ),
        ):
            telemetry = create_hermes_tool_portal_telemetry_from_environment()
            callback_thread: threading.Thread | None = None
            try:
                with telemetry.observe_tool_operation("tool_portal_list"):
                    pass
                telemetry.observe_post_tool_call(
                    duration_milliseconds=1,
                    status="ok",
                    tool_name="tool_portal_list",
                )
                self.assertTrue(trace_export_entered.wait(timeout=1))
                self.assertTrue(metric_export_entered.wait(timeout=1))
                self.assertTrue(log_export_entered.wait(timeout=1))

                def invoke_callback() -> None:
                    with telemetry.observe_tool_operation("tool_portal_list"):
                        pass
                    telemetry.observe_post_tool_call(
                        duration_milliseconds=1,
                        status="ok",
                        tool_name="tool_portal_list",
                    )
                    turn_handle = telemetry.start_turn(TurnStartedRecord(platform_class="discord"))
                    provider_handle = telemetry.start_provider_attempt(
                        turn_handle,
                        ProviderAttemptStartedRecord(
                            model="test-model",
                            provider="test-provider",
                        ),
                    )
                    if provider_handle is not None:
                        telemetry.complete_provider_attempt(
                            provider_handle,
                            ProviderAttemptCompletedRecord(
                                duration_milliseconds=1,
                                result_class=ProviderAttemptResultClass.SUCCESS,
                            ),
                        )
                    telemetry.emit_tool_call(
                        turn_handle,
                        ToolCallRecord(
                            duration_milliseconds=1,
                            result_class=ToolResultClass.SUCCESS,
                            tool_category=ToolCategory.HERMES_TOOL,
                            tool_name="terminal",
                        ),
                    )
                    if turn_handle is not None:
                        telemetry.complete_turn(
                            turn_handle,
                            TurnCompletedRecord(result_class=TurnResultClass.SUCCESS),
                        )
                    callback_completed.set()

                callback_thread = threading.Thread(target=invoke_callback)
                callback_thread.start()
                self.assertTrue(callback_completed.wait(timeout=1))
                self.assertFalse(release_exporters.is_set())
            finally:
                release_exporters.set()
                if callback_thread is not None:
                    callback_thread.join(timeout=1)
                telemetry.shutdown()
            if callback_thread is not None:
                self.assertFalse(callback_thread.is_alive())
            self.assertEqual(
                {
                    thread.ident
                    for thread in threading.enumerate()
                    if thread.name.startswith("Otel")
                },
                baseline_otel_thread_ids,
            )

    def test_framework_sink_uses_explicit_parent_and_emits_all_signals(self) -> None:
        span_exporter = _RecordingSpanExporter()
        log_exporter = _RecordingLogExporter()
        metric_exporter = _RecordingMetricExporter()
        with (
            telemetry_environment(
                OTEL_BLRP_SCHEDULE_DELAY="10",
                OTEL_BSP_SCHEDULE_DELAY="10",
                OTEL_LOGS_EXPORTER="otlp",
                OTEL_METRIC_EXPORT_INTERVAL="10",
                OTEL_METRICS_EXPORTER="otlp",
                OTEL_TRACES_EXPORTER="otlp",
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPSpanExporter",
                return_value=span_exporter,
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPLogExporter",
                return_value=log_exporter,
            ),
            patch(
                "agent_vm_hermes_adapter.managed_tool_portal_observability.OTLPMetricExporter",
                return_value=metric_exporter,
            ),
        ):
            telemetry = create_hermes_tool_portal_telemetry_from_environment()

        self.assertFalse(trace.get_current_span().get_span_context().is_valid)
        turn_handle = telemetry.start_turn(TurnStartedRecord(platform_class="discord"))
        provider_handle = telemetry.start_provider_attempt(
            turn_handle,
            ProviderAttemptStartedRecord(
                model="test-model",
                provider="test-provider",
            ),
        )
        if provider_handle is None or turn_handle is None:
            self.fail("enabled framework telemetry did not create observation handles")
        telemetry.complete_provider_attempt(
            provider_handle,
            ProviderAttemptCompletedRecord(
                duration_milliseconds=12,
                result_class=ProviderAttemptResultClass.SUCCESS,
                usage_input_tokens=3,
                usage_output_tokens=5,
            ),
        )
        telemetry.emit_tool_call(
            turn_handle,
            ToolCallRecord(
                duration_milliseconds=7,
                result_class=ToolResultClass.SUCCESS,
                tool_category=ToolCategory.HERMES_TOOL,
                tool_name="terminal",
            ),
        )
        telemetry.complete_turn(
            turn_handle,
            TurnCompletedRecord(result_class=TurnResultClass.SUCCESS),
        )
        self.assertFalse(trace.get_current_span().get_span_context().is_valid)
        telemetry.shutdown()

        spans_by_name = {span.name: span for span in span_exporter.spans}
        self.assertEqual(
            set(spans_by_name),
            {"hermes.llm.request", "hermes.tool.call", "hermes.turn"},
        )
        turn_span_id = spans_by_name["hermes.turn"].context.span_id
        provider_parent = spans_by_name["hermes.llm.request"].parent
        tool_parent = spans_by_name["hermes.tool.call"].parent
        if provider_parent is None or tool_parent is None:
            self.fail("framework child spans did not retain explicit turn parents")
        self.assertEqual(provider_parent.span_id, turn_span_id)
        self.assertEqual(tool_parent.span_id, turn_span_id)

        log_event_names = {
            record.log_record.event_name
            for record in log_exporter.records
            if record.log_record.event_name is not None
        }
        self.assertEqual(
            log_event_names,
            {
                "hermes.llm.request.completed",
                "hermes.tool.call.completed",
                "hermes.turn.completed",
            },
        )
        metric_names = {
            metric.name
            for export in metric_exporter.exports
            for resource_metrics in export.resource_metrics
            for scope_metrics in resource_metrics.scope_metrics
            for metric in scope_metrics.metrics
        }
        self.assertEqual(
            metric_names,
            {
                "hermes.llm.input_tokens",
                "hermes.llm.output_tokens",
                "hermes.llm.request.duration",
                "hermes.llm.requests_total",
                "hermes.tool.call.duration",
                "hermes.tool.calls_total",
                "hermes.turn.duration",
                "hermes.turns_total",
            },
        )


if __name__ == "__main__":
    unittest.main()
