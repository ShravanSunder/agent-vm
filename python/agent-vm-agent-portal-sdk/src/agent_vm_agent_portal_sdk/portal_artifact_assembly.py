"""Assemble one authorized range without accepting missing or reordered bytes."""

import base64
import binascii
from collections.abc import Mapping

from .portal_relay_protocol import PortalRelayProtocolError

MAX_ARTIFACT_CHUNK_BYTES = 65_536


class PortalArtifactAssembly:
    def __init__(self, *, reference: Mapping[str, object], offset_bytes: int, max_bytes: int) -> None:
        if not 0 < max_bytes <= 16 * 1024 * 1024 or offset_bytes < 0:
            raise PortalRelayProtocolError("Invalid artifact assembly range.")
        self._reference = dict(reference)
        self._offset = offset_bytes
        self._maximum = max_bytes
        self._content = bytearray()
        self._finished = False

    def append(self, *, reference: Mapping[str, object], offset_bytes: int, content_base64: str) -> None:
        if self._finished or reference != self._reference or offset_bytes != self._offset + len(self._content):
            raise PortalRelayProtocolError("Artifact chunk has invalid reference or position.")
        try:
            content = base64.b64decode(content_base64, validate=True)
        except (ValueError, binascii.Error) as error:
            raise PortalRelayProtocolError("Artifact chunk is not canonical base64.") from error
        if not content or base64.b64encode(content).decode("ascii") != content_base64:
            raise PortalRelayProtocolError("Artifact chunk must contain canonical nonempty bytes.")
        if len(content) > MAX_ARTIFACT_CHUNK_BYTES or len(self._content) + len(content) > self._maximum:
            raise PortalRelayProtocolError("Artifact chunk exceeds requested bounds.")
        self._content.extend(content)

    def finish(
        self,
        *,
        reference: Mapping[str, object],
        offset_bytes: int,
        byte_length: int,
        truncated: bool,
        media_type: str | None,
    ) -> dict[str, object]:
        total_bytes = self._reference.get("byteLength")
        if (
            self._finished
            or reference != self._reference
            or offset_bytes != self._offset
            or byte_length != len(self._content)
            or isinstance(total_bytes, bool)
            or not isinstance(total_bytes, int)
            or truncated != (self._offset + byte_length < total_bytes)
            or byte_length != min(self._maximum, max(0, total_bytes - self._offset))
        ):
            raise PortalRelayProtocolError("Artifact end does not match the requested range and received bytes.")
        self._finished = True
        return {
            "contentBase64": base64.b64encode(self._content).decode("ascii"),
            "reference": self._reference,
            "offsetBytes": self._offset,
            "truncated": truncated,
            **({"mediaType": media_type} if media_type is not None else {}),
        }
