import asyncio
import io
import threading
import typing as t
import unittest
from collections.abc import Awaitable, Mapping

from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import BaseModel, ConfigDict

from agent_vm_hermes_adapter import (
    HermesGatewayRuntimeEnvironment,
    HermesGatewayRuntimeEnvironmentFactory,
    HermesGatewayRuntimeOutcomeError,
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
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> Awaitable[PortableResult]: ...


class FakeOperationGroup:
    def __init__(self, results: Mapping[str, Mapping[str, object]]) -> None:
        self.calls: list[tuple[str, Mapping[str, object], Mapping[str, object]]] = []
        self._results = dict(results)
        self._overrides: dict[str, FakeOperationCallable] = {}

    def set_result(self, operation_name: str, result: Mapping[str, object]) -> None:
        self._results[operation_name] = result

    def set_override(
        self,
        operation_name: str,
        operation: FakeOperationCallable,
    ) -> None:
        self._overrides[operation_name] = operation

    def __getattr__(self, operation_name: str) -> FakeOperationCallable:
        override = self._overrides.get(operation_name)
        if override is not None:
            return override

        async def execute(
            request: Mapping[str, object],
            *,
            trusted_context: Mapping[str, object],
        ) -> PortableResult:
            self.calls.append((operation_name, request, trusted_context))
            return PortableResult.model_validate(self._results[operation_name])

        return execute


class FakeSandbox:
    def __init__(self) -> None:
        generation = "tool-vm-generation-7"
        self.environment = FakeOperationGroup(
            {
                "open": {
                    "kind": "opened",
                    "environment": {
                        "handleId": "environment-1",
                        "kind": "environment",
                        "owningGeneration": generation,
                    },
                },
                "close": {
                    "kind": "closed",
                    "environment": {
                        "handleId": "environment-1",
                        "kind": "environment",
                        "owningGeneration": generation,
                    },
                },
                "status": {
                    "kind": "active",
                    "environment": {
                        "handleId": "environment-1",
                        "kind": "environment",
                        "owningGeneration": generation,
                    },
                },
            }
        )
        operation = {
            "operationId": "operation-1",
            "owningGeneration": generation,
        }
        self.execution = FakeOperationGroup(
            {
                "start": {
                    "kind": "started",
                    "mode": "direct",
                    "operation": operation,
                    "streams": [
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
                    ],
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
                    "kind": "terminal",
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
                    "stream": {
                        "handleId": "stdout-1",
                        "kind": "stream",
                        "owningGeneration": generation,
                        "channel": "stdout",
                    },
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
                    "stream": {
                        "handleId": "stdin-1",
                        "kind": "stream",
                        "owningGeneration": generation,
                        "channel": "stdin",
                    },
                    "sequence": 0,
                    "bytesWritten": 0,
                },
                "close": {
                    "kind": "closed",
                    "stream": {
                        "handleId": "stdin-1",
                        "kind": "stream",
                        "owningGeneration": generation,
                        "channel": "stdin",
                    },
                },
            }
        )


class FakeGatewayRuntimeClient:
    def __init__(self) -> None:
        self.sandbox = FakeSandbox()
        self.connect_calls = 0
        self.disconnect_calls = 0

    async def connect(self) -> None:
        self.connect_calls += 1

    async def disconnect(self) -> None:
        self.disconnect_calls += 1


def build_projection(*, agent_id: str, profile_name: str) -> dict[str, object]:
    return {
        "agentId": agent_id,
        "frameworkIdentity": {"kind": "hermes", "profileName": profile_name},
        "profileAssignmentRevision": f"revision-{agent_id}",
        "toolPortalProfileId": f"policy-{agent_id}",
    }


def build_config() -> HermesManagedAdapterConfig:
    return HermesManagedAdapterConfig(
        profiles=(
            build_projection(agent_id="researcher", profile_name="researcher"),
            build_projection(agent_id="reviewer", profile_name="reviewer"),
        ),
        projection_cohort_digest=PROJECTION_COHORT_DIGEST,
        protected_hermes_home="/var/lib/agent-vm/hermes",
    )


@t.final
class HermesGatewayRuntimeEnvironmentTests(unittest.TestCase):
    _client: FakeGatewayRuntimeClient | None = None
    _adapter: HermesManagedAdapter | None = None
    _factory: HermesGatewayRuntimeEnvironmentFactory | None = None

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
    def factory(self) -> HermesGatewayRuntimeEnvironmentFactory:
        if self._factory is None:
            raise RuntimeError("test Hermes environment factory is not initialized")
        return self._factory

    @t.override
    def setUp(self) -> None:
        self._client = FakeGatewayRuntimeClient()
        self._adapter = HermesManagedAdapter(
            config=build_config(),
            gateway_runtime_client=t.cast(
                "GatewayRuntimeClient",
                t.cast("object", self.client),
            ),
        )
        self.adapter.connect_gateway_runtime()
        self._factory = HermesGatewayRuntimeEnvironmentFactory(adapter=self.adapter)

    @t.override
    def tearDown(self) -> None:
        self.adapter.close()
        self._factory = None
        self._adapter = None
        self._client = None

    def test_creates_profile_fenced_environments_over_one_shared_client(self) -> None:
        researcher = self.factory.create(
            profile_name="researcher",
            task_id="session-researcher",
            cwd="/gateway/process/cwd",
            timeout=60,
        )
        reviewer = self.factory.create(
            profile_name="reviewer",
            task_id="session-reviewer",
            cwd="/work",
            timeout=60,
        )

        self.assertIsInstance(researcher, HermesGatewayRuntimeEnvironment)
        self.assertIsInstance(reviewer, HermesGatewayRuntimeEnvironment)
        self.assertIsNot(researcher, reviewer)
        self.assertEqual(researcher.agent_id, "researcher")
        self.assertEqual(reviewer.agent_id, "reviewer")
        self.assertEqual(researcher.cwd, "/work")
        self.assertEqual(reviewer.cwd, "/work")
        self.assertIs(researcher.gateway_runtime_client, self.client)
        self.assertIs(reviewer.gateway_runtime_client, self.client)
        self.assertEqual(self.client.connect_calls, 1)

    def test_rejects_missing_wrong_and_cross_profile_creation_before_open(self) -> None:
        for profile_name in (None, "", "default", "undeclared"):
            with self.subTest(profile_name=profile_name):
                with self.assertRaisesRegex(Exception, "profile"):
                    self.factory.create(
                        profile_name=profile_name,
                        task_id="session-1",
                        cwd="/work",
                        timeout=60,
                    )

        self.assertEqual(self.client.sandbox.environment.calls, [])

    def test_process_handle_preserves_exact_exit_and_fenced_context(self) -> None:
        environment = self.factory.create(
            profile_name="researcher",
            task_id="session-researcher",
            cwd="/work",
            timeout=60,
        )
        process = environment._run_bash("printf ready", timeout=30)

        self.assertEqual(process.wait(timeout=2), 0)
        self.assertEqual(process.returncode, 0)
        self.assertIsInstance(process.stdout, io.TextIOBase)

        start_calls = [call for call in self.client.sandbox.execution.calls if call[0] == "start"]
        self.assertEqual(len(start_calls), 2)
        bootstrap_command = start_calls[0][1]["command"]
        if not isinstance(bootstrap_command, str):
            self.fail("bootstrap command must be a string")
        self.assertTrue(bootstrap_command.startswith("bash -l -c "))
        start_call = start_calls[-1]
        self.assertEqual(start_call[0], "start")
        self.assertEqual(start_call[1]["command"], "bash -c 'printf ready'")
        self.assertEqual(start_call[1]["cwd"], "/work")
        principal = start_call[2]["principal"]
        if not isinstance(principal, Mapping):
            self.fail("trusted principal must be a mapping")
        principal_mapping = t.cast("Mapping[str, object]", principal)
        self.assertEqual(principal_mapping["agentId"], "researcher")
        self.assertEqual(
            principal_mapping["frameworkIdentity"],
            {"kind": "hermes", "profileName": "researcher"},
        )

        environment.cleanup()
        self.assertEqual(self.client.sandbox.environment.calls[-1][0], "close")

    def test_writes_and_closes_standard_input_before_waiting_for_completion(self) -> None:
        environment = self.factory.create(
            profile_name="researcher",
            task_id="session-researcher",
            cwd="/work",
            timeout=60,
        )
        operation_events: list[str] = []

        async def write_standard_input(
            request: Mapping[str, object],
            *,
            trusted_context: Mapping[str, object],
        ) -> PortableResult:
            del trusted_context
            operation_events.append("write")
            return PortableResult.model_validate(
                {
                    "bytesWritten": 12,
                    "kind": "written",
                    "sequence": 0,
                    "stream": request["stream"],
                }
            )

        async def close_standard_input(
            request: Mapping[str, object],
            *,
            trusted_context: Mapping[str, object],
        ) -> PortableResult:
            del trusted_context
            self.assertEqual(operation_events, ["write"])
            operation_events.append("close")
            return PortableResult.model_validate(
                {
                    "kind": "closed",
                    "stream": request["stream"],
                }
            )

        async def wait_for_completion(
            request: Mapping[str, object],
            *,
            trusted_context: Mapping[str, object],
        ) -> PortableResult:
            del request, trusted_context
            self.assertEqual(operation_events, ["write", "close"])
            operation_events.append("wait")
            return PortableResult.model_validate(self.client.sandbox.execution._results["wait"])

        self.client.sandbox.stream.set_override("write", write_standard_input)
        self.client.sandbox.stream.set_override("close", close_standard_input)
        self.client.sandbox.execution.set_override("wait", wait_for_completion)

        process = environment._run_bash(
            "cat > /workspace/from-stdin.txt",
            timeout=30,
            stdin_data="STDIN_READY\n",
        )

        self.assertEqual(process.wait(timeout=2), 0)
        self.assertEqual(operation_events, ["write", "close", "wait"])
        environment.cleanup()

    def test_replaced_environment_retires_locally_without_remote_close(self) -> None:
        environment = self.factory.create(
            profile_name="researcher",
            task_id="pending-researcher",
            cwd="/work",
            timeout=60,
        )
        environment.bind_cache_identity("agent-vm-hermes:tool-vm-generation-7:identity-digest")

        self.assertEqual(environment.owning_generation, "tool-vm-generation-7")
        self.assertEqual(environment.resolve_status_kind(), "active")
        self.assertEqual(
            self.client.sandbox.environment.calls[-1][2]["correlation"],
            {"sessionId": "agent-vm-hermes:tool-vm-generation-7:identity-digest"},
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
        self.assertEqual(environment.resolve_status_kind(), "replaced")

        environment.retire_locally()
        with self.assertRaisesRegex(RuntimeError, "closed"):
            environment._run_bash("pwd")
        environment.cleanup()

        environment_operation_names = [
            operation_name for operation_name, _, _ in self.client.sandbox.environment.calls
        ]
        self.assertEqual(environment_operation_names, ["open", "status", "status"])

    def test_ambiguous_outcome_is_never_synthesized_as_success(self) -> None:
        environment = self.factory.create(
            profile_name="researcher",
            task_id="session-researcher",
            cwd="/work",
            timeout=60,
        )
        self.client.sandbox.execution.set_result(
            "wait",
            {
                "kind": "terminal",
                "operation": {
                    "operationId": "operation-1",
                    "owningGeneration": "tool-vm-generation-7",
                },
                "outcome": {
                    "kind": "ambiguous",
                    "certainty": "side-effects-and-termination-unknown",
                    "retryClass": "forbidden",
                },
            },
        )

        process = environment._run_bash("touch /workspace/unknown", timeout=30)

        with self.assertRaises(HermesGatewayRuntimeOutcomeError):
            process.wait(timeout=2)
        self.assertEqual(process.returncode, 125)
        environment.cleanup()

    def test_kill_cancels_the_exact_gateway_runtime_operation(self) -> None:
        wait_started = threading.Event()

        async def blocked_wait(
            request: Mapping[str, object],
            *,
            trusted_context: Mapping[str, object],
        ) -> PortableResult:
            self.client.sandbox.execution.calls.append(("wait", request, trusted_context))
            wait_started.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        environment = self.factory.create(
            profile_name="researcher",
            task_id="session-researcher",
            cwd="/work",
            timeout=60,
        )
        self.client.sandbox.execution.set_override("wait", blocked_wait)
        process = environment._run_bash("sleep 300", timeout=300)
        self.assertTrue(wait_started.wait(timeout=2))

        process.kill()

        self.assertEqual(process.wait(timeout=2), 130)
        self.assertEqual(self.client.sandbox.execution.calls[-1][0], "cancel")
        environment.cleanup()

    def test_kill_accepts_non_terminal_cancellation_results_without_outcome(self) -> None:
        cancellation_kinds = (
            "running",
            "cancel-request-accepted",
            "cancellation-pending",
        )
        environments = {
            cancellation_kind: self.factory.create(
                profile_name="researcher",
                task_id=f"session-{cancellation_kind}",
                cwd="/work",
                timeout=60,
            )
            for cancellation_kind in cancellation_kinds
        }

        for cancellation_kind in cancellation_kinds:
            with self.subTest(cancellation_kind=cancellation_kind):
                wait_started = threading.Event()

                async def blocked_wait(
                    request: Mapping[str, object],
                    *,
                    trusted_context: Mapping[str, object],
                ) -> PortableResult:
                    self.client.sandbox.execution.calls.append(("wait", request, trusted_context))
                    wait_started.set()
                    await asyncio.Event().wait()
                    raise AssertionError("unreachable")

                environment = environments[cancellation_kind]
                self.client.sandbox.execution.set_override("wait", blocked_wait)
                self.client.sandbox.execution.set_result(
                    "cancel",
                    {
                        "kind": cancellation_kind,
                        "operation": {
                            "operationId": "operation-1",
                            "owningGeneration": "tool-vm-generation-7",
                        },
                    },
                )
                process = environment._run_bash("sleep 300", timeout=300)
                self.assertTrue(wait_started.wait(timeout=2))

                process.kill()

                with self.assertRaises(HermesGatewayRuntimeOutcomeError) as error:
                    process.wait(timeout=2)
                self.assertEqual(error.exception.outcome_kind, cancellation_kind)
                environment.cleanup()

    def test_adapter_close_stops_its_dedicated_client_loop_thread(self) -> None:
        loop_thread_ids_before_close = {
            thread.ident
            for thread in threading.enumerate()
            if thread.name == "agent-vm-hermes-gateway-runtime"
        }
        self.assertEqual(len(loop_thread_ids_before_close), 1)

        self.adapter.close()

        loop_thread_ids_after_close = {
            thread.ident
            for thread in threading.enumerate()
            if thread.name == "agent-vm-hermes-gateway-runtime"
        }
        self.assertEqual(loop_thread_ids_after_close, set())
        self.assertEqual(self.client.disconnect_calls, 1)


if __name__ == "__main__":
    unittest.main()
