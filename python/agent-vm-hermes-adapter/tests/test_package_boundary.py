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
MANAGED_TOOL_PORTAL_SOURCE_FILES = (
    SOURCE_ROOT / "managed_tool_portal_capability_tools.py",
    *sorted((SOURCE_ROOT / "managed_tool_portal").glob("*.py")),
)
MANAGED_TOOL_PORTAL_TEST_FILES = (
    *sorted((PACKAGE_ROOT / "tests").glob("test_managed_tool_portal_*.py")),
)


def _qualified_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_qualified_name(node.value)}.{node.attr}"
    return ""


def _assignment_name(target: ast.expr) -> str:
    if isinstance(target, ast.Name):
        return target.id
    if isinstance(target, ast.Attribute):
        return target.attr
    return ""


class PackageBoundaryTests(unittest.TestCase):
    def test_managed_tool_portal_boundary_forbids_untyped_escape_hatches(self) -> None:
        violations: list[str] = []
        boundary_files = MANAGED_TOOL_PORTAL_SOURCE_FILES + MANAGED_TOOL_PORTAL_TEST_FILES
        for source_file in boundary_files:
            syntax_tree = ast.parse(source_file.read_text(encoding="utf-8"))
            for node in ast.walk(syntax_tree):
                if not isinstance(node, ast.stmt | ast.expr):
                    continue
                location = f"{source_file.relative_to(PACKAGE_ROOT)}:{node.lineno}"
                if isinstance(node, ast.Name) and node.id == "Any":
                    violations.append(f"{location}: Any")
                elif isinstance(node, ast.Attribute) and node.attr == "Any":
                    violations.append(f"{location}: Any")
                elif isinstance(node, ast.Call) and _qualified_name(node.func).split(".")[-1] in {
                    "cast",
                    "getattr",
                    "hasattr",
                }:
                    violations.append(f"{location}: {_qualified_name(node.func)}")
                elif (
                    isinstance(node, ast.Call)
                    and _qualified_name(node.func).split(".")[-1] == "dataclass"
                ):
                    violations.append(f"{location}: dataclass")
                elif isinstance(node, ast.ClassDef) and any(
                    _qualified_name(base).split(".")[-1] in {"NamedTuple", "TypedDict"}
                    for base in node.bases
                ):
                    violations.append(f"{location}: forbidden structural container")
                elif (
                    isinstance(node, ast.Subscript)
                    and _qualified_name(node.value).split(".")[-1] == "Callable"
                    and "..." in ast.unparse(node.slice)
                ):
                    violations.append(f"{location}: variadic Callable")
                elif (
                    isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
                    and (node.args.vararg is not None or node.args.kwarg is not None)
                    and (
                        node.name == "__call__"
                        or "callback" in node.name.lower()
                        or "hook" in node.name.lower()
                    )
                ):
                    violations.append(f"{location}: untyped variadic adapter")
                elif isinstance(node, ast.AnnAssign):
                    annotation = ast.unparse(node.annotation).replace(" ", "")
                    assignment_name = _assignment_name(node.target).lower()
                    is_loose_object_dictionary = annotation in {
                        "dict[str,object]",
                        "Mapping[str,object]",
                        "t.Mapping[str,object]",
                    }
                    state_name_fragments = (
                        "binding",
                        "cache",
                        "callback",
                        "entry",
                        "hook",
                        "runtime",
                        "state",
                    )
                    if is_loose_object_dictionary and any(
                        fragment in assignment_name for fragment in state_name_fragments
                    ):
                        violations.append(f"{location}: loose state dictionary")

        self.assertEqual(violations, [])

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

    def test_package_leaves_hermes_distribution_ownership_to_the_runtime_image(self) -> None:
        with (PACKAGE_ROOT / "pyproject.toml").open("rb") as pyproject_file:
            package_config = tomllib.load(pyproject_file)

        self.assertEqual(
            package_config["project"]["dependencies"],
            [
                (f"agent-vm-agent-portal-sdk=={package_config['project']['version']}"),
                "opentelemetry-api==1.44.0",
                "opentelemetry-exporter-otlp-proto-http==1.44.0",
                "opentelemetry-sdk==1.44.0",
                "pydantic>=2.12.0,<3",
            ],
        )
        self.assertFalse(
            any(
                dependency.startswith("hermes-agent")
                for dependency in package_config["project"]["dependencies"]
            )
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
                    "failed": False,
                    "interrupted": False,
                    "turn_exit_reason": "max_iterations_reached",
                    "model": "model",
                    "platform": "discord",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
