import asyncio
import typing as t
from collections.abc import Mapping

import agent_vm_agent_portal_sdk.portal_bridge_connection as connection_module
import pytest
from agent_vm_agent_portal_sdk.portal_bridge_connection import PortalBridgeConnection
from agent_vm_agent_portal_sdk.portal_execution_bridge import PortalExecutionBridge
from agent_vm_agent_portal_sdk.portal_relay_protocol import PortalRelayDecoder, encode_relay_frame
from pydantic import BaseModel


@pytest.mark.parametrize("startup_bytes", [b"", b"invalid-header\r\n\r\n"])
def test_helper_failure_before_ready_reports_actionable_error(startup_bytes: bytes) -> None:
    async def scenario() -> None:
        closed: list[bool] = []

        class Process:
            async def read(self) -> bytes:
                return startup_bytes

            async def write(self, content: bytes) -> None:
                del content
                raise AssertionError("A failed helper cannot accept Portal work.")

            async def close(self) -> None:
                closed.append(True)

        async def invoke(_operation: str, _request: Mapping[str, object]) -> BaseModel:
            raise AssertionError("No Portal call is admitted before readiness.")

        connection = PortalBridgeConnection(process=Process(), bridge=PortalExecutionBridge(invoke=invoke))
        pump = asyncio.create_task(connection.run())
        try:
            with pytest.raises(connection_module.PortalRelayProtocolError, match="before readiness"):
                await connection.wait_ready()
        finally:
            await asyncio.gather(pump, return_exceptions=True)
        assert closed == [True]

    asyncio.run(scenario())


def test_cancellation_in_same_chunk_prevents_not_yet_scheduled_request() -> None:
    async def scenario() -> None:
        effects: list[str] = []
        frames = b"".join(
            encode_relay_frame(message)
            for message in [
                {"kind": "ready", "version": 1, "maxMessageBytes": 1048576, "maxPendingRequests": 16},
                {"kind": "request", "requestId": "one", "operation": "list", "request": {"requests": [{"id": "list"}]}},
                {"kind": "cancel", "requestId": "one"},
            ]
        )

        class Process:
            def __init__(self) -> None:
                self.first = True

            async def read(self) -> bytes:
                if self.first:
                    self.first = False
                    return frames
                ready = asyncio.Event()
                asyncio.get_running_loop().call_soon(ready.set)
                await ready.wait()
                second_turn = asyncio.Event()
                asyncio.get_running_loop().call_soon(second_turn.set)
                await second_turn.wait()
                return b""

            async def write(self, content: bytes) -> None:
                pass

            async def close(self) -> None:
                pass

        async def invoke(operation: str, request: Mapping[str, object]) -> BaseModel:
            effects.append(operation)
            raise RuntimeError("Should never dispatch cancelled request")

        connection = PortalBridgeConnection(process=Process(), bridge=PortalExecutionBridge(invoke=invoke))
        await connection.run()
        assert effects == []

    asyncio.run(scenario())


def test_failed_response_write_closes_process_and_wakes_reader() -> None:
    async def scenario() -> None:
        closed = asyncio.Event()
        frames = b"".join(
            encode_relay_frame(message)
            for message in [
                {"kind": "ready", "version": 1, "maxMessageBytes": 1048576, "maxPendingRequests": 16},
                {"kind": "request", "requestId": "one", "operation": "list", "request": {}},
            ]
        )

        class Process:
            def __init__(self) -> None:
                self.first = True

            async def read(self) -> bytes:
                if self.first:
                    self.first = False
                    return frames
                await closed.wait()
                return b""

            async def write(self, content: bytes) -> None:
                assert content
                raise ConnectionError("write failed")

            async def close(self) -> None:
                closed.set()

        async def invoke(operation: str, request: Mapping[str, object]) -> BaseModel:
            raise AssertionError("Malformed request should be rejected")

        connection = PortalBridgeConnection(process=Process(), bridge=PortalExecutionBridge(invoke=invoke))
        await asyncio.wait_for(connection.run(), timeout=2)
        assert closed.is_set()

    asyncio.run(scenario())


