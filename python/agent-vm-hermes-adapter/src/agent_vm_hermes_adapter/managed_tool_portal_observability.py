"""Bounded process-owned OpenTelemetry for managed Hermes Tool Portal calls."""

import contextlib
import json
import logging
import math
import os
import re
import time
import typing as t
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from urllib.parse import unquote_to_bytes

from opentelemetry import trace
from opentelemetry._logs import SeverityNumber
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.metrics import Counter, Histogram
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import (
    SERVICE_NAME,
    TELEMETRY_SDK_LANGUAGE,
    TELEMETRY_SDK_NAME,
    TELEMETRY_SDK_VERSION,
    Resource,
)
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.version import __version__ as OPENTELEMETRY_SDK_VERSION
from opentelemetry.trace import Span, Status, StatusCode
from opentelemetry.util.types import AttributeValue

from .managed_framework_observability import (
    ProviderAttemptCompletedRecord,
    ProviderAttemptStartedRecord,
    ToolCallRecord,
    TurnCompletedRecord,
    TurnStartedRecord,
)

_INSTRUMENTATION_NAME = "agent-vm-hermes"
_OPERATION_CATEGORY = "tool_portal"
_OPERATION_LOG_NAME = "hermes.tool_portal.operation.completed"
_OPERATION_COUNTER_NAME = "hermes.tool_portal.operations_total"
_OPERATION_DURATION_NAME = "hermes.tool_portal.operation.duration"
_SIGNAL_EXPORTER_ENVIRONMENT_NAMES = (
    "OTEL_TRACES_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
)
_MAX_RECORD_BYTES_ENVIRONMENT_NAME = "AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES"
_MAX_INFLIGHT_OBSERVATIONS_ENVIRONMENT_NAME = "AGENT_VM_HERMES_OTEL_MAX_INFLIGHT_OBSERVATIONS"
_MANAGED_OTEL_CONTRACT_ENVIRONMENT_NAMES = (
    "AGENT_VM_HERMES_OTEL_MAX_INFLIGHT_OBSERVATIONS",
    "AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES",
    "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE",
    "OTEL_BLRP_MAX_QUEUE_SIZE",
    "OTEL_BLRP_SCHEDULE_DELAY",
    "OTEL_BSP_MAX_EXPORT_BATCH_SIZE",
    "OTEL_BSP_MAX_QUEUE_SIZE",
    "OTEL_BSP_SCHEDULE_DELAY",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_LOGS_EXPORTER",
    "OTEL_METRIC_EXPORT_INTERVAL",
    "OTEL_METRICS_EXPORTER",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_SERVICE_NAME",
    "OTEL_TRACES_EXPORTER",
    "OTEL_TRACES_SAMPLER",
    "OTEL_TRACES_SAMPLER_ARG",
)
_APPROVED_RESOURCE_ATTRIBUTE_NAMES = frozenset(
    {
        "dev.release.channel",
        "dev.repo.hash",
        "dev.runtime.flavor",
        "dev.worktree.hash",
    }
)
_RESOURCE_CATEGORY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_RESOURCE_HASH_PATTERN = re.compile(r"^[a-f0-9]{16}$")


class HermesTelemetryConfigurationError(ValueError):
    """Raised when the controller-authored telemetry environment is invalid."""


class _FlushableProvider(t.Protocol):
    def force_flush(self) -> object: ...

    def shutdown(self) -> object: ...


class _HermesTelemetryConfiguration:
    __slots__ = (
        "endpoint",
        "logs_enabled",
        "max_inflight_observations",
        "max_record_bytes",
        "metrics_enabled",
        "service_name",
        "traces_enabled",
    )

    def __init__(
        self,
        *,
        endpoint: str | None,
        logs_enabled: bool,
        max_inflight_observations: int,
        max_record_bytes: int,
        metrics_enabled: bool,
        service_name: str | None,
        traces_enabled: bool,
    ) -> None:
        self.endpoint = endpoint
        self.logs_enabled = logs_enabled
        self.max_inflight_observations = max_inflight_observations
        self.max_record_bytes = max_record_bytes
        self.metrics_enabled = metrics_enabled
        self.service_name = service_name
        self.traces_enabled = traces_enabled

    @property
    def any_signal_enabled(self) -> bool:
        return self.logs_enabled or self.metrics_enabled or self.traces_enabled


