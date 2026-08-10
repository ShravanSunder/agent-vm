"""Hermes BaseEnvironment backed by one managed Gateway Runtime client."""

import asyncio
import base64
import concurrent.futures
import hashlib
import os
import shlex
import threading
import typing as t

from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import BaseModel
from tools.environments.base import BaseEnvironment

from .managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesProfileAdmissionError,
    _projection_profile_name,
    _projection_string_field,
    build_managed_trusted_context,
)

_DEFAULT_TOOL_VM_CWD = "/work"
_MAXIMUM_STREAM_CHUNK_BYTES = 1024 * 1024


class HermesGatewayRuntimeOutcomeError(RuntimeError):
    """A Tool VM operation did not have a proven ordinary completion."""

    def __init__(self, outcome_kind: str) -> None:
        super().__init__(
            f"Gateway Runtime operation ended with non-completed outcome {outcome_kind!r}."
        )
        self.outcome_kind = outcome_kind


def _model_mapping(value: BaseModel) -> dict[str, object]:
    normalized = value.model_dump(by_alias=True, exclude_none=True, mode="json")
    if not isinstance(normalized, dict):
        message = "Gateway Runtime operation result did not produce an object"
        raise TypeError(message)
    return t.cast("dict[str, object]", normalized)


def _require_mapping(value: object, label: str) -> t.Mapping[str, object]:
    if not isinstance(value, t.Mapping):
        message = f"{label} must be an object"
        raise TypeError(message)
    return t.cast("t.Mapping[str, object]", value)


def _require_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        message = f"{label} must be a non-empty string"
        raise TypeError(message)
    return value


def _binary_chunk(content: bytes) -> dict[str, object]:
    return {
        "byteLength": len(content),
        "contentBase64": base64.b64encode(content).decode("ascii"),
        "encoding": "base64",
    }


def _write_all_to_file_descriptor(write_fd: int, content: bytes) -> None:
    remaining_content = memoryview(content)
    while remaining_content:
        written_bytes = os.write(write_fd, remaining_content)
        if written_bytes <= 0:
            raise OSError("Hermes output pipe write made no progress")
        remaining_content = remaining_content[written_bytes:]