def test_output_budget_exhaustion_rejects_before_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(connection_module, "_TOTAL_TRANSFER_BYTES", 65_536)

    async def scenario() -> None:
        effects: list[str] = []
        output: list[dict[str, object]] = []
        decoder = PortalRelayDecoder()

        class Process:
            def __init__(self) -> None:
                self.first = True

            async def read(self) -> bytes:
                if not self.first:
                    return b""
                self.first = False
                return encode_relay_frame({"kind": "ready", "version": 1, "maxMessageBytes": 1048576, "maxPendingRequests": 16}) + encode_relay_frame(
                    {"kind": "request", "requestId": "one", "operation": "list", "request": {"requests": [{"id": "list"}]}},
                )

            async def write(self, content: bytes) -> None:
                output.extend(decoder.feed(content))

            async def close(self) -> None:
                pass

        async def invoke(operation: str, request: Mapping[str, object]) -> BaseModel:
            effects.append(operation)
            raise AssertionError("Must reject before dispatch")

        await connection_module.PortalBridgeConnection(process=Process(), bridge=PortalExecutionBridge(invoke=invoke)).run()
        assert effects == []
        error = next(message for message in output if message["kind"] == "error")
        assert error["dispatch"] == "not-dispatched"

    asyncio.run(scenario())


