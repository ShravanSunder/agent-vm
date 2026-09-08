import asyncio
from tempfile import TemporaryDirectory

import agent_vm_agent_portal_sdk.guest_portal_relay as relay_module
import pytest
from agent_vm_agent_portal_sdk.guest_portal_relay import GuestPortalRelay
from agent_vm_agent_portal_sdk.local_tool_portal_transport import LocalToolPortalTransport
from agent_vm_agent_portal_sdk.portal_relay_protocol import PortalRelayDecoder, encode_relay_frame


def test_guest_relay_routes_each_response_to_its_originating_socket() -> None:
    async def scenario(socket_path: str) -> None:
        requests: asyncio.Queue[dict[str, object]] = asyncio.Queue()

        async def send(message: dict[str, object]) -> None:
            await requests.put(message)

        relay = GuestPortalRelay(socket_path=socket_path, send_to_host=send)
        await relay.start()
        await relay.receive_from_host({"kind": "credit", "requests": 16, "bytes": 64 * 1024 * 1024})
        first = LocalToolPortalTransport(socket_path=socket_path)
        second = LocalToolPortalTransport(socket_path=socket_path)
        try:
            await first.connect()
            await second.connect()
            first_call = asyncio.create_task(first.call_tool("tool_portal_list", {}))
            second_call = asyncio.create_task(second.call_tool("tool_portal_search", {}))
            observed = [await asyncio.wait_for(requests.get(), timeout=2) for _ in range(2)]
            assert observed[0]["requestId"] != observed[1]["requestId"]
            for request in reversed(observed):
                await relay.receive_from_host({"kind": "result", "requestId": request["requestId"], "result": {"operation": request["operation"]}})
            assert await first_call == {"structuredContent": {"operation": "list"}}
            assert await second_call == {"structuredContent": {"operation": "search"}}
        finally:
            await asyncio.gather(first.close(), second.close())
            await relay.close()

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as directory:
        asyncio.run(scenario(f"{directory}/portal.sock"))


def test_slow_guest_reader_does_not_block_another_socket() -> None:
    async def scenario(socket_path: str) -> None:
        requests: asyncio.Queue[dict[str, object]] = asyncio.Queue()

        async def send(message: dict[str, object]) -> None:
            await requests.put(message)

        relay = GuestPortalRelay(socket_path=socket_path, send_to_host=send)
        await relay.start()
        await relay.receive_from_host({"kind": "credit", "requests": 16, "bytes": 64 * 1024 * 1024})
        slow_reader, slow_writer = await asyncio.open_unix_connection(socket_path, limit=1024)
        fast = LocalToolPortalTransport(socket_path=socket_path)
        try:
            slow_writer.write(encode_relay_frame({"kind": "hello", "version": 1}))
            await slow_writer.drain()
            await slow_reader.read(1024)
            slow_writer.write(encode_relay_frame({"kind": "request", "requestId": "slow", "operation": "list", "request": {}}))
            await slow_writer.drain()
            slow_request = await asyncio.wait_for(requests.get(), timeout=2)
            await fast.connect()
            fast_call = asyncio.create_task(fast.call_tool("tool_portal_search", {}))
            fast_request = await asyncio.wait_for(requests.get(), timeout=2)
            await asyncio.wait_for(
                relay.receive_from_host({"kind": "result", "requestId": slow_request["requestId"], "result": {"large": "x" * 900_000}}),
                timeout=2,
            )
            await relay.receive_from_host({"kind": "result", "requestId": fast_request["requestId"], "result": {"fast": True}})
            assert await asyncio.wait_for(fast_call, timeout=2) == {"structuredContent": {"fast": True}}
        finally:
            slow_writer.close()
            await slow_writer.wait_closed()
            await fast.close()
            await relay.close()

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as directory:
        asyncio.run(scenario(f"{directory}/portal.sock"))


