"""Strict bounded asyncio transport for the private Gateway-runtime UDS."""

import asyncio
import json
import typing as t
from collections.abc import Mapping

_HEADER_DELIMITER = b"\r\n\r\n"
_MAXIMUM_CONTENT_BYTES = 1024 * 1024
_MAXIMUM_HEADER_BYTES = 8 * 1024
_CANCELLED_RESPONSE_DRAIN_SECONDS = 5


class GatewayRuntimeUdsTransportError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class GatewayRuntimeUdsRemoteError(GatewayRuntimeUdsTransportError):
    """A complete JSON-RPC error response received over a healthy transport."""

    def __init__(
        self,
        json_rpc_code: str,
        message: str,
        *,
        data: Mapping[str, object] | None = None,
    ) -> None:
        self.data = dict(data) if data is not None else None
        data_code = self.data.get("code") if self.data is not None else None
        super().__init__(data_code if isinstance(data_code, str) else json_rpc_code, message)
        self.json_rpc_code = json_rpc_code


def _raise_transport_error(
    code: str,
    message: str,
    *,
    cause: BaseException | None = None,
) -> t.Never:
    error = GatewayRuntimeUdsTransportError(code, message)
    if cause is None:
        raise error
    raise error from cause


def _encode_frame(message: Mapping[str, object]) -> bytes:
    body = json.dumps(
        message,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(body) > _MAXIMUM_CONTENT_BYTES:
        _raise_transport_error(
            "content-too-large",
            "Gateway runtime request exceeds the content limit.",
        )
    return f"Content-Length: {len(body)}\r\n\r\n".encode() + body


def _parse_content_length(header: bytes) -> int:
    if len(header) > _MAXIMUM_HEADER_BYTES:
        _raise_transport_error(
            "header-too-large",
            "Gateway runtime response header exceeds its limit.",
        )
    try:
        header_text = header.decode("ascii")
    except UnicodeDecodeError as error:
        _raise_transport_error(
            "invalid-header",
            "Gateway runtime response header must be ASCII.",
            cause=error,
        )
    header_lines = header_text.split("\r\n")
    if len(header_lines) != 1 or ":" not in header_lines[0]:
        _raise_transport_error(
            "invalid-header",
            "Gateway runtime response must contain one Content-Length header.",
        )
    header_name, header_value = header_lines[0].split(":", 1)
    content_length_text = header_value.strip()
    if header_name.strip().lower() != "content-length" or not content_length_text.isdecimal():
        _raise_transport_error(
            "invalid-header",
            "Gateway runtime response has an invalid Content-Length header.",
        )
    content_length = int(content_length_text)
    if content_length > _MAXIMUM_CONTENT_BYTES:
        _raise_transport_error(
            "content-too-large",
            "Gateway runtime response exceeds the content limit.",
        )
    return content_length


def _decode_response(body: bytes) -> Mapping[str, object]:
    try:
        decoded = t.cast("object", json.loads(body.decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _raise_transport_error(
            "invalid-json",
            "Gateway runtime response is not valid UTF-8 JSON.",
            cause=error,
        )
    if not isinstance(decoded, dict):
        _raise_transport_error(
            "invalid-envelope",
            "Gateway runtime response must be a JSON object.",
        )
    response = t.cast("dict[object, object]", decoded)
    has_error = "error" in response
    has_result = "result" in response
    if set(response) - {"error", "id", "jsonrpc", "result"} or response.get("jsonrpc") != "2.0" or has_error == has_result:
        _raise_transport_error(
            "invalid-envelope",
            "Gateway runtime response envelope is invalid.",
        )
    return t.cast("Mapping[str, object]", response)


async def _read_frame(reader: asyncio.StreamReader) -> Mapping[str, object]:
    try:
        header_with_delimiter = await reader.readuntil(_HEADER_DELIMITER)
    except asyncio.LimitOverrunError as error:
        _raise_transport_error(
            "header-too-large",
            "Gateway runtime response header exceeds the reader limit.",
            cause=error,
        )
    except asyncio.IncompleteReadError as error:
        _raise_transport_error(
            "incomplete-header",
            "Gateway runtime response ended before its header completed.",
            cause=error,
        )

    header = header_with_delimiter[: -len(_HEADER_DELIMITER)]
    content_length = _parse_content_length(header)
    try:
        body = await reader.readexactly(content_length)
    except asyncio.IncompleteReadError as error:
        _raise_transport_error(
            "incomplete-body",
            "Gateway runtime response ended before its body completed.",
            cause=error,
        )
    return _decode_response(body)


class GatewayRuntimeUdsTransport:
    """One persistent request/response connection with bounded serialized writes."""

    def __init__(self) -> None:
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._request_lock = asyncio.Lock()
        self._next_request_id = 1
        self._cancelled_response_drain_tasks: set[asyncio.Task[None]] = set()

    async def connect(self, socket_path: str) -> None:
        if self._writer is not None:
            _raise_transport_error(
                "already-connected",
                "Gateway runtime UDS transport is already connected.",
            )
        self._reader, self._writer = await asyncio.open_unix_connection(socket_path)

    async def handshake(
        self,
        attachment: Mapping[str, object],
    ) -> Mapping[str, object]:
        return await self.request("managed-plugin.handshake", attachment)

    async def request(
        self,
        method: str,
        params: Mapping[str, object],
    ) -> Mapping[str, object]:
        await self._request_lock.acquire()
        release_request_lock = True
        try:
            reader = self._reader
            writer = self._writer
            if reader is None or writer is None:
                _raise_transport_error(
                    "not-connected",
                    "Gateway runtime UDS transport is not connected.",
                )
            request_id = self._next_request_id
            self._next_request_id += 1
            try:
                writer.write(
                    _encode_frame(
                        {
                            "id": request_id,
                            "jsonrpc": "2.0",
                            "method": method,
                            "params": dict(params),
                        },
                    ),
                )
                await writer.drain()
                response = await _read_frame(reader)
            except asyncio.CancelledError:
                writer.write(
                    _encode_frame(
                        {
                            "jsonrpc": "2.0",
                            "method": "notifications/cancelled",
                            "params": {"requestId": request_id},
                        },
                    ),
                )
                try:
                    await asyncio.shield(writer.drain())
                except Exception:
                    await self._close_connection()
                    raise
                drain_task = asyncio.create_task(
                    self._discard_cancelled_response(
                        reader=reader,
                        request_id=request_id,
                    ),
                )
                self._cancelled_response_drain_tasks.add(drain_task)
                drain_task.add_done_callback(self._cancelled_response_drain_tasks.discard)
                release_request_lock = False
                raise
            if response.get("id") != request_id:
                _raise_transport_error(
                    "unexpected-response",
                    "Gateway runtime response id does not match the pending request.",
                )
            if "error" in response:
                error_object = response["error"]
                if isinstance(error_object, dict):
                    error_mapping = t.cast("dict[object, object]", error_object)
                    error_code = error_mapping.get("code")
                    error_data = error_mapping.get("data")
                    error_message = error_mapping.get("message")
                    raise GatewayRuntimeUdsRemoteError(
                        str(error_code),
                        error_message if isinstance(error_message, str) else "Gateway runtime request failed.",
                        data=(
                            t.cast("Mapping[str, object]", error_data)
                            if isinstance(error_data, dict) and all(isinstance(key, str) for key in error_data)
                            else None
                        ),
                    )
                _raise_transport_error(
                    "invalid-remote-error",
                    "Gateway runtime returned an invalid error object.",
                )
            result = response.get("result")
            if not isinstance(result, dict):
                _raise_transport_error(
                    "invalid-result",
                    "Gateway runtime response result must be an object.",
                )
            return t.cast("Mapping[str, object]", result)
        finally:
            if release_request_lock:
                self._request_lock.release()

    async def _discard_cancelled_response(
        self,
        *,
        reader: asyncio.StreamReader,
        request_id: int,
    ) -> None:
        try:
            async with asyncio.timeout(_CANCELLED_RESPONSE_DRAIN_SECONDS):
                response = await _read_frame(reader)
            if response.get("id") != request_id:
                _raise_transport_error(
                    "unexpected-response",
                    "Gateway runtime cancelled response id does not match the discarded request.",
                )
        except BaseException:
            await self._close_connection()
        finally:
            self._request_lock.release()

    async def _close_connection(self) -> None:
        writer = self._writer
        self._reader = None
        self._writer = None
        if writer is None:
            return
        writer.close()
        await writer.wait_closed()

    async def disconnect(self) -> None:
        await self._close_connection()
        drain_tasks = tuple(self._cancelled_response_drain_tasks)
        if drain_tasks:
            _ = await asyncio.gather(*drain_tasks, return_exceptions=True)
