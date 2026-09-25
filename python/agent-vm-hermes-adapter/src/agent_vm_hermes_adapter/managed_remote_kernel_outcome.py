"""Prevent stock Hermes from replaying a possibly completed managed cell."""

import typing as t

from tools import code_kernel_remote

_UNCERTAIN_OUTCOME_MESSAGE = (
    "Remote kernel execution outcome is uncertain; code may have completed. "
    "Automatic fallback was suppressed. Verify effects before retrying."
)


class _RemoteKernelExecution(t.Protocol):
    def __call__(
        self,
        code: str,
        *,
        env: object,
        env_type: str,
        task_env_id: str,
        sandbox_tools: frozenset[str],
        timeout: int,
        max_tool_calls: int,
        reset: bool,
        idle_exit: int = 1800,
    ) -> dict[str, object] | None: ...


class ManagedRemoteKernelOutcomeGuard:
    """Fail closed when a remote-kernel exception leaves cell effects uncertain."""

    def __init__(self) -> None:
        self._original_execution: _RemoteKernelExecution = (
            code_kernel_remote.execute_in_remote_kernel
        )
        self._installed_execution: _RemoteKernelExecution | None = None

    def install(self) -> None:
        if self._installed_execution is not None:
            raise RuntimeError("Managed remote-kernel outcome guard is already installed")
        if code_kernel_remote.execute_in_remote_kernel is not self._original_execution:
            raise RuntimeError("Pinned Hermes remote-kernel target changed before guard install")

        def execute_without_uncertain_replay(
            code: str,
            *,
            env: object,
            env_type: str,
            task_env_id: str,
            sandbox_tools: frozenset[str],
            timeout: int,
            max_tool_calls: int,
            reset: bool,
            idle_exit: int = 1800,
        ) -> dict[str, object] | None:
            try:
                return self._original_execution(
                    code,
                    env=env,
                    env_type=env_type,
                    task_env_id=task_env_id,
                    sandbox_tools=sandbox_tools,
                    timeout=timeout,
                    max_tool_calls=max_tool_calls,
                    reset=reset,
                    idle_exit=idle_exit,
                )
            except Exception:
                return {
                    "status": "error",
                    "error": _UNCERTAIN_OUTCOME_MESSAGE,
                    "stdout": _UNCERTAIN_OUTCOME_MESSAGE,
                    "kernel": {"remote": True},
                }

        setattr(code_kernel_remote, "execute_in_remote_kernel", execute_without_uncertain_replay)
        self._installed_execution = execute_without_uncertain_replay

    def close(self) -> None:
        if self._installed_execution is None:
            return
        setattr(code_kernel_remote, "execute_in_remote_kernel", self._original_execution)
        self._installed_execution = None
