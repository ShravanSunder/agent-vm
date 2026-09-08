"""Guest-local message router, with no provider or managed authority access."""

import asyncio
import typing as t
from contextlib import suppress
from pathlib import Path

from .portal_relay_protocol import (
    MAX_RELAY_MESSAGE_BYTES,
    MAX_RELAY_PENDING_REQUESTS,
    MAX_RELAY_TRANSFER_BYTES,
    RELAY_CONTROL_RESERVE_BYTES,
    PortalRelayDecoder,
    PortalRelayProtocolError,
    encode_relay_frame,
    relay_response_reservation_bytes,
)

_MAX_CONNECTIONS = 16
_MAX_OUTGOING_BYTES = 64 * 1024 * 1024
_MAX_OUTGOING_FRAMES = 1024


class _GuestPeer:
    def __init__(self, writer: asyncio.StreamWriter) -> None:
        self.writer = writer
        self.write_lock = asyncio.Lock()
        self.initialized = False
        self.requests: dict[str, str | None] = {}

    async def send(self, message: dict[str, object]) -> None:
        frame = encode_relay_frame(message)
        await self.send_frame(frame)

    async def send_frame(self, frame: bytes) -> None:
        async with self.write_lock:
            self.writer.write(frame)
            await self.writer.drain()


class GuestPortalRelay:
    def __init__(
        self,
        *,
        socket_path: str,
        send_to_host: t.Callable[[dict[str, object]], t.Awaitable[None]],
    ) -> None:
        self._socket_path = socket_path
        self._send_to_host = send_to_host
        self._server: asyncio.Server | None = None
        self._peers: set[_GuestPeer] = set()
        self._tasks: set[asyncio.Task[None]] = set()
        self._requests: dict[str, tuple[_GuestPeer, str, int]] = {}
        self._waiting: dict[tuple[_GuestPeer, str], dict[str, object]] = {}
        self._next_id = 0
        self._closed = False
        self._outgoing_bytes = 0
        self._outgoing: dict[asyncio.Task[None], _GuestPeer] = {}
        self._admission_lock = asyncio.Lock()
        self._admission_task: asyncio.Task[None] | None = None
        self._failure_close_task: asyncio.Task[None] | None = None
        self._host_credit_requests = 0
        self._host_credit_bytes = 0
        self._sent_request_bytes = 0
        self._received_host_bytes = 0
        self._sent_control_bytes = 0

    async def start(self) -> None:
        if self._server is not None or self._closed:
            raise RuntimeError("Guest relay was already started or closed.")
        self._server = await asyncio.start_unix_server(self._accept, path=self._socket_path)
        await asyncio.to_thread(Path(self._socket_path).chmod, 0o600)

    def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self._closed or len(self._peers) >= _MAX_CONNECTIONS:
            writer.close()
            return
        peer = _GuestPeer(writer)
        self._peers.add(peer)
        task = asyncio.create_task(self._serve_peer(reader, peer))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _serve_peer(self, reader: asyncio.StreamReader, peer: _GuestPeer) -> None:
        decoder = PortalRelayDecoder()
        try:
            while not self._closed and (data := await reader.read(65_536)):
                for message in decoder.feed(data):
                    await self._receive_peer(peer, message)
        except (ConnectionError, PortalRelayProtocolError):
            pass
        finally:
            self._peers.discard(peer)
            cancellations = list(peer.requests.items())
            for guest_id, request_id in cancellations:
                if request_id is None:
                    self._waiting.pop((peer, guest_id), None)
                else:
                    self._requests.pop(request_id, None)
                    if not self._closed:
                        await self._send_control({"kind": "cancel", "requestId": request_id})
            peer.requests.clear()
            for task, destination in tuple(self._outgoing.items()):
                if destination is peer:
                    task.cancel()
            peer.writer.transport.abort()
            with suppress(ConnectionError):
                await peer.writer.wait_closed()

    async def _receive_peer(self, peer: _GuestPeer, message: dict[str, object]) -> None:
        if not peer.initialized:
            if message["kind"] != "hello":
                raise PortalRelayProtocolError("Guest must negotiate before Portal requests.")
            peer.initialized = True
            await peer.send(
                {
                    "kind": "ready",
                    "version": 1,
                    "maxMessageBytes": MAX_RELAY_MESSAGE_BYTES,
                    "maxPendingRequests": MAX_RELAY_PENDING_REQUESTS,
                },
            )
            return
        kind = message["kind"]
        request_id = message.get("requestId")
        if not isinstance(request_id, str):
            raise PortalRelayProtocolError("Guest request has no identity.")
        if kind == "cancel":
            if request_id not in peer.requests:
                return
            host_id = peer.requests[request_id]
            if host_id is None:
                peer.requests.pop(request_id)
                self._waiting.pop((peer, request_id), None)
                self._queue_response(
                    peer,
                    {"kind": "error", "requestId": request_id, "code": "cancelled", "dispatch": "not-dispatched"},
                )
            else:
                await self._send_control({"kind": "cancel", "requestId": host_id})
            return
        if kind != "request" or request_id in peer.requests:
            raise PortalRelayProtocolError("Invalid or duplicate guest request.")
        if len(self._requests) + len(self._waiting) >= MAX_RELAY_PENDING_REQUESTS:
            await peer.send({"kind": "error", "requestId": request_id, "code": "pending-request-limit-exceeded", "dispatch": "not-dispatched"})
            return
        peer.requests[request_id] = None
        self._waiting[(peer, request_id)] = message
        self._schedule_waiting_drain()

    def _schedule_waiting_drain(self) -> None:
        if self._closed or (self._admission_task is not None and not self._admission_task.done()):
            return
        self._admission_task = asyncio.create_task(self._drain_waiting_requests())
        self._admission_task.add_done_callback(self._waiting_drain_finished)

    def _waiting_drain_finished(self, task: asyncio.Task[None]) -> None:
        if self._admission_task is task:
            self._admission_task = None
        if task.cancelled() or task.exception() is None or self._closed:
            return
        if self._failure_close_task is None:
            self._failure_close_task = asyncio.create_task(self.close())

    async def _drain_waiting_requests(self) -> None:
        async with self._admission_lock:
            while self._waiting:
                selected: tuple[tuple[_GuestPeer, str], dict[str, object], bytes, int] | None = None
                rejected_impossible_request = False
                for key, message in tuple(self._waiting.items()):
                    forwarded = {**message, "requestId": str(self._next_id + 1)}
                    frame = encode_relay_frame(forwarded)
                    reservation = relay_response_reservation_bytes(forwarded)
                    required_credit = max(len(frame), reservation)
                    pending_reservations = sum(item[2] for item in self._requests.values())
                    request_capacity = MAX_RELAY_TRANSFER_BYTES - RELAY_CONTROL_RESERVE_BYTES - self._sent_request_bytes
                    response_capacity = MAX_RELAY_TRANSFER_BYTES - RELAY_CONTROL_RESERVE_BYTES - self._received_host_bytes - pending_reservations
                    maximum_future_response_capacity = MAX_RELAY_TRANSFER_BYTES - RELAY_CONTROL_RESERVE_BYTES - self._received_host_bytes
                    if len(frame) > request_capacity or reservation > maximum_future_response_capacity:
                        peer, guest_id = key
                        self._waiting.pop(key)
                        peer.requests.pop(guest_id, None)
                        self._queue_response(
                            peer,
                            {
                                "kind": "error",
                                "requestId": guest_id,
                                "code": "relay-credit-exhausted",
                                "dispatch": "not-dispatched",
                            },
                        )
                        rejected_impossible_request = True
                        break
                    if self._host_credit_requests <= 0:
                        continue
                    if required_credit <= self._host_credit_bytes and len(frame) <= request_capacity and reservation <= response_capacity:
                        selected = key, forwarded, frame, reservation
                        break
                if rejected_impossible_request:
                    continue
                if selected is None:
                    return
                (peer, guest_id), forwarded, frame, reservation = selected
                self._waiting.pop((peer, guest_id))
                self._next_id += 1
                host_id = str(forwarded["requestId"])
                peer.requests[guest_id] = host_id
                self._requests[host_id] = (peer, guest_id, reservation)
                self._host_credit_requests -= 1
                self._host_credit_bytes -= max(len(frame), reservation)
                self._sent_request_bytes += len(frame)
                await self._send_to_host(forwarded)

    async def _send_control(self, message: dict[str, object]) -> None:
        frame = encode_relay_frame(message)
        if self._sent_control_bytes + len(frame) > RELAY_CONTROL_RESERVE_BYTES:
            raise PortalRelayProtocolError("Guest relay control capacity exceeded.")
        self._sent_control_bytes += len(frame)
        await self._send_to_host(message)

    async def receive_from_host(self, message: dict[str, object]) -> None:
        # Apply the same strict schema when called directly by an embedding host.
        host_frame = encode_relay_frame(message)
        if self._closed:
            return
        self._received_host_bytes += len(host_frame)
        if message["kind"] == "close":
            await self.close()
            return
        if message["kind"] == "credit":
            requests = message["requests"]
            byte_capacity = message["bytes"]
            if not isinstance(requests, int) or not isinstance(byte_capacity, int):
                raise PortalRelayProtocolError("Host credit is malformed.")
            self._host_credit_requests = requests
            self._host_credit_bytes = byte_capacity
            self._schedule_waiting_drain()
            return
        host_id = message.get("requestId")
        if not isinstance(host_id, str):
            raise PortalRelayProtocolError("Host response has no identity.")
        binding = self._requests.get(host_id)
        if binding is None:
            # A disconnected peer has no remaining recipient; never reassign it.
            return
        if message["kind"] not in {"result", "error", "artifact-chunk", "artifact-end"}:
            raise PortalRelayProtocolError("Invalid host response kind.")
        peer, guest_id, reservation = binding
        self._requests[host_id] = (peer, guest_id, max(0, reservation - len(host_frame)))
        self._queue_response(peer, {**message, "requestId": guest_id})
        if message["kind"] != "artifact-chunk":
            self._requests.pop(host_id, None)
            peer.requests.pop(guest_id, None)

    def _queue_response(self, peer: _GuestPeer, message: dict[str, object]) -> None:
        frame = encode_relay_frame(message)
        if self._outgoing_bytes + len(frame) > _MAX_OUTGOING_BYTES or len(self._outgoing) >= _MAX_OUTGOING_FRAMES:
            peer.writer.transport.abort()
            raise PortalRelayProtocolError("Guest relay response capacity exceeded.")
        self._outgoing_bytes += len(frame)

        async def deliver() -> None:
            await peer.send_frame(frame)

        task = asyncio.create_task(deliver())
        self._outgoing[task] = peer

        def finished(completed: asyncio.Task[None]) -> None:
            self._outgoing.pop(completed, None)
            self._outgoing_bytes -= len(frame)
            if not completed.cancelled() and completed.exception() is not None:
                peer.writer.transport.abort()

        task.add_done_callback(finished)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        tasks = (*self._tasks, *self._outgoing)
        if self._admission_task is not None:
            tasks = (*tasks, self._admission_task)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._requests.clear()
        self._waiting.clear()
