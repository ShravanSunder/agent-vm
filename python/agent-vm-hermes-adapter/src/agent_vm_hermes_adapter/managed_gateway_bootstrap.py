"""Fixed managed boot entry for stock Hermes Gateway 0.18.2."""

import hashlib
import json
import os
import shutil
import sqlite3
import stat
import tempfile
import threading
import types
import typing as t
from collections.abc import Callable, Mapping
from pathlib import Path

import hermes_constants
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from hermes_cli import gateway as hermes_gateway
from hermes_cli import managed_scope as hermes_managed_scope
from tools import file_tools as hermes_file_tools
from tools import terminal_tool as hermes_terminal_tool
from tools.process_registry import process_registry as hermes_process_registry

from .managed_gateway_runtime_environment import (
    HermesGatewayRuntimeEnvironment,
    HermesGatewayRuntimeEnvironmentFactory,
)
from .managed_gateway_runtime_process_hooks import HermesManagedProcessHooks
from .managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesManagedAdapterConfig,
    HermesProfileAdmissionError,
    _projection_profile_name,
    _projection_string_field,
)
from .managed_tool_portal_capability_tools import (
    clear_managed_tool_portal_plugin_configuration,
    configure_managed_tool_portal_plugin,
)

DEFAULT_MANAGED_FRAMEWORK_CONFIGURATION_PATH = Path(
    "/run/agent-vm/managed-gateway/framework-service.json"
)
DEFAULT_PROTECTED_HERMES_HOME = Path("/home/hermes/.hermes")
DEFAULT_DURABLE_HERMES_HOME = Path("/run/agent-vm/hermes-durable-home")
_MANAGED_CONFIGURATION_PATH_ENVIRONMENT_NAME = "AGENT_VM_HERMES_MANAGED_CONFIG_PATH"
_MANAGED_HERMES_HOME_ENVIRONMENT_NAME = "HERMES_HOME"
_MANAGED_DURABLE_HERMES_HOME_ENVIRONMENT_NAME = "AGENT_VM_HERMES_DURABLE_HOME"
_MANAGED_TOOL_PORTAL_PLUGIN_NAME = "agent-vm-tool-portal"
_MANAGED_CACHE_KEY_PREFIX = "agent-vm-hermes:"
_MANAGED_TOOL_VM_CWD = "/work"
_MANAGED_UPSTREAM_ROUTING_ENVIRONMENT: Mapping[str, str] = {
    "TERMINAL_ENV": "ssh",
    "TERMINAL_SSH_HOST": "managed-tool-vm.invalid",
    "TERMINAL_SSH_USER": "agent-vm-managed",
}


class _HermesTerminalToolModule(t.Protocol):
    @property
    def _active_environments(self) -> dict[str, object]: ...

    @property
    def _create_environment(self) -> Callable[..., object]: ...

    @property
    def _resolve_container_task_id(self) -> Callable[[str | None], str]: ...

    def replace_create_environment(self, value: Callable[..., object]) -> None: ...

    def replace_resolve_container_task_id(
        self,
        value: Callable[[str | None], str],
    ) -> None: ...

    def configured_environment_timeout(self) -> int: ...

    def evict_environment_cache(
        self,
        cache_identity: str,
        expected_environment: object,
    ) -> None: ...


