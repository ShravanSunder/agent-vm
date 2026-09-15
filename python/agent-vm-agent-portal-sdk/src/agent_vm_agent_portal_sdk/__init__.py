"""Portable agent-vm Tool Portal SDK."""

import typing as t

from .artifact_read_resource_uri import create_portal_artifact_read_resource_request
from .contracts import (
    PORTABLE_CONTRACT_ADAPTERS,
    PORTABLE_REFINEMENT_IDENTITIES,
    encode_canonical_json,
)

if t.TYPE_CHECKING:
    from .tool_portal_mcp_client import ToolPortalMcpClient


def connect_tool_portal() -> "ToolPortalMcpClient":
    """Create the managed client for use with ``async with`` in Tool VM code."""
    from .local_tool_portal_transport import LocalToolPortalTransport
    from .tool_portal_mcp_client import ToolPortalMcpClient

    return ToolPortalMcpClient(transport=LocalToolPortalTransport.from_environment())


__all__ = (
    "PORTABLE_CONTRACT_ADAPTERS",
    "PORTABLE_REFINEMENT_IDENTITIES",
    "connect_tool_portal",
    "create_portal_artifact_read_resource_request",
    "encode_canonical_json",
)