def test_guest_relay_waits_for_host_credit_and_cancel_still_progresses() -> None:
    async def scenario(socket_path: str) -> None:
        forwarded: asyncio.Queue[dict[str, object]] = asyncio.Queue()

        async def send(message: dict[str, object]) -> None:
            await forwarded.put(message)

        relay = GuestPortalRelay(socket_path=socket_path, send_to_host=send)
        await relay.start()
        reader, writer = await asyncio.open_unix_connection(socket_path)
        decoder = PortalRelayDecoder()
        try:
            writer.write(encode_relay_frame({"kind": "hello", "version": 1}))
            writer.write(encode_relay_frame({"kind": "request", "requestId": "waiting", "operation": "list", "request": {}}))
            writer.write(encode_relay_frame({"kind": "cancel", "requestId": "waiting"}))
            await writer.drain()
            received = decoder.feed(await asyncio.wait_for(reader.read(65_536), timeout=2))
            assert received.pop(0)["kind"] == "ready"
            if not received:
                received = decoder.feed(await asyncio.wait_for(reader.read(65_536), timeout=2))
            cancellation = received[0]
            assert cancellation == {
                "kind": "error",
                "requestId": "waiting",
                "code": "cancelled",
                "dispatch": "not-dispatched",
            }

            await asyncio.sleep(0)
            assert forwarded.empty()

            writer.write(encode_relay_frame({"kind": "request", "requestId": "admitted", "operation": "list", "request": {}}))
            await writer.drain()
            await relay.receive_from_host({"kind": "credit", "requests": 1, "bytes": 1})
            await asyncio.sleep(0)
            assert forwarded.empty()
            await relay.receive_from_host({"kind": "credit", "requests": 1, "bytes": 2 * 1024 * 1024})
            request = await asyncio.wait_for(forwarded.get(), timeout=2)
            assert request["kind"] == "request"
            assert request["requestId"] != "admitted"
        finally:
            writer.close()
            await writer.wait_closed()
            await relay.close()

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as directory:
        asyncio.run(scenario(f"{directory}/portal.sock"))


def test_guest_relay_does_not_forward_more_requests_than_advertised() -> None:
    async def scenario(socket_path: str) -> None:
        forwarded: asyncio.Queue[dict[str, object]] = asyncio.Queue()

        async def send(message: dict[str, object]) -> None:
            await forwarded.put(message)

        relay = GuestPortalRelay(socket_path=socket_path, send_to_host=send)
        await relay.start()
        first = LocalToolPortalTransport(socket_path=socket_path)
        second = LocalToolPortalTransport(socket_path=socket_path)
        await relay.receive_from_host({"kind": "credit", "requests": 1, "bytes": 2 * 1024 * 1024})
        try:
            await first.connect()
            await second.connect()
            first_call = asyncio.create_task(first.call_tool("tool_portal_list", {}))
            second_call = asyncio.create_task(second.call_tool("tool_portal_search", {}))
            admitted = await asyncio.wait_for(forwarded.get(), timeout=2)
            await asyncio.sleep(0)
            assert forwarded.empty()

            await relay.receive_from_host({"kind": "result", "requestId": admitted["requestId"], "result": {"first": True}})
            await relay.receive_from_host({"kind": "credit", "requests": 1, "bytes": 2 * 1024 * 1024})
            next_request = await asyncio.wait_for(forwarded.get(), timeout=2)
            await relay.receive_from_host({"kind": "result", "requestId": next_request["requestId"], "result": {"second": True}})
            assert (await first_call)["structuredContent"] in ({"first": True}, {"second": True})
            assert (await second_call)["structuredContent"] in ({"first": True}, {"second": True})
        finally:
            await asyncio.gather(first.close(), second.close())
            await relay.close()

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as directory:
        asyncio.run(scenario(f"{directory}/portal.sock"))


def test_guest_relay_bounds_requests_waiting_for_credit_at_sixteen() -> None:
    async def scenario(socket_path: str) -> None:
        async def send(_message: dict[str, object]) -> None:
            raise AssertionError("A request without host credit must not be forwarded.")

        relay = GuestPortalRelay(socket_path=socket_path, send_to_host=send)
        await relay.start()
        reader, writer = await asyncio.open_unix_connection(socket_path)
        decoder = PortalRelayDecoder()
        try:
            writer.write(encode_relay_frame({"kind": "hello", "version": 1}))
            await writer.drain()
            assert decoder.feed(await asyncio.wait_for(reader.read(65_536), timeout=2))[0]["kind"] == "ready"
            for sequence in range(17):
                writer.write(
                    encode_relay_frame(
                        {"kind": "request", "requestId": str(sequence), "operation": "list", "request": {}},
                    ),
                )
            await writer.drain()
            overload = decoder.feed(await asyncio.wait_for(reader.read(65_536), timeout=2))[0]
            assert overload == {
                "kind": "error",
                "requestId": "16",
                "code": "pending-request-limit-exceeded",
                "dispatch": "not-dispatched",
            }
        finally:
            writer.close()
            await writer.wait_closed()
            await relay.close()

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as directory:
        asyncio.run(scenario(f"{directory}/portal.sock"))


