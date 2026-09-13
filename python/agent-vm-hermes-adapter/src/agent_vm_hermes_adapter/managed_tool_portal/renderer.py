"""Deterministic bounded renderer for the managed Tool Portal orientation."""

import typing as t

from agent_vm_agent_portal_sdk import encode_canonical_json

from agent_vm_hermes_adapter.managed_tool_portal.catalog import PreparedCatalogManifest
from agent_vm_hermes_adapter.managed_tool_portal.models import (
    NamespaceInventory,
    OrientationRenderFailure,
    RenderedOrientation,
)

MAX_ORIENTATION_UTF8_BYTES = 2_000
MAX_DISPLAYED_NAMESPACE_COUNT = 20

_ORIENTATION_INTRODUCTION = "Profile-authorized Portal tools:"
_OPERATION_LINES = (
    "- tool_portal_list, tool_portal_search, tool_portal_describe, tool_portal_call, "
    "tool_portal_file.",
)
_CATALOG_OPERATION_LINES = (
    "- Profile-authorized capabilities are registered as individual native tools; "
    "tool_portal_file remains available for attachment delivery.",
)
_COMPOSITION_LINES = (
    "Python connect_tool_portal(), TypeScript connectToolPortal(), and "
    "tool-portal CLI auto-connect "
    "for the active foreground invocation; endpoint expires afterward.",
    "Inspect/compose; wait for human approval. Uncertain transport: do not replay "
    "uncertain effects. Guide: /agent-vm/tool-portal.md",
)
_WORKFLOW_LINE = (
    "Workflow: discover, describe, call, inspect.\n"
    "Gog files: relative --out/--out-dir uses an operation folder; use reported names or "
    "list it. Inputs start at /work, not terminal cwd. /agent-vm/files is read-only to ordinary "
    "tools; expiresAtMs or Tool VM close ends access; reads do not extend one hour. Copy to "
    "/workspace; check exitCode—a file does not prove success."
)


def _orientation_child_text(value: str) -> str:
    if any(ord(character) < 32 or character in "\u007f\u2028\u2029" for character in value):
        return encode_canonical_json(value)
    return value


def _candidate_orientation(
    inventory: NamespaceInventory,
    *,
    displayed_count: int,
    displayed_tool_counts: tuple[int, ...],
    catalog_mode: t.Literal["compact", "catalog"],
) -> str:
    total_count = len(inventory.namespaces)
    omitted_count = total_count - displayed_count
    sorted_namespaces = tuple(sorted(inventory.namespaces, key=lambda item: item.namespace))
    operation_lines = _CATALOG_OPERATION_LINES if catalog_mode == "catalog" else _OPERATION_LINES
    lines = [_ORIENTATION_INTRODUCTION, *operation_lines, *_COMPOSITION_LINES]
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
                    lines.append(f"  {_orientation_child_text(tool.name)}")
                    if tool.description is not None:
                        lines.append(f"    {_orientation_child_text(tool.description)}")
            if displayed_tool_count < len(item.tools) or item.has_more_tools:
                lines.append(
                    "  Additional tools are available through "
                    + ("SDK or CLI discovery." if catalog_mode == "catalog" else "list/search.")
                )
    if omitted_count > 0:
        lines.append(
            f"{omitted_count} namespace names omitted; use "
            + (
                "SDK or CLI discovery to inspect them."
                if catalog_mode == "catalog"
                else "tool_portal_list or tool_portal_search to discover them."
            )
        )
    lines.append(_WORKFLOW_LINE)
    return "\n".join(lines)


def render_orientation(
    inventory: NamespaceInventory,
    *,
    max_utf8_bytes: int = MAX_ORIENTATION_UTF8_BYTES,
    catalog_mode: t.Literal["compact", "catalog"] = "compact",
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
            catalog_mode=catalog_mode,
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
                    catalog_mode=catalog_mode,
                )
                if len(candidate.encode("utf-8")) > max_utf8_bytes:
                    break
                displayed_tool_counts = candidate_counts
        orientation = _candidate_orientation(
            inventory,
            displayed_count=selected_displayed_count,
            displayed_tool_counts=tuple(displayed_tool_counts),
            catalog_mode=catalog_mode,
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
        catalog_mode=catalog_mode,
    )
    return OrientationRenderFailure(
        inventory_id=inventory.inventory_id,
        minimum_required_bytes=len(zero_prefix.encode("utf-8")),
        total_count=total_count,
        omitted_count=total_count,
    )


def render_catalog_guidance(
    inventory: NamespaceInventory,
    manifest: PreparedCatalogManifest,
    *,
    changed_fingerprint: bool,
    catalog_mode: t.Literal["compact", "catalog"] = "compact",
) -> str:
    """Fit the largest complete static-import prefix after essential guidance."""
    del changed_fingerprint
    publication_root = f"/run/agent-vm/tool-portal-sdk/{manifest.definition_fingerprint}"
    import_lines = tuple(
        (
            f"- import {{ {namespace.exported_factory_name} }} from "
            f"'{publication_root}/{namespace.module_path}';"
        )
        for namespace in manifest.namespaces
    )
    for displayed_import_count in range(len(import_lines), -1, -1):
        omitted_import_count = len(import_lines) - displayed_import_count
        guidance_lines = [
            "Generated Tool Portal TypeScript imports for this Gateway epoch:",
            "- import { connectToolPortal } from '@agent-vm/agent-portal-sdk';",
            *import_lines[:displayed_import_count],
            *(
                (
                    f"- {omitted_import_count} namespace imports omitted; read the complete "
                    "local manifest before choosing another static import.",
                )
                if omitted_import_count > 0
                else ()
            ),
            f"- Complete manifest: {publication_root}/manifest.json",
        ]
        guidance = "\n".join(guidance_lines)
        remaining_bytes = MAX_ORIENTATION_UTF8_BYTES - len(guidance.encode("utf-8")) - 1
        if remaining_bytes < 1:
            continue
        rendered = render_orientation(
            inventory,
            max_utf8_bytes=remaining_bytes,
            catalog_mode=catalog_mode,
        )
        if isinstance(rendered, RenderedOrientation):
            return f"{rendered.orientation}\n{guidance}"
    raise RuntimeError("Essential generated Tool Portal guidance exceeds its byte budget.")