def test_request_traffic_cannot_consume_reserved_control_capacity(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(connection_module, "_TOTAL_TRANSFER_BYTES", 9000)

    async def scenario() -> None:
        effects: list[str] = []
        output: list[dict[str, object]] = []
        decoder = PortalRelayDecoder()

        class Process:
            def __init__(self) -> None:
                self.first = True

            async def read(self) -> bytes:
                if not self.first:
                    return b""
                self.first = False
                return encode_relay_frame({"kind": "ready", "version": 1, "maxMessageBytes": 1048576, "maxPendingRequests": 16}) + encode_relay_frame(
                    {"kind": "request", "requestId": "one", "operation": "list", "request": {"padding": "x" * 1000}},
                )

            async def write(self, content: bytes) -> None:
                output.extend(decoder.feed(content))

            async def close(self) -> None:
                pass

        async def invoke(operation: str, request: Mapping[str, object]) -> BaseModel:
            effects.append(operation)
            raise AssertionError("Request traffic in the control reserve must not dispatch.")

        await PortalBridgeConnection(process=Process(), bridge=PortalExecutionBridge(invoke=invoke)).run()
        assert effects == []
        error = next(message for message in output if message["kind"] == "error")
        assert error == {
            "kind": "error",
            "requestId": "one",
            "code": "relay-credit-exhausted",
            "dispatch": "not-dispatched",
        }

    asyncio.run(scenario())


def test_host_advertises_credit_after_ready_and_request_completion() -> None:
    async def scenario() -> None:
        request_finished = asyncio.Event()
        output: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        decoder = PortalRelayDecoder()
        input_frames: asyncio.Queue[bytes] = asyncio.Queue()
        await input_frames.put(encode_relay_frame({"kind": "ready", "version": 1, "maxMessageBytes": 1048576, "maxPendingRequests": 16}))

        class Process:
            async def read(self) -> bytes:
                return await input_frames.get()

            async def write(self, content: bytes) -> None:
                for message in decoder.feed(content):
                    await output.put(message)

            async def close(self) -> None:
                await input_frames.put(b"")

        async def invoke(operation: str, request: Mapping[str, object]) -> BaseModel:
            await request_finished.wait()
            result = connection_module.PORTABLE_CONTRACT_ADAPTERS["portal.list.result"].validate_python(
                {"ok": True, "items": [{"id": "list", "status": "ok", "value": {"namespaces": [], "namespaceDiscovery": [], "tools": []}}]},
            )
            assert isinstance(result, BaseModel)
            return result

        connection = PortalBridgeConnection(process=Process(), bridge=PortalExecutionBridge(invoke=invoke))
        pump = asyncio.create_task(connection.run())
        try:
            initial_credit = await asyncio.wait_for(output.get(), timeout=2)
            assert initial_credit["kind"] == "credit"
            assert initial_credit["requests"] == 16
            initial_bytes = initial_credit["bytes"]
            assert isinstance(initial_bytes, int)
            assert 0 < initial_bytes < 64 * 1024 * 1024

            await input_frames.put(
                encode_relay_frame({"kind": "request", "requestId": "one", "operation": "list", "request": {"requests": [{"id": "list"}]}}),
            )
            reduced_credit = await asyncio.wait_for(output.get(), timeout=2)
            assert reduced_credit["kind"] == "credit"
            assert reduced_credit["requests"] == 15
            reduced_bytes = reduced_credit["bytes"]
            assert isinstance(reduced_bytes, int)
            assert reduced_bytes < initial_bytes

            request_finished.set()
            result = await asyncio.wait_for(output.get(), timeout=2)
            assert result["kind"] == "result"
            replenished_credit = await asyncio.wait_for(output.get(), timeout=2)
            assert replenished_credit["kind"] == "credit"
            assert replenished_credit["requests"] == 16
            replenished_bytes = replenished_credit["bytes"]
            assert isinstance(replenished_bytes, int)
            assert replenished_bytes > reduced_bytes
        finally:
            await connection.close()
            await asyncio.gather(pump, return_exceptions=True)

    asyncio.run(scenario())


def test_artifact_stream_does_not_request_an_aggregate_result() -> None:
    async def scenario() -> None:
        finished = asyncio.Event()
        output: list[dict[str, object]] = []
        decoder = PortalRelayDecoder()
        reference = {"id": "artifact", "byteLength": 3, "expiresAt": "2030-01-01T00:00:00.000Z", "fingerprint": f"sha256:{'a' * 64}"}

        class Process:
            def __init__(self) -> None:
                self.first = True

            async def read(self) -> bytes:
                if self.first:
                    self.first = False
                    return encode_relay_frame({"kind": "ready", "version": 1, "maxMessageBytes": 1048576, "maxPendingRequests": 16}) + encode_relay_frame(
                        {
                            "kind": "request",
                            "requestId": "one",
                            "operation": "artifact-read",
                            "request": {"reference": reference, "maxBytes": 3, "offsetBytes": 0},
                        },
                    )
                await finished.wait()
                return b""

            async def write(self, content: bytes) -> None:
                output.extend(decoder.feed(content))
                if output[-1]["kind"] == "artifact-end":
                    finished.set()

            async def close(self) -> None:
                finished.set()

        async def invoke(operation: str, request: Mapping[str, object]) -> BaseModel:
            raise AssertionError("Artifact streaming must not aggregate through invoke")

        async def stream(request: Mapping[str, object], send: t.Callable[[dict[str, object]], t.Awaitable[None]]) -> None:
            assert request["maxBytes"] == 3
            await send({"kind": "artifact-chunk", "reference": reference, "offsetBytes": 0, "contentBase64": "YWJj"})
            await send({"kind": "artifact-end", "reference": reference, "offsetBytes": 0, "byteLength": 3, "truncated": False})

        connection = PortalBridgeConnection(process=Process(), bridge=PortalExecutionBridge(invoke=invoke), stream_artifact=stream)
        await asyncio.wait_for(connection.run(), timeout=2)
        artifact_output = [item for item in output if item["kind"] in {"artifact-chunk", "artifact-end"}]
        assert [item["kind"] for item in artifact_output] == ["artifact-chunk", "artifact-end"]
        assert all(item["requestId"] == "one" for item in artifact_output)

    asyncio.run(scenario())
