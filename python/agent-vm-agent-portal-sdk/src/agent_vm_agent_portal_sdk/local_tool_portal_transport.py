"""Invocation-local Portal transport; never attaches to the trusted Gateway UDS."""

import asyncio
import os
import typing as t
from collections.abc import Mapping
from pathlib import PurePosixPath

from .artifact_read_resource_uri import PORTAL_ARTIFACT_READ_REQUEST_META_KEY, create_portal_artifact_read_resource_request
from .portal_artifact_assembly import PortalArtifactAssembly
from .portal_relay_protocol import MAX_RELAY_MESSAGE_BYTES, PortalRelayDecoder, PortalRelayProtocolError, encode_relay_frame

TOOL_PORTAL_SOCKET_ENV = "AGENT_VM_TOOL_PORTAL_SOCKET"
_PORTAL_OPERATIONS = {
    "tool_portal_list": "list",
    "tool_portal_search": "search",
    "tool_portal_describe": "describe",
    "tool_portal_call": "call",
}


class PortalConnectionUnavailableError(ConnectionError):
    """No active managed Portal interface is available in this execution."""


class PortalRelayCallError(RuntimeError):
    def __init__(self, *, code: str, dispatch: str) -> None:
        super().__init__(f"Portal relay request failed ({code}); dispatch={dispatch}.")
        self.code = code
        self.dispatch = dispatch