class _StockHermesTerminalToolAdapter:
    @property
    def _active_environments(self) -> dict[str, object]:
        return hermes_terminal_tool._active_environments

    @property
    def _create_environment(self) -> Callable[..., object]:
        return hermes_terminal_tool._create_environment

    @property
    def _resolve_container_task_id(self) -> Callable[[str | None], str]:
        return hermes_terminal_tool._resolve_container_task_id

    def replace_create_environment(self, value: Callable[..., object]) -> None:
        setattr(hermes_terminal_tool, "_create_environment", value)

    def replace_resolve_container_task_id(
        self,
        value: Callable[[str | None], str],
    ) -> None:
        setattr(hermes_terminal_tool, "_resolve_container_task_id", value)

    def configured_environment_timeout(self) -> int:
        timeout = hermes_terminal_tool._get_env_config()["timeout"]
        if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0:
            message = "Stock Hermes environment timeout must be a positive integer"
            raise TypeError(message)
        return timeout

    def evict_environment_cache(
        self,
        cache_identity: str,
        expected_environment: object,
    ) -> None:
        with hermes_terminal_tool._env_lock:
            cached_environment = hermes_terminal_tool._active_environments.get(cache_identity)
            if cached_environment is not None and cached_environment is not expected_environment:
                message = "Hermes managed environment cache identity changed during replacement"
                raise RuntimeError(message)
            hermes_terminal_tool._active_environments.pop(cache_identity, None)
            hermes_terminal_tool._last_activity.pop(cache_identity, None)
            with hermes_file_tools._file_ops_lock:
                hermes_file_tools._file_ops_cache.pop(cache_identity, None)


class _ManagedAdapterMaterial(t.NamedTuple):
    attachment: Mapping[str, object]
    agent_projections: Mapping[str, object]


class _ManagedEnvironmentCacheEntry(t.NamedTuple):
    cache_identity: str
    environment: HermesGatewayRuntimeEnvironment


def _require_mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        message = f"{label} must be an object"
        raise TypeError(message)
    return t.cast("Mapping[str, object]", value)


def _require_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        message = f"{label} must be a non-empty string"
        raise TypeError(message)
    return value


def load_managed_adapter_material(configuration_path: Path) -> _ManagedAdapterMaterial:
    raw_configuration = json.loads(configuration_path.read_text(encoding="utf-8"))
    configuration = _require_mapping(raw_configuration, "managed Hermes adapter material")
    if set(configuration) != {"agentProjections", "attachment"}:
        message = "managed Hermes adapter material requires exactly attachment and agentProjections"
        raise ValueError(message)
    attachment = _require_mapping(configuration["attachment"], "attachment")
    if attachment.get("clientKind") != "hermes-managed-plugin":
        message = "managed Hermes attachment clientKind must be hermes-managed-plugin"
        raise ValueError(message)
    agent_projections = _require_mapping(
        configuration["agentProjections"],
        "agentProjections",
    )
    configured_agent_ids_value = attachment.get("configuredAgentIds")
    if not isinstance(configured_agent_ids_value, list) or not all(
        isinstance(agent_id, str) for agent_id in configured_agent_ids_value
    ):
        message = "managed Hermes attachment configuredAgentIds must be a string array"
        raise TypeError(message)
    configured_agent_ids = t.cast("list[str]", configured_agent_ids_value)
    if (
        not configured_agent_ids
        or len(configured_agent_ids) != len(set(configured_agent_ids))
        or sorted(configured_agent_ids) != sorted(agent_projections)
    ):
        message = "managed Hermes attachment and projection agent cohorts must match exactly"
        raise ValueError(message)
    return _ManagedAdapterMaterial(
        attachment=dict(attachment),
        agent_projections=types.MappingProxyType(dict(agent_projections)),
    )


def _validate_managed_profile_cohort(
    *,
    protected_hermes_home: Path,
    agent_projections: t.Iterable[CanonicalManagedAgentProjection],
) -> None:
    expected_profile_names = {
        _projection_profile_name(projection) for projection in agent_projections
    }
    profiles_root = protected_hermes_home / "profiles"
    for directory_path, label in (
        (protected_hermes_home, "protected Hermes home"),
        (profiles_root, "managed Hermes profile root"),
    ):
        try:
            directory_mode = directory_path.lstat().st_mode
        except FileNotFoundError as error:
            message = f"{label} must exist as a real directory"
            raise HermesProfileAdmissionError(message) from error
        if stat.S_ISLNK(directory_mode) or not stat.S_ISDIR(directory_mode):
            message = f"{label} must exist as a real directory"
            raise HermesProfileAdmissionError(message)

    with os.scandir(profiles_root) as profiles_directory:
        profile_entries = tuple(profiles_directory)
    actual_profile_names = {entry.name for entry in profile_entries}
    if actual_profile_names != expected_profile_names:
        missing_profile_names = sorted(expected_profile_names - actual_profile_names)
        unexpected_profile_names = sorted(actual_profile_names - expected_profile_names)
        message = (
            "Managed Hermes profile cohort does not match immutable adapter projections: "
            f"missing={missing_profile_names!r}, unexpected={unexpected_profile_names!r}"
        )
        raise HermesProfileAdmissionError(message)

    for profile_entry in profile_entries:
        if profile_entry.is_symlink() or not profile_entry.is_dir(follow_symlinks=False):
            message = f"Managed Hermes profile {profile_entry.name!r} must be a real directory"
            raise HermesProfileAdmissionError(message)


