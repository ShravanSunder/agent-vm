"""Deterministic bounded renderer for the managed Tool Portal orientation."""

from agent_vm_agent_portal_sdk import encode_canonical_json

from agent_vm_hermes_adapter.managed_tool_portal.models import (
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
    displayed_tool_counts: tuple[int, ...],
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
        for item_index, item in enumerate(sorted_namespaces[:displayed_count]):
            lines.append(f"Namespace: {encode_canonical_json(item.namespace)}")
            if item.summary is not None:
                lines.append(f"Summary: {encode_canonical_json(item.summary)}")
            displayed_tool_count = displayed_tool_counts[item_index]
            if displayed_tool_count > 0:
                lines.append("Tools:")
                for tool in item.tools[:displayed_tool_count]:
                    lines.append(f"  {tool.name}")
                    if tool.description is not None:
                        lines.append(f"    {tool.description}")
                if displayed_tool_count < len(item.tools):
                    lines.append("  Additional tools are available through list/search.")
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
    selected_displayed_count: int | None = None
    for displayed_count in range(maximum_displayed_count, -1, -1):
        orientation = _candidate_orientation(
            inventory,
            displayed_count=displayed_count,
            displayed_tool_counts=(0,) * displayed_count,
        )
        utf8_byte_count = len(orientation.encode("utf-8"))
        if utf8_byte_count <= max_utf8_bytes:
            selected_displayed_count = displayed_count
            break

    if selected_displayed_count is not None:
        displayed_tool_counts = [0] * selected_displayed_count
        sorted_namespaces = tuple(sorted(inventory.namespaces, key=lambda item: item.namespace))
        for namespace_index, namespace in enumerate(sorted_namespaces[:selected_displayed_count]):
            for tool_count in range(1, len(namespace.tools) + 1):
                candidate_counts = list(displayed_tool_counts)
                candidate_counts[namespace_index] = tool_count
                candidate = _candidate_orientation(
                    inventory,
                    displayed_count=selected_displayed_count,
                    displayed_tool_counts=tuple(candidate_counts),
                )
                if len(candidate.encode("utf-8")) > max_utf8_bytes:
                    break
                displayed_tool_counts = candidate_counts
        orientation = _candidate_orientation(
            inventory,
            displayed_count=selected_displayed_count,
            displayed_tool_counts=tuple(displayed_tool_counts),
        )
        return RenderedOrientation(
            inventory_id=inventory.inventory_id,
            orientation=orientation,
            utf8_byte_count=len(orientation.encode("utf-8")),
            displayed_count=selected_displayed_count,
            total_count=total_count,
            omitted_count=total_count - selected_displayed_count,
        )

    zero_prefix = _candidate_orientation(
        inventory,
        displayed_count=0,
        displayed_tool_counts=(),
    )
    return OrientationRenderFailure(
        inventory_id=inventory.inventory_id,
        minimum_required_bytes=len(zero_prefix.encode("utf-8")),
        total_count=total_count,
        omitted_count=total_count,
    )