def _required_signal_enabled(environment_name: str) -> bool:
    value = os.environ.get(environment_name)
    if value == "otlp":
        return True
    if value == "none":
        return False
    raise HermesTelemetryConfigurationError(
        f"{environment_name} must be the exact value 'otlp' or 'none'."
    )


def _required_non_negative_integer(environment_name: str) -> int:
    value = os.environ.get(environment_name)
    if value is None or not value.isascii() or not value.isdecimal():
        raise HermesTelemetryConfigurationError(
            f"{environment_name} must be a non-negative base-10 integer."
        )
    return int(value)


def _load_telemetry_configuration() -> _HermesTelemetryConfiguration:
    if "OTEL_SDK_DISABLED" in os.environ:
        raise HermesTelemetryConfigurationError(
            "OTEL_SDK_DISABLED is reserved by the managed Hermes telemetry runtime."
        )
    if not any(
        environment_name in os.environ
        for environment_name in _MANAGED_OTEL_CONTRACT_ENVIRONMENT_NAMES
    ):
        return _HermesTelemetryConfiguration(
            endpoint=None,
            logs_enabled=False,
            max_inflight_observations=0,
            max_record_bytes=0,
            metrics_enabled=False,
            service_name=None,
            traces_enabled=False,
        )
    traces_enabled, metrics_enabled, logs_enabled = (
        _required_signal_enabled(environment_name)
        for environment_name in _SIGNAL_EXPORTER_ENVIRONMENT_NAMES
    )
    configuration = _HermesTelemetryConfiguration(
        endpoint=os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"),
        logs_enabled=logs_enabled,
        max_inflight_observations=_required_non_negative_integer(
            _MAX_INFLIGHT_OBSERVATIONS_ENVIRONMENT_NAME
        ),
        max_record_bytes=_required_non_negative_integer(_MAX_RECORD_BYTES_ENVIRONMENT_NAME),
        metrics_enabled=metrics_enabled,
        service_name=os.environ.get("OTEL_SERVICE_NAME"),
        traces_enabled=traces_enabled,
    )
    if configuration.any_signal_enabled:
        if not configuration.endpoint:
            raise HermesTelemetryConfigurationError(
                "OTEL_EXPORTER_OTLP_ENDPOINT is required when a telemetry signal is enabled."
            )
        if not configuration.service_name:
            raise HermesTelemetryConfigurationError(
                "OTEL_SERVICE_NAME is required when a telemetry signal is enabled."
            )
    return configuration


