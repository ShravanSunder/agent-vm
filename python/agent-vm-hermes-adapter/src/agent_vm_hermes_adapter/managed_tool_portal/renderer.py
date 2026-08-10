"""Deterministic bounded renderer for the managed Tool Portal orientation."""

from agent_vm_agent_portal_sdk import encode_canonical_json

from .models import (
    NamespaceInventory,
    OrientationRenderFailure,
    RenderedOrientation,
)

MAX_ORIENTATION_UTF8_BYTES = 2_000
MAX_DISPLAYED_NAMESPACE_COUNT = 20

_ORIENTATION_INTRODUCTION = (
    "Tool Portal exposes profile-authorized capabilities through four operations:"
)
_OPERATION_LINES = (
    "- tool_portal_list: List authorized capabilities and compact summaries.",
    "- tool_portal_search: Search authorized capabilities by intent.",
    "- tool_portal_describe: Retrieve exact schemas for selected capabilities.",
    "- tool_portal_call: Validate and call an authorized capability.",
)
_WORKFLOW_LINE = "Workflow: list or search, describe the exact capability schema, then call it."


def _candidate_orientation(
    inventory: NamespaceInventory,
    *,
    displayed_count: int,
) -> str:
    total_count = len(inventory.namespaces)
    omitted_count = total_count - displayed_count
    sorted_namespaces = tuple(sorted(inventory.namespaces, key=lambda item: item.namespace))
    lines = [_ORIENTATION_INTRODUCTION, *_OPERATION_LINES]
    lines.append(
        f"Namespace availability for this profile (showing {displayed_count} of {total_count}):"
    )
    if total_count == 0:
        lines.append("- (none admitted)")
    else:
        lines.extend(
            f"- {encode_canonical_json(item.namespace)}: {item.status}"
            for item in sorted_namespaces[:displayed_count]
        )
    if omitted_count > 0:
        lines.append(
            f"{omitted_count} namespace names omitted; use tool_portal_list "
            "or tool_portal_search to discover them."
        )
    lines.append(_WORKFLOW_LINE)
    return "\n".join(lines)


def render_orientation(
    inventory: NamespaceInventory,
    *,
    max_utf8_bytes: int = MAX_ORIENTATION_UTF8_BYTES,
) -> RenderedOrientation | OrientationRenderFailure:
    """Render the greatest complete namespace prefix within the byte budget."""
    if max_utf8_bytes < 1:
        raise ValueError("max_utf8_bytes must be positive")

    total_count = len(inventory.namespaces)
    maximum_displayed_count = min(MAX_DISPLAYED_NAMESPACE_COUNT, total_count)
    for displayed_count in range(maximum_displayed_count, -1, -1):
        orientation = _candidate_orientation(
            inventory,
            displayed_count=displayed_count,
        )
        utf8_byte_count = len(orientation.encode("utf-8"))
        if utf8_byte_count <= max_utf8_bytes:
            return RenderedOrientation(
                inventory_id=inventory.inventory_id,
                orientation=orientation,
                utf8_byte_count=utf8_byte_count,
                displayed_count=displayed_count,
                total_count=total_count,
                omitted_count=total_count - displayed_count,
            )

    zero_prefix = _candidate_orientation(inventory, displayed_count=0)
    return OrientationRenderFailure(
        inventory_id=inventory.inventory_id,
        minimum_required_bytes=len(zero_prefix.encode("utf-8")),
        total_count=total_count,
        omitted_count=total_count,
    )