def _validate_managed_plugin_policy(configuration: Mapping[str, object]) -> None:
    plugins = _require_mapping(configuration.get("plugins"), "managed Hermes plugins policy")
    enabled_value = plugins.get("enabled")
    disabled_value = plugins.get("disabled")
    if not isinstance(enabled_value, list) or not all(
        isinstance(plugin_name, str) for plugin_name in enabled_value
    ):
        message = "managed Hermes plugins.enabled must be a string array"
        raise TypeError(message)
    if not isinstance(disabled_value, list) or not all(
        isinstance(plugin_name, str) for plugin_name in disabled_value
    ):
        message = "managed Hermes plugins.disabled must be a string array"
        raise TypeError(message)
    if _MANAGED_TOOL_PORTAL_PLUGIN_NAME not in enabled_value:
        message = (
            f"managed Hermes plugins.enabled must include {_MANAGED_TOOL_PORTAL_PLUGIN_NAME!r}"
        )
        raise HermesProfileAdmissionError(message)
    if _MANAGED_TOOL_PORTAL_PLUGIN_NAME in disabled_value:
        message = (
            f"managed Hermes plugins.disabled must not include {_MANAGED_TOOL_PORTAL_PLUGIN_NAME!r}"
        )
        raise HermesProfileAdmissionError(message)