def _content_digest(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


def _render_remote_bash_command(command: str, *, login: bool) -> str:
    login_flag = "-l " if login else ""
    return f"bash {login_flag}-c {shlex.quote(command)}"


class HermesGatewayRuntimeProcessHandle:
    """ProcessHandle facade for one exact Gateway Runtime execution."""

    def __init__(
        self,
        *,
        operation_future: concurrent.futures.Future[int],
        cancel_operation: t.Callable[[], str],
        close_stdout_write: t.Callable[[], None],
        stdout_read_fd: int,
    ) -> None:
        self._operation_future = operation_future
        self._cancel_operation = cancel_operation
        self._close_stdout_write = close_stdout_write
        self._stdout = os.fdopen(
            stdout_read_fd,
            "r",
            encoding="utf-8",
            errors="replace",
        )
        self._returncode: int | None = None
        self._outcome_error: HermesGatewayRuntimeOutcomeError | None = None
        self._state_lock = threading.Lock()
        operation_future.add_done_callback(self._operation_finished)

    @property
    def stdout(self) -> t.IO[str] | None:
        return self._stdout

    @property
    def returncode(self) -> int | None:
        with self._state_lock:
            return self._returncode

    def _operation_finished(self, future: concurrent.futures.Future[int]) -> None:
        with self._state_lock:
            if self._returncode is not None:
                return
            try:
                self._returncode = future.result()
            except concurrent.futures.CancelledError:
                if self._returncode is None:
                    self._returncode = 130
            except HermesGatewayRuntimeOutcomeError as error:
                self._outcome_error = error
                self._returncode = 125
            except BaseException:
                self._returncode = 125

    def poll(self) -> int | None:
        return self.returncode

    def kill(self) -> None:
        outcome_kind = self._cancel_operation()
        with self._state_lock:
            if outcome_kind == "cancelled-proven":
                self._returncode = 130
            else:
                self._outcome_error = HermesGatewayRuntimeOutcomeError(outcome_kind)
                self._returncode = 125
        self._close_stdout_write()
        self._operation_future.cancel()

    def wait(self, timeout: float | None = None) -> int:
        try:
            self._operation_future.result(timeout=timeout)
        except concurrent.futures.CancelledError:
            pass
        except HermesGatewayRuntimeOutcomeError as error:
            with self._state_lock:
                self._outcome_error = error
                self._returncode = 125
        with self._state_lock:
            if self._outcome_error is not None:
                raise self._outcome_error
            if self._returncode is None:
                raise TimeoutError(
                    "Gateway Runtime process did not finish before the wait deadline"
                )
            return self._returncode


class HermesGatewayRuntimeEnvironment(BaseEnvironment):
    """Hermes shell environment mapped to one stable managed-agent projection."""

    def __init__(
        self,
        *,
        adapter: HermesManagedAdapter,
        projection: CanonicalManagedAgentProjection,
        task_id: str,
        cwd: str,
        timeout: int,
    ) -> None:
        self._adapter = adapter
        self._projection = projection
        self._task_id = task_id
        self._trusted_context = build_managed_trusted_context(
            projection,
            session_id=task_id,
        ).model_dump(
            by_alias=True,
            mode="json",
            exclude_none=True,
        )
        self._cleanup_lock = threading.Lock()
        self._closed = False
        super().__init__(cwd=cwd or _DEFAULT_TOOL_VM_CWD, timeout=timeout)
        self._environment_handle = self._open_environment()
        self.init_session()

    @property
    def agent_id(self) -> str:
        return _projection_string_field(self._projection, "agentId")

    @property
    def profile_name(self) -> str:
        return _projection_profile_name(self._projection)

    @property
    def gateway_runtime_client(self) -> GatewayRuntimeClient:
        return self._adapter.gateway_runtime_client_for_profile(self.profile_name)

    @property
    def owning_generation(self) -> str:
        return _require_string(
            self._environment_handle.get("owningGeneration"),
            "environment owningGeneration",
        )

    @property
    def cache_identity(self) -> str:
        return self._task_id

    def bind_cache_identity(self, cache_identity: str) -> None:
        with self._cleanup_lock:
            if self._closed:
                message = "Cannot bind a closed Hermes managed environment"
                raise RuntimeError(message)
            self._task_id = cache_identity
            self._trusted_context = build_managed_trusted_context(
                self._projection,
                session_id=cache_identity,
            ).model_dump(
                by_alias=True,
                mode="json",
                exclude_none=True,
            )

    def require_local_process_authority(
        self,
        *,
        cache_identity: str,
        owning_generation: str,
    ) -> None:
        with self._cleanup_lock:
            if self._closed:
                raise RuntimeError("Hermes managed Gateway Runtime environment is retired")
            if self._task_id != cache_identity or self.owning_generation != owning_generation:
                raise RuntimeError("Hermes managed Gateway Runtime environment authority changed")

    def resolve_status_kind(self) -> str:
        result = self._adapter.run_gateway_runtime_coroutine(
            self.gateway_runtime_client.sandbox.environment.status(
                {"environment": dict(self._environment_handle)},
                trusted_context=self._trusted_context,
            ),
            timeout=self.timeout,
        )
        status_kind = _require_string(
            _model_mapping(result).get("kind"),
            "environment status kind",
        )
        if status_kind not in {"active", "closed", "replaced"}:
            message = f"Unsupported Gateway Runtime environment status {status_kind!r}"
            raise RuntimeError(message)
        return status_kind

    def start_managed_process(
        self,
        *,
        command: str,
        cwd: str,
        maximum_runtime_milliseconds: int,
        retained_output_bytes: int,
    ) -> dict[str, object]:
        self._require_open()
        result = self._adapter.run_gateway_runtime_coroutine(
            self.gateway_runtime_client.sandbox.process.start(
                {
                    "command": command,
                    "cwd": cwd,
                    "environment": dict(self._environment_handle),
                    "maxRuntimeMs": maximum_runtime_milliseconds,
                    "retainOutputBytes": retained_output_bytes,
                },
                trusted_context=self._trusted_context,
            )
        )
        return _model_mapping(result)

    def resolve_managed_process_status(
        self,
        process: t.Mapping[str, object],
    ) -> dict[str, object]:
        self._require_open()
        result = self._adapter.run_gateway_runtime_coroutine(
            self.gateway_runtime_client.sandbox.process.status(
                {"process": dict(process)},
                trusted_context=self._trusted_context,
            )
        )
        return _model_mapping(result)

    def wait_for_managed_process(
        self,
        process: t.Mapping[str, object],
        *,
        timeout_milliseconds: int,
    ) -> dict[str, object]:
        self._require_open()
        result = self._adapter.run_gateway_runtime_coroutine(
            self.gateway_runtime_client.sandbox.process.wait(
                {
                    "process": dict(process),
                    "timeoutMs": timeout_milliseconds,
                },
                trusted_context=self._trusted_context,
            )
        )
        return _model_mapping(result)

    def read_managed_process_logs(
        self,
        process: t.Mapping[str, object],
        *,
        cursor: str | None,
        maximum_bytes: int,
    ) -> dict[str, object]:
        self._require_open()
        request: dict[str, object] = {
            "channels": ["stdout", "stderr"],
            "maxBytes": maximum_bytes,
            "process": dict(process),
        }
        if cursor is not None:
            request["cursor"] = cursor
        result = self._adapter.run_gateway_runtime_coroutine(
            self.gateway_runtime_client.sandbox.process.logs(
                request,
                trusted_context=self._trusted_context,
            )
        )
        return _model_mapping(result)

    def cancel_managed_process(
        self,
        process: t.Mapping[str, object],
    ) -> dict[str, object]:
        self._require_open()
        result = self._adapter.run_gateway_runtime_coroutine(
            self.gateway_runtime_client.sandbox.process.cancel(
                {"process": dict(process)},
                trusted_context=self._trusted_context,
            )
        )
        return _model_mapping(result)

    def write_managed_process_input(
        self,
        stream: t.Mapping[str, object],
        *,
        content: bytes,
        sequence: int,
    ) -> dict[str, object]:
        self._require_open()
        result = self._adapter.run_gateway_runtime_coroutine(
            self.gateway_runtime_client.sandbox.stream.write(
                {
                    "content": _binary_chunk(content),
                    "contentDigest": _content_digest(content),
                    "sequence": sequence,
                    "stream": dict(stream),
                },
                trusted_context=self._trusted_context,
            )
        )
        return _model_mapping(result)

    def close_managed_process_input(
        self,
        stream: t.Mapping[str, object],
    ) -> dict[str, object]:
        self._require_open()
        result = self._adapter.run_gateway_runtime_coroutine(
            self.gateway_runtime_client.sandbox.stream.close(
                {"stream": dict(stream)},
                trusted_context=self._trusted_context,
            )
        )
        return _model_mapping(result)

    def _require_open(self) -> None:
        with self._cleanup_lock:
            if self._closed:
                raise RuntimeError("Hermes managed Gateway Runtime environment is closed")

    def retire_locally(self) -> None:
        with self._cleanup_lock:
            self._closed = True

    def _open_environment(self) -> t.Mapping[str, object]:
        result = self._adapter.run_gateway_runtime_coroutine(
            self.gateway_runtime_client.sandbox.environment.open(
                {},
                trusted_context=self._trusted_context,
            ),
            timeout=self.timeout,
        )
        return _require_mapping(_model_mapping(result).get("environment"), "environment handle")

    async def _read_stream(self, stream: t.Mapping[str, object], write_fd: int) -> None:
        cursor: str | None = None
        while True:
            request: dict[str, object] = {
                "maxBytes": _MAXIMUM_STREAM_CHUNK_BYTES,
                "stream": dict(stream),
            }
            if cursor is not None:
                request["cursor"] = cursor
            result = await self.gateway_runtime_client.sandbox.stream.read(
                request,
                trusted_context=self._trusted_context,
            )
            result_mapping = _model_mapping(result)
            chunk = _require_mapping(result_mapping.get("chunk"), "stream chunk")
            content = base64.b64decode(
                _require_string(chunk.get("contentBase64"), "stream contentBase64")
                if chunk.get("byteLength") != 0
                else "",
                validate=True,
            )
            if content:
                try:
                    await asyncio.to_thread(
                        _write_all_to_file_descriptor,
                        write_fd,
                        content,
                    )
                except OSError:
                    return
            if result_mapping.get("eof") is True:
                return
            next_cursor = _require_string(result_mapping.get("nextCursor"), "stream nextCursor")
            if next_cursor == cursor:
                message = "Gateway Runtime stream returned a non-advancing cursor"
                raise RuntimeError(message)
            cursor = next_cursor

    async def _write_stdin(
        self,
        stream: t.Mapping[str, object],
        stdin_data: str | None,
    ) -> None:
        if stdin_data is not None:
            content = stdin_data.encode("utf-8")
            await self.gateway_runtime_client.sandbox.stream.write(
                {
                    "content": _binary_chunk(content),
                    "contentDigest": _content_digest(content),
                    "sequence": 0,
                    "stream": dict(stream),
                },
                trusted_context=self._trusted_context,
            )
        await self.gateway_runtime_client.sandbox.stream.close(
            {"stream": dict(stream)},
            trusted_context=self._trusted_context,
        )

    async def _run_operation(
        self,
        *,
        command: str,
        login: bool,
        timeout: int,
        stdin_data: str | None,
        write_fd: int,
        close_stdout_write: t.Callable[[], None],
        operation_state: dict[str, t.Mapping[str, object]],
        operation_ready: threading.Event,
    ) -> int:
        try:
            started = await self.gateway_runtime_client.sandbox.execution.start(
                {
                    "command": _render_remote_bash_command(command, login=login),
                    "cwd": self.cwd,
                    "environment": dict(self._environment_handle),
                    "mode": {"kind": "direct"},
                    "timeoutMs": timeout * 1_000,
                },
                trusted_context=self._trusted_context,
            )
            started_mapping = _model_mapping(started)
            if started_mapping.get("mode") != "direct":
                message = "Hermes managed environment requires direct Gateway Runtime execution"
                raise RuntimeError(message)
            operation = _require_mapping(started_mapping.get("operation"), "operation")
            operation_state["operation"] = operation
            operation_ready.set()
            streams_value = started_mapping.get("streams")
            if not isinstance(streams_value, list):
                message = "Gateway Runtime direct execution omitted streams"
                raise TypeError(message)
            streams = [_require_mapping(stream_value, "stream") for stream_value in streams_value]

            def require_stream(channel: str) -> t.Mapping[str, object]:
                for stream in streams:
                    if stream.get("channel") == channel:
                        return stream
                message = f"Gateway Runtime direct execution omitted {channel} stream"
                raise RuntimeError(message)

            stdout_stream = require_stream("stdout")
            stderr_stream = require_stream("stderr")
            stdin_stream = require_stream("stdin")
            await self._write_stdin(stdin_stream, stdin_data)
            wait_result = await self.gateway_runtime_client.sandbox.execution.wait(
                {"operation": dict(operation), "timeoutMs": timeout * 1_000},
                trusted_context=self._trusted_context,
            )
            await asyncio.gather(
                self._read_stream(stdout_stream, write_fd),
                self._read_stream(stderr_stream, write_fd),
            )
            wait_mapping = _model_mapping(wait_result)
            outcome = _require_mapping(wait_mapping.get("outcome"), "operation outcome")
            outcome_kind = _require_string(outcome.get("kind"), "operation outcome kind")
            if outcome_kind != "completed":
                raise HermesGatewayRuntimeOutcomeError(outcome_kind)
            exit_code = wait_mapping.get("exitCode")
            if not isinstance(exit_code, int) or isinstance(exit_code, bool):
                message = "Gateway Runtime completed execution without an exact exit code"
                raise HermesGatewayRuntimeOutcomeError(message)
            return exit_code
        finally:
            operation_ready.set()
            close_stdout_write()

    @t.override
    def _run_bash(
        self,
        cmd_string: str,
        *,
        login: bool = False,
        timeout: int = 120,
        stdin_data: str | None = None,
    ) -> HermesGatewayRuntimeProcessHandle:
        self._require_open()
        stdout_read_fd, stdout_write_fd = os.pipe()
        stdout_write_lock = threading.Lock()
        stdout_write_closed = False

        def close_stdout_write() -> None:
            nonlocal stdout_write_closed
            with stdout_write_lock:
                if stdout_write_closed:
                    return
                stdout_write_closed = True
                try:
                    os.close(stdout_write_fd)
                except OSError:
                    pass

        operation_state: dict[str, t.Mapping[str, object]] = {}
        operation_ready = threading.Event()
        future = self._adapter.submit_gateway_runtime_coroutine(
            self._run_operation(
                command=cmd_string,
                login=login,
                timeout=timeout,
                stdin_data=stdin_data,
                write_fd=stdout_write_fd,
                close_stdout_write=close_stdout_write,
                operation_state=operation_state,
                operation_ready=operation_ready,
            )
        )

        def cancel_operation() -> str:
            if not operation_ready.wait(timeout=5):
                return "ambiguous"
            operation = operation_state.get("operation")
            if operation is None:
                return "ambiguous"
            result = self._adapter.run_gateway_runtime_coroutine(
                self.gateway_runtime_client.sandbox.execution.cancel(
                    {"operation": dict(operation)},
                    trusted_context=self._trusted_context,
                )
            )
            cancellation = _model_mapping(result)
            cancellation_kind = _require_string(
                cancellation.get("kind"),
                "cancellation result kind",
            )
            if cancellation_kind in {
                "running",
                "cancel-request-accepted",
                "cancellation-pending",
            }:
                return cancellation_kind
            outcome = _require_mapping(
                cancellation.get("outcome"),
                "cancellation outcome",
            )
            return _require_string(outcome.get("kind"), "cancellation outcome kind")

        return HermesGatewayRuntimeProcessHandle(
            operation_future=future,
            cancel_operation=cancel_operation,
            close_stdout_write=close_stdout_write,
            stdout_read_fd=stdout_read_fd,
        )

    @t.override
    def cleanup(self) -> None:
        with self._cleanup_lock:
            if self._closed:
                return
            self._closed = True
        self._adapter.run_gateway_runtime_coroutine(
            self.gateway_runtime_client.sandbox.environment.close(
                {"environment": dict(self._environment_handle)},
                trusted_context=self._trusted_context,
            )
        )


class HermesGatewayRuntimeEnvironmentFactory:
    """Create exact-profile BaseEnvironment instances without fallback."""

    def __init__(self, *, adapter: HermesManagedAdapter) -> None:
        self._adapter = adapter
        self._environments: list[HermesGatewayRuntimeEnvironment] = []
        self._environment_lock = threading.Lock()
        self._closed = False

    def create(
        self,
        *,
        profile_name: str | None,
        task_id: str,
        cwd: str,
        timeout: int,
    ) -> HermesGatewayRuntimeEnvironment:
        del cwd
        with self._environment_lock:
            if self._closed:
                message = "Hermes managed environment factory is closed"
                raise RuntimeError(message)
        if not profile_name or profile_name == "default":
            raise HermesProfileAdmissionError(
                "Managed Hermes requires an explicit routed SessionSource.profile."
            )
        projection = self._adapter.projection_for_profile(profile_name)
        environment = HermesGatewayRuntimeEnvironment(
            adapter=self._adapter,
            projection=projection,
            task_id=task_id,
            cwd=_DEFAULT_TOOL_VM_CWD,
            timeout=timeout,
        )
        with self._environment_lock:
            if self._closed:
                environment.cleanup()
                message = "Hermes managed environment factory closed during environment creation"
                raise RuntimeError(message)
            self._environments.append(environment)
        return environment

    def close(self) -> None:
        with self._environment_lock:
            if self._closed:
                return
            self._closed = True
            environments = tuple(self._environments)
            self._environments.clear()
        cleanup_errors: list[Exception] = []
        for environment in environments:
            try:
                environment.cleanup()
            except Exception as error:
                cleanup_errors.append(error)
        if cleanup_errors:
            raise ExceptionGroup(
                "Failed to close Hermes managed Gateway Runtime environments",
                cleanup_errors,
            )
