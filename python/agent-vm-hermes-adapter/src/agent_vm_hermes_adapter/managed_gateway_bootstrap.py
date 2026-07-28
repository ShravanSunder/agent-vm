"""Fixed managed boot entry for stock Hermes Gateway 0.19.0."""

import copy
import hashlib
import inspect
import json
import os
import re
import stat
import threading
import types
import typing as t
from collections.abc import Callable, Mapping
from pathlib import Path

import hermes_constants
from agent import secret_scope as hermes_secret_scope
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from gateway import run as hermes_gateway_run
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
from .managed_tool_portal_observability import (
    create_hermes_tool_portal_telemetry_from_environment,
)

DEFAULT_MANAGED_FRAMEWORK_CONFIGURATION_PATH = Path(
    "/run/agent-vm/managed-gateway/framework-service.json"
)
DEFAULT_PROTECTED_HERMES_HOME = Path("/home/hermes/.hermes")
_MANAGED_CONFIGURATION_PATH_ENVIRONMENT_NAME = "AGENT_VM_HERMES_MANAGED_CONFIG_PATH"
_MANAGED_HERMES_HOME_ENVIRONMENT_NAME = "HERMES_HOME"
_MANAGED_TOOL_PORTAL_PLUGIN_NAME = "agent-vm-tool-portal"
_MANAGED_CACHE_KEY_PREFIX = "agent-vm-hermes:"
_MANAGED_TOOL_VM_CWD = "/work"
_ENVIRONMENT_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
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
    profile_environment_source_names_by_profile: Mapping[str, Mapping[str, str]]


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
    required_fields = {
        "agentProjections",
        "attachment",
        "profileEnvironmentSourceNamesByProfile",
    }
    if set(configuration) != required_fields:
        message = "managed Hermes adapter material has an unexpected field set"
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
    profile_environment_mapping_field = "profileEnvironmentSourceNamesByProfile"
    raw_profile_environment_mapping = _require_mapping(
        configuration[profile_environment_mapping_field],
        profile_environment_mapping_field,
    )
    expected_profile_names = {
        _projection_profile_name(_require_mapping(projection, f"agentProjections[{agent_id!r}]"))
        for agent_id, projection in agent_projections.items()
    }
    if set(raw_profile_environment_mapping) != expected_profile_names:
        message = (
            "managed Hermes profile environment mapping and profile cohorts must match exactly"
        )
        raise ValueError(message)
    normalized_profile_environment_mapping: dict[str, Mapping[str, str]] = {}
    for profile_name, target_sources_value in raw_profile_environment_mapping.items():
        target_sources = _require_mapping(
            target_sources_value,
            f"profile environment mapping for profile {profile_name!r}",
        )
        if not target_sources:
            message = f"profile environment mapping for profile {profile_name!r} must not be empty"
            raise ValueError(message)
        normalized_target_sources: dict[str, str] = {}
        for target_name_value, source_name_value in target_sources.items():
            target_name = _require_string(
                target_name_value,
                f"profile target environment name for profile {profile_name!r}",
            )
            source_name = _require_string(
                source_name_value,
                f"profile source environment name for profile {profile_name!r}",
            )
            if _ENVIRONMENT_NAME_PATTERN.fullmatch(target_name) is None:
                message = f"profile target environment name for profile {profile_name!r} is unsafe"
                raise ValueError(message)
            if hermes_secret_scope._is_global_env(target_name):
                message = f"profile target environment name for profile {profile_name!r} is global"
                raise ValueError(message)
            if _ENVIRONMENT_NAME_PATTERN.fullmatch(source_name) is None:
                message = f"profile source environment name for profile {profile_name!r} is unsafe"
                raise ValueError(message)
            normalized_target_sources[target_name] = source_name
        normalized_profile_environment_mapping[profile_name] = types.MappingProxyType(
            normalized_target_sources
        )
    return _ManagedAdapterMaterial(
        attachment=dict(attachment),
        agent_projections=types.MappingProxyType(dict(agent_projections)),
        profile_environment_source_names_by_profile=types.MappingProxyType(
            normalized_profile_environment_mapping
        ),
    )