class HermesManagedEnvironmentHooks:
    """Install the two stock-Hermes seams required by managed mode."""

    def __init__(
        self,
        *,
        adapter: HermesManagedAdapter,
        attachment: Mapping[str, object],
        protected_hermes_home: Path,
        terminal_tool_module: _HermesTerminalToolModule,
    ) -> None:
        self._adapter = adapter
        self._attachment = attachment
        self._protected_hermes_home = protected_hermes_home
        self._terminal_tool_module = terminal_tool_module
        self._environment_factory = HermesGatewayRuntimeEnvironmentFactory(adapter=adapter)
        self._original_create_environment = terminal_tool_module._create_environment
        self._original_resolve_container_task_id = terminal_tool_module._resolve_container_task_id
        self._original_upstream_routing_environment: dict[str, str | None] | None = None
        self._resolution_lock = threading.Lock()
        self._current_environments: dict[str, _ManagedEnvironmentCacheEntry] = {}
        self._pending_environments: dict[str, HermesGatewayRuntimeEnvironment] = {}
        self._installed = False

    def _current_projection(self) -> CanonicalManagedAgentProjection:
        current_hermes_home = hermes_constants.get_hermes_home()
        for projection in self._adapter.profiles:
            profile_name = _projection_profile_name(projection)
            expected_profile_home = self._protected_hermes_home / "profiles" / profile_name
            if current_hermes_home == expected_profile_home:
                return projection
        raise HermesProfileAdmissionError(
            "Managed Hermes tool execution requires an explicit admitted profile runtime scope."
        )

    def _cache_key_for_projection(
        self,
        projection: CanonicalManagedAgentProjection,
        *,
        owning_generation: str | None = None,
    ) -> str:
        identity = {
            "agentId": _projection_string_field(projection, "agentId"),
            "attachmentGeneration": self._attachment.get("attachmentGeneration"),
            "frameworkEpoch": self._attachment.get("frameworkEpoch"),
            "gatewayEpoch": self._attachment.get("gatewayEpoch"),
            "profileAssignmentRevision": _projection_string_field(
                projection,
                "profileAssignmentRevision",
            ),
            "profileName": _projection_profile_name(projection),
            "runtimeEpoch": self._attachment.get("runtimeEpoch"),
            **({"owningGeneration": owning_generation} if owning_generation is not None else {}),
        }
        serialized_identity = json.dumps(identity, separators=(",", ":"), sort_keys=True)
        identity_digest = hashlib.sha256(serialized_identity.encode()).hexdigest()
        if owning_generation is None:
            return f"{_MANAGED_CACHE_KEY_PREFIX}pending:{identity_digest}"
        return f"{_MANAGED_CACHE_KEY_PREFIX}{owning_generation}:{identity_digest}"

    def resolve_container_task_id(self, task_id: str | None) -> str:
        del task_id
        projection = self._current_projection()
        profile_name = _projection_profile_name(projection)
        with self._resolution_lock:
            current_entry = self._current_environments.get(profile_name)
            if current_entry is not None:
                status_kind = current_entry.environment.resolve_status_kind()
                if status_kind == "active":
                    return current_entry.cache_identity
                self._terminal_tool_module.evict_environment_cache(
                    current_entry.cache_identity,
                    current_entry.environment,
                )
                current_entry.environment.retire_locally()
                _ = self._current_environments.pop(profile_name, None)

            pending_identity = self._cache_key_for_projection(projection)
            environment = self._environment_factory.create(
                profile_name=profile_name,
                task_id=pending_identity,
                cwd=_MANAGED_TOOL_VM_CWD,
                timeout=self._terminal_tool_module.configured_environment_timeout(),
            )
            cache_identity = self._cache_key_for_projection(
                projection,
                owning_generation=environment.owning_generation,
            )
            environment.bind_cache_identity(cache_identity)
            entry = _ManagedEnvironmentCacheEntry(
                cache_identity=cache_identity,
                environment=environment,
            )
            self._current_environments[profile_name] = entry
            self._pending_environments[cache_identity] = environment
            return cache_identity

    def create_environment(
        self,
        env_type: str,
        image: str,
        cwd: str,
        timeout: int,
        ssh_config: dict[str, object] | None = None,
        container_config: dict[str, object] | None = None,
        local_config: dict[str, object] | None = None,
        task_id: str = "default",
        host_cwd: str | None = None,
    ) -> object:
        del env_type, image, cwd, timeout, ssh_config, container_config, local_config, host_cwd
        projection = self._current_projection()
        profile_name = _projection_profile_name(projection)
        with self._resolution_lock:
            current_entry = self._current_environments.get(profile_name)
            if current_entry is None or current_entry.cache_identity != task_id:
                message = (
                    "Hermes managed environment cache identity does not match the active profile"
                )
                raise HermesProfileAdmissionError(message)
            pending_environment = self._pending_environments.pop(task_id, None)
            if pending_environment is not None:
                return pending_environment
            return current_entry.environment

    @staticmethod
    def _restore_upstream_routing_environment(
        original_environment: Mapping[str, str | None],
    ) -> None:
        for environment_name, original_value in original_environment.items():
            if original_value is None:
                _ = os.environ.pop(environment_name, None)
            else:
                os.environ[environment_name] = original_value

    def install(self) -> None:
        if self._installed:
            message = "Hermes managed environment hooks are already installed"
            raise RuntimeError(message)
        if self._terminal_tool_module._active_environments:
            message = "Hermes managed environment hooks must install before environment use"
            raise RuntimeError(message)
        original_environment = {
            environment_name: os.environ.get(environment_name)
            for environment_name in _MANAGED_UPSTREAM_ROUTING_ENVIRONMENT
        }
        try:
            os.environ.update(_MANAGED_UPSTREAM_ROUTING_ENVIRONMENT)
            self._terminal_tool_module.replace_resolve_container_task_id(
                self.resolve_container_task_id
            )
            self._terminal_tool_module.replace_create_environment(self.create_environment)
        except BaseException:
            self._terminal_tool_module.replace_create_environment(self._original_create_environment)
            self._terminal_tool_module.replace_resolve_container_task_id(
                self._original_resolve_container_task_id
            )
            self._restore_upstream_routing_environment(original_environment)
            raise
        self._original_upstream_routing_environment = original_environment
        self._installed = True

    def close(self) -> None:
        if not self._installed:
            return
        cleanup_error: BaseException | None = None
        try:
            self._environment_factory.close()
        except BaseException as error:
            cleanup_error = error
        finally:
            self._terminal_tool_module.replace_create_environment(self._original_create_environment)
            self._terminal_tool_module.replace_resolve_container_task_id(
                self._original_resolve_container_task_id
            )
            original_environment = self._original_upstream_routing_environment
            if original_environment is not None:
                self._restore_upstream_routing_environment(original_environment)
                self._original_upstream_routing_environment = None
            self._installed = False
        if cleanup_error is not None:
            raise cleanup_error


