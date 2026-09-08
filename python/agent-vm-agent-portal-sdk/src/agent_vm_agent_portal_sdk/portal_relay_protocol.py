"""Bounded guest relay framing; this protocol carries no trusted authority."""

import json
import typing as t
from collections.abc import Mapping

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

MAX_RELAY_MESSAGE_BYTES = 1024 * 1024
MAX_RELAY_HEADER_BYTES = 8 * 1024
MAX_RELAY_BUFFER_BYTES = MAX_RELAY_MESSAGE_BYTES + MAX_RELAY_HEADER_BYTES
MAX_RELAY_PENDING_REQUESTS = 16
MAX_RELAY_TRANSFER_BYTES = 64 * 1024 * 1024
RELAY_CONTROL_RESERVE_BYTES = 8 * 1024
RELAY_STREAM_CHUNK_BYTES = 64 * 1024


class PortalRelayProtocolError(ValueError):
    """Untrusted relay traffic did not satisfy the bounded wire contract."""


class _RelayModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class RelayRequest(_RelayModel):
    kind: t.Literal["request"]
    request_id: str = Field(alias="requestId", min_length=1)
    operation: t.Literal["list", "search", "describe", "call", "artifact-read"]
    request: dict[str, object]


class RelayCancel(_RelayModel):
    kind: t.Literal["cancel"]
    request_id: str = Field(alias="requestId", min_length=1)