class LocalToolPortalTransport:
    def __init__(self, *, socket_path: str) -> None:
        if not PurePosixPath(socket_path).is_absolute() or "\0" in socket_path:
            raise PortalConnectionUnavailableError("Managed Portal socket must be an absolute guest path.")
        self._socket_path = socket_path
        self._writer: asyncio.StreamWriter | None = None
        self._read_task: asyncio.Task[None] | None = None
        self._ready: asyncio.Future[None] | None = None
        self._pending: dict[str, asyncio.Future[Mapping[str, object]]] = {}
        self._write_lock = asyncio.Lock()
        self._next_id = 0
        self._max_pending = 16
        self._max_message_bytes = MAX_RELAY_MESSAGE_BYTES
        self._closed = False
        self._assemblies: dict[str, PortalArtifactAssembly] = {}

    @classmethod
    def from_environment(cls) -> t.Self:
        socket_path = os.environ.get(TOOL_PORTAL_SOCKET_ENV)
        if not socket_path:
            raise PortalConnectionUnavailableError("No managed Tool Portal connection context; run inside an active managed execution.")
        return cls(socket_path=socket_path)

    async def connect(self) -> None:
        if self._closed or self._writer is not None:
            raise PortalConnectionUnavailableError("Portal transport is already connected or closed.")
        try:
            async with asyncio.timeout(5):
                reader, self._writer = await asyncio.open_unix_connection(self._socket_path)
                self._ready = asyncio.get_running_loop().create_future()
                self._read_task = asyncio.create_task(self._read_responses(reader))
                await self._send({"kind": "hello", "version": 1})
                await self._ready
        except BaseException as error:
            await self.close()
            if isinstance(error, (OSError, PortalRelayProtocolError)):
                raise PortalConnectionUnavailableError(
                    "Managed Tool Portal is unavailable; run inside an active managed execution with a matching relay.",
                ) from error
            raise

    async def _send(self, message: Mapping[str, object]) -> None:
        frame = encode_relay_frame(message)
        if len(frame) - frame.index(b"\r\n\r\n") - 4 > self._max_message_bytes:
            raise PortalRelayProtocolError("Relay frame exceeds negotiated limit.")
        async with self._write_lock:
            writer = self._writer
            if self._closed or writer is None:
                raise PortalConnectionUnavailableError("Portal execution connection is closed.")
            writer.write(frame)
            await writer.drain()

    async def _read_responses(self, reader: asyncio.StreamReader) -> None:
        decoder = PortalRelayDecoder()
        try:
            while data := await reader.read(65_536):
                for message in decoder.feed(data):
                    self._receive(message)
            raise PortalConnectionUnavailableError("Portal connection ended; outstanding effects may be uncertain.")
        except (Exception, asyncio.CancelledError) as error:
            if self._ready is not None and not self._ready.done():
                self._ready.set_exception(PortalConnectionUnavailableError("Portal handshake did not complete."))
            for pending in self._pending.values():
                if not pending.done():
                    pending.set_exception(PortalConnectionUnavailableError("Portal connection lost; outstanding effects may be uncertain."))
            self._pending.clear()
            self._assemblies.clear()
            self._closed = True
            if self._writer is not None:
                self._writer.close()
            if isinstance(error, asyncio.CancelledError):
                raise

    def _receive(self, message: Mapping[str, object]) -> None:
        if message["kind"] == "ready":
            if self._ready is None or self._ready.done():
                raise PortalRelayProtocolError("Unexpected Portal ready frame.")
            maximum_pending = message["maxPendingRequests"]
            maximum_bytes = message["maxMessageBytes"]
            if not isinstance(maximum_pending, int) or not isinstance(maximum_bytes, int):
                raise PortalRelayProtocolError("Invalid negotiated Portal limits.")
            self._max_pending = maximum_pending
            self._max_message_bytes = maximum_bytes
            self._ready.set_result(None)
            return
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or request_id not in self._pending:
            raise PortalRelayProtocolError("Unexpected Portal response identity.")
        pending = self._pending[request_id]
        if pending.done():
            if message["kind"] in {"result", "error", "artifact-end"}:
                self._pending.pop(request_id)
                self._assemblies.pop(request_id, None)
            return
        if message["kind"] in {"artifact-chunk", "artifact-end"}:
            self._receive_artifact(request_id, message)
            return
        if message["kind"] == "error":
            pending.set_exception(PortalRelayCallError(code=str(message["code"]), dispatch=str(message["dispatch"])))
        elif message["kind"] == "result":
            result = message["result"]
            if not isinstance(result, dict):
                raise PortalRelayProtocolError("Portal result must be an object.")
            pending.set_result(t.cast("dict[str, object]", result))
        else:
            raise PortalRelayProtocolError("Unexpected Portal response frame.")
        self._pending.pop(request_id)
        self._assemblies.pop(request_id, None)

    def _receive_artifact(self, request_id: str, message: Mapping[str, object]) -> None:
        assembly = self._assemblies.get(request_id)
        if assembly is None:
            raise PortalRelayProtocolError("Unexpected artifact response.")
        reference = message["reference"]
        offset = message["offsetBytes"]
        if not isinstance(reference, dict) or not isinstance(offset, int):
            raise PortalRelayProtocolError("Malformed artifact response.")
        artifact_reference = t.cast("dict[str, object]", reference)
        if message["kind"] == "artifact-chunk":
            assembly.append(reference=artifact_reference, offset_bytes=offset, content_base64=str(message["contentBase64"]))
            return
        byte_length = message["byteLength"]
        truncated = message["truncated"]
        media_type = message.get("mediaType")
        if not isinstance(byte_length, int) or not isinstance(truncated, bool) or (media_type is not None and not isinstance(media_type, str)):
            raise PortalRelayProtocolError("Malformed artifact end.")
        assembled = assembly.finish(reference=artifact_reference, offset_bytes=offset, byte_length=byte_length, truncated=truncated, media_type=media_type)
        self._assemblies.pop(request_id)
        self._pending.pop(request_id).set_result(assembled)

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, object],
        *,
        metadata: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]:
        operation = _PORTAL_OPERATIONS.get(name)
        if operation is None:
            raise ValueError("Only Portal capability operations are available.")
        if metadata:
            raise ValueError("Managed Portal metadata cannot carry standalone approval authority.")
        return {"structuredContent": await self._request(operation, arguments)}

    async def _request(
        self,
        operation: str,
        arguments: Mapping[str, object],
        assembly: PortalArtifactAssembly | None = None,
    ) -> Mapping[str, object]:
        if self._ready is None or not self._ready.done() or self._closed:
            raise PortalConnectionUnavailableError("Portal handshake must complete before calls.")
        if len(self._pending) >= self._max_pending:
            raise PortalRelayCallError(code="pending-request-limit-exceeded", dispatch="not-dispatched")
        self._next_id += 1
        request_id = str(self._next_id)
        result = asyncio.get_running_loop().create_future()
        self._pending[request_id] = result
        if assembly is not None:
            if self._assemblies:
                self._pending.pop(request_id)
                raise PortalRelayCallError(code="artifact-assembly-limit", dispatch="not-dispatched")
            self._assemblies[request_id] = assembly
        try:
            await self._send({"kind": "request", "requestId": request_id, "operation": operation, "request": dict(arguments)})
            return await asyncio.shield(result)
        except asyncio.CancelledError:
            result.cancel()
            await self._send({"kind": "cancel", "requestId": request_id})
            raise
        except BaseException:
            self._pending.pop(request_id, None)
            self._assemblies.pop(request_id, None)
            result.cancel()
            raise

    async def read_resource(self, request: Mapping[str, object]) -> Mapping[str, object]:
        metadata = request.get("_meta")
        if not isinstance(metadata, dict):
            raise PortalRelayProtocolError("Portal artifact request is missing metadata.")
        public_request = metadata.get(PORTAL_ARTIFACT_READ_REQUEST_META_KEY)
        if not isinstance(public_request, dict):
            raise PortalRelayProtocolError("Portal artifact request is missing its range.")
        public_mapping = t.cast("dict[str, object]", public_request)
        if dict(request) != create_portal_artifact_read_resource_request(public_mapping):
            raise PortalRelayProtocolError("Portal artifact URI and metadata do not match.")
        reference = public_mapping["reference"]
        offset = public_mapping.get("offsetBytes", 0)
        maximum = public_mapping["maxBytes"]
        if not isinstance(reference, dict) or not isinstance(offset, int) or not isinstance(maximum, int):
            raise PortalRelayProtocolError("Portal artifact range is malformed.")
        assembly = PortalArtifactAssembly(reference=t.cast("dict[str, object]", reference), offset_bytes=offset, max_bytes=maximum)
        result = await self._request("artifact-read", public_mapping, assembly)
        return {"contents": [{"uri": request["uri"], "mimeType": result.get("mediaType", "application/octet-stream"), "blob": result["contentBase64"]}]}

    async def close(self) -> None:
        self._closed = True
        if self._writer is not None:
            self._writer.close()
            await self._writer.wait_closed()
        if self._read_task is not None:
            self._read_task.cancel()
            await asyncio.gather(self._read_task, return_exceptions=True)
