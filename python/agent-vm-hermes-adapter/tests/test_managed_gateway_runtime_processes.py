import base64
import threading
import typing as t
import unittest
from unittest.mock import patch

from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import BaseModel, ConfigDict
from tools.process_registry import ProcessRegistry, ProcessSession

from agent_vm_hermes_adapter.managed_gateway_runtime_environment import (
    HermesGatewayRuntimeEnvironment,
    HermesGatewayRuntimeEnvironmentFactory,
)
from agent_vm_hermes_adapter.managed_gateway_runtime_process_hooks import (
    HermesManagedProcessHooks,
)
from agent_vm_hermes_adapter.managed_gateway_runtime_process_state import (
    HermesManagedProcessRecord,
)
from agent_vm_hermes_adapter.managed_gateway_runtime_processes import (
    HermesManagedProcessAuthorityError,
    HermesManagedProcessRegistryPort,
    HermesManagedProcessRuntime,
)
from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesManagedAdapterConfig,
)

PROJECTION_COHORT_DIGEST = (
    "projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)


class PortableResult(BaseModel):
    model_config = ConfigDict(extra="allow")


class FakeOperationCallable(t.Protocol):
    def __call__(
        self,
        request: t.Mapping[str, object],
        *,
        trusted_context: t.Mapping[str, object],
    ) -> t.Awaitable[PortableResult]: ...


class FakeOperationGroup:
    def __init__(self, results: t.Mapping[str, t.Mapping[str, object]]) -> None:
        self.calls: list[tuple[str, t.Mapping[str, object], t.Mapping[str, object]]] = []
        self._results = dict(results)
        self._next_errors: dict[str, list[Exception]] = {}

    def set_result(self, operation_name: str, result: t.Mapping[str, object]) -> None:
        self._results[operation_name] = result

    def fail_next(self, operation_name: str, error: Exception) -> None:
        self._next_errors.setdefault(operation_name, []).append(error)

    def __getattr__(self, operation_name: str) -> FakeOperationCallable:
        async def execute(
            request: t.Mapping[str, object],
            *,
            trusted_context: t.Mapping[str, object],
        ) -> PortableResult:
            self.calls.append((operation_name, request, trusted_context))
            queued_errors = self._next_errors.get(operation_name)
            if queued_errors:
                raise queued_errors.pop(0)
            return PortableResult.model_validate(self._results[operation_name])

        return execute


class FakeSandbox:
    def __init__(self) -> None:
        generation = "tool-vm-generation-7"
        environment_handle = {
            "handleId": "environment-1",
            "kind": "environment",
            "owningGeneration": generation,
        }
        operation = {
            "operationId": "operation-1",
            "owningGeneration": generation,
        }
        process_handle = {
            "handleId": "process-1",
            "kind": "process",
            "owningGeneration": generation,
        }
        streams = [
            {
                "handleId": "stdin-1",
                "kind": "stream",
                "owningGeneration": generation,
                "channel": "stdin",
            },
            {
                "handleId": "stdout-1",
                "kind": "stream",
                "owningGeneration": generation,
                "channel": "stdout",
            },
            {
                "handleId": "stderr-1",
                "kind": "stream",
                "owningGeneration": generation,
                "channel": "stderr",
            },
        ]
        self.environment = FakeOperationGroup(
            {
                "open": {"kind": "opened", "environment": environment_handle},
                "close": {"kind": "closed", "environment": environment_handle},
                "status": {"kind": "active", "environment": environment_handle},
            }
        )
        self.execution = FakeOperationGroup(
            {
                "start": {
                    "kind": "started",
                    "mode": "direct",
                    "operation": operation,
                    "streams": streams,
                },
                "wait": {
                    "kind": "terminal",
                    "operation": operation,
                    "outcome": {
                        "kind": "completed",
                        "certainty": "proven",
                        "completion": "succeeded",
                        "retryClass": "forbidden",
                    },
                    "exitCode": 0,
                },
                "cancel": {
                    "kind": "termination-proven",
                    "operation": operation,
                    "outcome": {
                        "kind": "cancelled-proven",
                        "certainty": "proven-terminated",
                        "retryClass": "manual-only",
                    },
                },
            }
        )
        self.process = FakeOperationGroup(
            {
                "start": {
                    "kind": "started",
                    "operation": operation,
                    "process": process_handle,
                    "streams": streams,
                },
                "status": {
                    "kind": "running",
                    "operation": operation,
                    "process": process_handle,
                },
                "wait": {
                    "kind": "terminal",
                    "operation": operation,
                    "process": process_handle,
                    "outcome": {
                        "kind": "completed",
                        "certainty": "proven",
                        "completion": "succeeded",
                        "retryClass": "forbidden",
                    },
                },
                "logs": {
                    "kind": "logs",
                    "process": process_handle,
                    "chunks": [
                        {
                            "channel": "stdout",
                            "chunk": {
                                "byteLength": 6,
                                "contentBase64": base64.b64encode(b"ready\n").decode("ascii"),
                                "encoding": "base64",
                            },
                            "sequence": 0,
                        }
                    ],
                    "truncated": False,
                },
                "cancel": {
                    "kind": "termination-proven",
                    "operation": operation,
                    "outcome": {
                        "kind": "cancelled-proven",
                        "certainty": "proven-terminated",
                        "retryClass": "manual-only",
                    },
                },
            }
        )
        self.stream = FakeOperationGroup(
            {
                "read": {
                    "kind": "read",
                    "stream": streams[1],
                    "chunk": {
                        "encoding": "base64",
                        "contentBase64": "",
                        "byteLength": 0,
                    },
                    "sequence": 0,
                    "eof": True,
                },
                "write": {
                    "kind": "written",
                    "stream": streams[0],
                    "sequence": 0,
                    "bytesWritten": 5,
                },
                "close": {"kind": "closed", "stream": streams[0]},
            }
        )


class FakeGatewayRuntimeClient:
    def __init__(self) -> None:
        self.sandbox = FakeSandbox()

    async def connect(self) -> None:
        return None

    async def disconnect(self) -> None:
        return None


class FakeProcessRegistryPort(HermesManagedProcessRegistryPort):
    def __init__(self) -> None:
        self.running: dict[str, ProcessSession] = {}
        self.finished: dict[str, ProcessSession] = {}
        self.output_events: list[tuple[str, str]] = []

    @t.override
    def register(self, session: ProcessSession) -> None:
        self.running[session.id] = session

    @t.override
    def append_output(self, session: ProcessSession, output: str) -> None:
        session.output_buffer += output
        self.output_events.append((session.id, output))

    @t.override
    def finish(self, session: ProcessSession) -> None:
        _ = self.running.pop(session.id, None)
        self.finished[session.id] = session
        session._completion_event.set()


class FailingInstallProcessRegistry(ProcessRegistry):
    def __init__(self) -> None:
        self._failing_method_name: str | None = None
        super().__init__()

    def fail_next_install_at(self, method_name: str) -> None:
        self._failing_method_name = method_name

    @t.override
    def __setattr__(self, attribute_name: str, value: object) -> None:
        if attribute_name == self.__dict__.get("_failing_method_name"):
            self._failing_method_name = None
            raise RuntimeError(f"refused process hook {attribute_name}")
        super().__setattr__(attribute_name, value)


def build_projection(*, agent_id: str) -> dict[str, object]:
    return {
        "agentId": agent_id,
        "frameworkIdentity": {"kind": "hermes", "profileName": agent_id},
        "profileAssignmentRevision": f"revision-{agent_id}",
        "toolPortalNamespaces": [{"namespace": "filesystem"}, {"namespace": "github"}],
        "toolPortalProfileId": f"policy-{agent_id}",
    }


def build_log_chunk(
    *,
    channel: str,
    sequence: int,
    content: bytes,
) -> dict[str, object]:
    return {
        "channel": channel,
        "chunk": {
            "byteLength": len(content),
            "contentBase64": base64.b64encode(content).decode("ascii"),
            "encoding": "base64",
        },
        "sequence": sequence,
    }


@t.final
class HermesManagedProcessRuntimeTests(unittest.TestCase):
    _client: FakeGatewayRuntimeClient | None = None
    _adapter: HermesManagedAdapter | None = None
    _environment_factory: HermesGatewayRuntimeEnvironmentFactory | None = None
    _process_registry: FakeProcessRegistryPort | None = None
    _current_projection: list[CanonicalManagedAgentProjection] | None = None
    _runtime: HermesManagedProcessRuntime | None = None

    @property
    def client(self) -> FakeGatewayRuntimeClient:
        if self._client is None:
            raise RuntimeError("test Gateway Runtime client is not initialized")
        return self._client

    @property
    def adapter(self) -> HermesManagedAdapter:
        if self._adapter is None:
            raise RuntimeError("test Hermes adapter is not initialized")
        return self._adapter

    @property
    def environment_factory(self) -> HermesGatewayRuntimeEnvironmentFactory:
        if self._environment_factory is None:
            raise RuntimeError("test Hermes environment factory is not initialized")
        return self._environment_factory

    @property
    def process_registry(self) -> FakeProcessRegistryPort:
        if self._process_registry is None:
            raise RuntimeError("test process registry is not initialized")
        return self._process_registry

    @property
    def current_projection(self) -> list[CanonicalManagedAgentProjection]:
        if self._current_projection is None:
            raise RuntimeError("test current projection is not initialized")
        return self._current_projection

    @property
    def runtime(self) -> HermesManagedProcessRuntime:
        if self._runtime is None:
            raise RuntimeError("test managed process runtime is not initialized")
        return self._runtime

    @t.override
    def setUp(self) -> None:
        self._client = FakeGatewayRuntimeClient()
        self._adapter = HermesManagedAdapter(
            config=HermesManagedAdapterConfig(
                profiles=(
                    build_projection(agent_id="researcher"),
                    build_projection(agent_id="reviewer"),
                ),
                projection_cohort_digest=PROJECTION_COHORT_DIGEST,
                protected_hermes_home="/home/hermes/.hermes",
            ),
            gateway_runtime_client=t.cast(
                "GatewayRuntimeClient",
                t.cast("object", self.client),
            ),
        )
        self.adapter.connect_gateway_runtime()
        self._environment_factory = HermesGatewayRuntimeEnvironmentFactory(adapter=self.adapter)
        self._process_registry = FakeProcessRegistryPort()
        self._current_projection = [self.adapter.projection_for_profile("researcher")]
        self._runtime = HermesManagedProcessRuntime(
            current_projection=lambda: self.current_projection[0],
            process_registry=self.process_registry,
            start_monitor_threads=False,
        )

    @t.override
    def tearDown(self) -> None:
        self.runtime.close()
        self.environment_factory.close()
        self.adapter.close()
        self._runtime = None
        self._current_projection = None
        self._process_registry = None
        self._environment_factory = None
        self._adapter = None
        self._client = None

    def create_environment(
        self,
        profile_name: str = "researcher",
    ) -> HermesGatewayRuntimeEnvironment:
        return self.environment_factory.create(
            profile_name=profile_name,
            task_id=f"agent-vm-hermes:{profile_name}:generation-7",
            cwd="/work",
            timeout=60,
        )

    def process_record(self, session_id: str) -> HermesManagedProcessRecord:
        record = self.runtime._records_by_session_id.get(session_id)
        if record is None:
            raise RuntimeError(f"managed process record {session_id!r} was not found")
        return record

    def test_background_start_uses_opaque_process_api_without_shell_pid_emulation(self) -> None:
        environment = self.create_environment()

        session = self.runtime.spawn_via_env(
            env=environment,
            command="pnpm test",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )

        self.assertIsNone(session.pid)
        self.assertEqual(session.pid_scope, "sandbox")
        self.assertRegex(session.id, r"^proc_[a-f0-9]+$")
        self.assertEqual(tuple(self.process_registry.running), (session.id,))
        process_start = self.client.sandbox.process.calls[-1]
        self.assertEqual(process_start[0], "start")
        self.assertEqual(process_start[1]["command"], "pnpm test")
        self.assertEqual(process_start[1]["cwd"], "/work")
        self.assertNotRegex(str(process_start[1]), r"nohup|\.pid|\.log|echo \$!|kill -0")

    def test_process_list_matches_same_task_or_same_session_with_profile_fence(self) -> None:
        environment = self.create_environment()
        session = self.runtime.spawn_via_env(
            env=environment,
            command="sleep 300",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )

        same_task = self.runtime.list_sessions(
            task_id=environment.cache_identity,
            session_key="different-session",
        )
        same_session = self.runtime.list_sessions(
            task_id="different-task",
            session_key="session-researcher",
        )
        unrelated = self.runtime.list_sessions(
            task_id="different-task",
            session_key="different-session",
        )
        self.current_projection[0] = self.adapter.projection_for_profile("reviewer")
        different_profile = self.runtime.list_sessions(
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )

        self.assertEqual([result["session_id"] for result in same_task], [session.id])
        self.assertEqual([result["session_id"] for result in same_session], [session.id])
        self.assertEqual(unrelated, [])
        self.assertEqual(different_profile, [])

    def test_process_actions_map_to_opaque_process_and_stream_operations(self) -> None:
        environment = self.create_environment()
        session = self.runtime.spawn_via_env(
            env=environment,
            command="read input",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )

        poll_result = self.runtime.poll(session.id)
        write_result = self.runtime.write_stdin(session.id, "hello")
        close_result = self.runtime.close_stdin(session.id)
        wait_result = self.runtime.wait(session.id, timeout=5)

        self.assertEqual(poll_result["status"], "running")
        output_preview = poll_result["output_preview"]
        if not isinstance(output_preview, str):
            self.fail("managed process poll output_preview was not a string")
        self.assertIn("ready", output_preview)
        self.assertEqual(write_result, {"status": "ok", "bytes_written": 5})
        self.assertEqual(close_result, {"status": "ok", "message": "EOF sent"})
        self.assertEqual(wait_result["status"], "exited")
        self.assertEqual(wait_result["exit_code"], 0)
        self.assertEqual(
            [operation for operation, _, _ in self.client.sandbox.process.calls],
            ["start", "status", "logs", "wait", "logs"],
        )
        self.assertEqual(
            [operation for operation, _, _ in self.client.sandbox.stream.calls[-2:]],
            ["write", "close"],
        )
        self.assertEqual(
            self.process_registry.output_events,
            [(session.id, "ready\n")],
        )

    def test_transient_monitor_observation_errors_preserve_cancellation_authority(self) -> None:
        for failing_operation in ("status", "logs"):
            with self.subTest(failing_operation=failing_operation):
                environment = self.create_environment()
                session = self.runtime.spawn_via_env(
                    env=environment,
                    command=f"observe {failing_operation}",
                    cwd="/work",
                    task_id=environment.cache_identity,
                    session_key="session-researcher",
                )
                record = self.process_record(session.id)
                self.client.sandbox.process.fail_next(
                    failing_operation,
                    RuntimeError(f"transient {failing_operation} failure"),
                )

                keep_monitoring = self.runtime._observe_process_for_monitor(record)

                self.assertTrue(keep_monitoring)
                self.assertFalse(session.exited)
                self.assertFalse(record.finished)

                cancellation_result = self.runtime.kill_process(session.id)

                self.assertEqual(cancellation_result["status"], "killed")
                cancel_operation, cancel_request, _ = self.client.sandbox.process.calls[-1]
                self.assertEqual(cancel_operation, "cancel")
                self.assertEqual(cancel_request["process"], record.process)

    def test_duplicate_and_out_of_order_logs_append_once_with_bounded_high_water(self) -> None:
        environment = self.create_environment()
        session = self.runtime.spawn_via_env(
            env=environment,
            command="emit logs",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )
        self.client.sandbox.process.set_result(
            "logs",
            {
                "kind": "logs",
                "process": {
                    "handleId": "process-1",
                    "kind": "process",
                    "owningGeneration": "tool-vm-generation-7",
                },
                "chunks": [
                    build_log_chunk(channel="stdout", sequence=0, content=b"first\n"),
                    build_log_chunk(channel="stdout", sequence=0, content=b"duplicate\n"),
                    build_log_chunk(channel="stdout", sequence=1, content=b"second\n"),
                    build_log_chunk(channel="stdout", sequence=0, content=b"late\n"),
                ],
                "truncated": False,
            },
        )

        first_result = self.runtime.read_log(session.id)
        second_result = self.runtime.read_log(session.id)

        self.assertEqual(first_result["output"], "first\nsecond")
        self.assertEqual(second_result["output"], "first\nsecond")
        self.assertEqual(
            self.process_registry.output_events,
            [(session.id, "first\nsecond\n")],
        )
        self.assertEqual(
            self.process_record(session.id).latest_log_sequence_by_channel,
            {"stdout": 1},
        )

    def test_concurrent_stdin_write_and_eof_are_ordered_without_post_eof_write(self) -> None:
        environment = self.create_environment()
        session = self.runtime.spawn_via_env(
            env=environment,
            command="read stdin",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )
        write_started = threading.Event()
        release_write = threading.Event()
        close_attempted = threading.Event()
        thread_errors: list[BaseException] = []
        write_results: list[dict[str, object]] = []
        close_results: list[dict[str, object]] = []
        original_write = environment.write_managed_process_input
        input_operations_before = [
            operation
            for operation, _, _ in self.client.sandbox.stream.calls
            if operation in {"write", "close"}
        ]

        def blocking_write(
            stream: t.Mapping[str, object],
            *,
            content: bytes,
            sequence: int,
        ) -> dict[str, object]:
            write_started.set()
            if not release_write.wait(timeout=1):
                raise RuntimeError("test did not release managed stdin write")
            return original_write(stream, content=content, sequence=sequence)

        def run_write() -> None:
            try:
                write_results.append(self.runtime.write_stdin(session.id, "hello"))
            except BaseException as error:
                thread_errors.append(error)

        def run_close() -> None:
            close_attempted.set()
            try:
                close_results.append(self.runtime.close_stdin(session.id))
            except BaseException as error:
                thread_errors.append(error)

        with patch.object(
            environment,
            "write_managed_process_input",
            side_effect=blocking_write,
        ):
            write_thread = threading.Thread(target=run_write)
            close_thread = threading.Thread(target=run_close)
            write_thread.start()
            self.assertTrue(write_started.wait(timeout=1))
            close_thread.start()
            self.assertTrue(close_attempted.wait(timeout=1))
            self.assertEqual(
                [
                    operation
                    for operation, _, _ in self.client.sandbox.stream.calls
                    if operation in {"write", "close"}
                ],
                input_operations_before,
            )
            release_write.set()
            write_thread.join(timeout=2)
            close_thread.join(timeout=2)

        self.assertFalse(write_thread.is_alive())
        self.assertFalse(close_thread.is_alive())
        self.assertEqual(thread_errors, [])
        self.assertEqual(write_results, [{"status": "ok", "bytes_written": 5}])
        self.assertEqual(close_results, [{"status": "ok", "message": "EOF sent"}])
        self.assertEqual(
            [
                operation
                for operation, _, _ in self.client.sandbox.stream.calls
                if operation in {"write", "close"}
            ][len(input_operations_before) :],
            ["write", "close"],
        )
        input_calls_before = sum(
            operation in {"write", "close"} for operation, _, _ in self.client.sandbox.stream.calls
        )

        post_eof_result = self.runtime.write_stdin(session.id, "too late")

        self.assertEqual(post_eof_result, {"status": "error", "error": "Process stdin is closed"})
        self.assertEqual(
            sum(
                operation in {"write", "close"}
                for operation, _, _ in self.client.sandbox.stream.calls
            ),
            input_calls_before,
        )

    def test_kill_cancels_exact_opaque_process(self) -> None:
        environment = self.create_environment()
        session = self.runtime.spawn_via_env(
            env=environment,
            command="sleep 300",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )

        result = self.runtime.kill_process(session.id)

        self.assertEqual(result["status"], "killed")
        self.assertEqual(self.client.sandbox.process.calls[-1][0], "cancel")
        self.assertEqual(session.exit_code, 130)

    def test_cross_profile_process_actions_fail_before_uds_use(self) -> None:
        environment = self.create_environment()
        session = self.runtime.spawn_via_env(
            env=environment,
            command="sleep 300",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )
        calls_before = len(self.client.sandbox.process.calls)
        self.current_projection[0] = self.adapter.projection_for_profile("reviewer")

        result = self.runtime.poll(session.id)

        self.assertEqual(result["status"], "not_found")
        self.assertEqual(len(self.client.sandbox.process.calls), calls_before)

    def test_cross_profile_start_fails_before_environment_status_uds_use(self) -> None:
        environment = self.create_environment("reviewer")
        status_calls_before = len(self.client.sandbox.environment.calls)

        with self.assertRaisesRegex(HermesManagedProcessAuthorityError, "current profile"):
            self.runtime.spawn_via_env(
                env=environment,
                command="sleep 300",
                cwd="/work",
                task_id=environment.cache_identity,
                session_key="session-reviewer",
            )

        self.assertEqual(len(self.client.sandbox.environment.calls), status_calls_before)
        self.assertEqual(self.client.sandbox.process.calls, [])

    def test_cross_profile_kill_all_does_not_cancel_other_profile_processes(self) -> None:
        environment = self.create_environment()
        _ = self.runtime.spawn_via_env(
            env=environment,
            command="sleep 300",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )
        process_calls_before = len(self.client.sandbox.process.calls)
        self.current_projection[0] = self.adapter.projection_for_profile("reviewer")

        killed = self.runtime.kill_all()

        self.assertEqual(killed, 0)
        self.assertEqual(len(self.client.sandbox.process.calls), process_calls_before)

    def test_active_process_capacity_refuses_start_before_creating_unowned_process(self) -> None:
        environment = self.create_environment()
        for process_index in range(64):
            _ = self.runtime.spawn_via_env(
                env=environment,
                command=f"sleep {process_index}",
                cwd="/work",
                task_id=environment.cache_identity,
                session_key="session-researcher",
            )
        process_calls_before = len(self.client.sandbox.process.calls)

        with self.assertRaisesRegex(RuntimeError, "process limit"):
            self.runtime.spawn_via_env(
                env=environment,
                command="sleep overflow",
                cwd="/work",
                task_id=environment.cache_identity,
                session_key="session-researcher",
            )

        self.assertEqual(len(self.client.sandbox.process.calls), process_calls_before)

    def test_completed_record_eviction_admits_successor_at_process_capacity(self) -> None:
        environment = self.create_environment()
        sessions = [
            self.runtime.spawn_via_env(
                env=environment,
                command=f"sleep {process_index}",
                cwd="/work",
                task_id=environment.cache_identity,
                session_key="session-researcher",
            )
            for process_index in range(64)
        ]
        completed_result = self.runtime.wait(sessions[0].id, timeout=1)

        successor = self.runtime.spawn_via_env(
            env=environment,
            command="successor",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )

        self.assertEqual(completed_result["status"], "exited")
        self.assertNotEqual(successor.id, sessions[0].id)
        self.assertEqual(
            sum(operation == "start" for operation, _, _ in self.client.sandbox.process.calls),
            65,
        )
        self.assertEqual(self.runtime.poll(sessions[0].id)["status"], "not_found")
        self.assertEqual(len(self.runtime._records_by_session_id), 64)

    def test_stale_generation_fails_before_process_operation(self) -> None:
        environment = self.create_environment()
        session = self.runtime.spawn_via_env(
            env=environment,
            command="sleep 300",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )
        self.client.sandbox.environment.set_result(
            "status",
            {
                "kind": "replaced",
                "environment": {
                    "handleId": "environment-1",
                    "kind": "environment",
                    "owningGeneration": "tool-vm-generation-7",
                },
            },
        )
        process_calls_before = len(self.client.sandbox.process.calls)

        result = self.runtime.poll(session.id)

        self.assertEqual(result["status"], "error")
        self.assertRegex(t.cast("str", result["error"]), r"stale|replaced")
        self.assertEqual(len(self.client.sandbox.process.calls), process_calls_before)

    def test_locally_retired_generation_fails_before_any_uds_operation(self) -> None:
        environment = self.create_environment()
        session = self.runtime.spawn_via_env(
            env=environment,
            command="sleep 300",
            cwd="/work",
            task_id=environment.cache_identity,
            session_key="session-researcher",
        )
        environment_calls_before = len(self.client.sandbox.environment.calls)
        process_calls_before = len(self.client.sandbox.process.calls)
        environment.retire_locally()

        result = self.runtime.poll(session.id)

        self.assertEqual(result["status"], "error")
        self.assertRegex(t.cast("str", result["error"]), r"locally retired")
        self.assertEqual(len(self.client.sandbox.environment.calls), environment_calls_before)
        self.assertEqual(len(self.client.sandbox.process.calls), process_calls_before)

    def test_locally_retired_environment_refuses_start_before_any_uds_operation(self) -> None:
        environment = self.create_environment()
        environment_calls_before = len(self.client.sandbox.environment.calls)
        environment.retire_locally()

        with self.assertRaisesRegex(HermesManagedProcessAuthorityError, "locally retired"):
            self.runtime.spawn_via_env(
                env=environment,
                command="sleep 300",
                cwd="/work",
                task_id=environment.cache_identity,
                session_key="session-researcher",
            )

        self.assertEqual(len(self.client.sandbox.environment.calls), environment_calls_before)
        self.assertEqual(self.client.sandbox.process.calls, [])

    def test_partial_hook_install_restores_every_prior_instance_method(self) -> None:
        process_registry = FailingInstallProcessRegistry()
        patched_method_names = (
            "spawn_via_env",
            "poll",
            "read_log",
            "wait",
            "kill_process",
            "write_stdin",
            "submit_stdin",
            "close_stdin",
            "list_sessions",
            "kill_all",
        )
        original_instance_values = {
            method_name: process_registry.__dict__.get(method_name)
            for method_name in patched_method_names
        }
        process_registry.fail_next_install_at("write_stdin")
        hooks = HermesManagedProcessHooks(
            current_projection=lambda: self.current_projection[0],
            process_registry=process_registry,
        )

        with self.assertRaisesRegex(RuntimeError, "write_stdin"):
            hooks.install()

        self.assertEqual(
            {
                method_name: process_registry.__dict__.get(method_name)
                for method_name in patched_method_names
            },
            original_instance_values,
        )


if __name__ == "__main__":
    unittest.main()