def _encoded_record_size(record: Mapping[str, object]) -> int:
    return len(
        json.dumps(
            dict(record),
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    )


def _encoded_trace_record_size(
    span_name: str,
    attributes: Mapping[str, object],
) -> int:
    return _encoded_record_size(
        {
            "attributes": dict(attributes),
            "signal": "trace",
            "span_name": span_name,
            "status_code": "error",
        }
    )


def _encoded_log_record_size(
    event_name: str,
    attributes: Mapping[str, object],
) -> int:
    return _encoded_record_size(
        {
            "attributes": dict(attributes),
            "body": event_name,
            "event_name": event_name,
            "severity_number": SeverityNumber.INFO.value,
            "severity_text": "INFO",
            "signal": "log",
        }
    )


def _encoded_metric_record_size(
    metric_name: str,
    value: int | float,
    attributes: Mapping[str, object],
    *,
    unit: str,
) -> int:
    return _encoded_record_size(
        {
            "attributes": dict(attributes),
            "metric_name": metric_name,
            "signal": "metric",
            "unit": unit,
            "value": value,
        }
    )


def _decode_resource_component(value: str) -> str | None:
    try:
        return unquote_to_bytes(value).decode("utf-8")
    except (UnicodeDecodeError, ValueError):
        return None


def _resource_value_is_valid(attribute_name: str, value: str) -> bool:
    if attribute_name in {"dev.repo.hash", "dev.worktree.hash"}:
        return _RESOURCE_HASH_PATTERN.fullmatch(value) is not None
    return _RESOURCE_CATEGORY_PATTERN.fullmatch(value) is not None


def _approved_resource_attributes(environment_value: str | None) -> dict[str, str]:
    if environment_value is None:
        return {}
    admitted_attributes: dict[str, str] = {}
    rejected_attribute_names: set[str] = set()
    seen_attribute_names: set[str] = set()
    for encoded_entry in environment_value.split(","):
        if encoded_entry.count("=") != 1:
            continue
        encoded_name, encoded_value = encoded_entry.split("=", 1)
        attribute_name = _decode_resource_component(encoded_name)
        attribute_value = _decode_resource_component(encoded_value)
        if attribute_name in _APPROVED_RESOURCE_ATTRIBUTE_NAMES:
            if attribute_name in seen_attribute_names:
                rejected_attribute_names.add(attribute_name)
                admitted_attributes.pop(attribute_name, None)
                continue
            seen_attribute_names.add(attribute_name)
        if (
            attribute_name not in _APPROVED_RESOURCE_ATTRIBUTE_NAMES
            or attribute_value is None
            or not _resource_value_is_valid(attribute_name, attribute_value)
        ):
            continue
        admitted_attributes[attribute_name] = attribute_value
    for rejected_attribute_name in rejected_attribute_names:
        admitted_attributes.pop(rejected_attribute_name, None)
    return admitted_attributes


def _build_telemetry_resource(service_name: str) -> Resource:
    return Resource(
        {
            SERVICE_NAME: service_name,
            TELEMETRY_SDK_LANGUAGE: "python",
            TELEMETRY_SDK_NAME: "opentelemetry",
            TELEMETRY_SDK_VERSION: OPENTELEMETRY_SDK_VERSION,
            **_approved_resource_attributes(os.environ.get("OTEL_RESOURCE_ATTRIBUTES")),
        }
    )


def _provider_started_attributes(
    record: ProviderAttemptStartedRecord,
) -> dict[str, AttributeValue]:
    attributes: dict[str, AttributeValue] = {
        "agent_vm.operation.category": "provider_attempt",
        "agent_vm.operation.name": "llm_request",
        "agent_vm.result.class": "unknown",
        "hermes.api.mode": record.api_mode.value,
    }
    if record.api_call_count is not None:
        attributes["hermes.api.call_count"] = record.api_call_count
    if record.model is not None:
        attributes["hermes.model"] = record.model
    if record.provider is not None:
        attributes["hermes.provider"] = record.provider
    return attributes


def _provider_completed_attributes(
    record: ProviderAttemptCompletedRecord,
) -> dict[str, AttributeValue]:
    attributes: dict[str, AttributeValue] = {
        "agent_vm.result.class": record.result_class.value,
    }
    optional_attributes = {
        "hermes.failover.reason": record.failover_reason,
        "hermes.finish_reason.class": record.finish_reason_class,
        "http.response.status_class": record.http_status_class,
        "hermes.retry.count": record.retry_count,
        "hermes.retryable": record.retryable,
        "hermes.usage.input_tokens": record.usage_input_tokens,
        "hermes.usage.output_tokens": record.usage_output_tokens,
    }
    attributes.update(
        {
            attribute_name: attribute_value
            for attribute_name, attribute_value in optional_attributes.items()
            if attribute_value is not None
        }
    )
    return attributes


def _provider_metric_attributes(
    attributes: Mapping[str, AttributeValue],
) -> dict[str, AttributeValue]:
    admitted_attribute_names = {
        "agent_vm.operation.category",
        "agent_vm.operation.name",
        "agent_vm.result.class",
        "hermes.api.mode",
        "hermes.failover.reason",
        "hermes.provider",
    }
    return {
        attribute_name: attribute_value
        for attribute_name, attribute_value in attributes.items()
        if attribute_name in admitted_attribute_names
    }


@dataclass(frozen=True)
class _FrameworkTurnHandle:
    platform_class: str
    span: Span | None
    started_at_epoch_nanoseconds: int
    started_at_monotonic_nanoseconds: int


@dataclass(frozen=True)
class _FrameworkProviderAttemptHandle:
    span: Span | None
    started_at_epoch_nanoseconds: int
    started_record: ProviderAttemptStartedRecord


class HermesToolPortalTelemetry(t.Protocol):
    max_inflight_observations: int

    @property
    def observer_hooks_enabled(self) -> bool: ...

    @contextlib.contextmanager
    def observe_tool_operation(self, tool_name: str) -> Iterator[None]: ...

    def observe_post_tool_call(
        self,
        *,
        duration_milliseconds: object,
        status: object,
        tool_name: object,
    ) -> None: ...

    def trace_context_provider(self) -> Mapping[str, object] | None: ...

    def shutdown(self) -> None: ...

    def start_turn(self, record: TurnStartedRecord) -> object | None: ...

    def complete_turn(self, handle: object, record: TurnCompletedRecord) -> None: ...

    def start_provider_attempt(
        self,
        parent_handle: object | None,
        record: ProviderAttemptStartedRecord,
    ) -> object | None: ...

    def complete_provider_attempt(
        self,
        handle: object,
        record: ProviderAttemptCompletedRecord,
    ) -> None: ...

    def emit_tool_call(
        self,
        parent_handle: object | None,
        record: ToolCallRecord,
    ) -> None: ...


def _signal_endpoint(base_endpoint: str, signal_path: str) -> str:
    return f"{base_endpoint.rstrip('/')}{signal_path}"


def _safe_tool_name(value: object) -> str | None:
    if not isinstance(value, str) or value not in {
        "tool_portal_list",
        "tool_portal_search",
        "tool_portal_describe",
        "tool_portal_call",
    }:
        return None
    return value


def _result_class(status: object) -> str:
    return "success" if status == "ok" else "failure"


def _duration_milliseconds(value: object) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return 0.0
    duration_milliseconds = float(value)
    if not math.isfinite(duration_milliseconds) or duration_milliseconds < 0:
        return 0.0
    return min(duration_milliseconds, 86_400_000.0)


class _DisabledHermesToolPortalTelemetry:
    observer_hooks_enabled = False
    max_inflight_observations = 0

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


class _OtelHermesToolPortalTelemetry:
    def __init__(self, *, configuration: _HermesTelemetryConfiguration) -> None:
        if configuration.endpoint is None or configuration.service_name is None:
            raise AssertionError("Enabled telemetry configuration was not validated.")
        self.max_inflight_observations = configuration.max_inflight_observations
        self._max_record_bytes = configuration.max_record_bytes
        self._logger_provider: LoggerProvider | None = None
        self._logger = None
        self._meter_provider: MeterProvider | None = None
        self._operation_counter = None
        self._operation_duration = None
        self._framework_counters: dict[str, Counter] = {}
        self._framework_histograms: dict[str, Histogram] = {}
        self._tracer_provider: TracerProvider | None = None
        self._tracer = None
        resource = _build_telemetry_resource(configuration.service_name)
        if configuration.logs_enabled:
            self._initialize_logs(configuration.endpoint, resource)
        if configuration.metrics_enabled:
            self._initialize_metrics(configuration.endpoint, resource)
        if configuration.traces_enabled:
            self._initialize_traces(configuration.endpoint, resource)

    @property
    def observer_hooks_enabled(self) -> bool:
        return (
            self._logger is not None or self._meter_provider is not None or self._tracer is not None
        )

    def _initialize_logs(self, endpoint: str, resource: Resource) -> None:
        provider: LoggerProvider | None = None
        processor: BatchLogRecordProcessor | None = None
        processor_registered = False
        try:
            provider = LoggerProvider(resource=resource)
            processor = BatchLogRecordProcessor(
                OTLPLogExporter(endpoint=_signal_endpoint(endpoint, "/v1/logs"))
            )
            provider.add_log_record_processor(processor)
            processor_registered = True
            logger = provider.get_logger(_INSTRUMENTATION_NAME)
        except Exception:
            _safe_provider_shutdown(provider)
            if not processor_registered:
                _safe_provider_shutdown(processor)
            _log_signal_initialization_failure("logs")
            return
        self._logger_provider = provider
        self._logger = logger

    def _initialize_metrics(self, endpoint: str, resource: Resource) -> None:
        provider: MeterProvider | None = None
        metric_reader: PeriodicExportingMetricReader | None = None
        try:
            metric_reader = PeriodicExportingMetricReader(
                OTLPMetricExporter(endpoint=_signal_endpoint(endpoint, "/v1/metrics"))
            )
            provider = MeterProvider(metric_readers=[metric_reader], resource=resource)
            meter = provider.get_meter(_INSTRUMENTATION_NAME)
            operation_counter = meter.create_counter(_OPERATION_COUNTER_NAME)
            operation_duration = meter.create_histogram(_OPERATION_DURATION_NAME, unit="ms")
            framework_counters = {
                metric_name: meter.create_counter(metric_name)
                for metric_name in (
                    "hermes.turns_total",
                    "hermes.llm.requests_total",
                    "hermes.llm.input_tokens",
                    "hermes.llm.output_tokens",
                    "hermes.tool.calls_total",
                )
            }
            framework_histograms = {
                metric_name: meter.create_histogram(metric_name, unit="ms")
                for metric_name in (
                    "hermes.turn.duration",
                    "hermes.llm.request.duration",
                    "hermes.tool.call.duration",
                )
            }
        except Exception:
            _safe_provider_shutdown(provider)
            if provider is None:
                _safe_provider_shutdown(metric_reader)
            _log_signal_initialization_failure("metrics")
            return
        self._meter_provider = provider
        self._operation_counter = operation_counter
        self._operation_duration = operation_duration
        self._framework_counters = framework_counters
        self._framework_histograms = framework_histograms

    def _initialize_traces(self, endpoint: str, resource: Resource) -> None:
        provider: TracerProvider | None = None
        processor: BatchSpanProcessor | None = None
        processor_registered = False
        try:
            provider = TracerProvider(resource=resource)
            processor = BatchSpanProcessor(
                OTLPSpanExporter(endpoint=_signal_endpoint(endpoint, "/v1/traces"))
            )
            provider.add_span_processor(processor)
            processor_registered = True
            tracer = provider.get_tracer(_INSTRUMENTATION_NAME)
        except Exception:
            _safe_provider_shutdown(provider)
            if not processor_registered:
                _safe_provider_shutdown(processor)
            _log_signal_initialization_failure("traces")
            return
        self._tracer_provider = provider
        self._tracer = tracer

    @contextlib.contextmanager
    def observe_tool_operation(self, tool_name: str) -> Iterator[None]:
        attributes = {
            "agent_vm.operation.category": _OPERATION_CATEGORY,
            "agent_vm.operation.name": tool_name,
        }
        if self._tracer is None or not self._trace_record_is_admitted(
            "hermes.tool_portal.operation",
            attributes,
        ):
            yield
            return
        try:
            span_manager = self._tracer.start_as_current_span(
                "hermes.tool_portal.operation",
                attributes=attributes,
                record_exception=False,
                set_status_on_exception=False,
            )
            span = span_manager.__enter__()
        except Exception:
            yield
            return
        try:
            yield
        except BaseException as error:
            _safe_set_span_status(span, StatusCode.ERROR)
            try:
                span_manager.__exit__(type(error), error, error.__traceback__)
            except Exception:
                pass
            raise
        else:
            _safe_set_span_status(span, StatusCode.OK)
            try:
                span_manager.__exit__(None, None, None)
            except Exception:
                pass

    def observe_post_tool_call(
        self,
        *,
        duration_milliseconds: object,
        status: object,
        tool_name: object,
    ) -> None:
        safe_tool_name = _safe_tool_name(tool_name)
        if safe_tool_name is None:
            return
        self._emit_completion(
            duration_milliseconds=_duration_milliseconds(duration_milliseconds),
            result_class=_result_class(status),
            tool_name=safe_tool_name,
        )

    def trace_context_provider(self) -> Mapping[str, object] | None:
        if self._tracer is None:
            return None
        span_context = trace.get_current_span().get_span_context()
        if not span_context.is_valid:
            return None
        return {
            "traceparent": (
                f"00-{span_context.trace_id:032x}-{span_context.span_id:016x}"
                f"-{int(span_context.trace_flags):02x}"
            )
        }

    def _emit_completion(
        self,
        *,
        duration_milliseconds: float,
        result_class: str,
        tool_name: str,
    ) -> None:
        attributes = {
            "agent_vm.operation.category": _OPERATION_CATEGORY,
            "agent_vm.operation.name": tool_name,
            "agent_vm.result.class": result_class,
        }
        if self._logger is not None and self._log_record_is_admitted(
            _OPERATION_LOG_NAME,
            attributes,
        ):
            try:
                self._logger.emit(
                    event_name=_OPERATION_LOG_NAME,
                    body=_OPERATION_LOG_NAME,
                    attributes=attributes,
                    severity_number=SeverityNumber.INFO,
                    severity_text="INFO",
                )
            except Exception:
                pass
        if self._operation_counter is not None and self._metric_record_is_admitted(
            _OPERATION_COUNTER_NAME,
            1,
            attributes,
            unit="1",
        ):
            try:
                self._operation_counter.add(1, attributes)
            except Exception:
                pass
        if self._operation_duration is not None and self._metric_record_is_admitted(
            _OPERATION_DURATION_NAME,
            duration_milliseconds,
            attributes,
            unit="ms",
        ):
            try:
                self._operation_duration.record(duration_milliseconds, attributes)
            except Exception:
                pass

    def _trace_record_is_admitted(
        self,
        span_name: str,
        attributes: Mapping[str, object],
    ) -> bool:
        try:
            return _encoded_trace_record_size(span_name, attributes) <= self._max_record_bytes
        except Exception:
            return False

    def _log_record_is_admitted(
        self,
        event_name: str,
        attributes: Mapping[str, object],
    ) -> bool:
        try:
            return _encoded_log_record_size(event_name, attributes) <= self._max_record_bytes
        except Exception:
            return False

    def _metric_record_is_admitted(
        self,
        metric_name: str,
        value: int | float,
        attributes: Mapping[str, object],
        *,
        unit: str,
    ) -> bool:
        try:
            return (
                _encoded_metric_record_size(
                    metric_name,
                    value,
                    attributes,
                    unit=unit,
                )
                <= self._max_record_bytes
            )
        except Exception:
            return False

    def shutdown(self) -> None:
        for provider in (
            self._logger_provider,
            self._meter_provider,
            self._tracer_provider,
        ):
            _safe_provider_shutdown(provider)

    def start_turn(self, record: TurnStartedRecord) -> object | None:
        started_at_epoch_nanoseconds = time.time_ns()
        started_at_monotonic_nanoseconds = time.monotonic_ns()
        attributes = {
            "agent_vm.operation.category": "turn",
            "agent_vm.operation.name": "turn",
            "agent_vm.result.class": "unknown",
            "hermes.platform.class": record.platform_class,
        }
        maximum_attributes = {**attributes, "agent_vm.result.class": "interrupted"}
        span = (
            self._start_framework_span(
                "hermes.turn",
                attributes,
                None,
                start_time=started_at_epoch_nanoseconds,
            )
            if self._trace_record_is_admitted("hermes.turn", maximum_attributes)
            else None
        )
        if span is None and self._logger is None and self._meter_provider is None:
            return None
        return _FrameworkTurnHandle(
            platform_class=record.platform_class,
            span=span,
            started_at_epoch_nanoseconds=started_at_epoch_nanoseconds,
            started_at_monotonic_nanoseconds=started_at_monotonic_nanoseconds,
        )

    def complete_turn(self, handle: object, record: TurnCompletedRecord) -> None:
        if not isinstance(handle, _FrameworkTurnHandle):
            return
        result_class = record.result_class.value
        attributes = {
            "agent_vm.operation.category": "turn",
            "agent_vm.operation.name": "turn",
            "agent_vm.result.class": result_class,
            "hermes.platform.class": handle.platform_class,
        }
        duration_milliseconds = _duration_milliseconds(
            (time.monotonic_ns() - handle.started_at_monotonic_nanoseconds) / 1_000_000,
        )
        self._finish_framework_span(
            handle.span,
            result_class,
            attributes,
            end_time=handle.started_at_epoch_nanoseconds + int(duration_milliseconds * 1_000_000),
        )
        self._emit_framework_log("hermes.turn.completed", attributes)
        self._record_framework_metric("hermes.turns_total", 1, attributes)
        self._record_framework_metric("hermes.turn.duration", duration_milliseconds, attributes)

    def start_provider_attempt(
        self,
        parent_handle: object | None,
        record: ProviderAttemptStartedRecord,
    ) -> object | None:
        started_at_epoch_nanoseconds = time.time_ns()
        attributes = _provider_started_attributes(record)
        maximum_attributes = {
            **attributes,
            "agent_vm.result.class": "failure",
            "hermes.failover.reason": "x" * 64,
            "hermes.finish_reason.class": "x" * 64,
            "http.response.status_class": "5xx",
            "hermes.retryable": True,
            "hermes.retry.count": 2_147_483_647,
            "hermes.usage.input_tokens": 2_147_483_647,
            "hermes.usage.output_tokens": 2_147_483_647,
        }
        parent_span = (
            parent_handle.span if isinstance(parent_handle, _FrameworkTurnHandle) else None
        )
        span = (
            self._start_framework_span(
                "hermes.llm.request",
                attributes,
                parent_span,
                start_time=started_at_epoch_nanoseconds,
            )
            if self._trace_record_is_admitted(
                "hermes.llm.request",
                maximum_attributes,
            )
            else None
        )
        if span is None and self._logger is None and self._meter_provider is None:
            return None
        return _FrameworkProviderAttemptHandle(
            span=span,
            started_at_epoch_nanoseconds=started_at_epoch_nanoseconds,
            started_record=record,
        )

    def complete_provider_attempt(
        self,
        handle: object,
        record: ProviderAttemptCompletedRecord,
    ) -> None:
        if not isinstance(handle, _FrameworkProviderAttemptHandle):
            return
        attributes = {
            **_provider_started_attributes(handle.started_record),
            **_provider_completed_attributes(record),
        }
        result_class = record.result_class.value
        event_name = (
            "hermes.llm.request.failed"
            if result_class == "failure"
            else "hermes.llm.request.completed"
        )
        duration_milliseconds = _duration_milliseconds(record.duration_milliseconds)
        self._finish_framework_span(
            handle.span,
            result_class,
            attributes,
            end_time=handle.started_at_epoch_nanoseconds + int(duration_milliseconds * 1_000_000),
        )
        self._emit_framework_log(event_name, attributes)
        metric_attributes = _provider_metric_attributes(attributes)
        self._record_framework_metric("hermes.llm.requests_total", 1, metric_attributes)
        self._record_framework_metric(
            "hermes.llm.request.duration",
            duration_milliseconds,
            metric_attributes,
        )
        if record.usage_input_tokens is not None:
            self._record_framework_metric(
                "hermes.llm.input_tokens",
                record.usage_input_tokens,
                metric_attributes,
            )
        if record.usage_output_tokens is not None:
            self._record_framework_metric(
                "hermes.llm.output_tokens",
                record.usage_output_tokens,
                metric_attributes,
            )

    def emit_tool_call(
        self,
        parent_handle: object | None,
        record: ToolCallRecord,
    ) -> None:
        attributes: dict[str, AttributeValue] = {
            "agent_vm.operation.category": "tool",
            "agent_vm.operation.name": "tool_call",
            "agent_vm.result.class": record.result_class.value,
            "hermes.tool.category": record.tool_category.value,
        }
        if record.tool_name is not None:
            attributes["hermes.tool.name"] = record.tool_name
        parent_span = (
            parent_handle.span if isinstance(parent_handle, _FrameworkTurnHandle) else None
        )
        ended_at_nanoseconds = time.time_ns()
        started_at_nanoseconds = ended_at_nanoseconds - int(
            record.duration_milliseconds * 1_000_000
        )
        span = (
            self._start_framework_span(
                "hermes.tool.call",
                attributes,
                parent_span,
                start_time=started_at_nanoseconds,
            )
            if self._trace_record_is_admitted("hermes.tool.call", attributes)
            else None
        )
        self._finish_framework_span(
            span,
            record.result_class.value,
            end_time=ended_at_nanoseconds,
        )
        self._emit_framework_log("hermes.tool.call.completed", attributes)
        metric_attributes = {
            key: value
            for key, value in attributes.items()
            if key
            in {
                "agent_vm.operation.category",
                "agent_vm.operation.name",
                "agent_vm.result.class",
                "hermes.tool.category",
            }
        }
        self._record_framework_metric("hermes.tool.calls_total", 1, metric_attributes)
        self._record_framework_metric(
            "hermes.tool.call.duration",
            record.duration_milliseconds,
            metric_attributes,
        )

    def _start_framework_span(
        self,
        span_name: str,
        attributes: Mapping[str, AttributeValue],
        parent_span: Span | None,
        *,
        start_time: int | None = None,
    ) -> Span | None:
        if self._tracer is None:
            return None
        parent_context = (
            trace.set_span_in_context(parent_span) if parent_span is not None else Context()
        )
        try:
            return self._tracer.start_span(
                span_name,
                context=parent_context,
                attributes=attributes,
                start_time=start_time,
            )
        except Exception:
            return None

    def _finish_framework_span(
        self,
        span: Span | None,
        result_class: str,
        attributes: Mapping[str, AttributeValue] | None = None,
        *,
        end_time: int | None = None,
    ) -> None:
        if span is None:
            return
        try:
            if attributes is not None:
                span.set_attributes(attributes)
            span.set_status(
                Status(StatusCode.OK if result_class == "success" else StatusCode.ERROR)
            )
            span.end(end_time=end_time)
        except Exception:
            try:
                span.end(end_time=end_time)
            except Exception:
                pass

    def _emit_framework_log(
        self,
        event_name: str,
        attributes: Mapping[str, AttributeValue],
    ) -> None:
        if self._logger is None:
            return
        if not self._log_record_is_admitted(event_name, attributes):
            return
        try:
            self._logger.emit(
                event_name=event_name,
                body=event_name,
                attributes=attributes,
                severity_number=SeverityNumber.INFO,
                severity_text="INFO",
            )
        except Exception:
            pass

    def _record_framework_metric(
        self,
        metric_name: str,
        value: int | float,
        attributes: Mapping[str, AttributeValue],
    ) -> None:
        if self._meter_provider is None:
            return
        unit = "ms" if metric_name.endswith(".duration") else "1"
        if not self._metric_record_is_admitted(
            metric_name,
            value,
            attributes,
            unit=unit,
        ):
            return
        try:
            if metric_name.endswith(".duration"):
                histogram = self._framework_histograms.get(metric_name)
                if histogram is not None:
                    histogram.record(value, attributes)
            else:
                counter = self._framework_counters.get(metric_name)
                if counter is not None:
                    counter.add(value, attributes)
        except Exception:
            pass


def _safe_set_span_status(span: Span, status_code: StatusCode) -> None:
    try:
        span.set_status(Status(status_code))
    except Exception:
        pass


def _safe_provider_shutdown(provider: _FlushableProvider | None) -> None:
    if provider is None:
        return
    try:
        provider.force_flush()
    except Exception:
        pass
    try:
        provider.shutdown()
    except Exception:
        pass


def _log_signal_initialization_failure(signal_name: str) -> None:
    logging.getLogger(__name__).warning(
        "Managed Hermes %s telemetry initialization failed; that signal is disabled.",
        signal_name,
    )


def create_hermes_tool_portal_telemetry_from_environment() -> HermesToolPortalTelemetry:
    configuration = _load_telemetry_configuration()
    if not configuration.any_signal_enabled:
        return _DisabledHermesToolPortalTelemetry()
    return _OtelHermesToolPortalTelemetry(configuration=configuration)
