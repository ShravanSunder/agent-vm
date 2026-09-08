import asyncio
import typing as t
from tempfile import TemporaryDirectory

import pytest
from agent_vm_agent_portal_sdk import connect_tool_portal
from agent_vm_agent_portal_sdk.local_tool_portal_transport import LocalToolPortalTransport, PortalConnectionUnavailableError
from agent_vm_agent_portal_sdk.portal_relay_protocol import PortalRelayDecoder, encode_relay_frame
from agent_vm_agent_portal_sdk.tool_portal_mcp_client import ToolPortalMcpClient


def test_missing_managed_socket_never_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENT_VM_TOOL_PORTAL_SOCKET", raising=False)
    with pytest.raises(PortalConnectionUnavailableError):
        LocalToolPortalTransport.from_environment()


@pytest.mark.parametrize("failure", [ConnectionRefusedError(), FileNotFoundError(), TimeoutError()])
def test_unavailable_socket_has_public_connection_error(monkeypatch: pytest.MonkeyPatch, failure: OSError) -> None:
    async def unavailable_socket(_path: str) -> t.NoReturn:
        raise failure

    monkeypatch.setattr(asyncio, "open_unix_connection", unavailable_socket)

    async def scenario() -> None:
        transport = LocalToolPortalTransport(socket_path="/expired-invocation.sock")
        with pytest.raises(PortalConnectionUnavailableError, match="active managed execution"):
            await transport.connect()
        with pytest.raises(PortalConnectionUnavailableError, match="closed"):
            await transport.connect()

    asyncio.run(scenario())


def test_automatic_client_requires_execution_context(monkeypatch: pytest.MonkeyPatch) -> None:
    # Existing isolation tests reload package modules; resolve the current error class.
    from agent_vm_agent_portal_sdk.local_tool_portal_transport import PortalConnectionUnavailableError as CurrentConnectionError

    monkeypatch.delenv("AGENT_VM_TOOL_PORTAL_SOCKET", raising=False)
    with pytest.raises(CurrentConnectionError):
        connect_tool_portal()


def test_real_socket_correlates_reversed_responses() -> None:
    async def scenario(socket_path: str) -> None:
        server_finished = asyncio.Event()

        async def server_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            decoder = PortalRelayDecoder()
            requests: list[dict[str, object]] = []
            try:
                while data := await reader.read(65_536):
                    for message in decoder.feed(data):
                        if message["kind"] == "hello":
                            writer.write(encode_relay_frame({"kind": "ready", "version": 1, "maxMessageBytes": 1048576, "maxPendingRequests": 16}))
                            await writer.drain()
                        elif message["kind"] == "request":
                            requests.append(message)
                            if len(requests) == 2:
                                for request in reversed(requests):
                                    writer.write(
                                        encode_relay_frame({"kind": "result", "requestId": request["requestId"], "result": {"received": request["operation"]}}),
                                    )
                                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
                server_finished.set()

        server = await asyncio.start_unix_server(server_client, path=socket_path)
        transport = LocalToolPortalTransport(socket_path=socket_path)
        try:
            await transport.connect()
            results = await asyncio.gather(transport.call_tool("tool_portal_list", {}), transport.call_tool("tool_portal_search", {}))
            assert results == [{"structuredContent": {"received": "list"}}, {"structuredContent": {"received": "search"}}]
        finally:
            await transport.close()
            server.close()
            await server.wait_closed()
            await asyncio.wait_for(server_finished.wait(), timeout=2)

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as socket_directory:
        asyncio.run(scenario(f"{socket_directory}/portal.sock"))


@pytest.mark.parametrize("name", ["approval.decide", "sandbox.process.start", "provider_search"])
def test_transport_rejects_non_portal_names_before_connection(name: str) -> None:
    async def scenario() -> None:
        transport = LocalToolPortalTransport(socket_path="/unused.sock")
        with pytest.raises(ValueError, match="Portal"):
            await transport.call_tool(name, {})

    asyncio.run(scenario())


