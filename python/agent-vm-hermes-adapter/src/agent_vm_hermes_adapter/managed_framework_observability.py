"""Pure, bounded mapping from pinned Hermes hooks to framework observations."""

import enum
import math
import re
import threading
import typing as t
from collections.abc import Mapping
from dataclasses import dataclass

from agent.error_classifier import FailoverReason

_MAX_INTEGER = 2_147_483_647
_MAX_DURATION_MILLISECONDS = 86_400_000.0
_PLATFORM_TOKEN_PATTERN = re.compile(r"^[a-z0-9_]{1,64}$")
_TOOL_PORTAL_TOOL_NAMES = frozenset(
    {
        "tool_portal_list",
        "tool_portal_search",
        "tool_portal_describe",
        "tool_portal_call",
    }
)
_FAILOVER_REASONS = frozenset(reason.value for reason in FailoverReason)


class ApiMode(enum.StrEnum):
    CHAT_COMPLETIONS = "chat_completions"
    CODEX_RESPONSES = "codex_responses"
    ANTHROPIC_MESSAGES = "anthropic_messages"
    BEDROCK_CONVERSE = "bedrock_converse"
    CODEX_APP_SERVER = "codex_app_server"
    UNKNOWN = "unknown"


class TurnResultClass(enum.StrEnum):
    SUCCESS = "success"
    FAILURE = "failure"
    INTERRUPTED = "interrupted"
    ABANDONED = "abandoned"
    UNKNOWN = "unknown"


class ProviderAttemptResultClass(enum.StrEnum):
    SUCCESS = "success"
    FAILURE = "failure"
    UNKNOWN = "unknown"


class ToolResultClass(enum.StrEnum):
    SUCCESS = "success"
    FAILURE = "failure"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"
    UNKNOWN = "unknown"


class ToolCategory(enum.StrEnum):
    TOOL_PORTAL = "tool_portal"
    HERMES_TOOL = "hermes_tool"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class TurnStartedRecord:
    platform_class: str = "unknown"


@dataclass(frozen=True)
class TurnCompletedRecord:
    result_class: TurnResultClass


@dataclass(frozen=True)
class ProviderAttemptStartedRecord:
    api_call_count: int | None = None
    api_mode: ApiMode = ApiMode.UNKNOWN
    model: str | None = None
    provider: str | None = None


@dataclass(frozen=True)
class ProviderAttemptCompletedRecord:
    duration_milliseconds: float
    result_class: ProviderAttemptResultClass
    failover_reason: str | None = None
    finish_reason_class: str | None = None
    http_status_class: str | None = None
    retry_count: int | None = None
    retryable: bool | None = None
    usage_input_tokens: int | None = None
    usage_output_tokens: int | None = None


@dataclass(frozen=True)
class ToolCallRecord:
    duration_milliseconds: float
    result_class: ToolResultClass
    tool_category: ToolCategory
    tool_name: str | None = None


class FrameworkObservationSink(t.Protocol):
    def start_turn(self, record: TurnStartedRecord) -> object | None: ...

    def complete_turn(
        self,
        handle: object,
        record: TurnCompletedRecord,
    ) -> None: ...

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


@dataclass(frozen=True)
class _ProviderAttemptCorrelation:
    handle: object
    turn_id: str


