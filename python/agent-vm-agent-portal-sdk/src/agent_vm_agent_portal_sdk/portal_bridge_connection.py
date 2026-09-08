"""Pump one guest relay process through trusted Portal callbacks."""

import asyncio
import typing as t
from collections.abc import Mapping

from pydantic import BaseModel, ValidationError

from .contracts import PORTABLE_CONTRACT_ADAPTERS
from .portal_execution_bridge import PortalExecutionBridge
from .portal_relay_protocol import (
    MAX_RELAY_PENDING_REQUESTS,
    MAX_RELAY_TRANSFER_BYTES,
    RELAY_CONTROL_RESERVE_BYTES,
    RELAY_STREAM_CHUNK_BYTES,
    PortalRelayDecoder,
    PortalRelayProtocolError,
    encode_relay_frame,
    relay_response_reservation_bytes,
)

_MAX_CHUNK_BYTES = RELAY_STREAM_CHUNK_BYTES
_MAX_PENDING_REQUESTS = MAX_RELAY_PENDING_REQUESTS
_TOTAL_TRANSFER_BYTES = MAX_RELAY_TRANSFER_BYTES
_CONTROL_RESERVE_BYTES = RELAY_CONTROL_RESERVE_BYTES
type StreamPortalArtifact = t.Callable[[Mapping[str, object], t.Callable[[dict[str, object]], t.Awaitable[None]]], t.Awaitable[None]]


class PortalRelayProcessPort(t.Protocol):
    async def read(self) -> bytes: ...

    async def write(self, content: bytes) -> None: ...

    async def close(self) -> None: ...