def _materialize_profile_environment_files(
    *,
    protected_hermes_home: Path,
    environment_source_names_by_profile: Mapping[str, Mapping[str, str]],
) -> None:
    values_by_profile: dict[str, dict[str, str]] = {}
    source_names = {
        source_name
        for target_sources in environment_source_names_by_profile.values()
        for source_name in target_sources.values()
    }
    try:
        for profile_name, target_sources in environment_source_names_by_profile.items():
            target_values: dict[str, str] = {}
            for target_name, source_name in target_sources.items():
                source_value = os.environ.get(source_name)
                if not source_value:
                    message = (
                        f"profile source environment for {profile_name!r} must contain a value"
                    )
                    raise ValueError(message)
                if any(character in source_value for character in ("\0", "\r", "\n")):
                    message = (
                        f"profile source environment for {profile_name!r} contains unsafe content"
                    )
                    raise ValueError(message)
                target_values[target_name] = source_value
            values_by_profile[profile_name] = target_values
    finally:
        for source_name in source_names:
            _ = os.environ.pop(source_name, None)

    created_environment_paths: list[Path] = []
    try:
        for profile_name, target_values in values_by_profile.items():
            environment_path = protected_hermes_home / "profiles" / profile_name / ".env"
            file_descriptor = os.open(
                environment_path,
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
            )
            created_environment_paths.append(environment_path)
            try:
                os.fchmod(file_descriptor, 0o600)
                with os.fdopen(file_descriptor, "wb", closefd=False) as environment_file:
                    for target_name in sorted(target_values):
                        environment_file.write(
                            f"{target_name}={target_values[target_name]}\n".encode()
                        )
            finally:
                os.close(file_descriptor)
    except BaseException as materialization_error:
        cleanup_errors: list[BaseException] = []
        for environment_path in reversed(created_environment_paths):
            try:
                environment_path.unlink()
            except FileNotFoundError:
                pass
            except BaseException as cleanup_error:
                cleanup_errors.append(cleanup_error)
        if cleanup_errors:
            message = "Managed Hermes could not remove every failed profile environment shadow"
            raise RuntimeError(message) from cleanup_errors[0]
        raise materialization_error


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


