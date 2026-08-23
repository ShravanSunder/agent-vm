import concurrent.futures
import json
import os
import stat
import tempfile
import typing as t
import unittest
from collections.abc import Callable, Mapping
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, Mock, call, patch

import hermes_constants
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from gateway import run as hermes_gateway_run
from tools import file_tools as hermes_file_tools
from tools.environments import local as local_environment_module
from tools.environments import ssh as ssh_environment_module
from tools.process_registry import ProcessSession
from tools.process_registry import process_registry as hermes_process_registry

import agent_vm_hermes_adapter.managed_gateway_bootstrap as managed_gateway_bootstrap
from agent_vm_hermes_adapter.managed_gateway_bootstrap import (
    HermesManagedEnvironmentHooks,
    load_managed_adapter_material,
)
from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesManagedAdapterConfig,
)
from agent_vm_hermes_adapter.managed_tool_portal.cache import PluginStateCache
from agent_vm_hermes_adapter.managed_tool_portal.models import (
    EvictionReason,
    InjectionCacheKey,
    InjectionMarker,
)
from agent_vm_hermes_adapter.managed_tool_portal_capability_tools import (
    MANAGED_TOOL_PORTAL_TOOL_NAMES,
)
from agent_vm_hermes_adapter.managed_tool_portal_capability_tools import (
    register as register_managed_tool_portal_plugin,
)
from agent_vm_hermes_adapter.managed_tool_portal_observability import HermesToolPortalTelemetry

