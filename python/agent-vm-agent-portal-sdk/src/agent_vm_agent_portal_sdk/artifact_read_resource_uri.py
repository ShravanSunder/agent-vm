"""Portable construction of bounded Tool Portal artifact MCP resource requests."""

import typing as t
from collections.abc import Mapping
from urllib.parse import urlencode

from pydantic import BaseModel

from .contracts import PORTABLE_CONTRACT_ADAPTERS

PORTAL_ARTIFACT_READ_REQUEST_META_KEY = "agent-vm/artifact-read-request"


def create_portal_artifact_read_resource_request(
    request: Mapping[str, object],
) -> dict[str, object]:
    """Encode one validated public read while the resource URI exposes only its ID."""
    validated_request = PORTABLE_CONTRACT_ADAPTERS["portal.artifact.read-request"].validate_python(request)
    if not isinstance(validated_request, BaseModel):
        error_message = "Artifact read request did not produce a typed model."
        raise TypeError(error_message)
    request_payload = t.cast(
        "dict[str, object]",
        validated_request.model_dump(by_alias=True, mode="json", exclude_none=True),
    )
    reference_value = request_payload.get("reference")
    if not isinstance(reference_value, dict):
        error_message = "Artifact read request did not contain a typed reference."
        raise TypeError(error_message)
    reference = t.cast("dict[str, object]", reference_value)
    artifact_id = reference.get("id")
    if not isinstance(artifact_id, str) or not artifact_id:
        error_message = "Artifact reference did not contain an opaque identifier."
        raise TypeError(error_message)
    return {
        "_meta": {PORTAL_ARTIFACT_READ_REQUEST_META_KEY: request_payload},
        "uri": f"agent-vm-artifact://read?{urlencode([('id', artifact_id)])}",
    }
