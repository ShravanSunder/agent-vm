import json
import unittest
from unittest.mock import patch

from tools import code_execution_tool, code_kernel_remote

from agent_vm_hermes_adapter.managed_remote_kernel_outcome import (
    ManagedRemoteKernelOutcomeGuard,
)


class _FakeRemoteEnvironment:
    def execute(self, command: str, *, cwd: str | None = None, timeout: int = 0) -> dict[str, str]:
        del command, cwd, timeout
        return {"output": "OK"}


class _FakeCompletedRemoteKernel:
    def __init__(self, environment: _FakeRemoteEnvironment) -> None:
        self.env = environment
        self.kernel_dir = "/tmp/managed-kernel-test"
        self.rpc_token = "test-token"
        self.attached = 0
        self.last_used = 0.0
        self.execution_count = 0
        self.cell_seq = 0
        self.dispatched_cells = 0

    def sh(self, command: str, *, timeout: int = 0) -> str:
        del timeout
        if command.startswith("mv ") and "cell_req_" in command:
            self.dispatched_cells += 1
            return ""
        if command.startswith("cat ") and "cell_res_" in command:
            return json.dumps({"status": "ok", "stdout": "completed", "execution_count": 1})
        if command.startswith("rm -f ") and "cell_res_" in command:
            raise OSError("private result cleanup detail")
        return ""


class ManagedRemoteKernelOutcomeTests(unittest.TestCase):
    def test_actual_pinned_kernel_path_does_not_replay_after_completed_result_cleanup(self) -> None:
        environment = _FakeRemoteEnvironment()
        kernel = _FakeCompletedRemoteKernel(environment)
        fallback_calls: list[str] = []

        def replay_fallback(*args: object, **kwargs: object) -> str:
            del args, kwargs
            fallback_calls.append("per-call")
            return json.dumps({"status": "success"})

        with (
            patch.object(code_execution_tool, "_load_config", return_value={"timeout": 10}),
            patch.object(
                code_execution_tool,
                "_get_or_create_env",
                return_value=(environment, "ssh"),
            ),
            patch.object(code_execution_tool, "_ship_file_to_remote"),
            patch.object(code_execution_tool, "_rpc_poll_loop"),
            patch.object(code_execution_tool, "_run_remote_per_call", replay_fallback),
            patch.object(
                code_kernel_remote,
                "_acquire_remote_kernel",
                return_value=(kernel, False, False, False),
            ),
            patch.object(code_kernel_remote, "_evict_over_cap_unlocked", return_value=[]),
        ):
            guard = ManagedRemoteKernelOutcomeGuard()
            try:
                guard.install()
                result = json.loads(code_execution_tool._execute_remote("effect()", "task-a", None))
            finally:
                guard.close()

        self.assertEqual(kernel.dispatched_cells, 1)
        self.assertEqual(fallback_calls, [])
        self.assertEqual(result["status"], "error")
        self.assertIn("uncertain", result["error"])
        self.assertNotIn("private", json.dumps(result))

    def test_completed_cell_is_not_replayed_after_uncertain_kernel_failure(self) -> None:
        dispatched_effects: list[str] = []
        fallback_calls: list[str] = []

        def fail_after_cell_dispatch(*args: object, **kwargs: object) -> None:
            del args, kwargs
            dispatched_effects.append("kernel")
            raise OSError("private transport detail")

        def replay_fallback(*args: object, **kwargs: object) -> str:
            del args, kwargs
            fallback_calls.append("per-call")
            return json.dumps({"status": "success"})

        with (
            patch.object(code_execution_tool, "_load_config", return_value={"timeout": 10}),
            patch.object(
                code_execution_tool,
                "_get_or_create_env",
                return_value=(_FakeRemoteEnvironment(), "ssh"),
            ),
            patch.object(code_kernel_remote, "execute_in_remote_kernel", fail_after_cell_dispatch),
            patch.object(code_execution_tool, "_run_remote_per_call", replay_fallback),
        ):
            guard = ManagedRemoteKernelOutcomeGuard()
            try:
                guard.install()
                result = json.loads(code_execution_tool._execute_remote("effect()", "task-a", None))
            finally:
                guard.close()

        self.assertEqual(dispatched_effects, ["kernel"])
        self.assertEqual(fallback_calls, [])
        self.assertEqual(result["status"], "error")
        self.assertIn("uncertain", result["error"])
        self.assertNotIn("private", json.dumps(result))

    def test_proven_kernel_startup_failure_retains_stock_per_call_fallback(self) -> None:
        fallback_calls: list[str] = []

        def fallback(*args: object, **kwargs: object) -> str:
            del args, kwargs
            fallback_calls.append("per-call")
            return json.dumps({"status": "success"})

        with (
            patch.object(code_execution_tool, "_load_config", return_value={"timeout": 10}),
            patch.object(
                code_execution_tool,
                "_get_or_create_env",
                return_value=(_FakeRemoteEnvironment(), "ssh"),
            ),
            patch.object(code_kernel_remote, "execute_in_remote_kernel", return_value=None),
            patch.object(code_execution_tool, "_run_remote_per_call", fallback),
        ):
            guard = ManagedRemoteKernelOutcomeGuard()
            try:
                guard.install()
                result = json.loads(code_execution_tool._execute_remote("effect()", "task-a", None))
            finally:
                guard.close()

        self.assertEqual(fallback_calls, ["per-call"])
        self.assertEqual(result["status"], "success")