PROJECTION_COHORT_DIGEST = (
    "projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)
PROTECTED_HERMES_HOME = Path("/home/hermes/.hermes")


def build_projection(*, agent_id: str, profile_name: str) -> dict[str, object]:
    return {
        "agentId": agent_id,
        "frameworkIdentity": {"kind": "hermes", "profileName": profile_name},
        "profileAssignmentRevision": f"revision-{agent_id}",
        "toolPortalNamespaceNames": ["filesystem", "github"],
        "toolPortalProfileId": f"policy-{agent_id}",
    }


def build_attachment(*, client_kind: str = "hermes-managed-plugin") -> dict[str, object]:
    return {
        "attachmentGeneration": 7,
        "clientKind": client_kind,
        "configuredAgentIds": ["researcher", "reviewer"],
        "frameworkEpoch": "framework-epoch-1",
        "gatewayEpoch": "gateway-epoch-1",
        "protocolVersion": 1,
        "projectionCohortDigest": PROJECTION_COHORT_DIGEST,
        "runtimeEpoch": "runtime-epoch-1",
        "schemaVersion": 1,
    }


def build_material(
    *,
    client_kind: str = "hermes-managed-plugin",
    profile_names: tuple[str, str] = ("researcher", "reviewer"),
    profile_environment_source_names_by_profile: Mapping[str, object] | None = None,
) -> dict[str, object]:
    researcher_profile_name, reviewer_profile_name = profile_names
    material: dict[str, object] = {
        "agentProjections": {
            "researcher": build_projection(
                agent_id="researcher",
                profile_name=researcher_profile_name,
            ),
            "reviewer": build_projection(
                agent_id="reviewer",
                profile_name=reviewer_profile_name,
            ),
        },
        "attachment": build_attachment(client_kind=client_kind),
    }
    material["profileEnvironmentSourceNamesByProfile"] = (
        {
            researcher_profile_name: {"DISCORD_BOT_TOKEN": "SOURCE_RESEARCHER"},
            reviewer_profile_name: {"DISCORD_BOT_TOKEN": "SOURCE_REVIEWER"},
        }
        if profile_environment_source_names_by_profile is None
        else dict(profile_environment_source_names_by_profile)
    )
    return material


def materialize_profile_cohort(
    protected_hermes_home: Path,
    *,
    profile_names: tuple[str, ...] = ("researcher", "reviewer"),
) -> None:
    profiles_root = protected_hermes_home / "profiles"
    for profile_name in profile_names:
        profile_home = profiles_root / profile_name
        profile_home.mkdir(parents=True, exist_ok=True)
        (profile_home / "existing-content.txt").write_text(
            f"existing {profile_name} content",
            encoding="utf-8",
        )


def managed_plugin_configuration() -> Mapping[str, object]:
    return {
        "plugins": {
            "enabled": ["agent-vm-tool-portal"],
            "disabled": [],
        }
    }


class FakeGatewayRuntimeClient:
    last_instance: t.ClassVar["FakeGatewayRuntimeClient | None"] = None

    def __init__(
        self,
        *,
        attachment: object | None = None,
        trace_context_provider: Callable[[], Mapping[str, object] | None] | None = None,
    ) -> None:
        self.attachment = attachment
        self.trace_context_provider = trace_context_provider
        self.connect_calls = 0
        self.disconnect_calls = 0
        self.__class__.last_instance = self

    async def connect(self) -> None:
        self.connect_calls += 1

    async def disconnect(self) -> None:
        self.disconnect_calls += 1


class FakeHermesToolPortalTelemetry:
    def __init__(self) -> None:
        self.observer_hooks_enabled = True
        self.max_inflight_observations = 8
        self.shutdown_calls = 0
        self.trace_context_provider: Callable[[], Mapping[str, object] | None] = self._provide

    def _provide(self) -> Mapping[str, object] | None:
        return None

    def shutdown(self) -> None:
        self.shutdown_calls += 1

    def start_turn(self, record: object) -> object:
        del record
        return object()

    def complete_turn(self, handle: object, record: object) -> None:
        del handle, record

    def start_provider_attempt(
        self,
        parent_handle: object | None,
        record: object,
    ) -> object:
        del parent_handle, record
        return object()

    def complete_provider_attempt(self, handle: object, record: object) -> None:
        del handle, record

    def emit_tool_call(
        self,
        parent_handle: object | None,
        record: object,
    ) -> None:
        del parent_handle, record


class FakeTerminalToolModule:
    def __init__(self) -> None:
        self._active_environments: dict[str, object] = {}
        self._create_environment: Callable[..., object] = lambda *args, **kwargs: object()
        self._resolve_container_task_id: Callable[[str | None], str] = lambda task_id: (
            task_id or "default"
        )

    def has_active_environments(self) -> bool:
        return bool(self._active_environments)

    def replace_create_environment(self, value: Callable[..., object]) -> None:
        self._create_environment = value

    def replace_resolve_container_task_id(
        self,
        value: Callable[[str | None], str],
    ) -> None:
        self._resolve_container_task_id = value

    def configured_environment_timeout(self) -> int:
        return 120

    def evict_environment_cache(
        self,
        cache_identity: str,
        expected_environment: object,
    ) -> None:
        cached_environment = self._active_environments.get(cache_identity)
        if cached_environment is not None and cached_environment is not expected_environment:
            raise RuntimeError("unexpected managed environment cache replacement")
        self._active_environments.pop(cache_identity, None)


class FakeHermesPluginContext:
    def __init__(self) -> None:
        self.registered_hook_names: list[str] = []
        self.registered_tool_names: list[str] = []

    def register_hook(
        self,
        hook_name: str,
        callback: Callable[..., object],
    ) -> None:
        del callback
        self.registered_hook_names.append(hook_name)

    def register_tool(
        self,
        name: str,
        toolset: str,
        schema: dict[str, object],
        handler: Callable[..., str],
        check_fn: Callable[..., bool] | None = None,
        requires_env: list[object] | None = None,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
        override: bool = False,
    ) -> None:
        del (
            toolset,
            schema,
            handler,
            check_fn,
            requires_env,
            is_async,
            description,
            emoji,
            override,
        )
        self.registered_tool_names.append(name)


class FakeManagedEnvironment:
    def __init__(self, *, owning_generation: str) -> None:
        self.cwd = "/work"
        self.owning_generation = owning_generation
        self.bound_cache_identity: str | None = None
        self.status_kind = "active"
        self.status_error: Exception | None = None
        self.retired = False

    def bind_cache_identity(self, cache_identity: str) -> None:
        self.bound_cache_identity = cache_identity

    def resolve_status_kind(self) -> str:
        if self.status_error is not None:
            raise self.status_error
        return self.status_kind

    def retire_locally(self) -> None:
        self.retired = True

    def execute(self, command: str, **kwargs: object) -> dict[str, object]:
        del command, kwargs
        return {"output": "", "returncode": 0}


def build_adapter() -> HermesManagedAdapter:
    return HermesManagedAdapter(
        config=HermesManagedAdapterConfig(
            profiles=t.cast(
                "dict[str, dict[str, object]]",
                build_material()["agentProjections"],
            ).values(),
            projection_cohort_digest=PROJECTION_COHORT_DIGEST,
            protected_hermes_home=str(PROTECTED_HERMES_HOME),
        ),
        gateway_runtime_client=t.cast(
            "GatewayRuntimeClient",
            t.cast("object", FakeGatewayRuntimeClient()),
        ),
    )


@t.final
class ManagedGatewayBootstrapTests(unittest.TestCase):
    def test_loads_exact_controller_material_and_rejects_other_frameworks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            configuration_path = Path(temporary_directory) / "framework-service.json"
            material = build_material()
            configuration_path.write_text(json.dumps(material), encoding="utf-8")

            loaded = load_managed_adapter_material(configuration_path)

            self.assertEqual(dict(loaded.attachment), material["attachment"])
            self.assertEqual(dict(loaded.agent_projections), material["agentProjections"])

            configuration_path.write_text(
                json.dumps(build_material(client_kind="openclaw-managed-plugin")),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "hermes-managed-plugin"):
                load_managed_adapter_material(configuration_path)

    def test_loaded_attachment_constructs_real_gateway_runtime_client(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            configuration_path = Path(temporary_directory) / "framework-service.json"
            configuration_path.write_text(json.dumps(build_material()), encoding="utf-8")
            loaded = load_managed_adapter_material(configuration_path)

            gateway_runtime_client = GatewayRuntimeClient(attachment=loaded.attachment)

            self.assertIsInstance(gateway_runtime_client, GatewayRuntimeClient)

    def test_rejects_malformed_or_drifted_material(self) -> None:
        malformed_materials = (
            {**build_material(), "extra": True},
            {
                **build_material(),
                "discordBotTokenEnvironmentVariablesByProfile": None,
            },
            {
                **build_material(),
                "attachment": {
                    **build_attachment(),
                    "configuredAgentIds": ["researcher"],
                },
            },
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            configuration_path = Path(temporary_directory) / "framework-service.json"
            for material in malformed_materials:
                with self.subTest(material=material):
                    configuration_path.write_text(json.dumps(material), encoding="utf-8")
                    with self.assertRaises((TypeError, ValueError)):
                        load_managed_adapter_material(configuration_path)

    def test_loads_only_complete_safe_profile_environment_source_maps(self) -> None:
        valid_mapping = {
            "researcher": {
                "DISCORD_BOT_TOKEN": "DISCORD_BOT_TOKEN_RESEARCHER",
                "OPENROUTER_API_KEY": "OPENROUTER_API_KEY_RESEARCHER",
            },
            "reviewer": {
                "DISCORD_BOT_TOKEN": "DISCORD_BOT_TOKEN_REVIEWER",
                "OPENROUTER_API_KEY": "OPENROUTER_API_KEY_REVIEWER",
            },
        }
        invalid_mappings: tuple[tuple[str, Mapping[str, object]], ...] = (
            (
                "missing profile",
                {"researcher": valid_mapping["researcher"]},
            ),
            (
                "unexpected profile",
                {
                    **valid_mapping,
                    "intruder": {"DISCORD_BOT_TOKEN": "DISCORD_BOT_TOKEN_INTRUDER"},
                },
            ),
            (
                "empty target map",
                {
                    **valid_mapping,
                    "reviewer": {},
                },
            ),
            (
                "unsafe target name",
                {
                    **valid_mapping,
                    "reviewer": {"DISCORD-BOT-TOKEN": "DISCORD_BOT_TOKEN_REVIEWER"},
                },
            ),
            (
                "global target name",
                {
                    **valid_mapping,
                    "reviewer": {"HERMES_HOME": "DISCORD_BOT_TOKEN_REVIEWER"},
                },
            ),
            (
                "unsafe source name",
                {
                    **valid_mapping,
                    "reviewer": {"DISCORD_BOT_TOKEN": "DISCORD-BOT-TOKEN-REVIEWER"},
                },
            ),
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            configuration_path = Path(temporary_directory) / "framework-service.json"
            configuration_path.write_text(
                json.dumps(
                    build_material(profile_environment_source_names_by_profile=valid_mapping)
                ),
                encoding="utf-8",
            )

            loaded = load_managed_adapter_material(configuration_path)

            self.assertEqual(
                {
                    profile_name: dict(target_sources)
                    for profile_name, target_sources in (
                        loaded.profile_environment_source_names_by_profile.items()
                    )
                },
                valid_mapping,
            )
            for case_name, invalid_mapping in invalid_mappings:
                with self.subTest(case_name=case_name):
                    configuration_path.write_text(
                        json.dumps(
                            build_material(
                                profile_environment_source_names_by_profile=invalid_mapping
                            )
                        ),
                        encoding="utf-8",
                    )
                    with self.assertRaises((TypeError, ValueError)):
                        load_managed_adapter_material(configuration_path)

    def test_materializes_complete_sorted_profile_maps_before_stock_gateway(self) -> None:
        environment_mapping = {
            "research-profile": {
                "ZEBRA_KEY": "SOURCE_RESEARCHER_ZEBRA",
                "DISCORD_BOT_TOKEN": "SOURCE_RESEARCHER_DISCORD",
            },
            "review-profile": {
                "ZEBRA_KEY": "SOURCE_REVIEWER_ZEBRA",
                "DISCORD_BOT_TOKEN": "SOURCE_REVIEWER_DISCORD",
            },
        }
        token_values = {
            "SOURCE_RESEARCHER_ZEBRA": "test-researcher-zebra",
            "SOURCE_RESEARCHER_DISCORD": "test-researcher-discord",
            "SOURCE_REVIEWER_ZEBRA": "test-reviewer-zebra",
            "SOURCE_REVIEWER_DISCORD": "test-reviewer-discord",
        }

        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            configuration_path = temporary_root / "framework-service.json"
            protected_hermes_home = temporary_root / "protected-hermes-home"
            profile_names = ("research-profile", "review-profile")
            configuration_path.write_text(
                json.dumps(
                    build_material(
                        profile_names=profile_names,
                        profile_environment_source_names_by_profile=environment_mapping,
                    )
                ),
                encoding="utf-8",
            )
            materialize_profile_cohort(
                protected_hermes_home,
                profile_names=profile_names,
            )

            def stock_gateway_runner() -> None:
                for profile_name, target_sources in environment_mapping.items():
                    token_path = protected_hermes_home / "profiles" / profile_name / ".env"
                    expected_content = "".join(
                        f"{target_name}={token_values[target_sources[target_name]]}\n"
                        for target_name in sorted(target_sources)
                    )
                    self.assertEqual(
                        token_path.read_text(encoding="utf-8"),
                        expected_content,
                    )
                    self.assertEqual(stat.S_IMODE(token_path.stat().st_mode), 0o600)
                    for source_name in target_sources.values():
                        self.assertNotIn(source_name, os.environ)
                    self.assertEqual(
                        {path.name for path in token_path.parent.iterdir()},
                        {".env", "existing-content.txt"},
                    )

            with (
                patch.dict(os.environ, token_values, clear=False),
                patch.object(
                    managed_gateway_bootstrap,
                    "GatewayRuntimeClient",
                    FakeGatewayRuntimeClient,
                ),
            ):
                managed_gateway_bootstrap.run_managed_hermes_gateway(
                    configuration_path=configuration_path,
                    managed_configuration_loader=managed_plugin_configuration,
                    protected_hermes_home=protected_hermes_home,
                    stock_gateway_runner=stock_gateway_runner,
                    terminal_tool_module=FakeTerminalToolModule(),
                )

    def test_removes_created_profile_shadows_when_later_write_and_unlink_fail(self) -> None:
        environment_mapping = {
            "researcher": {"DISCORD_BOT_TOKEN": "SOURCE_RESEARCHER"},
            "reviewer": {"DISCORD_BOT_TOKEN": "SOURCE_REVIEWER"},
        }
        token_values = {
            "SOURCE_RESEARCHER": "opaque-token-researcher",
            "SOURCE_REVIEWER": "opaque-token-reviewer",
        }

        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            configuration_path = temporary_root / "framework-service.json"
            protected_hermes_home = temporary_root / "protected-hermes-home"
            configuration_path.write_text(
                json.dumps(
                    build_material(profile_environment_source_names_by_profile=environment_mapping)
                ),
                encoding="utf-8",
            )
            materialize_profile_cohort(protected_hermes_home)
            stock_gateway_runner = Mock()
            original_fchmod = managed_gateway_bootstrap.os.fchmod
            original_unlink = Path.unlink
            chmod_calls = 0

            def fail_second_shadow_chmod(file_descriptor: int, mode: int) -> None:
                nonlocal chmod_calls
                chmod_calls += 1
                if chmod_calls == 2:
                    raise OSError("forced second profile shadow write failure")
                original_fchmod(file_descriptor, mode)

            def fail_researcher_unlink(path: Path, missing_ok: bool = False) -> None:
                if path.name == ".env" and path.parent.name == "researcher":
                    raise OSError("forced first shadow unlink failure")
                original_unlink(path, missing_ok=missing_ok)

            isolated_environment = dict(token_values)
            with (
                patch.object(managed_gateway_bootstrap.os, "environ", isolated_environment),
                patch.object(
                    managed_gateway_bootstrap.os,
                    "fchmod",
                    side_effect=fail_second_shadow_chmod,
                ),
                patch.object(Path, "unlink", new=fail_researcher_unlink),
                self.assertRaisesRegex(RuntimeError, "could not remove every failed"),
            ):
                managed_gateway_bootstrap.run_managed_hermes_gateway(
                    configuration_path=configuration_path,
                    managed_configuration_loader=managed_plugin_configuration,
                    protected_hermes_home=protected_hermes_home,
                    stock_gateway_runner=stock_gateway_runner,
                    terminal_tool_module=FakeTerminalToolModule(),
                )

            for target_sources in environment_mapping.values():
                for source_name in target_sources.values():
                    self.assertNotIn(source_name, isolated_environment)
            self.assertTrue((protected_hermes_home / "profiles" / "researcher" / ".env").exists())
            self.assertFalse((protected_hermes_home / "profiles" / "reviewer" / ".env").exists())
            self.assertFalse((protected_hermes_home / ".env").exists())
            stock_gateway_runner.assert_not_called()

    def test_managed_policy_bindings_overlay_fallbacks_and_restore_stock_targets(self) -> None:
        class FakeGatewayRunner:
            @staticmethod
            def _load_provider_routing() -> dict[str, object]:
                return {"unexpected": True}

        fallback_inputs: list[dict[str, object]] = []

        def get_fallback_chain(configuration: dict[str, object]) -> list[object]:
            fallback_inputs.append(configuration)
            return [configuration]

        def load_gateway_config() -> dict[str, object]:
            return {"provider_routing": {"order": ["provider-b"]}}

        def load_gateway_config_for_runner() -> dict[str, object]:
            return {"unexpected": True}

        fake_gateway_run = SimpleNamespace(
            GatewayRunner=FakeGatewayRunner,
            _load_gateway_config=load_gateway_config,
            get_fallback_chain=get_fallback_chain,
            load_gateway_config=load_gateway_config,
            load_gateway_config_for_runner=load_gateway_config_for_runner,
        )
        bindings = managed_gateway_bootstrap._HermesManagedPolicyReadBindings(
            gateway_run_module=fake_gateway_run,
        )
        original_fallback = fake_gateway_run.get_fallback_chain
        original_gateway_config_for_runner = fake_gateway_run.load_gateway_config_for_runner
        original_routing_descriptor = FakeGatewayRunner.__dict__["_load_provider_routing"]

        with patch.object(
            managed_gateway_bootstrap.hermes_managed_scope,
            "apply_managed_overlay",
            side_effect=lambda configuration: {**configuration, "managed": True},
        ):
            bindings.install()
            self.assertEqual(
                fake_gateway_run.get_fallback_chain({"fallback": "local"}),
                [{"fallback": "local", "managed": True}],
            )
            self.assertIsInstance(
                FakeGatewayRunner.__dict__["_load_provider_routing"], staticmethod
            )
            self.assertEqual(FakeGatewayRunner._load_provider_routing(), {"order": ["provider-b"]})
            self.assertEqual(
                FakeGatewayRunner()._load_provider_routing(),
                {"order": ["provider-b"]},
            )
            self.assertEqual(
                fake_gateway_run.load_gateway_config_for_runner(),
                {"provider_routing": {"order": ["provider-b"]}},
            )
            bindings.close()

        self.assertEqual(fallback_inputs, [{"fallback": "local", "managed": True}])
        self.assertIs(fake_gateway_run.get_fallback_chain, original_fallback)
        self.assertIs(
            fake_gateway_run.load_gateway_config_for_runner,
            original_gateway_config_for_runner,
        )
        self.assertIs(
            FakeGatewayRunner.__dict__["_load_provider_routing"],
            original_routing_descriptor,
        )

    def test_managed_policy_bindings_restore_fallback_after_partial_install_failure(self) -> None:
        class RefusingGatewayRunnerMeta(type):
            fail_provider_routing_install = True

            @t.override
            def __setattr__(cls, name: str, value: object) -> None:
                if name == "_load_provider_routing" and cls.fail_provider_routing_install:
                    raise RuntimeError("forced provider routing install failure")
                super().__setattr__(name, value)

        class RefusingGatewayRunner(metaclass=RefusingGatewayRunnerMeta):
            @staticmethod
            def _load_provider_routing() -> dict[str, object]:
                return {}

        def get_fallback_chain(configuration: dict[str, object]) -> list[object]:
            return [configuration]

        def load_gateway_config() -> dict[str, object]:
            return {}

        fake_gateway_run = SimpleNamespace(
            GatewayRunner=RefusingGatewayRunner,
            _load_gateway_config=load_gateway_config,
            get_fallback_chain=get_fallback_chain,
            load_gateway_config=load_gateway_config,
            load_gateway_config_for_runner=load_gateway_config,
        )
        bindings = managed_gateway_bootstrap._HermesManagedPolicyReadBindings(
            gateway_run_module=fake_gateway_run,
        )
        original_fallback = fake_gateway_run.get_fallback_chain
        original_routing_descriptor = RefusingGatewayRunner.__dict__["_load_provider_routing"]

        with self.assertRaisesRegex(RuntimeError, "forced provider routing install failure"):
            bindings.install()

        self.assertIs(fake_gateway_run.get_fallback_chain, original_fallback)
        self.assertIs(
            RefusingGatewayRunner.__dict__["_load_provider_routing"],
            original_routing_descriptor,
        )

    def test_managed_policy_bindings_reject_drifted_stock_targets(self) -> None:
        bindings = managed_gateway_bootstrap._HermesManagedPolicyReadBindings(
            gateway_run_module=hermes_gateway_run,
        )
        with patch.object(hermes_gateway_run, "get_fallback_chain", lambda _: []):
            with self.assertRaisesRegex(RuntimeError, "changed"):
                bindings.install()

    def test_rejects_missing_or_unsafe_profile_values_before_stock_gateway(self) -> None:
        environment_mapping = {
            "researcher": {"DISCORD_BOT_TOKEN": "SOURCE_RESEARCHER"},
            "reviewer": {"DISCORD_BOT_TOKEN": "SOURCE_REVIEWER"},
        }
        invalid_token_environments: tuple[tuple[str, Mapping[str, str]], ...] = (
            (
                "missing value",
                {"SOURCE_RESEARCHER": "test-token-researcher"},
            ),
            (
                "NUL",
                {
                    "SOURCE_RESEARCHER": "test-token-researcher",
                    "SOURCE_REVIEWER": "test-token\0reviewer",
                },
            ),
            (
                "carriage return",
                {
                    "SOURCE_RESEARCHER": "test-token-researcher",
                    "SOURCE_REVIEWER": "test-token\rreviewer",
                },
            ),
            (
                "line feed",
                {
                    "SOURCE_RESEARCHER": "test-token-researcher",
                    "SOURCE_REVIEWER": "test-token\nreviewer",
                },
            ),
        )

        for case_name, invalid_environment in invalid_token_environments:
            with self.subTest(case_name=case_name), tempfile.TemporaryDirectory() as directory:
                temporary_root = Path(directory)
                configuration_path = temporary_root / "framework-service.json"
                protected_hermes_home = temporary_root / "protected-hermes-home"
                configuration_path.write_text(
                    json.dumps(
                        build_material(
                            profile_environment_source_names_by_profile=environment_mapping
                        )
                    ),
                    encoding="utf-8",
                )
                materialize_profile_cohort(protected_hermes_home)
                stock_gateway_runner = Mock()
                isolated_environment = dict(invalid_environment)

                with (
                    patch.object(
                        managed_gateway_bootstrap.os,
                        "environ",
                        isolated_environment,
                    ),
                    self.assertRaises((TypeError, ValueError)) as raised,
                ):
                    managed_gateway_bootstrap.run_managed_hermes_gateway(
                        configuration_path=configuration_path,
                        managed_configuration_loader=managed_plugin_configuration,
                        protected_hermes_home=protected_hermes_home,
                        stock_gateway_runner=stock_gateway_runner,
                        terminal_tool_module=FakeTerminalToolModule(),
                    )

                error_text = str(raised.exception)
                for source_value in invalid_environment.values():
                    self.assertNotIn(source_value, error_text)
                stock_gateway_runner.assert_not_called()
                for target_sources in environment_mapping.values():
                    for source_name in target_sources.values():
                        self.assertNotIn(source_name, isolated_environment)
                for profile_name in environment_mapping:
                    self.assertFalse(
                        (protected_hermes_home / "profiles" / profile_name / ".env").exists()
                    )

    def test_refuses_to_follow_a_profile_environment_symlink(self) -> None:
        environment_mapping = {
            "researcher": {"DISCORD_BOT_TOKEN": "SOURCE_RESEARCHER"},
            "reviewer": {"DISCORD_BOT_TOKEN": "SOURCE_REVIEWER"},
        }
        token_values = {
            "SOURCE_RESEARCHER": "test-token-researcher",
            "SOURCE_REVIEWER": "test-token-reviewer",
        }

        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            configuration_path = temporary_root / "framework-service.json"
            protected_hermes_home = temporary_root / "protected-hermes-home"
            configuration_path.write_text(
                json.dumps(
                    build_material(profile_environment_source_names_by_profile=environment_mapping)
                ),
                encoding="utf-8",
            )
            materialize_profile_cohort(protected_hermes_home)
            symlink_target = temporary_root / "must-not-change"
            symlink_target.write_text("sentinel", encoding="utf-8")
            (protected_hermes_home / "profiles" / "researcher" / ".env").symlink_to(symlink_target)
            stock_gateway_runner = Mock()

            with (
                patch.dict(os.environ, token_values, clear=False),
                self.assertRaises(OSError),
            ):
                managed_gateway_bootstrap.run_managed_hermes_gateway(
                    configuration_path=configuration_path,
                    managed_configuration_loader=managed_plugin_configuration,
                    protected_hermes_home=protected_hermes_home,
                    stock_gateway_runner=stock_gateway_runner,
                    terminal_tool_module=FakeTerminalToolModule(),
                )

            self.assertEqual(symlink_target.read_text(encoding="utf-8"), "sentinel")
            for target_sources in environment_mapping.values():
                for source_name in target_sources.values():
                    self.assertNotIn(source_name, os.environ)
            stock_gateway_runner.assert_not_called()

    def test_installs_profile_aware_cache_keys_before_environment_use(self) -> None:
        adapter = build_adapter()
        terminal_tool_module = FakeTerminalToolModule()
        hooks = HermesManagedEnvironmentHooks(
            adapter=adapter,
            attachment=build_attachment(),
            protected_hermes_home=PROTECTED_HERMES_HOME,
            terminal_tool_module=terminal_tool_module,
        )
        original_resolver = terminal_tool_module._resolve_container_task_id
        original_factory = terminal_tool_module._create_environment

        researcher_environment = FakeManagedEnvironment(
            owning_generation="tool-vm-generation-researcher"
        )
        reviewer_environment = FakeManagedEnvironment(
            owning_generation="tool-vm-generation-reviewer"
        )

        hooks.install()
        try:
            with patch.object(
                hooks._environment_factory,
                "create",
                side_effect=(researcher_environment, reviewer_environment),
            ):
                with patch.object(
                    hermes_constants,
                    "get_hermes_home",
                    return_value=PROTECTED_HERMES_HOME / "profiles" / "researcher",
                ):
                    researcher_key = terminal_tool_module._resolve_container_task_id("session-a")
                with patch.object(
                    hermes_constants,
                    "get_hermes_home",
                    return_value=PROTECTED_HERMES_HOME / "profiles" / "reviewer",
                ):
                    reviewer_key = terminal_tool_module._resolve_container_task_id("session-b")

            self.assertNotEqual(researcher_key, reviewer_key)
            self.assertNotEqual(researcher_key, "default")
            self.assertNotEqual(reviewer_key, "default")
        finally:
            hooks.close()
            adapter.close(disconnect_gateway_runtime=False)

        self.assertIs(terminal_tool_module._resolve_container_task_id, original_resolver)
        self.assertIs(terminal_tool_module._create_environment, original_factory)

    def test_routes_stock_background_terminal_through_managed_environment(self) -> None:
        adapter = build_adapter()
        hooks = HermesManagedEnvironmentHooks(
            adapter=adapter,
            attachment=build_attachment(),
            protected_hermes_home=PROTECTED_HERMES_HOME,
            terminal_tool_module=managed_gateway_bootstrap._StockHermesTerminalToolAdapter(),
        )
        stock_terminal_tool = managed_gateway_bootstrap.hermes_terminal_tool
        spawn_via_env = Mock(return_value=SimpleNamespace(id="managed-process", pid=4321))
        spawn_local = Mock(side_effect=AssertionError("managed mode used Gateway-local spawn"))
        managed_environment = FakeManagedEnvironment(
            owning_generation="tool-vm-generation-background"
        )

        with (
            patch.dict(
                os.environ,
                {
                    "TERMINAL_ENV": "local",
                    "TERMINAL_SSH_HOST": "previous-host",
                    "TERMINAL_SSH_USER": "previous-user",
                },
                clear=False,
            ),
            patch.dict(stock_terminal_tool._active_environments, {}, clear=True),
            patch.dict(stock_terminal_tool._last_activity, {}, clear=True),
            patch.object(stock_terminal_tool, "_start_cleanup_thread", return_value=None),
            patch.object(
                managed_gateway_bootstrap.hermes_constants,
                "get_hermes_home",
                return_value=PROTECTED_HERMES_HOME / "profiles" / "researcher",
            ),
            patch.object(
                hooks._environment_factory,
                "create",
                return_value=managed_environment,
            ),
            patch.object(
                hermes_process_registry,
                "spawn_via_env",
                spawn_via_env,
            ),
            patch.object(
                hermes_process_registry,
                "spawn_local",
                spawn_local,
            ),
        ):
            hooks.install()
            try:
                self.assertEqual(os.environ["TERMINAL_ENV"], "ssh")
                self.assertEqual(os.environ["TERMINAL_SSH_HOST"], "managed-tool-vm.invalid")
                self.assertEqual(os.environ["TERMINAL_SSH_USER"], "agent-vm-managed")
                result = stock_terminal_tool.terminal_tool(
                    command="printf managed-background",
                    background=True,
                    force=True,
                    task_id="session-a",
                )
            finally:
                hooks.close()
                adapter.close(disconnect_gateway_runtime=False)

            self.assertEqual(os.environ["TERMINAL_ENV"], "local")
            self.assertEqual(os.environ["TERMINAL_SSH_HOST"], "previous-host")
            self.assertEqual(os.environ["TERMINAL_SSH_USER"], "previous-user")

        spawn_via_env.assert_called_once()
        spawn_local.assert_not_called()
        self.assertEqual(json.loads(result)["session_id"], "managed-process")

    def test_managed_factory_never_constructs_local_or_generic_ssh_environment(self) -> None:
        adapter = build_adapter()
        hooks = HermesManagedEnvironmentHooks(
            adapter=adapter,
            attachment=build_attachment(),
            protected_hermes_home=PROTECTED_HERMES_HOME,
            terminal_tool_module=managed_gateway_bootstrap._StockHermesTerminalToolAdapter(),
        )
        stock_terminal_tool = managed_gateway_bootstrap.hermes_terminal_tool
        managed_environment = FakeManagedEnvironment(
            owning_generation="tool-vm-generation-no-fallback"
        )

        with (
            patch.dict(stock_terminal_tool._active_environments, {}, clear=True),
            patch.dict(stock_terminal_tool._last_activity, {}, clear=True),
            patch.object(stock_terminal_tool, "_start_cleanup_thread", return_value=None),
            patch.object(
                managed_gateway_bootstrap.hermes_constants,
                "get_hermes_home",
                return_value=PROTECTED_HERMES_HOME / "profiles" / "researcher",
            ),
            patch.object(
                hooks._environment_factory,
                "create",
                return_value=managed_environment,
            ),
            patch.object(
                local_environment_module,
                "LocalEnvironment",
                side_effect=AssertionError("managed mode constructed LocalEnvironment"),
            ) as local_environment,
            patch.object(
                ssh_environment_module,
                "SSHEnvironment",
                side_effect=AssertionError("managed mode constructed SSHEnvironment"),
            ) as ssh_environment,
        ):
            hooks.install()
            try:
                result = stock_terminal_tool.terminal_tool(
                    command="printf managed",
                    force=True,
                    task_id="session-a",
                )
            finally:
                hooks.close()
                adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(json.loads(result)["exit_code"], 0)
        local_environment.assert_not_called()
        ssh_environment.assert_not_called()

    def test_reuses_one_preopened_environment_before_stock_cache_insertion(self) -> None:
        adapter = build_adapter()
        terminal_tool_module = FakeTerminalToolModule()
        hooks = HermesManagedEnvironmentHooks(
            adapter=adapter,
            attachment=build_attachment(),
            protected_hermes_home=PROTECTED_HERMES_HOME,
            terminal_tool_module=terminal_tool_module,
        )
        managed_environment = FakeManagedEnvironment(
            owning_generation="tool-vm-generation-single-open"
        )

        hooks.install()
        try:
            with (
                patch.object(
                    hermes_constants,
                    "get_hermes_home",
                    return_value=PROTECTED_HERMES_HOME / "profiles" / "researcher",
                ),
                patch.object(
                    hooks._environment_factory,
                    "create",
                    return_value=managed_environment,
                ) as create_environment,
            ):
                first_cache_identity = terminal_tool_module._resolve_container_task_id("session-a")
                second_cache_identity = terminal_tool_module._resolve_container_task_id("session-b")
                first_environment = terminal_tool_module._create_environment(
                    env_type="ssh",
                    image="",
                    cwd="/work",
                    timeout=120,
                    task_id=first_cache_identity,
                )
                second_environment = terminal_tool_module._create_environment(
                    env_type="ssh",
                    image="",
                    cwd="/work",
                    timeout=120,
                    task_id=second_cache_identity,
                )
        finally:
            hooks.close()
            adapter.close(disconnect_gateway_runtime=False)

        self.assertEqual(first_cache_identity, second_cache_identity)
        self.assertIs(first_environment, managed_environment)
        self.assertIs(second_environment, managed_environment)
        create_environment.assert_called_once()

    def test_reopens_replaced_generation_without_retargeting_stale_processes(self) -> None:
        adapter = build_adapter()
        hooks = HermesManagedEnvironmentHooks(
            adapter=adapter,
            attachment=build_attachment(),
            protected_hermes_home=PROTECTED_HERMES_HOME,
            terminal_tool_module=managed_gateway_bootstrap._StockHermesTerminalToolAdapter(),
        )
        stock_terminal_tool = managed_gateway_bootstrap.hermes_terminal_tool
        environment_a = FakeManagedEnvironment(owning_generation="tool-vm-generation-a")
        environment_b = FakeManagedEnvironment(owning_generation="tool-vm-generation-b")

        with (
            patch.dict(stock_terminal_tool._active_environments, {}, clear=True),
            patch.dict(stock_terminal_tool._last_activity, {}, clear=True),
            patch.dict(stock_terminal_tool._creation_locks, {}, clear=True),
            patch.dict(hermes_file_tools._file_ops_cache, {}, clear=True),
            patch.dict(stock_terminal_tool._session_cwd, {}, clear=True),
            patch.object(stock_terminal_tool, "_start_cleanup_thread", return_value=None),
            patch.object(
                managed_gateway_bootstrap.hermes_constants,
                "get_hermes_home",
                return_value=PROTECTED_HERMES_HOME / "profiles" / "researcher",
            ),
            patch.object(
                hooks._environment_factory,
                "create",
                side_effect=(environment_a, environment_b),
            ) as create_environment,
        ):
            hooks.install()
            try:
                file_operations_a = hermes_file_tools._get_file_ops("session-a")
                cache_identity_a = environment_a.bound_cache_identity
                if cache_identity_a is None:
                    self.fail("managed environment A did not receive a cache identity")
                stale_process = ProcessSession(
                    id="process-a",
                    command="sleep 300",
                    env_ref=environment_a,
                )

                environment_a.status_kind = "replaced"
                file_operations_b = hermes_file_tools._get_file_ops("session-a")
                cache_identity_b = environment_b.bound_cache_identity
                if cache_identity_b is None:
                    self.fail("managed environment B did not receive a cache identity")
            finally:
                hooks.close()
                adapter.close(disconnect_gateway_runtime=False)

        self.assertNotEqual(cache_identity_a, cache_identity_b)
        self.assertIn("tool-vm-generation-a", cache_identity_a)
        self.assertIn("tool-vm-generation-b", cache_identity_b)
        self.assertIs(file_operations_a.env, environment_a)
        self.assertIs(file_operations_b.env, environment_b)
        self.assertIs(stale_process.env_ref, environment_a)
        self.assertIsNot(stale_process.env_ref, environment_b)
        self.assertTrue(environment_a.retired)
        self.assertNotIn(cache_identity_a, stock_terminal_tool._active_environments)
        self.assertNotIn(cache_identity_a, hermes_file_tools._file_ops_cache)
        create_environment.assert_has_calls(
            [
                call(
                    profile_name="researcher",
                    task_id=ANY,
                    cwd="/work",
                    timeout=ANY,
                ),
                call(
                    profile_name="researcher",
                    task_id=ANY,
                    cwd="/work",
                    timeout=ANY,
                ),
            ]
        )

    def test_reopens_generation_when_cached_status_probe_rejects_stale_authority(self) -> None:
        adapter = build_adapter()
        terminal_tool_module = FakeTerminalToolModule()
        hooks = HermesManagedEnvironmentHooks(
            adapter=adapter,
            attachment=build_attachment(),
            protected_hermes_home=PROTECTED_HERMES_HOME,
            terminal_tool_module=terminal_tool_module,
        )
        stale_environment = FakeManagedEnvironment(owning_generation="tool-vm-generation-stale")
        replacement_environment = FakeManagedEnvironment(
            owning_generation="tool-vm-generation-replacement"
        )

        hooks.install()
        try:
            with (
                patch.object(
                    hermes_constants,
                    "get_hermes_home",
                    return_value=PROTECTED_HERMES_HOME / "profiles" / "researcher",
                ),
                patch.object(
                    hooks._environment_factory,
                    "create",
                    side_effect=(stale_environment, replacement_environment),
                ),
            ):
                stale_cache_identity = terminal_tool_module._resolve_container_task_id("session-a")
                terminal_tool_module._active_environments[stale_cache_identity] = stale_environment
                stale_environment.status_error = RuntimeError(
                    "Gateway runtime method dispatch failed."
                )

                replacement_cache_identity = terminal_tool_module._resolve_container_task_id(
                    "session-a"
                )
        finally:
            hooks.close()
            adapter.close(disconnect_gateway_runtime=False)

        self.assertNotEqual(stale_cache_identity, replacement_cache_identity)
        self.assertTrue(stale_environment.retired)
        self.assertNotIn(stale_cache_identity, terminal_tool_module._active_environments)
        self.assertIn("tool-vm-generation-replacement", replacement_cache_identity)

    def test_forces_managed_environment_initial_cwd_to_tool_vm_work(self) -> None:
        adapter = build_adapter()
        terminal_tool_module = FakeTerminalToolModule()
        hooks = HermesManagedEnvironmentHooks(
            adapter=adapter,
            attachment=build_attachment(),
            protected_hermes_home=PROTECTED_HERMES_HOME,
            terminal_tool_module=terminal_tool_module,
        )
        managed_environment = FakeManagedEnvironment(
            owning_generation="tool-vm-generation-forced-cwd"
        )

        hooks.install()
        try:
            with (
                patch.object(
                    hermes_constants,
                    "get_hermes_home",
                    return_value=PROTECTED_HERMES_HOME / "profiles" / "researcher",
                ),
                patch.object(
                    hooks._environment_factory,
                    "create",
                    return_value=managed_environment,
                ) as create_environment,
            ):
                managed_cache_key = terminal_tool_module._resolve_container_task_id("session-a")
                result = terminal_tool_module._create_environment(
                    env_type="local",
                    image="",
                    cwd="/gateway/process/cwd",
                    timeout=120,
                    task_id=managed_cache_key,
                )
        finally:
            hooks.close()
            adapter.close(disconnect_gateway_runtime=False)

        self.assertIs(result, managed_environment)
        create_environment.assert_called_once_with(
            profile_name="researcher",
            task_id=ANY,
            cwd="/work",
            timeout=120,
        )

    def test_rejects_default_scope_and_late_hook_installation(self) -> None:
        adapter = build_adapter()
        terminal_tool_module = FakeTerminalToolModule()
        hooks = HermesManagedEnvironmentHooks(
            adapter=adapter,
            attachment=build_attachment(),
            protected_hermes_home=PROTECTED_HERMES_HOME,
            terminal_tool_module=terminal_tool_module,
        )
        hooks.install()
        try:
            with patch.object(
                hermes_constants,
                "get_hermes_home",
                return_value=PROTECTED_HERMES_HOME,
            ):
                with self.assertRaisesRegex(Exception, "explicit admitted profile"):
                    terminal_tool_module._resolve_container_task_id(None)
        finally:
            hooks.close()
            adapter.close(disconnect_gateway_runtime=False)

        late_terminal_tool_module = FakeTerminalToolModule()
        late_terminal_tool_module._active_environments["default"] = object()
        late_adapter = build_adapter()
        late_hooks = HermesManagedEnvironmentHooks(
            adapter=late_adapter,
            attachment=build_attachment(),
            protected_hermes_home=PROTECTED_HERMES_HOME,
            terminal_tool_module=late_terminal_tool_module,
        )
        try:
            with self.assertRaisesRegex(RuntimeError, "before environment use"):
                late_hooks.install()
        finally:
            late_adapter.close(disconnect_gateway_runtime=False)

    def test_connects_installs_hooks_before_stock_gateway_and_restores_on_exit(self) -> None:
        terminal_tool_module = FakeTerminalToolModule()
        plugin_context = FakeHermesPluginContext()
        telemetry = FakeHermesToolPortalTelemetry()
        original_resolver = terminal_tool_module._resolve_container_task_id
        original_factory = terminal_tool_module._create_environment
        original_process_instance_methods = {
            method_name: hermes_process_registry.__dict__.get(method_name)
            for method_name in (
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
        }
        runner_calls = 0

        def stock_gateway_runner() -> None:
            nonlocal runner_calls
            runner_calls += 1
            register_managed_tool_portal_plugin(plugin_context)
            self.assertIsNot(terminal_tool_module._resolve_container_task_id, original_resolver)
            self.assertIsNot(terminal_tool_module._create_environment, original_factory)
            for method_name, original_value in original_process_instance_methods.items():
                self.assertIsNot(
                    hermes_process_registry.__dict__.get(method_name),
                    original_value,
                )
            self.assertEqual(
                tuple(plugin_context.registered_tool_names),
                MANAGED_TOOL_PORTAL_TOOL_NAMES,
            )
            self.assertEqual(
                set(plugin_context.registered_hook_names),
                {
                    "api_request_error",
                    "on_session_end",
                    "post_api_request",
                    "post_tool_call",
                    "pre_api_request",
                    "pre_gateway_dispatch",
                    "pre_llm_call",
                },
            )
            self.assertNotIn("pre_tool_call", plugin_context.registered_hook_names)
            client = FakeGatewayRuntimeClient.last_instance
            if client is None:
                self.fail("managed bootstrap did not construct a Gateway Runtime client")
            self.assertEqual(client.connect_calls, 1)

        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            configuration_path = temporary_root / "framework-service.json"
            protected_hermes_home = temporary_root / "protected-hermes-home"
            profile_names = ("research-profile", "review-profile")
            configuration_path.write_text(
                json.dumps(build_material(profile_names=profile_names)),
                encoding="utf-8",
            )
            materialize_profile_cohort(
                protected_hermes_home,
                profile_names=profile_names,
            )
            with (
                patch.object(
                    managed_gateway_bootstrap,
                    "GatewayRuntimeClient",
                    FakeGatewayRuntimeClient,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "create_hermes_tool_portal_telemetry_from_environment",
                    return_value=telemetry,
                ),
                patch.dict(
                    os.environ,
                    {"SOURCE_RESEARCHER": "test-researcher", "SOURCE_REVIEWER": "test-reviewer"},
                    clear=False,
                ),
            ):
                managed_gateway_bootstrap.run_managed_hermes_gateway(
                    configuration_path=configuration_path,
                    managed_configuration_loader=managed_plugin_configuration,
                    protected_hermes_home=protected_hermes_home,
                    stock_gateway_runner=stock_gateway_runner,
                    terminal_tool_module=terminal_tool_module,
                )

            self.assertEqual(
                (
                    protected_hermes_home / "profiles/research-profile/existing-content.txt"
                ).read_text(encoding="utf-8"),
                "existing research-profile content",
            )
            self.assertEqual(
                (protected_hermes_home / "profiles/review-profile/existing-content.txt").read_text(
                    encoding="utf-8"
                ),
                "existing review-profile content",
            )

        self.assertEqual(runner_calls, 1)
        self.assertIs(terminal_tool_module._resolve_container_task_id, original_resolver)
        self.assertIs(terminal_tool_module._create_environment, original_factory)
        self.assertEqual(
            {
                method_name: hermes_process_registry.__dict__.get(method_name)
                for method_name in original_process_instance_methods
            },
            original_process_instance_methods,
        )
        client = FakeGatewayRuntimeClient.last_instance
        if client is None:
            self.fail("managed bootstrap did not retain the test client receipt")
        self.assertEqual(client.disconnect_calls, 1)
        self.assertIs(client.trace_context_provider, telemetry.trace_context_provider)
        self.assertEqual(telemetry.shutdown_calls, 1)
        with self.assertRaisesRegex(RuntimeError, "requires bootstrap runtime configuration"):
            register_managed_tool_portal_plugin(FakeHermesPluginContext())

    def test_discovers_plugins_after_managed_runtime_configuration(self) -> None:
        terminal_tool_module = FakeTerminalToolModule()
        telemetry = FakeHermesToolPortalTelemetry()
        events: list[str] = []
        original_configure = managed_gateway_bootstrap.configure_managed_tool_portal_plugin

        class RecordingManagedPolicyBindings:
            def install(self) -> None:
                events.append("managed-policy")

            def close(self) -> None:
                events.append("managed-policy-close")

        def stock_gateway_runner() -> None:
            events.append("stock-gateway")

        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            configuration_path = temporary_root / "framework-service.json"
            protected_hermes_home = temporary_root / "protected-hermes-home"
            configuration_path.write_text(json.dumps(build_material()), encoding="utf-8")
            materialize_profile_cohort(protected_hermes_home)

            def record_configuration(
                *,
                adapter: HermesManagedAdapter,
                current_projection: Callable[[], CanonicalManagedAgentProjection],
                telemetry: HermesToolPortalTelemetry,
                inventory_coordinator: managed_gateway_bootstrap.InventoryCoordinator,
                injection_state_cache: PluginStateCache[InjectionCacheKey, InjectionMarker],
                gateway_epoch: str,
            ) -> None:
                events.append("managed-runtime")
                original_configure(
                    adapter=adapter,
                    current_projection=current_projection,
                    telemetry=telemetry,
                    inventory_coordinator=inventory_coordinator,
                    injection_state_cache=injection_state_cache,
                    gateway_epoch=gateway_epoch,
                )

            with (
                patch.object(
                    managed_gateway_bootstrap,
                    "GatewayRuntimeClient",
                    FakeGatewayRuntimeClient,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "create_hermes_tool_portal_telemetry_from_environment",
                    return_value=telemetry,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "configure_managed_tool_portal_plugin",
                    side_effect=record_configuration,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "_HermesManagedPolicyReadBindings",
                    RecordingManagedPolicyBindings,
                ),
                patch(
                    "hermes_cli.plugins.discover_plugins",
                    side_effect=lambda **kwargs: events.append(f"discover:{kwargs.get('force')}"),
                ) as discover_plugins,
                patch.dict(
                    os.environ,
                    {"SOURCE_RESEARCHER": "test-researcher", "SOURCE_REVIEWER": "test-reviewer"},
                    clear=False,
                ),
            ):
                managed_gateway_bootstrap.run_managed_hermes_gateway(
                    configuration_path=configuration_path,
                    managed_configuration_loader=managed_plugin_configuration,
                    protected_hermes_home=protected_hermes_home,
                    stock_gateway_runner=stock_gateway_runner,
                    terminal_tool_module=terminal_tool_module,
                )

        discover_plugins.assert_called_once_with(force=True)
        self.assertEqual(
            events,
            [
                "managed-runtime",
                "managed-policy",
                "discover:True",
                "stock-gateway",
                "managed-policy-close",
            ],
        )

    def test_eager_inventory_submission_is_nonblocking_and_fenced_before_disconnect(self) -> None:
        terminal_tool_module = FakeTerminalToolModule()
        telemetry = FakeHermesToolPortalTelemetry()
        events: list[str] = []

        class RecordingGatewayRuntimeClient(FakeGatewayRuntimeClient):
            @t.override
            async def connect(self) -> None:
                events.append("connect")
                await super().connect()

            @t.override
            async def disconnect(self) -> None:
                events.append("disconnect")
                await super().disconnect()

        class RecordingProcessHooks:
            def __init__(self, **kwargs: object) -> None:
                del kwargs

            def install(self) -> None:
                events.append("process-install")

            def close(self) -> None:
                events.append("process-close")

        class RecordingPolicyBindings:
            def install(self) -> None:
                events.append("policy-install")

            def close(self) -> None:
                events.append("policy-close")

        original_submit = HermesManagedAdapter.submit_gateway_runtime_coroutine
        original_hooks_install = HermesManagedEnvironmentHooks.install
        original_hooks_close = HermesManagedEnvironmentHooks.close
        original_configure = managed_gateway_bootstrap.configure_managed_tool_portal_plugin

        def record_submit(
            adapter: HermesManagedAdapter,
            coroutine: t.Coroutine[object, object, object],
        ) -> object:
            events.append("submit")
            return original_submit(adapter, coroutine)

        def record_hooks_install(hooks: HermesManagedEnvironmentHooks) -> None:
            events.append("hooks-install")
            original_hooks_install(hooks)

        def record_hooks_close(hooks: HermesManagedEnvironmentHooks) -> None:
            events.append("hooks-close")
            original_hooks_close(hooks)

        def record_configuration(
            *,
            adapter: HermesManagedAdapter,
            current_projection: Callable[[], CanonicalManagedAgentProjection],
            telemetry: HermesToolPortalTelemetry,
            inventory_coordinator: managed_gateway_bootstrap.InventoryCoordinator,
            injection_state_cache: PluginStateCache[InjectionCacheKey, InjectionMarker],
            gateway_epoch: str,
        ) -> None:
            events.append("configure")
            original_configure(
                adapter=adapter,
                current_projection=current_projection,
                telemetry=telemetry,
                inventory_coordinator=inventory_coordinator,
                injection_state_cache=injection_state_cache,
                gateway_epoch=gateway_epoch,
            )

        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            configuration_path = temporary_root / "framework-service.json"
            protected_hermes_home = temporary_root / "protected-hermes-home"
            configuration_path.write_text(json.dumps(build_material()), encoding="utf-8")
            materialize_profile_cohort(protected_hermes_home)

            inventory_coordinator = Mock()
            inventory_coordinator.start_population.side_effect = lambda projection: events.append(
                f"inventory-start:{projection.profile_name}"
            )
            inventory_coordinator.close.side_effect = lambda: events.append("inventory-close")
            injection_state_cache = Mock()
            injection_state_cache.close.side_effect = lambda reason: events.append(
                "injection-close"
            )

            def stock_gateway_runner() -> None:
                events.append("run-gateway")

            with (
                patch.object(
                    managed_gateway_bootstrap,
                    "GatewayRuntimeClient",
                    RecordingGatewayRuntimeClient,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "create_hermes_tool_portal_telemetry_from_environment",
                    return_value=telemetry,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "HermesManagedProcessHooks",
                    RecordingProcessHooks,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "_HermesManagedPolicyReadBindings",
                    RecordingPolicyBindings,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "InventoryCoordinator",
                    return_value=inventory_coordinator,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "PluginStateCache",
                    return_value=injection_state_cache,
                ),
                patch.object(
                    HermesManagedAdapter,
                    "submit_gateway_runtime_coroutine",
                    record_submit,
                ),
                patch.object(
                    HermesManagedEnvironmentHooks,
                    "install",
                    record_hooks_install,
                ),
                patch.object(
                    HermesManagedEnvironmentHooks,
                    "close",
                    record_hooks_close,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "configure_managed_tool_portal_plugin",
                    side_effect=record_configuration,
                ),
                patch(
                    "hermes_cli.plugins.discover_plugins",
                    side_effect=lambda **kwargs: events.append(f"discover:{kwargs.get('force')}"),
                ),
                patch.dict(
                    os.environ,
                    {"SOURCE_RESEARCHER": "test-researcher", "SOURCE_REVIEWER": "test-reviewer"},
                    clear=False,
                ),
            ):
                managed_gateway_bootstrap.run_managed_hermes_gateway(
                    configuration_path=configuration_path,
                    managed_configuration_loader=managed_plugin_configuration,
                    protected_hermes_home=protected_hermes_home,
                    stock_gateway_runner=stock_gateway_runner,
                    terminal_tool_module=terminal_tool_module,
                )

        self.assertLess(events.index("connect"), events.index("configure"))
        first_submit_index = events.index("submit")
        self.assertLess(events.index("configure"), first_submit_index)
        self.assertLess(first_submit_index, events.index("hooks-install"))
        self.assertLess(events.index("hooks-install"), events.index("process-install"))
        self.assertLess(events.index("process-install"), events.index("policy-install"))
        self.assertLess(events.index("policy-install"), events.index("discover:True"))
        self.assertLess(events.index("discover:True"), events.index("run-gateway"))
        self.assertIn("inventory-start:researcher", events)
        self.assertIn("inventory-start:reviewer", events)
        self.assertLess(events.index("inventory-close"), events.index("injection-close"))
        self.assertLess(events.index("injection-close"), events.index("disconnect"))

    def test_clears_plugin_runtime_when_stock_gateway_fails(self) -> None:
        terminal_tool_module = FakeTerminalToolModule()
        plugin_context = FakeHermesPluginContext()
        telemetry = FakeHermesToolPortalTelemetry()
        original_fallback_chain = hermes_gateway_run.get_fallback_chain
        original_provider_routing_descriptor = hermes_gateway_run.GatewayRunner.__dict__[
            "_load_provider_routing"
        ]

        def failing_stock_gateway_runner() -> None:
            register_managed_tool_portal_plugin(plugin_context)
            raise RuntimeError("stock Hermes Gateway failed")

        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            configuration_path = temporary_root / "framework-service.json"
            protected_hermes_home = temporary_root / "protected-hermes-home"
            configuration_path.write_text(json.dumps(build_material()), encoding="utf-8")
            materialize_profile_cohort(protected_hermes_home)
            with (
                patch.object(
                    managed_gateway_bootstrap,
                    "GatewayRuntimeClient",
                    FakeGatewayRuntimeClient,
                ),
                patch.object(
                    managed_gateway_bootstrap,
                    "create_hermes_tool_portal_telemetry_from_environment",
                    return_value=telemetry,
                ),
                patch.dict(
                    os.environ,
                    {"SOURCE_RESEARCHER": "test-researcher", "SOURCE_REVIEWER": "test-reviewer"},
                    clear=False,
                ),
                self.assertRaisesRegex(RuntimeError, "stock Hermes Gateway failed"),
            ):
                managed_gateway_bootstrap.run_managed_hermes_gateway(
                    configuration_path=configuration_path,
                    managed_configuration_loader=managed_plugin_configuration,
                    protected_hermes_home=protected_hermes_home,
                    stock_gateway_runner=failing_stock_gateway_runner,
                    terminal_tool_module=terminal_tool_module,
                )

        self.assertEqual(
            tuple(plugin_context.registered_tool_names),
            MANAGED_TOOL_PORTAL_TOOL_NAMES,
        )
        with self.assertRaisesRegex(RuntimeError, "requires bootstrap runtime configuration"):
            register_managed_tool_portal_plugin(FakeHermesPluginContext())
        client = FakeGatewayRuntimeClient.last_instance
        if client is None:
            self.fail("managed bootstrap did not retain the failed test client receipt")
        self.assertEqual(client.disconnect_calls, 1)
        self.assertIs(client.trace_context_provider, telemetry.trace_context_provider)
        self.assertEqual(telemetry.shutdown_calls, 1)
        self.assertIs(hermes_gateway_run.get_fallback_chain, original_fallback_chain)
        self.assertIs(
            hermes_gateway_run.GatewayRunner.__dict__["_load_provider_routing"],
            original_provider_routing_descriptor,
        )

    def test_inventory_shutdown_failures_do_not_prevent_injection_cache_close(self) -> None:
        injection_state_cache = Mock()
        inventory_coordinator = Mock()

        class ClosedLoopAdapter:
            def submit_gateway_runtime_coroutine(
                self,
                coroutine: t.Coroutine[object, object, None],
            ) -> t.Never:
                coroutine.close()
                raise RuntimeError("Gateway Runtime client loop is closed")

        class TimedOutSubmission(concurrent.futures.Future[None]):
            def __init__(self) -> None:
                super().__init__()
                self.result_timeouts: list[float | None] = []
                self.cancel_calls = 0

            @t.override
            def result(self, timeout: float | None = None) -> None:
                self.result_timeouts.append(timeout)
                raise concurrent.futures.TimeoutError

            @t.override
            def cancel(self) -> bool:
                self.cancel_calls += 1
                return True

        timed_out_submission = TimedOutSubmission()

        class TimedOutAdapter:
            def submit_gateway_runtime_coroutine(
                self,
                coroutine: t.Coroutine[object, object, None],
            ) -> concurrent.futures.Future[None]:
                coroutine.close()
                return timed_out_submission

        for adapter in (ClosedLoopAdapter(), TimedOutAdapter()):
            with self.subTest(adapter=type(adapter).__name__):
                managed_gateway_bootstrap._close_managed_tool_portal_state(
                    adapter=adapter,
                    inventory_coordinator=inventory_coordinator,
                    injection_state_cache=injection_state_cache,
                )

        self.assertEqual(injection_state_cache.close.call_count, 2)
        injection_state_cache.close.assert_called_with(EvictionReason.RUNTIME_SHUTDOWN)
        self.assertEqual(
            timed_out_submission.result_timeouts,
            [managed_gateway_bootstrap._INVENTORY_SHUTDOWN_TIMEOUT_SECONDS],
        )
        self.assertEqual(timed_out_submission.cancel_calls, 1)

    def test_shuts_down_telemetry_when_gateway_runtime_connect_fails(self) -> None:
        telemetry = FakeHermesToolPortalTelemetry()
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            configuration_path = temporary_root / "framework-service.json"
            protected_hermes_home = temporary_root / "protected-hermes-home"
            configuration_path.write_text(json.dumps(build_material()), encoding="utf-8")
            materialize_profile_cohort(protected_hermes_home)
            with (
                patch.object(
                    managed_gateway_bootstrap,
                    "create_hermes_tool_portal_telemetry_from_environment",
                    return_value=telemetry,
                ),
                patch.object(
                    HermesManagedAdapter,
                    "connect_gateway_runtime",
                    side_effect=RuntimeError("test-only Gateway Runtime connect failure"),
                ),
                patch.dict(
                    os.environ,
                    {"SOURCE_RESEARCHER": "test-researcher", "SOURCE_REVIEWER": "test-reviewer"},
                    clear=False,
                ),
                self.assertRaisesRegex(
                    RuntimeError,
                    "test-only Gateway Runtime connect failure",
                ),
            ):
                managed_gateway_bootstrap.run_managed_hermes_gateway(
                    configuration_path=configuration_path,
                    managed_configuration_loader=managed_plugin_configuration,
                    protected_hermes_home=protected_hermes_home,
                    stock_gateway_runner=Mock(),
                    terminal_tool_module=FakeTerminalToolModule(),
                )

        self.assertEqual(telemetry.shutdown_calls, 1)
        with self.assertRaisesRegex(RuntimeError, "requires bootstrap runtime configuration"):
            register_managed_tool_portal_plugin(FakeHermesPluginContext())

    def test_rejects_drifted_profile_cohort_before_managed_or_stock_runtime_use(self) -> None:
        def missing_protected_hermes_home(protected_hermes_home: Path) -> None:
            del protected_hermes_home

        def protected_hermes_home_file(protected_hermes_home: Path) -> None:
            protected_hermes_home.write_text(
                "not a protected Hermes home directory",
                encoding="utf-8",
            )

        def protected_hermes_home_symlink(protected_hermes_home: Path) -> None:
            symlink_target = protected_hermes_home.parent / "protected-hermes-home-target"
            materialize_profile_cohort(symlink_target)
            protected_hermes_home.symlink_to(
                symlink_target,
                target_is_directory=True,
            )

        def missing_profiles_root(protected_hermes_home: Path) -> None:
            protected_hermes_home.mkdir()

        def missing_expected_profile(protected_hermes_home: Path) -> None:
            (protected_hermes_home / "profiles/researcher").mkdir(parents=True)

        def extra_profile(protected_hermes_home: Path) -> None:
            materialize_profile_cohort(protected_hermes_home)
            (protected_hermes_home / "profiles/intruder").mkdir()

        def named_profile_file(protected_hermes_home: Path) -> None:
            (protected_hermes_home / "profiles/researcher").mkdir(parents=True)
            (protected_hermes_home / "profiles/reviewer").write_text(
                "not a profile directory",
                encoding="utf-8",
            )

        def named_profile_symlink(protected_hermes_home: Path) -> None:
            (protected_hermes_home / "profiles/researcher").mkdir(parents=True)
            symlink_target = protected_hermes_home / "reviewer-target"
            symlink_target.mkdir()
            (protected_hermes_home / "profiles/reviewer").symlink_to(
                symlink_target,
                target_is_directory=True,
            )

        def profiles_root_symlink(protected_hermes_home: Path) -> None:
            protected_hermes_home.mkdir()
            symlink_target = protected_hermes_home.parent / "profiles-target"
            for profile_name in ("researcher", "reviewer"):
                (symlink_target / profile_name).mkdir(parents=True, exist_ok=True)
            (protected_hermes_home / "profiles").symlink_to(
                symlink_target,
                target_is_directory=True,
            )

        drift_cases: tuple[tuple[str, Callable[[Path], None]], ...] = (
            ("missing protected Hermes home", missing_protected_hermes_home),
            ("protected Hermes home file", protected_hermes_home_file),
            ("protected Hermes home symlink", protected_hermes_home_symlink),
            ("missing profiles root", missing_profiles_root),
            ("missing expected profile", missing_expected_profile),
            ("extra profile", extra_profile),
            ("named profile file", named_profile_file),
            ("named profile symlink", named_profile_symlink),
            ("profiles root symlink", profiles_root_symlink),
        )

        for case_name, arrange_profile_tree in drift_cases:
            with self.subTest(case_name=case_name), tempfile.TemporaryDirectory() as directory:
                temporary_root = Path(directory)
                configuration_path = temporary_root / "framework-service.json"
                protected_hermes_home = temporary_root / "protected-hermes-home"
                configuration_path.write_text(json.dumps(build_material()), encoding="utf-8")
                arrange_profile_tree(protected_hermes_home)
                sentinel_path = temporary_root / "existing-content.txt"
                sentinel_path.write_text("must remain untouched", encoding="utf-8")
                stock_gateway_runner = Mock()

                with (
                    patch.object(
                        managed_gateway_bootstrap,
                        "GatewayRuntimeClient",
                    ) as gateway_runtime_client,
                    patch.object(
                        managed_gateway_bootstrap,
                        "configure_managed_tool_portal_plugin",
                    ) as configure_plugin,
                    self.assertRaisesRegex(Exception, "profile|Hermes home"),
                ):
                    managed_gateway_bootstrap.run_managed_hermes_gateway(
                        configuration_path=configuration_path,
                        managed_configuration_loader=managed_plugin_configuration,
                        protected_hermes_home=protected_hermes_home,
                        stock_gateway_runner=stock_gateway_runner,
                        terminal_tool_module=FakeTerminalToolModule(),
                    )

                gateway_runtime_client.assert_not_called()
                configure_plugin.assert_not_called()
                stock_gateway_runner.assert_not_called()
                self.assertEqual(
                    sentinel_path.read_text(encoding="utf-8"),
                    "must remain untouched",
                )

    def test_accepts_stock_hermes_reserved_default_profile_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            protected_hermes_home = Path(directory) / "protected-hermes-home"
            materialize_profile_cohort(protected_hermes_home)
            (protected_hermes_home / "profiles/default/pairing").mkdir(parents=True)

            managed_gateway_bootstrap._validate_managed_profile_cohort(
                protected_hermes_home=protected_hermes_home,
                agent_projections=(
                    CanonicalManagedAgentProjection.model_validate(
                        build_projection(agent_id="researcher", profile_name="researcher")
                    ),
                    CanonicalManagedAgentProjection.model_validate(
                        build_projection(agent_id="reviewer", profile_name="reviewer")
                    ),
                ),
            )

    def test_rejects_missing_or_conflicting_managed_plugin_policy_before_runtime_use(self) -> None:
        invalid_plugin_policies: tuple[tuple[str, Mapping[str, object]], ...] = (
            ("missing plugin policy", {}),
            ("missing enabled list", {"plugins": {"disabled": []}}),
            (
                "plugin not enabled",
                {"plugins": {"enabled": [], "disabled": []}},
            ),
            (
                "plugin explicitly disabled",
                {
                    "plugins": {
                        "enabled": ["agent-vm-tool-portal"],
                        "disabled": ["agent-vm-tool-portal"],
                    }
                },
            ),
        )

        for case_name, invalid_plugin_policy in invalid_plugin_policies:
            with self.subTest(case_name=case_name), tempfile.TemporaryDirectory() as directory:
                temporary_root = Path(directory)
                configuration_path = temporary_root / "framework-service.json"
                protected_hermes_home = temporary_root / "protected-hermes-home"
                configuration_path.write_text(json.dumps(build_material()), encoding="utf-8")
                materialize_profile_cohort(protected_hermes_home)
                stock_gateway_runner = Mock()

                with (
                    patch.object(
                        managed_gateway_bootstrap,
                        "GatewayRuntimeClient",
                    ) as gateway_runtime_client,
                    patch.object(
                        managed_gateway_bootstrap,
                        "configure_managed_tool_portal_plugin",
                    ) as configure_plugin,
                    self.assertRaisesRegex(Exception, "plugin|plugins"),
                ):
                    managed_gateway_bootstrap.run_managed_hermes_gateway(
                        configuration_path=configuration_path,
                        managed_configuration_loader=lambda: invalid_plugin_policy,
                        protected_hermes_home=protected_hermes_home,
                        stock_gateway_runner=stock_gateway_runner,
                        terminal_tool_module=FakeTerminalToolModule(),
                    )

                gateway_runtime_client.assert_not_called()
                configure_plugin.assert_not_called()
                stock_gateway_runner.assert_not_called()


if __name__ == "__main__":
    unittest.main()
