"""Real local sockets join guest clients, relay, bridge, and trusted Portal callbacks."""

import asyncio
import typing as t
from collections.abc import Mapping
from tempfile import TemporaryDirectory

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from agent_vm_agent_portal_sdk.guest_portal_relay import GuestPortalRelay
from agent_vm_agent_portal_sdk.local_tool_portal_transport import LocalToolPortalTransport
from agent_vm_agent_portal_sdk.portal_bridge_connection import PortalBridgeConnection
from agent_vm_agent_portal_sdk.portal_execution_bridge import PortalExecutionBridge
from agent_vm_agent_portal_sdk.portal_relay_protocol import PortalRelayDecoder, encode_relay_frame
from pydantic import BaseModel


def test_sequential_composition_reuses_capacity_and_preserves_request_identity() -> None:
    async def scenario(socket_path: str) -> None:
        request_bytes = 0
        response_bytes = 0
        forwarded_ids: set[str] = set()
        input_chunks: asyncio.Queue[bytes] = asyncio.Queue(maxsize=16)
        output_decoder = PortalRelayDecoder()
        slow_started = asyncio.Event()
        slow_cancelled = asyncio.Event()

        async def send_to_host(message: dict[str, object]) -> None:
            nonlocal request_bytes
            frame = encode_relay_frame(message)
            request_bytes += len(frame)
            for offset in range(0, len(frame), 65_536):
                await input_chunks.put(frame[offset : offset + 65_536])

        relay = GuestPortalRelay(socket_path=socket_path, send_to_host=send_to_host)

        class Process:
            async def read(self) -> bytes:
                return await input_chunks.get()

            async def write(self, content: bytes) -> None:
                nonlocal response_bytes
                response_bytes += len(content)
                for message in output_decoder.feed(content):
                    await relay.receive_from_host(message)

            async def close(self) -> None:
                await relay.close()
                await input_chunks.put(b"")

        async def invoke(_operation: str, request: Mapping[str, object]) -> BaseModel:
            call = t.cast("list[dict[str, object]]", request["calls"])[0]
            arguments = t.cast("dict[str, object]", call["arguments"])
            forwarded_id = t.cast("str", call["id"])
            assert forwarded_id not in forwarded_ids
            forwarded_ids.add(forwarded_id)
            if arguments.get("wait") is True:
                slow_started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    slow_cancelled.set()
            result = PORTABLE_CONTRACT_ADAPTERS["portal.call.result"].validate_python(
                {
                    "ok": True,
                    "items": [
                        {
                            "id": forwarded_id,
                            "status": "ok",
                            "operationId": forwarded_id,
                            "owningGeneration": "generation",
                            "outcome": {"kind": "completed", "certainty": "proven", "completion": "succeeded", "retryClass": "forbidden"},
                            "value": arguments,
                        },
                    ],
                },
            )
            assert isinstance(result, BaseModel)
            return result

        bridge = PortalBridgeConnection(process=Process(), bridge=PortalExecutionBridge(invoke=invoke))
        await relay.start()
        await send_to_host({"kind": "ready", "version": 1, "maxMessageBytes": 1_048_576, "maxPendingRequests": 16})
        pump = asyncio.create_task(bridge.run())
        first = LocalToolPortalTransport(socket_path=socket_path)
        second = LocalToolPortalTransport(socket_path=socket_path)
        payload = ["x" * 65_536, "y" * 65_536]
        request = {"calls": [{"id": "call-1", "namespace": "fixture", "name": "echo", "arguments": {"payload": payload}}]}
        try:
            await bridge.wait_ready()
            await first.connect()
            await second.connect()
            # Retain one response at a time: traffic exceeds the former quota in
            # each direction while the actual live payload remains small.
            for index in range(520):
                client = first if index % 2 == 0 else second
                response = await client.call_tool("tool_portal_call", request)
                result = t.cast("dict[str, object]", response["structuredContent"])
                item = t.cast("list[dict[str, object]]", result["items"])[0]
                assert item["id"] == "call-1"
                assert item["value"] == {"payload": payload}
            assert request_bytes > 64 * 1024 * 1024
            assert response_bytes > 64 * 1024 * 1024
            assert len(forwarded_ids) == 520

            pending = asyncio.create_task(
                first.call_tool(
                    "tool_portal_call",
                    {
                        "calls": [{"id": "call-1", "namespace": "fixture", "name": "echo", "arguments": {"wait": True}}],
                    },
                ),
            )
            await slow_started.wait()
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            await asyncio.wait_for(slow_cancelled.wait(), timeout=2)
            following = await second.call_tool("tool_portal_call", request)
            assert t.cast("dict[str, object]", following["structuredContent"])["ok"] is True
        finally:
            await asyncio.gather(first.close(), second.close())
            await bridge.close()
            await asyncio.gather(pump, return_exceptions=True)

    with TemporaryDirectory(prefix="prb-composition-", dir="/tmp") as directory:
        asyncio.run(asyncio.wait_for(scenario(f"{directory}/portal.sock"), timeout=30))
