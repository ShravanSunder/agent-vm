import json

import pytest
from agent_vm_agent_portal_sdk.portal_relay_protocol import PortalRelayDecoder, PortalRelayProtocolError, encode_relay_frame


def test_decoder_preserves_split_and_coalesced_messages() -> None:
    first = {"kind": "request", "requestId": "one", "operation": "list", "request": {}}
    second = {"kind": "cancel", "requestId": "one"}
    encoded = encode_relay_frame(first) + encode_relay_frame(second)
    decoder = PortalRelayDecoder()
    assert decoder.feed(encoded[:7]) == []
    assert decoder.feed(encoded[7:-1]) == [first]
    assert decoder.feed(encoded[-1:]) == [second]


def test_large_legal_frame_can_finish_in_a_chunk_containing_the_next_frame() -> None:
    first = {"kind": "result", "requestId": "one", "result": {"padding": "x" * (1024 * 1024 - 128)}}
    second = {"kind": "result", "requestId": "two", "result": {"padding": "y" * 20_000}}
    first_frame = encode_relay_frame(first)
    decoder = PortalRelayDecoder()
    assert decoder.feed(first_frame[:-1]) == []
    assert decoder.feed(first_frame[-1:] + encode_relay_frame(second)) == [first, second]


@pytest.mark.parametrize("authority_field", ["trustedContext", "agentId", "principal", "approvalDecision"])
def test_request_rejects_guest_authority_fields(authority_field: str) -> None:
    with pytest.raises(PortalRelayProtocolError):
        encode_relay_frame({"kind": "request", "requestId": "one", "operation": "call", "request": {}, authority_field: "forged"})


def test_protocol_rejects_non_portal_operation() -> None:
    with pytest.raises(PortalRelayProtocolError):
        encode_relay_frame({"kind": "request", "requestId": "one", "operation": "approval.decide", "request": {}})


def test_decoder_rejects_excessive_declared_body_without_buffering_it() -> None:
    decoder = PortalRelayDecoder()
    with pytest.raises(PortalRelayProtocolError):
        decoder.feed(b"Content-Length: 1048577\r\n\r\n")


def test_decoder_validates_untrusted_payload_not_only_encoder() -> None:
    body = json.dumps({"kind": "cancel", "requestId": "one", "agentId": "other"}).encode()
    decoder = PortalRelayDecoder()
    with pytest.raises(PortalRelayProtocolError):
        decoder.feed(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)


def test_decoder_rejects_duplicate_json_keys() -> None:
    body = b'{"kind":"cancel","requestId":"a","requestId":"b"}'
    with pytest.raises(PortalRelayProtocolError):
        PortalRelayDecoder().feed(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)


def test_decoder_rejects_invalid_utf8() -> None:
    with pytest.raises(PortalRelayProtocolError):
        PortalRelayDecoder().feed(b"Content-Length: 1\r\n\r\n\xff")


@pytest.mark.parametrize("invalid_version", [True, 1.0])
@pytest.mark.parametrize(
    "message",
    [
        {"kind": "hello", "version": 1},
        {"kind": "ready", "version": 1, "maxMessageBytes": 1048576, "maxPendingRequests": 16},
    ],
)
def test_protocol_version_requires_the_integer_literal(message: dict[str, object], invalid_version: object) -> None:
    with pytest.raises(PortalRelayProtocolError):
        encode_relay_frame({**message, "version": invalid_version})