class PortalBridgeConnection:
    def __init__(self, *, process: PortalRelayProcessPort, bridge: PortalExecutionBridge, stream_artifact: StreamPortalArtifact | None = None) -> None:
        self._process = process
        self._bridge = bridge
        self._stream_artifact = stream_artifact
        self._artifact_request_id: str | None = None
        self._write_lock = asyncio.Lock()
        self._requests: set[asyncio.Task[None]] = set()
        self._credit_updates: set[asyncio.Task[None]] = set()
        self._requests_by_id: dict[str, asyncio.Task[None]] = {}
        self._started_ids: set[str] = set()
        self._ready = asyncio.get_running_loop().create_future()
        self._closed = False
        self._cleanup_task: asyncio.Task[None] | None = None
        self._sent_bytes = 0
        self._received_bytes = 0
        self._reservations: dict[str, int] = {}

    async def wait_ready(self) -> None:
        async with asyncio.timeout(5):
            await asyncio.shield(self._ready)

    async def _send(self, message: dict[str, object]) -> None:
        frame = encode_relay_frame(message)
        async with self._write_lock:
            if self._closed:
                raise PortalRelayProtocolError("Portal bridge connection closed.")
            if self._sent_bytes + len(frame) > _TOTAL_TRANSFER_BYTES:
                raise PortalRelayProtocolError("Portal response transfer budget exhausted.")
            request_id = message.get("requestId")
            if isinstance(request_id, str) and request_id in self._reservations:
                if len(frame) > self._reservations[request_id]:
                    raise PortalRelayProtocolError("Portal response exceeded reserved capacity.")
                self._reservations[request_id] -= len(frame)
            self._sent_bytes += len(frame)
            for offset in range(0, len(frame), _MAX_CHUNK_BYTES):
                await self._process.write(frame[offset : offset + _MAX_CHUNK_BYTES])

    async def _respond(self, message: dict[str, object]) -> None:
        self._started_ids.add(str(message["requestId"]))
        if message.get("operation") == "artifact-read":
            await self._respond_artifact(message)
            return
        await self._send(await self._bridge.execute(message))

    def _available_credit(self, *, next_credit_frame_bytes: int = 0) -> tuple[int, int]:
        requests = max(0, _MAX_PENDING_REQUESTS - len(self._requests))
        request_bytes = max(0, _TOTAL_TRANSFER_BYTES - _CONTROL_RESERVE_BYTES - self._received_bytes)
        response_bytes = max(
            0,
            _TOTAL_TRANSFER_BYTES - _CONTROL_RESERVE_BYTES - self._sent_bytes - sum(self._reservations.values()) - next_credit_frame_bytes,
        )
        return requests, min(request_bytes, response_bytes)

    async def _advertise_credit(self) -> None:
        if self._closed or not self._ready.done():
            return
        frame_bytes = 0
        message: dict[str, object] = {"kind": "credit", "requests": 0, "bytes": 0}
        for _iteration in range(3):
            requests, byte_capacity = self._available_credit(next_credit_frame_bytes=frame_bytes)
            message = {"kind": "credit", "requests": requests, "bytes": byte_capacity}
            updated_frame_bytes = len(encode_relay_frame(message))
            if updated_frame_bytes == frame_bytes:
                break
            frame_bytes = updated_frame_bytes
        await self._send(message)

    def _schedule_credit_update(self) -> None:
        if self._closed:
            return
        task = asyncio.create_task(self._advertise_credit())
        self._credit_updates.add(task)
        task.add_done_callback(self._credit_update_finished)

    def _credit_update_finished(self, task: asyncio.Task[None]) -> None:
        self._credit_updates.discard(task)
        if task.cancelled() or task.exception() is None:
            return
        self._bridge.close()
        self._closed = True
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._close_once())

    async def _respond_artifact(self, message: dict[str, object]) -> None:
        request_id = str(message["requestId"])
        try:
            validated = PORTABLE_CONTRACT_ADAPTERS["portal.artifact.read-request"].validate_python(message["request"])
            if not isinstance(validated, BaseModel):
                raise TypeError("Artifact request is not a typed model.")
        except (ValidationError, TypeError):
            await self._send({"kind": "error", "requestId": request_id, "code": "invalid-request", "dispatch": "not-dispatched"})
            return
        stream = self._stream_artifact
        if stream is None:
            await self._send({"kind": "error", "requestId": request_id, "code": "artifact-stream-unavailable", "dispatch": "not-dispatched"})
            return

        async def send(frame: dict[str, object]) -> None:
            await self._send({**frame, "requestId": request_id})

        request: dict[str, object] = validated.model_dump(by_alias=True, mode="json", exclude_none=True)
        try:
            await self._bridge.scope.admit(lambda: stream(request, send))
        except (Exception, asyncio.CancelledError):
            if not self._closed:
                await self._send({"kind": "error", "requestId": request_id, "code": "artifact-read-interrupted", "dispatch": "uncertain"})

    def _request_finished(self, task: asyncio.Task[None]) -> None:
        self._requests.discard(task)
        for request_id, registered in tuple(self._requests_by_id.items()):
            if registered is task:
                self._requests_by_id.pop(request_id)
                self._started_ids.discard(request_id)
                self._reservations.pop(request_id, None)
                if self._artifact_request_id == request_id:
                    self._artifact_request_id = None
        if not task.cancelled() and task.exception() is not None:
            self._bridge.close()
            self._closed = True
            if self._cleanup_task is None:
                self._cleanup_task = asyncio.create_task(self._close_once())
        else:
            self._schedule_credit_update()

    async def run(self) -> None:
        decoder = PortalRelayDecoder()
        try:
            while not self._closed and (chunk := await self._process.read()):
                self._received_bytes += len(chunk)
                if self._received_bytes > _TOTAL_TRANSFER_BYTES:
                    raise PortalRelayProtocolError("Portal request transfer budget exhausted.")
                for message in decoder.feed(chunk):
                    await self._receive(message)
            self._fail_readiness_if_pending()
        except (ConnectionError, PortalRelayProtocolError):
            self._fail_readiness_if_pending()
        except Exception:
            self._fail_readiness_if_pending()
            raise
        finally:
            await self.close()

    def _fail_readiness_if_pending(self) -> None:
        if self._closed or self._ready.done():
            return
        self._ready.set_exception(
            PortalRelayProtocolError("Tool Portal helper stopped before readiness; check its installation and protocol version."),
        )
        # Embeddings may drive the pump without a readiness waiter; awaiting still raises this error.
        self._ready.exception()

    async def _receive(self, message: dict[str, object]) -> None:
        if message["kind"] == "ready":
            if self._ready.done():
                raise PortalRelayProtocolError("Duplicate guest relay readiness.")
            self._ready.set_result(None)
            await self._advertise_credit()
        elif message["kind"] == "request":
            await self._receive_request(message)
        elif message["kind"] == "cancel":
            request_id = str(message["requestId"])
            registered = self._requests_by_id.get(request_id)
            if registered is not None and request_id not in self._started_ids:
                registered.cancel()
                await self._send({"kind": "error", "requestId": request_id, "code": "cancelled", "dispatch": "not-dispatched"})
            else:
                self._bridge.cancel(request_id)
                if registered is not None and request_id == self._artifact_request_id:
                    registered.cancel()
        else:
            raise PortalRelayProtocolError("Invalid guest relay direction.")

    async def _receive_request(self, message: dict[str, object]) -> None:
        if not self._ready.done():
            raise PortalRelayProtocolError("Guest requested before readiness.")
        request_id = str(message["requestId"])
        if request_id in self._requests_by_id:
            raise PortalRelayProtocolError("Duplicate relay request identity.")
        if self._received_bytes > _TOTAL_TRANSFER_BYTES - _CONTROL_RESERVE_BYTES:
            await self._send(
                {"kind": "error", "requestId": request_id, "code": "relay-credit-exhausted", "dispatch": "not-dispatched"},
            )
            return
        reservation = relay_response_reservation_bytes(message)
        artifact_busy = message.get("operation") == "artifact-read" and self._artifact_request_id is not None
        if (
            artifact_busy
            or len(self._requests) >= _MAX_PENDING_REQUESTS
            or self._sent_bytes + sum(self._reservations.values()) + reservation > _TOTAL_TRANSFER_BYTES - _CONTROL_RESERVE_BYTES
        ):
            await self._send({"kind": "error", "requestId": message["requestId"], "code": "pending-request-limit-exceeded", "dispatch": "not-dispatched"})
            return
        self._reservations[request_id] = reservation
        if message.get("operation") == "artifact-read":
            self._artifact_request_id = request_id
        task = asyncio.create_task(self._respond(message))
        self._requests.add(task)
        self._requests_by_id[request_id] = task
        task.add_done_callback(self._request_finished)
        await self._advertise_credit()

    async def close(self) -> None:
        self._closed = True
        self._bridge.close()
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._close_once())
        await asyncio.shield(self._cleanup_task)

    async def _close_once(self) -> None:
        self._closed = True
        self._bridge.close()
        if not self._ready.done():
            self._ready.cancel()
        tasks = (*self._requests, *self._credit_updates)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self._process.close()