class RelayHello(_RelayModel):
    kind: t.Literal["hello"]
    version: t.Literal[1]

    @field_validator("version", mode="before")
    @classmethod
    def require_integer_version(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("Relay protocol version must be an integer.")
        return value


class RelayReady(_RelayModel):
    kind: t.Literal["ready"]
    version: t.Literal[1]
    max_message_bytes: int = Field(alias="maxMessageBytes", gt=0, le=MAX_RELAY_MESSAGE_BYTES)
    max_pending_requests: int = Field(alias="maxPendingRequests", gt=0, le=MAX_RELAY_PENDING_REQUESTS)

    @field_validator("version", mode="before")
    @classmethod
    def require_integer_version(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("Relay protocol version must be an integer.")
        return value


class RelayResult(_RelayModel):
    kind: t.Literal["result"]
    request_id: str = Field(alias="requestId", min_length=1)
    result: dict[str, object]


class RelayError(_RelayModel):
    kind: t.Literal["error"]
    request_id: str = Field(alias="requestId", min_length=1)
    code: str = Field(min_length=1, max_length=128)
    dispatch: t.Literal["not-dispatched", "uncertain", "completed"]


class RelayClose(_RelayModel):
    kind: t.Literal["close"]


class RelayCredit(_RelayModel):
    kind: t.Literal["credit"]
    requests: int = Field(ge=0, le=MAX_RELAY_PENDING_REQUESTS)
    bytes: int = Field(ge=0, le=MAX_RELAY_TRANSFER_BYTES)


class RelayArtifactChunk(_RelayModel):
    kind: t.Literal["artifact-chunk"]
    request_id: str = Field(alias="requestId", min_length=1)
    reference: dict[str, object]
    offset_bytes: int = Field(alias="offsetBytes", ge=0)
    content_base64: str = Field(alias="contentBase64", max_length=90_000)


class RelayArtifactEnd(_RelayModel):
    kind: t.Literal["artifact-end"]
    request_id: str = Field(alias="requestId", min_length=1)
    reference: dict[str, object]
    offset_bytes: int = Field(alias="offsetBytes", ge=0)
    byte_length: int = Field(alias="byteLength", ge=0, le=16 * 1024 * 1024)
    truncated: bool
    media_type: str | None = Field(default=None, alias="mediaType")


type RelayMessage = t.Annotated[
    RelayRequest | RelayCancel | RelayHello | RelayReady | RelayResult | RelayError | RelayClose | RelayCredit | RelayArtifactChunk | RelayArtifactEnd,
    Field(discriminator="kind"),
]
_MESSAGE_ADAPTER = TypeAdapter(RelayMessage)


def _validate_message(value: object) -> dict[str, object]:
    try:
        return _MESSAGE_ADAPTER.validate_python(value).model_dump(mode="json", by_alias=True, exclude_none=True)
    except ValidationError as error:
        raise PortalRelayProtocolError("Invalid relay message.") from error


def encode_relay_frame(message: Mapping[str, object]) -> bytes:
    validated = _validate_message(dict(message))
    try:
        body = json.dumps(validated, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise PortalRelayProtocolError("Relay message is not JSON encodable.") from error
    if len(body) > MAX_RELAY_MESSAGE_BYTES:
        raise PortalRelayProtocolError("Relay message exceeds its byte limit.")
    return f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise PortalRelayProtocolError("Relay JSON contains duplicate keys.")
        result[key] = value
    return result


def _reject_json_constant(_constant: str) -> t.Never:
    raise PortalRelayProtocolError("Relay JSON contains a non-finite number.")


class PortalRelayDecoder:
    """Incrementally decode bounded frames without retaining caller chunks."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._body_length: int | None = None
        self._failed = False

    def feed(self, chunk: bytes) -> list[dict[str, object]]:
        if self._failed:
            raise PortalRelayProtocolError("Relay decoder is closed after invalid traffic.")
        if len(chunk) > MAX_RELAY_BUFFER_BYTES:
            self._failed = True
            raise PortalRelayProtocolError("Relay input chunk exceeds its buffer limit.")
        try:
            messages: list[dict[str, object]] = []
            position = 0
            while position < len(chunk):
                capacity = MAX_RELAY_BUFFER_BYTES - len(self._buffer)
                if capacity <= 0:
                    raise PortalRelayProtocolError("Relay input exceeds its buffer limit.")
                end = min(len(chunk), position + capacity)
                self._buffer.extend(memoryview(chunk)[position:end])
                messages.extend(self._drain())
                position = end
            return messages
        except (PortalRelayProtocolError, ValueError, UnicodeError, RecursionError) as error:
            self._failed = True
            self._buffer.clear()
            raise PortalRelayProtocolError("Invalid relay frame.") from error

    def _drain(self) -> list[dict[str, object]]:
        messages: list[dict[str, object]] = []
        while True:
            if self._body_length is None:
                delimiter = self._buffer.find(b"\r\n\r\n")
                if delimiter < 0:
                    if len(self._buffer) > MAX_RELAY_HEADER_BYTES:
                        raise PortalRelayProtocolError("Relay header exceeds its byte limit.")
                    return messages
                header = bytes(self._buffer[:delimiter])
                prefix = b"Content-Length: "
                if delimiter > MAX_RELAY_HEADER_BYTES or not header.startswith(prefix):
                    raise PortalRelayProtocolError("Relay header is malformed.")
                digits = header[len(prefix) :]
                if not digits or not digits.isdigit() or len(digits) > len(str(MAX_RELAY_MESSAGE_BYTES)):
                    raise PortalRelayProtocolError("Relay content length is malformed.")
                self._body_length = int(digits)
                if not 0 < self._body_length <= MAX_RELAY_MESSAGE_BYTES:
                    raise PortalRelayProtocolError("Relay content length exceeds its limit.")
                del self._buffer[: delimiter + 4]
            if len(self._buffer) < self._body_length:
                return messages
            body = bytes(self._buffer[: self._body_length])
            del self._buffer[: self._body_length]
            self._body_length = None
            decoded: object = json.loads(body.decode("utf-8"), object_pairs_hook=_unique_json_object, parse_constant=_reject_json_constant)
            messages.append(_validate_message(decoded))


def relay_response_reservation_bytes(message: Mapping[str, object]) -> int:
    """Return the conservative host-output reservation for one request."""
    request = message.get("request")
    if message.get("operation") == "artifact-read" and isinstance(request, dict):
        maximum = request.get("maxBytes")
        if isinstance(maximum, int) and not isinstance(maximum, bool) and 0 < maximum <= 16 * 1024 * 1024:
            chunks = (maximum + RELAY_STREAM_CHUNK_BYTES - 1) // RELAY_STREAM_CHUNK_BYTES
            return ((maximum + 2) // 3) * 4 + (chunks + 1) * RELAY_CONTROL_RESERVE_BYTES
    return MAX_RELAY_MESSAGE_BYTES + RELAY_CONTROL_RESERVE_BYTES
