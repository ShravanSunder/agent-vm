import ast
import pathlib
import tomllib
import unittest
from unittest.mock import MagicMock, patch

from agent.turn_finalizer import finalize_turn
from hermes_cli.middleware import OBSERVER_SCHEMA_VERSION
from hermes_cli.plugins import VALID_HOOKS

PACKAGE_ROOT = pathlib.Path(__file__).parents[1]
SOURCE_ROOT = PACKAGE_ROOT / "src" / "agent_vm_hermes_adapter"


class PackageBoundaryTests(unittest.TestCase):
    def test_runtime_imports_only_the_gateway_runtime_client_sdk_seam(self) -> None:
        imported_modules: set[str] = set()
        for source_file in SOURCE_ROOT.glob("*.py"):
            syntax_tree = ast.parse(source_file.read_text(encoding="utf-8"))
            for node in ast.walk(syntax_tree):
                if isinstance(node, ast.Import):
                    imported_modules.update(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported_modules.add(node.module)

        forbidden_fragments = (
            "gondolin",
            "managed_vm",
            "paramiko",
            "subprocess",
            "tools.environments.local",
            "tools.environments.ssh",
        )
        for module_name in imported_modules:
            self.assertFalse(
                any(fragment in module_name for fragment in forbidden_fragments),
                module_name,
            )

        self.assertIn(
            "agent_vm_agent_portal_sdk.gateway_runtime_client",
            imported_modules,
        )
        self.assertIn("agent_vm_agent_portal_sdk.contracts", imported_modules)

    def test_package_declares_exact_hermes_distribution(self) -> None:
        with (PACKAGE_ROOT / "pyproject.toml").open("rb") as pyproject_file:
            package_config = tomllib.load(pyproject_file)

        self.assertEqual(
            package_config["project"]["dependencies"],
            [
                (f"agent-vm-agent-portal-sdk=={package_config['project']['version']}"),
                "hermes-agent==0.19.0",
                "opentelemetry-api==1.44.0",
                "opentelemetry-exporter-otlp-proto-http==1.44.0",
                "opentelemetry-sdk==1.44.0",
                "pydantic>=2.12.0,<3",
            ],
        )
        self.assertEqual(
            package_config["project"]["entry-points"]["hermes_agent.plugins"],
            {
                "agent-vm-tool-portal": (
                    "agent_vm_hermes_adapter.managed_tool_portal_capability_tools"
                ),
            },
        )

    def test_installed_hermes_supports_adapter_telemetry_hooks(self) -> None:
        self.assertTrue(
            {
                "pre_llm_call",
                "pre_api_request",
                "post_api_request",
                "api_request_error",
                "post_tool_call",
                "on_session_end",
            }.issubset(VALID_HOOKS),
        )

    def test_installed_hermes_uses_the_expected_observer_schema(self) -> None:
        self.assertEqual(OBSERVER_SCHEMA_VERSION, "hermes.observer.v1")

    def test_installed_hermes_finalizer_emits_authoritative_turn_outcome(self) -> None:
        agent = MagicMock()
        agent.max_iterations = 5
        agent.iteration_budget.remaining = 5
        agent.quiet_mode = True
        agent.session_id = "session"
        agent.model = "model"
        agent.platform = "discord"
        agent._user_id = "user"
        agent._response_was_previewed = False
        agent._skill_nudge_interval = 0
        agent._skill_nudge_counter = 0
        agent.enabled_memory_providers = []
        agent._memory_manager = None
        agent._memory_review_interval = 0
        agent._background_review_thread = None
        observed_session_end_payloads: list[dict[str, object]] = []

        def capture_hook(hook_name: str, **hook_payload: object) -> list[object]:
            if hook_name == "on_session_end":
                observed_session_end_payloads.append(hook_payload)
            return []

        with patch("hermes_cli.plugins.invoke_hook", side_effect=capture_hook):
            result = finalize_turn(
                agent,
                final_response="incomplete response",
                api_call_count=5,
                interrupted=False,
                failed=False,
                messages=[
                    {"role": "user", "content": "request"},
                    {"role": "assistant", "content": "incomplete response"},
                ],
                conversation_history=[],
                effective_task_id="task",
                turn_id="turn",
                user_message="request",
                original_user_message="request",
                _should_review_memory=False,
                _turn_exit_reason="max_iterations_reached",
            )

        self.assertFalse(result["completed"])
        self.assertEqual(
            observed_session_end_payloads,
            [
                {
                    "session_id": "session",
                    "task_id": "task",
                    "turn_id": "turn",
                    "completed": False,
                    "interrupted": False,
                    "model": "model",
                    "platform": "discord",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
