"""Bounded process-owned OpenTelemetry for managed Hermes Tool Portal calls."""

import contextlib
import os
import typing as t
from collections.abc import Iterator, Mapping

from opentelemetry import trace
from opentelemetry._logs import SeverityNumber
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Status, StatusCode

_INSTRUMENTATION_NAME = "agent-vm-hermes"
_OPERATION_CATEGORY = "tool_portal"
_OPERATION_LOG_NAME = "hermes.tool_portal.operation.completed"
_OPERATION_COUNTER_NAME = "hermes.tool_portal.operations_total"
_OPERATION_DURATION_NAME = "hermes.tool_portal.operation.duration"


class HermesToolPortalTelemetry(t.Protocol):
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
    if not isinstance(value, int | float) or isinstance(value, bool) or value < 0:
        return 0.0
    return float(value)


class _DisabledHermesToolPortalTelemetry:
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


class _OtelHermesToolPortalTelemetry:
    def __init__(self, *, endpoint: str, service_name: str) -> None:
        resource = Resource.create({SERVICE_NAME: service_name})
        self._logger_provider = LoggerProvider(resource=resource)
        self._logger_provider.add_log_record_processor(
            BatchLogRecordProcessor(
                OTLPLogExporter(endpoint=_signal_endpoint(endpoint, "/v1/logs"))
            )
        )
        self._meter_provider = MeterProvider(
            metric_readers=[
                PeriodicExportingMetricReader(
                    OTLPMetricExporter(endpoint=_signal_endpoint(endpoint, "/v1/metrics"))
                )
            ],
            resource=resource,
        )
        self._tracer_provider = TracerProvider(resource=resource)
        self._tracer_provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=_signal_endpoint(endpoint, "/v1/traces")))
        )
        self._logger = self._logger_provider.get_logger(_INSTRUMENTATION_NAME)
        meter = self._meter_provider.get_meter(_INSTRUMENTATION_NAME)
        self._operation_counter = meter.create_counter(_OPERATION_COUNTER_NAME)
        self._operation_duration = meter.create_histogram(_OPERATION_DURATION_NAME, unit="ms")
        self._tracer = self._tracer_provider.get_tracer(_INSTRUMENTATION_NAME)

    @contextlib.contextmanager
    def observe_tool_operation(self, tool_name: str) -> Iterator[None]:
        with self._tracer.start_as_current_span(
            "hermes.tool_portal.operation",
            attributes={
                "agent_vm.operation.category": _OPERATION_CATEGORY,
                "agent_vm.operation.name": tool_name,
            },
        ) as span:
            try:
                yield
            except BaseException:
                span.set_status(Status(StatusCode.ERROR))
                raise
            else:
                span.set_status(Status(StatusCode.OK))

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
        self._logger.emit(
            event_name=_OPERATION_LOG_NAME,
            body=_OPERATION_LOG_NAME,
            attributes=attributes,
            severity_number=SeverityNumber.INFO,
            severity_text="INFO",
        )
        self._operation_counter.add(1, attributes)
        self._operation_duration.record(duration_milliseconds, attributes)

    def shutdown(self) -> None:
        for provider in (
            self._logger_provider,
            self._meter_provider,
            self._tracer_provider,
        ):
            try:
                provider.force_flush()
                provider.shutdown()
            except Exception:
                continue


def create_hermes_tool_portal_telemetry_from_environment() -> HermesToolPortalTelemetry:
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    service_name = os.environ.get("OTEL_SERVICE_NAME")
    if endpoint is None or service_name is None:
        return _DisabledHermesToolPortalTelemetry()
    return _OtelHermesToolPortalTelemetry(endpoint=endpoint, service_name=service_name)