def _correlation_key(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value


def _bounded_string(value: object, maximum_code_points: int) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value[:maximum_code_points]


def _bounded_integer(value: object) -> int | None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > _MAX_INTEGER:
        return None
    return value


def _duration_milliseconds(value: object, *, seconds: bool) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return 0.0
    numeric_value = float(value)
    if not math.isfinite(numeric_value) or numeric_value < 0:
        return 0.0
    if seconds:
        numeric_value *= 1000.0
    return min(numeric_value, _MAX_DURATION_MILLISECONDS)


def _closed_token(value: object) -> str:
    if not isinstance(value, str):
        return "unknown"
    normalized_value = value.lower()
    if _PLATFORM_TOKEN_PATTERN.fullmatch(normalized_value) is None:
        return "unknown"
    return normalized_value


def _api_mode(value: object) -> ApiMode:
    if not isinstance(value, str):
        return ApiMode.UNKNOWN
    try:
        return ApiMode(value)
    except ValueError:
        return ApiMode.UNKNOWN


def _failover_reason(value: object) -> str:
    if isinstance(value, str) and value in _FAILOVER_REASONS:
        return value
    return "unknown"


def _http_status_class(value: object) -> str | None:
    if not isinstance(value, int) or isinstance(value, bool) or not 100 <= value <= 599:
        return None
    return f"{value // 100}xx"


def _tool_result_class(value: object) -> ToolResultClass:
    if not isinstance(value, str):
        return ToolResultClass.UNKNOWN
    result_by_status = {
        "ok": ToolResultClass.SUCCESS,
        "error": ToolResultClass.FAILURE,
        "blocked": ToolResultClass.BLOCKED,
        "cancelled": ToolResultClass.CANCELLED,
        "timeout": ToolResultClass.TIMEOUT,
    }
    return result_by_status.get(value, ToolResultClass.UNKNOWN)


def _tool_category(tool_name: str | None) -> ToolCategory:
    if tool_name is None:
        return ToolCategory.UNKNOWN
    if tool_name in _TOOL_PORTAL_TOOL_NAMES:
        return ToolCategory.TOOL_PORTAL
    return ToolCategory.HERMES_TOOL


def _usage_token_count(usage: object, field_name: str) -> int | None:
    if not isinstance(usage, Mapping):
        return None
    return _bounded_integer(usage.get(field_name))


@t.final
class ManagedFrameworkObservability:
    """Observe pinned Hermes hooks without retaining or exporting hook content."""

    def __init__(
        self,
        *,
        sink: FrameworkObservationSink,
        max_inflight_observations: int,
    ) -> None:
        self._sink = sink
        self._max_inflight_observations = max(0, max_inflight_observations)
        self._correlation_lock = threading.Lock()
        self._turn_observations: dict[str, object] = {}
        self._provider_attempt_observations: dict[str, _ProviderAttemptCorrelation] = {}

    def on_pre_llm_call(
        self,
        *,
        turn_id: object = None,
        platform: object = None,
        **_discarded_hook_fields: object,
    ) -> None:
        turn_key = _correlation_key(turn_id)
        if turn_key is None:
            return None
        with self._correlation_lock:
            if (
                turn_key in self._turn_observations
                or len(self._turn_observations) >= self._max_inflight_observations
            ):
                return None
            try:
                handle = self._sink.start_turn(
                    TurnStartedRecord(platform_class=_closed_token(platform))
                )
            except Exception:
                return None
            if handle is not None:
                self._turn_observations[turn_key] = handle
        return None

    def on_pre_api_request(
        self,
        *,
        turn_id: object = None,
        api_request_id: object = None,
        model: object = None,
        provider: object = None,
        api_mode: object = None,
        api_call_count: object = None,
        **_discarded_hook_fields: object,
    ) -> None:
        turn_key = _correlation_key(turn_id)
        api_request_key = _correlation_key(api_request_id)
        if turn_key is None or api_request_key is None:
            return None
        with self._correlation_lock:
            if (
                api_request_key in self._provider_attempt_observations
                or len(self._provider_attempt_observations) >= self._max_inflight_observations
            ):
                return None
            parent_handle = self._turn_observations.get(turn_key)
            try:
                handle = self._sink.start_provider_attempt(
                    parent_handle,
                    ProviderAttemptStartedRecord(
                        api_call_count=_bounded_integer(api_call_count),
                        api_mode=_api_mode(api_mode),
                        model=_bounded_string(model, 256),
                        provider=_bounded_string(provider, 128),
                    ),
                )
            except Exception:
                return None
            if handle is not None:
                self._provider_attempt_observations[api_request_key] = _ProviderAttemptCorrelation(
                    handle=handle,
                    turn_id=turn_key,
                )
        return None

    def on_post_api_request(
        self,
        *,
        turn_id: object = None,
        api_request_id: object = None,
        api_duration: object = None,
        finish_reason: object = None,
        usage: object = None,
        **_discarded_hook_fields: object,
    ) -> None:
        correlation = self._pop_provider_attempt(turn_id, api_request_id)
        if correlation is None:
            return None
        self._complete_provider_attempt(
            correlation.handle,
            ProviderAttemptCompletedRecord(
                duration_milliseconds=_duration_milliseconds(
                    api_duration,
                    seconds=True,
                ),
                finish_reason_class=_closed_token(finish_reason),
                result_class=ProviderAttemptResultClass.SUCCESS,
                usage_input_tokens=_usage_token_count(usage, "input_tokens"),
                usage_output_tokens=_usage_token_count(usage, "output_tokens"),
            ),
        )
        return None

    def on_api_request_error(
        self,
        *,
        turn_id: object = None,
        api_request_id: object = None,
        api_duration: object = None,
        reason: object = None,
        status_code: object = None,
        retryable: object = None,
        retry_count: object = None,
        **_discarded_hook_fields: object,
    ) -> None:
        correlation = self._pop_provider_attempt(turn_id, api_request_id)
        if correlation is None:
            return None
        self._complete_provider_attempt(
            correlation.handle,
            ProviderAttemptCompletedRecord(
                duration_milliseconds=_duration_milliseconds(
                    api_duration,
                    seconds=True,
                ),
                failover_reason=_failover_reason(reason),
                http_status_class=_http_status_class(status_code),
                result_class=ProviderAttemptResultClass.FAILURE,
                retry_count=_bounded_integer(retry_count),
                retryable=retryable if isinstance(retryable, bool) else None,
            ),
        )
        return None

    def on_post_tool_call(
        self,
        *,
        turn_id: object = None,
        tool_name: object = None,
        duration_ms: object = None,
        status: object = None,
        **_discarded_hook_fields: object,
    ) -> None:
        turn_key = _correlation_key(turn_id)
        with self._correlation_lock:
            parent_handle = self._turn_observations.get(turn_key) if turn_key is not None else None
        safe_tool_name = _bounded_string(tool_name, 128)
        try:
            self._sink.emit_tool_call(
                parent_handle,
                ToolCallRecord(
                    duration_milliseconds=_duration_milliseconds(
                        duration_ms,
                        seconds=False,
                    ),
                    result_class=_tool_result_class(status),
                    tool_category=_tool_category(safe_tool_name),
                    tool_name=safe_tool_name,
                ),
            )
        except Exception:
            pass
        return None

    def on_session_end(
        self,
        *,
        turn_id: object = None,
        completed: object = None,
        interrupted: object = None,
        **_discarded_hook_fields: object,
    ) -> None:
        turn_key = _correlation_key(turn_id)
        if turn_key is None:
            return None
        with self._correlation_lock:
            turn_handle = self._turn_observations.pop(turn_key, None)
            provider_handles: list[object] = []
            for api_request_key, correlation in tuple(self._provider_attempt_observations.items()):
                if correlation.turn_id != turn_key:
                    continue
                provider_handles.append(correlation.handle)
                del self._provider_attempt_observations[api_request_key]
        unknown_provider_record = ProviderAttemptCompletedRecord(
            duration_milliseconds=0.0,
            result_class=ProviderAttemptResultClass.UNKNOWN,
        )
        for provider_handle in provider_handles:
            self._complete_provider_attempt(
                provider_handle,
                unknown_provider_record,
            )
        if turn_handle is not None:
            self._complete_turn(
                turn_handle,
                TurnCompletedRecord(
                    result_class=_turn_result_class(
                        completed=completed,
                        interrupted=interrupted,
                    )
                ),
            )
        return None

    def shutdown(self) -> None:
        with self._correlation_lock:
            provider_handles = [
                correlation.handle for correlation in self._provider_attempt_observations.values()
            ]
            turn_handles = list(self._turn_observations.values())
            self._provider_attempt_observations.clear()
            self._turn_observations.clear()
        unknown_provider_record = ProviderAttemptCompletedRecord(
            duration_milliseconds=0.0,
            result_class=ProviderAttemptResultClass.UNKNOWN,
        )
        abandoned_turn_record = TurnCompletedRecord(result_class=TurnResultClass.ABANDONED)
        for provider_handle in provider_handles:
            self._complete_provider_attempt(
                provider_handle,
                unknown_provider_record,
            )
        for turn_handle in turn_handles:
            self._complete_turn(
                turn_handle,
                abandoned_turn_record,
            )
        return None

    def _pop_provider_attempt(
        self,
        turn_id: object,
        api_request_id: object,
    ) -> _ProviderAttemptCorrelation | None:
        turn_key = _correlation_key(turn_id)
        api_request_key = _correlation_key(api_request_id)
        if turn_key is None or api_request_key is None:
            return None
        with self._correlation_lock:
            correlation = self._provider_attempt_observations.get(api_request_key)
            if correlation is None or correlation.turn_id != turn_key:
                return None
            return self._provider_attempt_observations.pop(api_request_key)

    def _complete_turn(
        self,
        handle: object,
        record: TurnCompletedRecord,
    ) -> None:
        try:
            self._sink.complete_turn(handle, record)
        except Exception:
            pass

    def _complete_provider_attempt(
        self,
        handle: object,
        record: ProviderAttemptCompletedRecord,
    ) -> None:
        try:
            self._sink.complete_provider_attempt(handle, record)
        except Exception:
            pass


def _turn_result_class(
    *,
    completed: object,
    interrupted: object,
) -> TurnResultClass:
    if interrupted is True:
        return TurnResultClass.INTERRUPTED
    if completed is True:
        return TurnResultClass.SUCCESS
    if completed is False:
        return TurnResultClass.FAILURE
    return TurnResultClass.UNKNOWN