class _HermesManagedPolicyReadBindings:
    """Temporarily directs pinned raw readers through Hermes managed config."""

    _original_provider_routing_descriptor: object
    _provider_routing_wrapper: object | None

    def __init__(self, *, gateway_run_module: object = hermes_gateway_run) -> None:
        self._gateway_run_module = gateway_run_module
        self._gateway_runner = self._require_gateway_runner()
        self._original_get_fallback_chain = self._require_callable("get_fallback_chain")
        self._original_load_gateway_config = self._require_callable("_load_gateway_config")
        original_provider_routing_descriptor = inspect.getattr_static(
            self._gateway_runner,
            "_load_provider_routing",
            None,
        )
        if not isinstance(original_provider_routing_descriptor, staticmethod):
            message = (
                "Pinned Hermes GatewayRunner._load_provider_routing target is absent, changed, "
                "or not a static method"
            )
            raise RuntimeError(message)
        original_provider_routing = original_provider_routing_descriptor.__func__
        if not callable(original_provider_routing):
            message = "Pinned Hermes GatewayRunner._load_provider_routing target is not callable"
            raise RuntimeError(message)
        self._original_provider_routing_descriptor = original_provider_routing_descriptor
        self._original_provider_routing: Callable[[], object] = original_provider_routing
        self._fallback_wrapper: Callable[[object], object] | None = None
        self._provider_routing_wrapper = None

    def _require_gateway_runner(self) -> type[object]:
        gateway_runner = getattr(self._gateway_run_module, "GatewayRunner", None)
        if not isinstance(gateway_runner, type):
            message = "Pinned Hermes GatewayRunner target is absent or changed"
            raise RuntimeError(message)
        return gateway_runner

    def _require_callable(self, name: str) -> Callable[..., object]:
        target = getattr(self._gateway_run_module, name, None)
        if not callable(target):
            message = f"Pinned Hermes {name} target is absent or not callable"
            raise RuntimeError(message)
        return target

    def install(self) -> None:
        if self._fallback_wrapper is not None or self._provider_routing_wrapper is not None:
            message = "Hermes managed policy bindings are already installed"
            raise RuntimeError(message)
        if (
            getattr(self._gateway_run_module, "get_fallback_chain", None)
            is not self._original_get_fallback_chain
        ):
            message = (
                "Pinned Hermes get_fallback_chain target changed before managed binding install"
            )
            raise RuntimeError(message)
        if (
            getattr(self._gateway_run_module, "_load_gateway_config", None)
            is not self._original_load_gateway_config
        ):
            message = (
                "Pinned Hermes _load_gateway_config target changed before managed binding install"
            )
            raise RuntimeError(message)
        if (
            inspect.getattr_static(self._gateway_runner, "_load_provider_routing", None)
            is not self._original_provider_routing_descriptor
        ):
            message = (
                "Pinned Hermes GatewayRunner._load_provider_routing target changed "
                "before managed binding install"
            )
            raise RuntimeError(message)

        def get_managed_fallback_chain(raw_configuration: object) -> object:
            if not isinstance(raw_configuration, dict):
                message = "Pinned Hermes fallback configuration must be a dictionary"
                raise TypeError(message)
            managed_configuration = hermes_managed_scope.apply_managed_overlay(
                copy.deepcopy(raw_configuration)
            )
            return self._original_get_fallback_chain(managed_configuration)

        def load_managed_provider_routing() -> object:
            effective_configuration = self._original_load_gateway_config()
            if not isinstance(effective_configuration, Mapping):
                message = "Pinned Hermes effective gateway configuration must be a mapping"
                raise TypeError(message)
            provider_routing = effective_configuration.get("provider_routing", {})
            if not isinstance(provider_routing, Mapping):
                message = "Pinned Hermes provider_routing must be a mapping"
                raise TypeError(message)
            return dict(provider_routing)

        self._fallback_wrapper = get_managed_fallback_chain
        try:
            setattr(self._gateway_run_module, "get_fallback_chain", self._fallback_wrapper)
            provider_routing_descriptor = staticmethod(load_managed_provider_routing)
            setattr(
                self._gateway_runner,
                "_load_provider_routing",
                provider_routing_descriptor,
            )
            self._provider_routing_wrapper = provider_routing_descriptor
            installed_provider_routing_descriptor = inspect.getattr_static(
                self._gateway_runner,
                "_load_provider_routing",
            )
            if not isinstance(installed_provider_routing_descriptor, staticmethod):
                message = (
                    "Pinned Hermes provider routing binding did not install as a static method"
                )
                raise RuntimeError(message)
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        restoration_errors: list[BaseException] = []
        if self._provider_routing_wrapper is not None:
            try:
                setattr(
                    self._gateway_runner,
                    "_load_provider_routing",
                    self._original_provider_routing_descriptor,
                )
            except BaseException as error:
                restoration_errors.append(error)
            finally:
                self._provider_routing_wrapper = None
        if self._fallback_wrapper is not None:
            try:
                setattr(
                    self._gateway_run_module,
                    "get_fallback_chain",
                    self._original_get_fallback_chain,
                )
            except BaseException as error:
                restoration_errors.append(error)
            finally:
                self._fallback_wrapper = None
        if restoration_errors:
            raise restoration_errors[0]


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
    managed_configuration = managed_configuration_loader()
    _validate_managed_plugin_policy(managed_configuration)
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
    _materialize_profile_environment_files(
        protected_hermes_home=protected_hermes_home,
        environment_source_names_by_profile=(material.profile_environment_source_names_by_profile),
    )
    telemetry = create_hermes_tool_portal_telemetry_from_environment()
    gateway_runtime_client = GatewayRuntimeClient(
        attachment=material.attachment,
        trace_context_provider=telemetry.trace_context_provider,
    )
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
    managed_policy_bindings = _HermesManagedPolicyReadBindings()
    adapter.connect_gateway_runtime()
    try:
        configure_managed_tool_portal_plugin(
            adapter=adapter,
            current_projection=hooks._current_projection,
            telemetry=telemetry,
        )
        hooks.install()
        try:
            process_hooks.install()
        except BaseException:
            hooks.close()
            raise
        managed_policy_bindings.install()
        (hermes_gateway.run_gateway if stock_gateway_runner is None else stock_gateway_runner)()
    finally:
        try:
            clear_managed_tool_portal_plugin_configuration()
        finally:
            try:
                managed_policy_bindings.close()
            finally:
                try:
                    process_hooks.close()
                finally:
                    try:
                        hooks.close()
                    finally:
                        try:
                            adapter.close()
                        finally:
                            telemetry.shutdown()


def run_managed_hermes_gateway(
    *,
    configuration_path: Path = DEFAULT_MANAGED_FRAMEWORK_CONFIGURATION_PATH,
    protected_hermes_home: Path = DEFAULT_PROTECTED_HERMES_HOME,
    managed_configuration_loader: Callable[[], Mapping[str, object]] = (
        hermes_managed_scope.load_managed_config
    ),
    stock_gateway_runner: Callable[[], None] | None = None,
    terminal_tool_module: _HermesTerminalToolModule | None = None,
) -> None:
    _run_managed_hermes_gateway_runtime(
        configuration_path=configuration_path,
        protected_hermes_home=protected_hermes_home,
        managed_configuration_loader=managed_configuration_loader,
        stock_gateway_runner=stock_gateway_runner,
        terminal_tool_module=terminal_tool_module,
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
    run_managed_hermes_gateway(
        configuration_path=configuration_path,
        protected_hermes_home=protected_hermes_home,
    )


if __name__ == "__main__":
    main()
