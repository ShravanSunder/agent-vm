import unittest

from agent_vm_hermes_adapter.managed_tool_portal.models import (
    NamespaceAvailability,
    NamespaceInventory,
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
        self.assertIn('"a\\ncontrol": available', first_render.orientation)
        self.assertIn('"éclair": available', first_render.orientation)
        self.assertLessEqual(first_render.utf8_byte_count, 2_000)
        self.assertEqual(first_render.omitted_count, 0)

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
            rendered.orientation.index('"namespace-00": available'),
            rendered.orientation.index('"namespace-01": available'),
        )
        self.assertNotIn('"namespace-20": available', rendered.orientation)

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