def test_credit_reader_progresses_while_guest_request_output_is_blocked() -> None:
    async def scenario(socket_path: str) -> None:
        forwarded: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        outbound_blocked = False
        blocked_send_started = asyncio.Event()
        release_outbound = asyncio.Event()

        async def send(message: dict[str, object]) -> None:
            if outbound_blocked:
                blocked_send_started.set()
                await release_outbound.wait()
            await forwarded.put(message)

        relay = GuestPortalRelay(socket_path=socket_path, send_to_host=send)
        await relay.start()
        first = LocalToolPortalTransport(socket_path=socket_path)
        second = LocalToolPortalTransport(socket_path=socket_path)
        await relay.receive_from_host({"kind": "credit", "requests": 1, "bytes": 2 * 1024 * 1024})
        try:
            await first.connect()
            await second.connect()
            first_call = asyncio.create_task(first.call_tool("tool_portal_list", {}))
            first_request = await asyncio.wait_for(forwarded.get(), timeout=2)

            outbound_blocked = True
            second_call = asyncio.create_task(second.call_tool("tool_portal_search", {}))
            credit_delivery = asyncio.create_task(relay.receive_from_host({"kind": "credit", "requests": 1, "bytes": 2 * 1024 * 1024}))
            await asyncio.wait_for(blocked_send_started.wait(), timeout=2)
            await asyncio.wait_for(asyncio.shield(credit_delivery), timeout=2)

            await relay.receive_from_host({"kind": "result", "requestId": first_request["requestId"], "result": {"first": True}})
            assert await asyncio.wait_for(first_call, timeout=2) == {"structuredContent": {"first": True}}
            release_outbound.set()
            second_request = await asyncio.wait_for(forwarded.get(), timeout=2)
            await relay.receive_from_host({"kind": "result", "requestId": second_request["requestId"], "result": {"second": True}})
            assert await asyncio.wait_for(second_call, timeout=2) == {"structuredContent": {"second": True}}
        finally:
            release_outbound.set()
            await asyncio.gather(first.close(), second.close())
            await relay.close()

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as directory:
        asyncio.run(scenario(f"{directory}/portal.sock"))


def test_request_that_cannot_fit_remaining_transfer_budget_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(relay_module, "MAX_RELAY_TRANSFER_BYTES", relay_module.RELAY_CONTROL_RESERVE_BYTES + 256)

    async def scenario(socket_path: str) -> None:
        async def send(_message: dict[str, object]) -> None:
            raise AssertionError("A permanently oversized request must not reach the host.")

        relay = GuestPortalRelay(socket_path=socket_path, send_to_host=send)
        await relay.start()
        reader, writer = await asyncio.open_unix_connection(socket_path)
        decoder = PortalRelayDecoder()
        try:
            writer.write(encode_relay_frame({"kind": "hello", "version": 1}))
            await writer.drain()
            assert decoder.feed(await asyncio.wait_for(reader.read(65_536), timeout=2))[0]["kind"] == "ready"
            writer.write(encode_relay_frame({"kind": "request", "requestId": "too-large", "operation": "list", "request": {}}))
            await writer.drain()
            error = decoder.feed(await asyncio.wait_for(reader.read(65_536), timeout=2))[0]
            assert error == {
                "kind": "error",
                "requestId": "too-large",
                "code": "relay-credit-exhausted",
                "dispatch": "not-dispatched",
            }
        finally:
            writer.close()
            await writer.wait_closed()
            await relay.close()

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as directory:
        asyncio.run(scenario(f"{directory}/portal.sock"))