def test_managed_transport_rejects_standalone_approval_metadata() -> None:
    async def scenario() -> None:
        transport = LocalToolPortalTransport(socket_path="/unused.sock")
        metadata: t.Mapping[str, object] = {"agent-vm/tool-portal-approval-token": "forged"}
        with pytest.raises(ValueError, match="metadata"):
            await transport.call_tool("tool_portal_call", {}, metadata=metadata)

    asyncio.run(scenario())


def test_disconnect_reports_uncertainty_without_replaying_request() -> None:
    async def scenario(socket_path: str) -> None:
        received: list[str] = []
        finished = asyncio.Event()

        async def server_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            decoder = PortalRelayDecoder()
            try:
                while data := await reader.read(65_536):
                    for message in decoder.feed(data):
                        if message["kind"] == "hello":
                            writer.write(encode_relay_frame({"kind": "ready", "version": 1, "maxMessageBytes": 1048576, "maxPendingRequests": 16}))
                            await writer.drain()
                        elif message["kind"] == "request":
                            received.append(str(message["requestId"]))
                            return
            finally:
                writer.close()
                await writer.wait_closed()
                finished.set()

        server = await asyncio.start_unix_server(server_client, path=socket_path)
        transport = LocalToolPortalTransport(socket_path=socket_path)
        try:
            await transport.connect()
            with pytest.raises(PortalConnectionUnavailableError, match="uncertain"):
                await asyncio.wait_for(transport.call_tool("tool_portal_call", {}), timeout=2)
            assert received == ["1"]
        finally:
            await transport.close()
            server.close()
            await server.wait_closed()
            await asyncio.wait_for(finished.wait(), timeout=2)

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as socket_directory:
        asyncio.run(scenario(f"{socket_directory}/portal.sock"))


def test_existing_client_reads_chunked_artifact_over_local_socket() -> None:
    async def scenario(socket_path: str) -> None:
        reference: dict[str, object] = {"id": "proof", "byteLength": 3, "expiresAt": "2030-01-01T00:00:00.000Z", "fingerprint": f"sha256:{'a' * 64}"}
        finished = asyncio.Event()

        async def server_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            decoder = PortalRelayDecoder()
            try:
                while data := await reader.read(65_536):
                    for message in decoder.feed(data):
                        if message["kind"] == "hello":
                            writer.write(encode_relay_frame({"kind": "ready", "version": 1, "maxMessageBytes": 1048576, "maxPendingRequests": 16}))
                        elif message["kind"] == "request":
                            assert message["operation"] == "artifact-read"
                            writer.write(
                                encode_relay_frame(
                                    {
                                        "kind": "artifact-chunk",
                                        "requestId": message["requestId"],
                                        "reference": reference,
                                        "offsetBytes": 0,
                                        "contentBase64": "YWJj",
                                    },
                                ),
                            )
                            writer.write(
                                encode_relay_frame(
                                    {
                                        "kind": "artifact-end",
                                        "requestId": message["requestId"],
                                        "reference": reference,
                                        "offsetBytes": 0,
                                        "byteLength": 3,
                                        "truncated": False,
                                    },
                                ),
                            )
                        await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
                finished.set()

        server = await asyncio.start_unix_server(server_client, path=socket_path)
        try:
            async with ToolPortalMcpClient(transport=LocalToolPortalTransport(socket_path=socket_path)) as client:
                result = await client.artifacts.read({"reference": reference, "maxBytes": 3, "offsetBytes": 0})
                assert result.model_dump(by_alias=True)["contentBase64"] == "YWJj"
        finally:
            server.close()
            await server.wait_closed()
            await asyncio.wait_for(finished.wait(), timeout=2)

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as socket_directory:
        asyncio.run(scenario(f"{socket_directory}/portal.sock"))
