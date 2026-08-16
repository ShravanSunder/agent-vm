"""Strict bounded asyncio transport for the private Gateway-runtime UDS."""

import asyncio
import contextlib
import json
import typing as t
from collections.abc import Mapping

_HEADER_DELIMITER = b"\r\n\r\n"
_MAXIMUM_CONTENT_BYTES = 1024 * 1024
_MAXIMUM_HEADER_BYTES = 8 * 1024
_MAXIMUM_PENDING_REQUESTS = 64
_MAXIMUM_SAFE_INTEGER = (1 << 53) - 1
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
    """One persistent connection with serialized writes and ID-correlated responses."""

    def __init__(self) -> None:
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._write_lock = asyncio.Lock()
        self._next_request_id = 1
        self._pending_responses: dict[int, asyncio.Future[Mapping[str, object]]] = {}
        self._response_reader_task: asyncio.Task[None] | None = None
        self._cancelled_response_drain_tasks: set[asyncio.Task[None]] = set()

    async def connect(self, socket_path: str) -> None:
        if self._writer is not None:
            _raise_transport_error(
                "already-connected",
                "Gateway runtime UDS transport is already connected.",
            )
        self._reader, self._writer = await asyncio.open_unix_connection(socket_path)
        self._response_reader_task = asyncio.create_task(self._read_responses())

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
        request_id: int | None = None
        response_future: asyncio.Future[Mapping[str, object]] | None = None
        try:
            async with self._write_lock:
                writer = self._writer
                if self._reader is None or writer is None:
                    _raise_transport_error(
                        "not-connected",
                        "Gateway runtime UDS transport is not connected.",
                    )
                if len(self._pending_responses) >= _MAXIMUM_PENDING_REQUESTS:
                    _raise_transport_error(
                        "pending-request-limit-exceeded",
                        "Gateway runtime pending request limit was reached.",
                    )
                request_id = self._allocate_request_id()
                frame = _encode_frame(
                    {
                        "id": request_id,
                        "jsonrpc": "2.0",
                        "method": method,
                        "params": dict(params),
                    },
                )
                response_future = asyncio.get_running_loop().create_future()
                self._pending_responses[request_id] = response_future
                await self._write_request_frame(
                    frame=frame,
                    request_id=request_id,
                    response_future=response_future,
                    writer=writer,
                )
            response = await asyncio.shield(response_future)
        except asyncio.CancelledError:
            if request_id is not None and response_future is not None and not response_future.done():
                try:
                    await asyncio.shield(self._send_cancellation(request_id))
                except Exception:
                    await self._close_connection()
                    raise
                drain_task = asyncio.create_task(
                    self._discard_cancelled_response(
                        response_future=response_future,
                    ),
                )
                self._cancelled_response_drain_tasks.add(drain_task)
                drain_task.add_done_callback(self._cancelled_response_drain_tasks.discard)
            raise
        except BaseException:
            if request_id is not None and response_future is not None:
                if self._pending_responses.get(request_id) is response_future:
                    del self._pending_responses[request_id]
                if not response_future.done():
                    response_future.cancel()
            raise

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
                        t.cast("Mapping[str, object]", error_data) if isinstance(error_data, dict) and all(isinstance(key, str) for key in error_data) else None
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

    def _allocate_request_id(self) -> int:
        if self._next_request_id > _MAXIMUM_SAFE_INTEGER:
            _raise_transport_error(
                "request-id-exhausted",
                "Gateway runtime request id space is exhausted.",
            )
        request_id = self._next_request_id
        self._next_request_id += 1
        return request_id

    async def _write_request_frame(
        self,
        *,
        frame: bytes,
        request_id: int,
        response_future: asyncio.Future[Mapping[str, object]],
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            writer.write(frame)
            await writer.drain()
        except Exception as error:
            write_error = GatewayRuntimeUdsTransportError(
                "request-write-failed",
                "Gateway runtime request write failed.",
            )
            if self._pending_responses.get(request_id) is response_future:
                del self._pending_responses[request_id]
            response_future.cancel()
            await self._close_connection(pending_error=write_error)
            raise write_error from error

    async def _send_cancellation(self, request_id: int) -> None:
        async with self._write_lock:
            writer = self._writer
            if writer is None:
                return
            writer.write(
                _encode_frame(
                    {
                        "jsonrpc": "2.0",
                        "method": "notifications/cancelled",
                        "params": {"requestId": request_id},
                    },
                ),
            )
            await writer.drain()

    async def _read_responses(self) -> None:
        reader = self._reader
        if reader is None:
            return
        try:
            while self._reader is reader:
                response = await _read_frame(reader)
                response_id = response.get("id")
                if type(response_id) is not int or not 1 <= response_id <= _MAXIMUM_SAFE_INTEGER:
                    _raise_transport_error(
                        "unexpected-response",
                        "Gateway runtime response id does not match a pending request.",
                    )
                response_future = self._pending_responses.pop(response_id, None)
                if response_future is None:
                    _raise_transport_error(
                        "unexpected-response",
                        "Gateway runtime response id does not match a pending request.",
                    )
                if not response_future.done():
                    response_future.set_result(response)
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            self._fail_pending_responses(error)
            await self._close_connection(cancel_response_reader=False)

    def _fail_pending_responses(self, error: BaseException) -> None:
        pending_responses = tuple(self._pending_responses.values())
        self._pending_responses.clear()
        for response_future in pending_responses:
            if not response_future.done():
                response_future.set_exception(error)

    async def _discard_cancelled_response(
        self,
        *,
        response_future: asyncio.Future[Mapping[str, object]],
    ) -> None:
        try:
            async with asyncio.timeout(_CANCELLED_RESPONSE_DRAIN_SECONDS):
                _ = await asyncio.shield(response_future)
        except BaseException:
            await self._close_connection()

    async def _close_connection(
        self,
        *,
        cancel_response_reader: bool = True,
        pending_error: BaseException | None = None,
    ) -> None:
        writer = self._writer
        self._reader = None
        self._writer = None
        response_reader_task = self._response_reader_task
        self._response_reader_task = None
        if cancel_response_reader and response_reader_task is not None and response_reader_task is not asyncio.current_task():
            response_reader_task.cancel()
            _ = await asyncio.gather(response_reader_task, return_exceptions=True)
        self._fail_pending_responses(
            pending_error
            if pending_error is not None
            else GatewayRuntimeUdsTransportError(
                "not-connected",
                "Gateway runtime UDS transport is not connected.",
            ),
        )
        if writer is not None:
            writer.close()
            with contextlib.suppress(ConnectionError, OSError):
                await writer.wait_closed()

    async def disconnect(self) -> None:
        await self._close_connection()
        drain_tasks = tuple(self._cancelled_response_drain_tasks)
        if drain_tasks:
            _ = await asyncio.gather(*drain_tasks, return_exceptions=True)
