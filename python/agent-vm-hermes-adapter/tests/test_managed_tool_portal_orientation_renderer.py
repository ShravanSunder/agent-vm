import unittest

from agent_vm_hermes_adapter.managed_tool_portal.models import (
    NamespaceAvailability,
    NamespaceInventory,
    NamespaceToolSummary,
    OrientationRenderFailure,
    RenderedOrientation,
)
from agent_vm_hermes_adapter.managed_tool_portal.renderer import render_orientation


def _inventory(*names: str) -> NamespaceInventory:
    return NamespaceInventory(
        inventory_id="inventory-a",
        namespaces=tuple(
            NamespaceAvailability(namespace=name, status="available") for name in names
        ),
    )


def _require_rendered(
    result: RenderedOrientation | OrientationRenderFailure,
) -> RenderedOrientation:
    if not isinstance(result, RenderedOrientation):
        raise AssertionError("expected a rendered orientation")
    return result


def _require_failure(
    result: RenderedOrientation | OrientationRenderFailure,
) -> OrientationRenderFailure:
    if not isinstance(result, OrientationRenderFailure):
        raise AssertionError("expected a fail-closed rendering result")
    return result


class ManagedToolPortalOrientationRendererTests(unittest.TestCase):
    def test_renderer_is_deterministic_and_uses_canonical_namespace_json(self) -> None:
        inventory = NamespaceInventory(
            inventory_id="inventory-a",
            namespaces=(
                NamespaceAvailability(namespace="zeta", status="unavailable"),
                NamespaceAvailability(namespace="éclair", status="available"),
                NamespaceAvailability(namespace="a\ncontrol", status="available"),
            ),
        )

        first_render = _require_rendered(render_orientation(inventory))
        second_render = _require_rendered(render_orientation(inventory))

        self.assertEqual(first_render, second_render)
        self.assertEqual(first_render.orientation[-1], ".")
        self.assertNotIn("\n", first_render.orientation[-1:])
        self.assertIn('Namespace: "a\\ncontrol"', first_render.orientation)
        self.assertIn('Namespace: "éclair"', first_render.orientation)
        self.assertLessEqual(first_render.utf8_byte_count, 2_000)
        self.assertEqual(first_render.omitted_count, 0)

    def test_renders_optional_summary_for_available_and_unavailable_namespaces(self) -> None:
        rendered = _require_rendered(
            render_orientation(
                NamespaceInventory(
                    inventory_id="inventory-a",
                    namespaces=(
                        NamespaceAvailability(
                            namespace="filesystem",
                            status="available",
                            summary="Read and write project files.",
                        ),
                        NamespaceAvailability(
                            namespace="github",
                            status="unavailable",
                            summary="Repository pull requests.",
                        ),
                        NamespaceAvailability(namespace="linear", status="available"),
                    ),
                )
            )
        )

        self.assertIn(
            'Namespace: "filesystem"\nSummary: "Read and write project files."',
            rendered.orientation,
        )
        self.assertIn(
            'Namespace: "github"\nSummary: "Repository pull requests."',
            rendered.orientation,
        )
        self.assertIn('Namespace: "linear"', rendered.orientation)
        self.assertNotIn('Summary: "None"', rendered.orientation)

    def test_summary_uses_canonical_single_line_json_encoding(self) -> None:
        summary = 'line one\nline two\r"quotes"\\slash\u0001😀'
        rendered = _require_rendered(
            render_orientation(
                NamespaceInventory(
                    inventory_id="inventory-a",
                    namespaces=(
                        NamespaceAvailability(
                            namespace="deepwiki",
                            status="available",
                            summary=summary,
                        ),
                    ),
                )
            )
        )

        summary_line = next(
            line for line in rendered.orientation.splitlines() if line.startswith("Summary: ")
        )
        self.assertEqual(
            summary_line,
            'Summary: "line one\\nline two\\r\\"quotes\\"\\\\slash\\u0001😀"',
        )
        self.assertNotIn("\nline two", summary_line)
        self.assertNotIn("\r", summary_line)

    def test_zero_names_are_explicitly_rendered_without_fabricated_namespace(self) -> None:
        rendered = _require_rendered(render_orientation(_inventory()))

        self.assertIn(
            "Namespace availability for this profile (showing 0 of 0):",
            rendered.orientation,
        )
        self.assertIn("- (none admitted)", rendered.orientation)
        self.assertNotIn("example", rendered.orientation)

    def test_names_are_sorted_and_limited_to_twenty_with_exact_omitted_count(self) -> None:
        inventory = _inventory(*[f"namespace-{index:02d}" for index in range(25, -1, -1)])

        rendered = _require_rendered(render_orientation(inventory))

        self.assertEqual(rendered.total_count, 26)
        self.assertEqual(rendered.displayed_count, 20)
        self.assertEqual(rendered.omitted_count, 6)
        self.assertIn(
            "6 namespace names omitted; use tool_portal_list or "
            "tool_portal_search to discover them.",
            rendered.orientation,
        )
        self.assertLess(
            rendered.orientation.index('Namespace: "namespace-00"'),
            rendered.orientation.index('Namespace: "namespace-01"'),
        )
        self.assertNotIn('Namespace: "namespace-20"', rendered.orientation)

    def test_renderer_selects_greatest_complete_prefix_that_fits_byte_budget(self) -> None:
        inventory = _inventory(*[f"name-{index}-" + "x" * 120 for index in range(20)])

        rendered = _require_rendered(render_orientation(inventory))

        self.assertGreater(rendered.displayed_count, 0)
        self.assertLess(rendered.displayed_count, 20)
        self.assertEqual(rendered.omitted_count, 20 - rendered.displayed_count)
        self.assertLessEqual(rendered.utf8_byte_count, 2_000)
        self.assertIn(
            f"{rendered.omitted_count} namespace names omitted; use tool_portal_list "
            "or tool_portal_search to discover them.",
            rendered.orientation,
        )

    def test_byte_budget_never_emits_a_namespace_without_its_summary(self) -> None:
        inventory = NamespaceInventory(
            inventory_id="inventory-a",
            namespaces=tuple(
                NamespaceAvailability(
                    namespace=f"namespace-{index:02d}",
                    status="available",
                    summary="x" * 400,
                )
                for index in range(8)
            ),
        )

        rendered = _require_rendered(render_orientation(inventory))

        self.assertGreater(rendered.displayed_count, 0)
        self.assertLess(rendered.displayed_count, len(inventory.namespaces))
        self.assertEqual(rendered.orientation.count("Summary: "), rendered.displayed_count)
        self.assertNotIn(
            f'Namespace: "namespace-{rendered.displayed_count:02d}"',
            rendered.orientation,
        )

    def test_renders_tools_as_bounded_children_without_repeating_the_namespace(self) -> None:
        rendered = _require_rendered(
            render_orientation(
                NamespaceInventory(
                    inventory_id="inventory-a",
                    namespaces=(
                        NamespaceAvailability(
                            namespace="oauth_authorization",
                            status="available",
                            summary="Set up and inspect account authorization.",
                            tools=(
                                NamespaceToolSummary(
                                    name="list",
                                    description="List account-profile authorization status.",
                                ),
                                NamespaceToolSummary(
                                    name="begin",
                                    description="Start a human authorization ceremony.",
                                ),
                            ),
                        ),
                    ),
                )
            )
        )

        self.assertEqual(rendered.orientation.count('Namespace: "oauth_authorization"'), 1)
        self.assertIn(
            "Tools:\n  list\n    List account-profile authorization status.\n"
            "  begin\n    Start a human authorization ceremony.",
            rendered.orientation,
        )

    def test_zero_prefix_failure_is_fail_closed_when_fixed_text_does_not_fit(self) -> None:
        rendered = _require_failure(render_orientation(_inventory("namespace"), max_utf8_bytes=1))

        self.assertEqual(rendered.kind, "orientation-render-failure")
        self.assertEqual(rendered.displayed_count, 0)
        self.assertGreater(rendered.minimum_required_bytes, 1)

    def test_duplicate_inventory_names_are_rejected_before_rendering(self) -> None:
        with self.assertRaises(ValueError):
            NamespaceInventory(
                inventory_id="inventory-a",
                namespaces=(
                    NamespaceAvailability(namespace="same", status="available"),
                    NamespaceAvailability(namespace="same", status="unavailable"),
                ),
            )