def _copy_file_atomically(source_path: Path, destination_path: Path) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_descriptor, temporary_name = tempfile.mkstemp(
        dir=destination_path.parent,
        prefix=f".{destination_path.name}.agent-vm-",
    )
    os.close(temporary_descriptor)
    temporary_path = Path(temporary_name)
    try:
        shutil.copy2(source_path, temporary_path)
        os.replace(temporary_path, destination_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _restore_durable_hermes_home(
    *,
    durable_hermes_home: Path,
    protected_hermes_home: Path,
) -> None:
    protected_hermes_home.mkdir(parents=True, exist_ok=True)
    if not durable_hermes_home.exists():
        return
    for durable_path in sorted(durable_hermes_home.rglob("*")):
        relative_path = durable_path.relative_to(durable_hermes_home)
        protected_path = protected_hermes_home / relative_path
        if durable_path.is_symlink():
            continue
        if durable_path.is_dir():
            protected_path.mkdir(parents=True, exist_ok=True)
            continue
        if durable_path.name.endswith("-shm"):
            continue
        _copy_file_atomically(durable_path, protected_path)


def _create_local_sqlite_snapshot(*, database_path: Path, snapshot_path: Path) -> None:
    source_connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
    try:
        destination_connection = sqlite3.connect(snapshot_path)
        try:
            source_connection.backup(destination_connection)
        finally:
            destination_connection.close()
    finally:
        source_connection.close()


def _persist_durable_hermes_home(
    *,
    durable_hermes_home: Path,
    protected_hermes_home: Path,
) -> None:
    durable_hermes_home.mkdir(parents=True, exist_ok=True)
    sqlite_database_paths = {
        database_path
        for database_path in protected_hermes_home.rglob("*.db")
        if database_path.is_file() and not database_path.is_symlink()
    }
    for protected_path in sorted(protected_hermes_home.rglob("*")):
        if protected_path.is_symlink() or not protected_path.is_file():
            continue
        if protected_path.name.endswith(("-shm", "-wal", "-journal")):
            continue
        relative_path = protected_path.relative_to(protected_hermes_home)
        durable_path = durable_hermes_home / relative_path
        if protected_path in sqlite_database_paths:
            with tempfile.TemporaryDirectory(dir=protected_path.parent) as temporary_directory:
                snapshot_path = Path(temporary_directory) / protected_path.name
                _create_local_sqlite_snapshot(
                    database_path=protected_path,
                    snapshot_path=snapshot_path,
                )
                _copy_file_atomically(snapshot_path, durable_path)
            for sidecar_suffix in ("-journal", "-shm", "-wal"):
                Path(f"{durable_path}{sidecar_suffix}").unlink(missing_ok=True)
            continue
        _copy_file_atomically(protected_path, durable_path)


def _run_managed_hermes_gateway_runtime(
    *,
    configuration_path: Path = DEFAULT_MANAGED_FRAMEWORK_CONFIGURATION_PATH,
    protected_hermes_home: Path = DEFAULT_PROTECTED_HERMES_HOME,
    managed_configuration_loader: Callable[[], Mapping[str, object]] = (
        hermes_managed_scope.load_managed_config
    ),
    stock_gateway_runner: Callable[[], None] | None = None,
    terminal_tool_module: _HermesTerminalToolModule | None = None,
) -> None:
    material = load_managed_adapter_material(configuration_path)
    _validate_managed_plugin_policy(managed_configuration_loader())
    projection_cohort_digest = _require_string(
        material.attachment.get("projectionCohortDigest"),
        "attachment.projectionCohortDigest",
    )
    adapter_config = HermesManagedAdapterConfig(
        profiles=material.agent_projections.values(),
        projection_cohort_digest=projection_cohort_digest,
        protected_hermes_home=str(protected_hermes_home),
    )
    _validate_managed_profile_cohort(
        protected_hermes_home=protected_hermes_home,
        agent_projections=adapter_config.profiles,
    )
    gateway_runtime_client = GatewayRuntimeClient(attachment=material.attachment)
    adapter = HermesManagedAdapter(
        config=adapter_config,
        gateway_runtime_client=gateway_runtime_client,
    )
    hooks = HermesManagedEnvironmentHooks(
        adapter=adapter,
        attachment=material.attachment,
        protected_hermes_home=protected_hermes_home,
        terminal_tool_module=(
            _StockHermesTerminalToolAdapter()
            if terminal_tool_module is None
            else terminal_tool_module
        ),
    )
    process_hooks = HermesManagedProcessHooks(
        current_projection=hooks._current_projection,
        process_registry=hermes_process_registry,
    )
    adapter.connect_gateway_runtime()
    try:
        configure_managed_tool_portal_plugin(
            adapter=adapter,
            current_projection=hooks._current_projection,
        )
        hooks.install()
        try:
            process_hooks.install()
        except BaseException:
            hooks.close()
            raise
        (hermes_gateway.run_gateway if stock_gateway_runner is None else stock_gateway_runner)()
    finally:
        try:
            clear_managed_tool_portal_plugin_configuration()
        finally:
            try:
                process_hooks.close()
            finally:
                try:
                    hooks.close()
                finally:
                    adapter.close()


def run_managed_hermes_gateway(
    *,
    configuration_path: Path = DEFAULT_MANAGED_FRAMEWORK_CONFIGURATION_PATH,
    protected_hermes_home: Path = DEFAULT_PROTECTED_HERMES_HOME,
    durable_hermes_home: Path | None = None,
    managed_configuration_loader: Callable[[], Mapping[str, object]] = (
        hermes_managed_scope.load_managed_config
    ),
    stock_gateway_runner: Callable[[], None] | None = None,
    terminal_tool_module: _HermesTerminalToolModule | None = None,
) -> None:
    if durable_hermes_home is not None:
        _restore_durable_hermes_home(
            durable_hermes_home=durable_hermes_home,
            protected_hermes_home=protected_hermes_home,
        )
    try:
        _run_managed_hermes_gateway_runtime(
            configuration_path=configuration_path,
            protected_hermes_home=protected_hermes_home,
            managed_configuration_loader=managed_configuration_loader,
            stock_gateway_runner=stock_gateway_runner,
            terminal_tool_module=terminal_tool_module,
        )
    finally:
        if durable_hermes_home is not None:
            _persist_durable_hermes_home(
                durable_hermes_home=durable_hermes_home,
                protected_hermes_home=protected_hermes_home,
            )


def main() -> None:
    configuration_path = Path(
        os.environ.get(
            _MANAGED_CONFIGURATION_PATH_ENVIRONMENT_NAME,
            str(DEFAULT_MANAGED_FRAMEWORK_CONFIGURATION_PATH),
        )
    )
    protected_hermes_home = Path(
        os.environ.get(
            _MANAGED_HERMES_HOME_ENVIRONMENT_NAME,
            str(DEFAULT_PROTECTED_HERMES_HOME),
        )
    )
    durable_hermes_home = Path(
        os.environ.get(
            _MANAGED_DURABLE_HERMES_HOME_ENVIRONMENT_NAME,
            str(DEFAULT_DURABLE_HERMES_HOME),
        )
    )
    run_managed_hermes_gateway(
        configuration_path=configuration_path,
        durable_hermes_home=durable_hermes_home,
        protected_hermes_home=protected_hermes_home,
    )


if __name__ == "__main__":
    main()
