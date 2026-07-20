"""Managed-mode hooks for the pinned Hermes process-registry singleton."""

import typing as t

from tools.process_registry import ProcessRegistry, ProcessSession

from .managed_gateway_runtime_processes import (
    HermesManagedProcessRegistryPort,
    HermesManagedProcessRuntime,
)
from .managed_profile_adapter import CanonicalManagedAgentProjection

_PATCHED_PROCESS_REGISTRY_METHODS = (
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
_MISSING_PROCESS_REGISTRY_METHOD = object()


@t.final
class StockHermesManagedProcessRegistryPort(HermesManagedProcessRegistryPort):
    """Keep Hermes notification/session metadata around opaque managed handles."""

    def __init__(self, process_registry: ProcessRegistry) -> None:
        self._process_registry = process_registry

    @t.override
    def register(self, session: ProcessSession) -> None:
        with self._process_registry._lock:
            self._process_registry._prune_if_needed()
            self._process_registry._running[session.id] = session

    @t.override
    def append_output(self, session: ProcessSession, output: str) -> None:
        with session._lock:
            session.output_buffer += output
            if len(session.output_buffer) > session.max_output_chars:
                session.output_buffer = session.output_buffer[-session.max_output_chars :]
        self._process_registry._check_watch_patterns(session, output)
        self._process_registry._emit_output(session, output)

    @t.override
    def finish(self, session: ProcessSession) -> None:
        self._process_registry._move_to_finished(session)


@t.final
class _OriginalProcessRegistryMethods:
    def __init__(self, process_registry: ProcessRegistry) -> None:
        self._instance_values = {
            method_name: process_registry.__dict__.get(
                method_name,
                _MISSING_PROCESS_REGISTRY_METHOD,
            )
            for method_name in _PATCHED_PROCESS_REGISTRY_METHODS
        }

    def restore(self, process_registry: ProcessRegistry, method_name: str) -> None:
        original_value = self._instance_values[method_name]
        if original_value is _MISSING_PROCESS_REGISTRY_METHOD:
            _ = process_registry.__dict__.pop(method_name, None)
        else:
            setattr(process_registry, method_name, original_value)


@t.final
class HermesManagedProcessHooks:
    """Install and restore the pinned stock-Hermes process-registry seam."""

    def __init__(
        self,
        *,
        current_projection: t.Callable[[], CanonicalManagedAgentProjection],
        process_registry: ProcessRegistry,
    ) -> None:
        self._process_registry = process_registry
        self._original = _OriginalProcessRegistryMethods(process_registry)
        self._runtime = HermesManagedProcessRuntime(
            current_projection=current_projection,
            process_registry=StockHermesManagedProcessRegistryPort(process_registry),
        )
        self._installed = False

    def install(self) -> None:
        if self._installed:
            raise RuntimeError("Hermes managed process hooks are already installed.")
        replacements = {
            "spawn_via_env": self._runtime.spawn_via_env,
            "poll": self._runtime.poll,
            "read_log": self._runtime.read_log,
            "wait": self._runtime.wait,
            "kill_process": self._runtime.kill_process,
            "write_stdin": self._runtime.write_stdin,
            "submit_stdin": self._runtime.submit_stdin,
            "close_stdin": self._runtime.close_stdin,
            "list_sessions": self._runtime.list_sessions,
            "kill_all": self._runtime.kill_all,
        }
        patched_method_names: list[str] = []
        try:
            for method_name, replacement in replacements.items():
                setattr(self._process_registry, method_name, replacement)
                patched_method_names.append(method_name)
        except BaseException:
            for method_name in reversed(patched_method_names):
                self._original.restore(self._process_registry, method_name)
            raise
        self._installed = True

    def close(self) -> None:
        if not self._installed:
            return
        try:
            self._runtime.close()
        finally:
            for method_name in _PATCHED_PROCESS_REGISTRY_METHODS:
                self._original.restore(self._process_registry, method_name)
            self._installed = False
