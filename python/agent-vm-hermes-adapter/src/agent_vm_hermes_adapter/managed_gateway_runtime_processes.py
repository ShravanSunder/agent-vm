"""Managed Hermes background processes backed by opaque Gateway Runtime handles."""

import base64
import secrets
import threading
import time
import typing as t

from tools.process_registry import ProcessSession

from .managed_gateway_runtime_environment import HermesGatewayRuntimeEnvironment
from .managed_gateway_runtime_process_state import (
    HermesManagedProcessOwner,
    HermesManagedProcessRecord,
    process_completion_reason,
    require_nonnegative_process_integer,
    require_process_mapping,
    require_process_string,
    terminal_process_exit_code,
)
from .managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    _projection_profile_name,
    _projection_string_field,
)

_MAXIMUM_PROCESS_RUNTIME_MILLISECONDS = 60 * 60 * 1_000
_MAXIMUM_RETAINED_OUTPUT_BYTES = 16 * 1_024 * 1_024
_MAXIMUM_LOG_READ_BYTES = 1024 * 1024
_MAXIMUM_TRACKED_PROCESS_RECORDS = 64
_MONITOR_INTERVAL_SECONDS = 1.0


class HermesManagedProcessRegistryPort(t.Protocol):
    """The narrow stock-Hermes registry behavior needed by managed processes."""

    def register(self, session: ProcessSession) -> None: ...

    def append_output(self, session: ProcessSession, output: str) -> None: ...

    def finish(self, session: ProcessSession) -> None: ...


class HermesManagedProcessAuthorityError(RuntimeError):
    """A managed process action did not carry current profile/generation authority."""


class _ManagedProcessNotFoundError(HermesManagedProcessAuthorityError):
    pass


