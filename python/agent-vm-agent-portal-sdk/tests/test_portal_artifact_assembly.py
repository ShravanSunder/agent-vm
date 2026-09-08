import base64

import pytest
from agent_vm_agent_portal_sdk.portal_artifact_assembly import PortalArtifactAssembly
from agent_vm_agent_portal_sdk.portal_relay_protocol import PortalRelayProtocolError

REFERENCE: dict[str, object] = {"id": "artifact", "byteLength": 6}


def test_assembles_contiguous_chunks_with_canonical_range_metadata() -> None:
    assembly = PortalArtifactAssembly(reference=REFERENCE, offset_bytes=1, max_bytes=4)
    assembly.append(reference=REFERENCE, offset_bytes=1, content_base64=base64.b64encode(b"bc").decode())
    assembly.append(reference=REFERENCE, offset_bytes=3, content_base64=base64.b64encode(b"de").decode())
    result = assembly.finish(reference=REFERENCE, offset_bytes=1, byte_length=4, truncated=True, media_type=None)
    assert result["contentBase64"] == base64.b64encode(b"bcde").decode()
    assert result["offsetBytes"] == 1
    assert result["truncated"] is True


@pytest.mark.parametrize("offset", [0, 2])
def test_rejects_overlapping_or_gapped_chunk(offset: int) -> None:
    assembly = PortalArtifactAssembly(reference=REFERENCE, offset_bytes=1, max_bytes=4)
    with pytest.raises(PortalRelayProtocolError):
        assembly.append(reference=REFERENCE, offset_bytes=offset, content_base64="Yg==")


def test_rejects_different_reference_and_excess_bytes() -> None:
    assembly = PortalArtifactAssembly(reference=REFERENCE, offset_bytes=0, max_bytes=1)
    with pytest.raises(PortalRelayProtocolError):
        assembly.append(reference={**REFERENCE, "id": "other"}, offset_bytes=0, content_base64="YQ==")
    with pytest.raises(PortalRelayProtocolError):
        assembly.append(reference=REFERENCE, offset_bytes=0, content_base64="YWI=")


def test_rejects_fabricated_complete_artifact() -> None:
    assembly = PortalArtifactAssembly(reference=REFERENCE, offset_bytes=0, max_bytes=2)
    assembly.append(reference=REFERENCE, offset_bytes=0, content_base64="YWI=")
    with pytest.raises(PortalRelayProtocolError):
        assembly.finish(reference=REFERENCE, offset_bytes=0, byte_length=2, truncated=False, media_type=None)
