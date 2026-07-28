import ast
import pathlib
import unittest

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
        pyproject = (PACKAGE_ROOT / "pyproject.toml").read_text(encoding="utf-8")

        self.assertIn('"hermes-agent==0.19.0"', pyproject)
        self.assertNotIn("hermes-agent>=", pyproject)


if __name__ == "__main__":
    unittest.main()