@t.final
class HermesManagedProcessRuntime:
    """Map stock Hermes process actions to one profile-fenced process registry."""

    def __init__(
        self,
        *,
        current_projection: t.Callable[[], CanonicalManagedAgentProjection],
        process_registry: HermesManagedProcessRegistryPort,
        start_monitor_threads: bool = True,
    ) -> None:
        self._current_projection = current_projection
        self._process_registry = process_registry
        self._start_monitor_threads = start_monitor_threads
        self._records_by_session_id: dict[str, HermesManagedProcessRecord] = {}
        self._process_start_reservations = 0
        self._records_lock = threading.RLock()
        self._process_start_condition = threading.Condition(self._records_lock)
        self._monitor_stop = threading.Event()
        self._monitor_threads: set[threading.Thread] = set()
        self._closed = False

    def _owner_for_environment(
        self,
        environment: HermesGatewayRuntimeEnvironment,
    ) -> HermesManagedProcessOwner:
        projection = self._current_projection()
        if environment.agent_id != _projection_string_field(
            projection, "agentId"
        ) or environment.profile_name != _projection_profile_name(projection):
            raise HermesManagedProcessAuthorityError(
                "Managed Hermes process environment does not belong to the current profile."
            )
        return HermesManagedProcessOwner(
            agent_id=environment.agent_id,
            assignment_revision=_projection_string_field(
                projection,
                "profileAssignmentRevision",
            ),
            cache_identity=environment.cache_identity,
            owning_generation=environment.owning_generation,
            profile_name=environment.profile_name,
        )

    def _require_owned_record(self, session_id: str) -> HermesManagedProcessRecord:
        with self._records_lock:
            record = self._records_by_session_id.get(session_id)
        if record is None or not record.owner.matches_projection(self._current_projection()):
            raise _ManagedProcessNotFoundError("Managed process session was not found.")
        self._require_live_record_generation(record)
        return record

    def _require_live_record_generation(self, record: HermesManagedProcessRecord) -> None:
        try:
            record.environment.require_local_process_authority(
                cache_identity=record.owner.cache_identity,
                owning_generation=record.owner.owning_generation,
            )
        except RuntimeError as error:
            self._finish_record(
                record,
                exit_code=125,
                completion_reason="lost",
                termination_source="local_authority_retired",
            )
            raise HermesManagedProcessAuthorityError(
                "Managed process environment authority is locally retired."
            ) from error
        if (
            record.environment.cache_identity != record.owner.cache_identity
            or record.environment.owning_generation != record.owner.owning_generation
            or record.process.get("owningGeneration") != record.owner.owning_generation
        ):
            self._finish_record(
                record,
                exit_code=125,
                completion_reason="lost",
                termination_source="generation_mismatch",
            )
            raise HermesManagedProcessAuthorityError(
                "Managed process handle has stale or mismatched generation authority."
            )
        status_kind = record.environment.resolve_status_kind()
        if status_kind != "active":
            self._finish_record(
                record,
                exit_code=125,
                completion_reason="lost",
                termination_source="backend_replaced",
            )
            raise HermesManagedProcessAuthorityError(
                "Managed process environment is stale or replaced."
            )

    def _reserve_process_record_capacity(self) -> None:
        with self._process_start_condition:
            if self._closed:
                raise RuntimeError("Managed Hermes process runtime is closed.")
            finished_records = sorted(
                (record for record in self._records_by_session_id.values() if record.finished),
                key=lambda record: record.session.started_at,
            )
            while (
                len(self._records_by_session_id) + self._process_start_reservations
                >= _MAXIMUM_TRACKED_PROCESS_RECORDS
                and finished_records
            ):
                evicted_record = finished_records.pop(0)
                _ = self._records_by_session_id.pop(evicted_record.session.id, None)
            if (
                len(self._records_by_session_id) + self._process_start_reservations
                >= _MAXIMUM_TRACKED_PROCESS_RECORDS
            ):
                raise RuntimeError("Managed Hermes background process limit was reached.")
            self._process_start_reservations += 1

    def _release_process_start_reservation(self) -> None:
        with self._process_start_condition:
            self._process_start_reservations -= 1
            self._process_start_condition.notify_all()

    def _record_for_action(
        self,
        session_id: str,
    ) -> tuple[HermesManagedProcessRecord | None, dict[str, object] | None]:
        try:
            return self._require_owned_record(session_id), None
        except _ManagedProcessNotFoundError:
            return None, {
                "status": "not_found",
                "error": f"No managed process with ID {session_id}",
            }
        except HermesManagedProcessAuthorityError as error:
            return None, {"status": "error", "error": str(error)}

    def spawn_via_env(
        self,
        env: object,
        command: str,
        cwd: str | None = None,
        task_id: str = "",
        session_key: str = "",
        timeout: int = 10,
    ) -> ProcessSession:
        del timeout
        if self._closed:
            raise RuntimeError("Managed Hermes process runtime is closed.")
        if not isinstance(env, HermesGatewayRuntimeEnvironment):
            raise HermesManagedProcessAuthorityError(
                "Managed Hermes background execution requires a managed environment."
            )
        if task_id != env.cache_identity:
            raise HermesManagedProcessAuthorityError(
                "Managed Hermes background task identity does not match its environment."
            )
        owner = self._owner_for_environment(env)
        try:
            env.require_local_process_authority(
                cache_identity=owner.cache_identity,
                owning_generation=owner.owning_generation,
            )
        except RuntimeError as error:
            raise HermesManagedProcessAuthorityError(
                "Managed Hermes background environment is locally retired."
            ) from error
        if env.resolve_status_kind() != "active":
            raise HermesManagedProcessAuthorityError(
                "Managed Hermes background environment is stale or unavailable."
            )
        self._reserve_process_record_capacity()
        started_process: t.Mapping[str, object] | None = None
        local_session_id: str | None = None
        registered_session_id: str | None = None
        try:
            started = env.start_managed_process(
                command=command,
                cwd=cwd or env.cwd,
                maximum_runtime_milliseconds=_MAXIMUM_PROCESS_RUNTIME_MILLISECONDS,
                retained_output_bytes=_MAXIMUM_RETAINED_OUTPUT_BYTES,
            )
            if started.get("kind") != "started":
                raise RuntimeError("Gateway Runtime process start did not return a started result.")
            process = require_process_mapping(started.get("process"), "managed process handle")
            started_process = process
            if process.get("owningGeneration") != owner.owning_generation:
                raise HermesManagedProcessAuthorityError(
                    "Gateway Runtime returned a process for a different Tool VM generation."
                )
            streams_value = started.get("streams")
            if not isinstance(streams_value, list):
                raise TypeError("Gateway Runtime process start omitted stream handles")
            streams_by_channel: dict[str, t.Mapping[str, object]] = {}
            for stream_value in streams_value:
                stream = require_process_mapping(stream_value, "managed process stream")
                channel = require_process_string(
                    stream.get("channel"),
                    "managed process stream channel",
                )
                if channel in streams_by_channel:
                    raise RuntimeError(f"Gateway Runtime returned duplicate {channel!r} streams.")
                if stream.get("owningGeneration") != owner.owning_generation:
                    raise HermesManagedProcessAuthorityError(
                        "Gateway Runtime returned a stream for a different Tool VM generation."
                    )
                streams_by_channel[channel] = stream
            missing_channels = {"stdin", "stdout", "stderr"} - streams_by_channel.keys()
            if missing_channels:
                raise RuntimeError(
                    "Gateway Runtime process start omitted required streams: "
                    + ", ".join(sorted(missing_channels))
                )
            session = ProcessSession(
                id=f"proc_{secrets.token_hex(12)}",
                command=command,
                task_id=task_id,
                session_key=session_key,
                pid=None,
                env_ref=env,
                cwd=cwd or env.cwd,
                started_at=time.time(),
                pid_scope="sandbox",
            )
            local_session_id = session.id
            record = HermesManagedProcessRecord(
                environment=env,
                owner=owner,
                process=process,
                session=session,
                streams_by_channel=streams_by_channel,
            )
            with self._records_lock:
                if session.id in self._records_by_session_id:
                    raise RuntimeError("Managed Hermes process session identifier collided.")
                self._records_by_session_id[session.id] = record
            self._process_registry.register(session)
            registered_session_id = session.id
        except BaseException:
            if registered_session_id is None:
                with self._records_lock:
                    if local_session_id is not None:
                        _ = self._records_by_session_id.pop(local_session_id, None)
                if started_process is not None:
                    try:
                        _ = env.cancel_managed_process(started_process)
                    except Exception:
                        pass
            raise
        finally:
            self._release_process_start_reservation()
        if self._start_monitor_threads:
            monitor_thread = threading.Thread(
                target=self._monitor_process,
                args=(record,),
                daemon=True,
                name=f"agent-vm-hermes-process-{session.id}",
            )
            with self._records_lock:
                self._monitor_threads.add(monitor_thread)
            monitor_thread.start()
        return session

    def _append_process_logs(self, record: HermesManagedProcessRecord) -> None:
        with record.log_state_lock:
            self._append_process_logs_locked(record)

    def _append_process_logs_locked(self, record: HermesManagedProcessRecord) -> None:
        logs = record.environment.read_managed_process_logs(
            record.process,
            cursor=record.log_cursor,
            maximum_bytes=_MAXIMUM_LOG_READ_BYTES,
        )
        if logs.get("kind") != "logs":
            raise RuntimeError("Gateway Runtime process logs returned an unsupported result.")
        chunks_value = logs.get("chunks")
        if not isinstance(chunks_value, list):
            raise TypeError("Gateway Runtime process logs omitted chunks")
        output_parts: list[str] = []
        for chunk_value in chunks_value:
            chunk = require_process_mapping(chunk_value, "managed process log chunk")
            channel = require_process_string(chunk.get("channel"), "managed process log channel")
            sequence = require_nonnegative_process_integer(
                chunk.get("sequence"),
                "managed process log sequence",
            )
            latest_sequence = record.latest_log_sequence_by_channel.get(channel)
            if latest_sequence is not None and sequence <= latest_sequence:
                continue
            binary_chunk = require_process_mapping(
                chunk.get("chunk"),
                "managed process log bytes",
            )
            encoded_content = binary_chunk.get("contentBase64")
            if not isinstance(encoded_content, str):
                raise TypeError("Managed process log contentBase64 must be a string")
            content = base64.b64decode(encoded_content, validate=True)
            declared_length = require_nonnegative_process_integer(
                binary_chunk.get("byteLength"),
                "managed process log byteLength",
            )
            if len(content) != declared_length:
                raise RuntimeError("Managed process log byteLength did not match its content.")
            record.latest_log_sequence_by_channel[channel] = sequence
            output_parts.append(content.decode("utf-8", errors="replace"))
        if output_parts:
            self._process_registry.append_output(record.session, "".join(output_parts))
        next_cursor = logs.get("nextCursor")
        if next_cursor is not None:
            record.log_cursor = require_process_string(
                next_cursor,
                "managed process log nextCursor",
            )

    def _finish_record(
        self,
        record: HermesManagedProcessRecord,
        *,
        exit_code: int,
        completion_reason: str,
        termination_source: str,
    ) -> None:
        with self._records_lock:
            if record.finished:
                return
            record.finished = True
            record.session.exited = True
            record.session.exit_code = exit_code
            record.session.completion_reason = completion_reason
            record.session.termination_source = termination_source
        self._process_registry.finish(record.session)

    def _apply_terminal_result(
        self,
        record: HermesManagedProcessRecord,
        result: t.Mapping[str, object],
    ) -> bool:
        if result.get("kind") != "terminal":
            return False
        outcome = require_process_mapping(result.get("outcome"), "managed process outcome")
        self._finish_record(
            record,
            exit_code=terminal_process_exit_code(outcome),
            completion_reason=process_completion_reason(outcome),
            termination_source="gateway_runtime",
        )
        return True

    def _refresh_record(self, record: HermesManagedProcessRecord) -> None:
        if record.finished:
            return
        status = record.environment.resolve_managed_process_status(record.process)
        _ = self._apply_terminal_result(record, status)
        self._append_process_logs(record)

    def _monitor_process(self, record: HermesManagedProcessRecord) -> None:
        try:
            while not record.finished and not self._monitor_stop.wait(_MONITOR_INTERVAL_SECONDS):
                if not self._observe_process_for_monitor(record):
                    return
        finally:
            with self._records_lock:
                self._monitor_threads.discard(threading.current_thread())

    def _observe_process_for_monitor(self, record: HermesManagedProcessRecord) -> bool:
        try:
            self._require_live_record_generation(record)
            self._refresh_record(record)
        except HermesManagedProcessAuthorityError:
            return False
        except Exception:
            return True
        return not record.finished

    @staticmethod
    def _poll_result(record: HermesManagedProcessRecord) -> dict[str, object]:
        result: dict[str, object] = {
            "command": record.session.command,
            "output_preview": record.session.output_buffer[-1_000:],
            "pid": None,
            "session_id": record.session.id,
            "status": "exited" if record.session.exited else "running",
            "uptime_seconds": max(0, int(time.time() - record.session.started_at)),
        }
        if record.session.exited:
            result.update(
                {
                    "completion_reason": record.session.completion_reason,
                    "exit_code": record.session.exit_code,
                    "termination_source": record.session.termination_source,
                }
            )
        return result

    def poll(self, session_id: str) -> dict[str, object]:
        record, error_result = self._record_for_action(session_id)
        if record is None:
            return t.cast("dict[str, object]", error_result)
        self._refresh_record(record)
        return self._poll_result(record)

    def read_log(
        self,
        session_id: str,
        offset: int = 0,
        limit: int = 200,
    ) -> dict[str, object]:
        record, error_result = self._record_for_action(session_id)
        if record is None:
            return t.cast("dict[str, object]", error_result)
        self._append_process_logs(record)
        lines = record.session.output_buffer.splitlines()
        selected_lines = lines[-limit:] if offset == 0 else lines[offset : offset + limit]
        return {
            "command": record.session.command,
            "output": "\n".join(selected_lines),
            "session_id": record.session.id,
            "showing": f"{len(selected_lines)} lines",
            "status": "exited" if record.session.exited else "running",
            "total_lines": len(lines),
        }

    def wait(self, session_id: str, timeout: int | None = None) -> dict[str, object]:
        record, error_result = self._record_for_action(session_id)
        if record is None:
            return t.cast("dict[str, object]", error_result)
        timeout_seconds = 180 if timeout is None else max(1, min(timeout, 3_600))
        result = record.environment.wait_for_managed_process(
            record.process,
            timeout_milliseconds=timeout_seconds * 1_000,
        )
        terminal = self._apply_terminal_result(record, result)
        self._append_process_logs(record)
        if not terminal:
            return {
                "command": record.session.command,
                "output": record.session.output_buffer[-1_000:],
                "status": "timeout",
                "timeout_note": f"Waited {timeout_seconds}s, process still running",
            }
        return {
            "command": record.session.command,
            "completion_reason": record.session.completion_reason,
            "exit_code": record.session.exit_code,
            "output": record.session.output_buffer[-2_000:],
            "status": "exited",
            "termination_source": record.session.termination_source,
        }

    def kill_process(
        self,
        session_id: str,
        *,
        source: str = "process.kill",
    ) -> dict[str, object]:
        record, error_result = self._record_for_action(session_id)
        if record is None:
            return t.cast("dict[str, object]", error_result)
        if record.finished:
            return {"status": "already_exited", "exit_code": record.session.exit_code}
        return self._cancel_record(record, source=source)

    def _cancel_record(
        self,
        record: HermesManagedProcessRecord,
        *,
        source: str,
    ) -> dict[str, object]:
        result = record.environment.cancel_managed_process(record.process)
        result_kind = require_process_string(result.get("kind"), "process cancellation kind")
        if result_kind in {"termination-proven", "already-terminal"}:
            outcome = require_process_mapping(
                result.get("outcome"),
                "process cancellation outcome",
            )
            self._finish_record(
                record,
                exit_code=terminal_process_exit_code(outcome),
                completion_reason=process_completion_reason(outcome),
                termination_source=source,
            )
            return {
                "completion_reason": record.session.completion_reason,
                "session_id": record.session.id,
                "status": "killed"
                if record.session.completion_reason == "killed"
                else "already_exited",
                "termination_source": record.session.termination_source,
            }
        if result_kind in {"cancel-request-accepted", "cancellation-pending", "running"}:
            return {"session_id": record.session.id, "status": "cancellation_pending"}
        return {
            "status": "error",
            "error": "Managed process cancellation outcome is ambiguous.",
        }

    def write_stdin(self, session_id: str, data: str) -> dict[str, object]:
        record, error_result = self._record_for_action(session_id)
        if record is None:
            return t.cast("dict[str, object]", error_result)
        with record.input_state_lock:
            if record.finished:
                return {"status": "already_exited", "error": "Process has already finished"}
            if record.input_closed:
                return {"status": "error", "error": "Process stdin is closed"}
            content = data.encode("utf-8")
            _ = record.environment.write_managed_process_input(
                record.streams_by_channel["stdin"],
                content=content,
                sequence=record.next_input_sequence,
            )
            record.next_input_sequence += 1
            return {"status": "ok", "bytes_written": len(content)}

    def submit_stdin(self, session_id: str, data: str = "") -> dict[str, object]:
        return self.write_stdin(session_id, data + "\n")

    def close_stdin(self, session_id: str) -> dict[str, object]:
        record, error_result = self._record_for_action(session_id)
        if record is None:
            return t.cast("dict[str, object]", error_result)
        with record.input_state_lock:
            if record.finished:
                return {"status": "already_exited", "error": "Process has already finished"}
            if record.input_closed:
                return {"status": "ok", "message": "EOF already sent"}
            _ = record.environment.close_managed_process_input(record.streams_by_channel["stdin"])
            record.input_closed = True
            return {"status": "ok", "message": "EOF sent"}

    def list_sessions(
        self,
        task_id: str | None = None,
        session_key: str | None = None,
    ) -> list[dict[str, object]]:
        projection = self._current_projection()
        with self._records_lock:
            candidate_session_ids = tuple(
                record.session.id
                for record in self._records_by_session_id.values()
                if record.owner.matches_projection(projection)
                and (
                    (task_id is None and session_key is None)
                    or (task_id is not None and record.session.task_id == task_id)
                    or (session_key is not None and record.session.session_key == session_key)
                )
            )
        records: list[HermesManagedProcessRecord] = []
        for session_id in candidate_session_ids:
            record, _ = self._record_for_action(session_id)
            if record is not None:
                records.append(record)
        return [self._poll_result(record) for record in records]

    def kill_all(self, task_id: str | None = None) -> int:
        projection = self._current_projection()
        with self._records_lock:
            candidate_session_ids = tuple(
                record.session.id
                for record in self._records_by_session_id.values()
                if not record.finished
                and record.owner.matches_projection(projection)
                and (task_id is None or record.owner.cache_identity == task_id)
            )
        killed = 0
        for session_id in candidate_session_ids:
            record, _ = self._record_for_action(session_id)
            if record is None:
                continue
            try:
                result = self._cancel_record(record, source="kill_all")
            except Exception:
                continue
            if result.get("status") in {"killed", "already_exited"}:
                killed += 1
        return killed

    def close(self) -> None:
        with self._process_start_condition:
            if self._closed:
                return
            self._closed = True
            while self._process_start_reservations > 0:
                _ = self._process_start_condition.wait()
            records = tuple(
                record for record in self._records_by_session_id.values() if not record.finished
            )
        for record in records:
            try:
                _ = self._cancel_record(record, source="runtime_close")
            except Exception:
                continue
        self._monitor_stop.set()
        with self._records_lock:
            monitor_threads = tuple(self._monitor_threads)
        for monitor_thread in monitor_threads:
            monitor_thread.join(timeout=2)
