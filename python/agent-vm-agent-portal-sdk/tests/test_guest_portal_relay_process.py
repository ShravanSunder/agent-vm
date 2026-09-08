import asyncio
import sys
from collections.abc import Mapping
from tempfile import TemporaryDirectory

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from agent_vm_agent_portal_sdk.local_tool_portal_transport import LocalToolPortalTransport
from agent_vm_agent_portal_sdk.portal_bridge_connection import PortalBridgeConnection
from agent_vm_agent_portal_sdk.portal_execution_bridge import PortalExecutionBridge
from agent_vm_agent_portal_sdk.portal_relay_protocol import PortalRelayDecoder, encode_relay_frame
from agent_vm_agent_portal_sdk.tool_portal_mcp_client import ToolPortalMcpClient
from pydantic import BaseModel


def test_helper_process_carries_requests_on_stdout_and_results_on_stdin() -> None:
    async def scenario(socket_path: str) -> None:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "agent_vm_agent_portal_sdk.guest_portal_relay_process",
            "--socket",
            socket_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        decoder = PortalRelayDecoder()
        transport = LocalToolPortalTransport(socket_path=socket_path)
        try:
            ready = decoder.feed(await asyncio.wait_for(process.stdout.read(65_536), timeout=5))
            assert ready[0]["kind"] == "ready"
            await transport.connect()
            pending = asyncio.create_task(transport.call_tool("tool_portal_list", {}))
            try:
                await asyncio.wait_for(process.stdout.read(65_536), timeout=0.05)
            except TimeoutError:
                pass
            else:
                raise AssertionError("Guest helper forwarded a Portal request without host credit.")
            process.stdin.write(encode_relay_frame({"kind": "credit", "requests": 16, "bytes": 64 * 1024 * 1024}))
            await process.stdin.drain()
            requests = decoder.feed(await asyncio.wait_for(process.stdout.read(65_536), timeout=5))
            assert requests[0]["operation"] == "list"
            process.stdin.write(encode_relay_frame({"kind": "result", "requestId": requests[0]["requestId"], "result": {"proof": "via-process-streams"}}))
            await process.stdin.drain()
            assert await asyncio.wait_for(pending, timeout=5) == {"structuredContent": {"proof": "via-process-streams"}}
        finally:
            await transport.close()
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()
        assert process.returncode == 0

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as directory:
        asyncio.run(scenario(f"{directory}/p.sock"))


def test_sdk_guest_helper_and_trusted_bridge_complete_a_portal_discovery() -> None:
    async def scenario(socket_path: str) -> None:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "agent_vm_agent_portal_sdk.guest_portal_relay_process",
            "--socket",
            socket_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        stdin = process.stdin
        stdout = process.stdout

        class ProcessPort:
            async def read(self) -> bytes:
                return await stdout.read(65_536)

            async def write(self, content: bytes) -> None:
                stdin.write(content)
                await stdin.drain()

            async def close(self) -> None:
                stdin.close()

        observed: list[Mapping[str, object]] = []

        async def invoke(operation: str, request: Mapping[str, object]) -> BaseModel:
            assert operation == "list"
            observed.append(request)
            result = PORTABLE_CONTRACT_ADAPTERS["portal.list.result"].validate_python(
                {
                    "ok": True,
                    "items": [
                        {"id": "discover", "status": "ok", "value": {"namespaces": ["files"], "namespaceDiscovery": [{"namespace": "files"}], "tools": []}},
                    ],
                },
            )
            assert isinstance(result, BaseModel)
            return result

        connection = PortalBridgeConnection(process=ProcessPort(), bridge=PortalExecutionBridge(invoke=invoke))
        pump = asyncio.create_task(connection.run())
        try:
            await connection.wait_ready()
            async with ToolPortalMcpClient(transport=LocalToolPortalTransport(socket_path=socket_path)) as client:
                result = await asyncio.wait_for(client.list({"requests": [{"id": "discover", "namespaces": ["files"]}]}), timeout=5)
                assert result.model_dump()["ok"] is True
            assert len(observed) == 1
        finally:
            pump.cancel()
            await asyncio.gather(pump, return_exceptions=True)
            stdin.close()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()
        assert process.returncode == 0

    with TemporaryDirectory(prefix="prb-", dir="/tmp") as directory:
        asyncio.run(scenario(f"{directory}/p.sock"))
