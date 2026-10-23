"""Host-only installed-wheel journey, invoked by the permanent Vitest host test."""

import asyncio
import importlib.metadata
import json
import os
import sys

import httpx
from agent_vm_agent_portal_sdk.standard_mcp_transport import (
    StandardMcpToolPortalTransport,
    ToolPortalStdioMcpConfig,
    ToolPortalStreamableHttpMcpConfig,
)
from agent_vm_agent_portal_sdk.tool_portal_mcp_client import ToolPortalMcpClient
from anyio import Path
from pydantic import BaseModel, Field, SecretStr


class HostReady(BaseModel):
    control_url: str = Field(alias="controlUrl")
    endpoint: str | None = None
    child_pid: int = Field(alias="childPid")


class PortalItem(BaseModel):
    status: str
    value: object = None
    artifacts: list[dict[str, object]] = Field(default_factory=list)
    outcome: dict[str, object] = Field(default_factory=dict)


class PortalResult(BaseModel):
    ok: bool
    items: list[PortalItem]


class WireObservation(BaseModel):
    method: str
    meta: dict[str, object] | None = None
    headers: dict[str, object] | None = None


class HostSnapshot(BaseModel):
    effects: list[dict[str, object]]
    observations: list[WireObservation]


class ApprovalToken(BaseModel):
    token: str


class ArtifactResult(BaseModel):
    content_base64: str = Field(alias="contentBase64")
    media_type: str = Field(alias="mediaType")
    offset_bytes: int = Field(alias="offsetBytes")
    truncated: bool


def call_request(*, name: str, call_id: str, value: int) -> dict[str, object]:
    return {"calls": [{"id": call_id, "namespace": "example", "name": name, "arguments": {"value": value}}]}


def parsed_result(result: BaseModel) -> PortalResult:
    return PortalResult.model_validate(result.model_dump(by_alias=True, mode="json"))


async def run_journey() -> None:
    mode, node_path, node_loader, node_host_path, receipt_name = sys.argv[1:]
    receipt_path = Path(receipt_name)
    child: asyncio.subprocess.Process | None = None
    host_arguments = ("--import", node_loader, node_host_path, mode, str(receipt_path))
    if mode == "http":
        child = await asyncio.create_subprocess_exec(node_path, *host_arguments, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        assert child.stderr is not None
        while True:
            line = await asyncio.wait_for(child.stderr.readline(), timeout=30)
            sys.stderr.buffer.write(line)
            if not line:
                message = "Node host exited before readiness."
                raise RuntimeError(message)
            if line.startswith(b"PYTHON_MCP_HOST_READY "):
                break
        ready = HostReady.model_validate_json(await receipt_path.read_text())
        assert ready.endpoint is not None
        transport = StandardMcpToolPortalTransport(ToolPortalStreamableHttpMcpConfig(endpoint=ready.endpoint, authorization=SecretStr("credential-agent-a")))
    else:
        transport = StandardMcpToolPortalTransport(
            ToolPortalStdioMcpConfig(
                executable=node_path,
                arguments=host_arguments,
                environment={"PATH": os.environ["PATH"], "TSX_TSCONFIG_PATH": os.environ["TSX_TSCONFIG_PATH"]},
            ),
        )
    client = ToolPortalMcpClient(transport=transport)
    try:
        await client.connect()
        listing = parsed_result(await client.list({"requests": [{"id": "listing"}]}))
        assert listing.ok
    except BaseException:
        await client.close()
        if child is not None and child.returncode is None:
            child.terminate()
            await child.wait()
        raise
    # A real discovery operation also establishes that the scoped stdio child is ready.
    ready = HostReady.model_validate_json(await receipt_path.read_text())
    async with httpx.AsyncClient(base_url=ready.control_url, timeout=30) as control:

        async def control_call(operation: str) -> httpx.Response:
            response = await control.post(operation)
            response.raise_for_status()
            return response

        async def snapshot() -> HostSnapshot:
            return HostSnapshot.model_validate_json((await control_call("/snapshot")).content)

        async def effects_count(expected: int) -> None:
            assert len((await snapshot()).effects) == expected

        async def invoke(name: str, call_id: str, value: int) -> PortalResult:
            return parsed_result(await client.call(call_request(name=name, call_id=call_id, value=value)))

        try:
            # No token, changed arguments and a changed protected set each dispatch zero leaves.
            protected = {
                "calls": [
                    {"id": "ask-a", "namespace": "example", "name": "ask", "arguments": {"value": 7}},
                    {"id": "ask-b", "namespace": "example", "name": "ask", "arguments": {"value": 8}},
                ],
            }
            missing = parsed_result(await client.call(protected))
            assert [item.status for item in missing.items] == ["approval_required", "approval_required"]
            await effects_count(0)
            token = ApprovalToken.model_validate_json((await control_call("/token")).content).token
            mismatch = parsed_result(await client.call(call_request(name="ask", call_id="ask-a", value=999), approval_token=token))
            assert not mismatch.ok
            await effects_count(0)
            changed_set = parsed_result(await client.call(call_request(name="ask", call_id="ask-a", value=7), approval_token=token))
            assert not changed_set.ok
            await effects_count(0)
            approved = parsed_result(await client.call(protected, approval_token=token))
            assert approved.ok
            assert [item.status for item in approved.items] == ["ok", "ok"]
            assert "python-wheel" in json.dumps([item.value for item in approved.items])
            await effects_count(2)
            replay = parsed_result(await client.call(protected, approval_token=token))
            assert not replay.ok
            assert all(item.outcome.get("retryClass") == "forbidden" for item in replay.items)
            await effects_count(2)

            binary = await invoke("binary", "binary", 9)
            assert binary.ok
            reference = binary.items[0].artifacts[0]
            artifact = ArtifactResult.model_validate(
                (await client.artifacts.read({"reference": reference, "maxBytes": 8, "offsetBytes": 0})).model_dump(by_alias=True),
            )
            assert artifact.content_base64 == "AP8KDX9BQkM="
            assert artifact.media_type == "application/octet-stream"
            assert artifact.truncated is False
            partial = ArtifactResult.model_validate(
                (await client.artifacts.read({"reference": reference, "maxBytes": 2, "offsetBytes": 2})).model_dump(by_alias=True),
            )
            assert partial.content_base64 == "Cg0="
            assert partial.offset_bytes == 2
            assert partial.truncated is True
            await effects_count(3)

            # Wait for the real provider's entered event; cancellation is not rollback.
            await control_call("/hold")
            cancelled = asyncio.create_task(client.call(call_request(name="read", call_id="cancelled", value=10)))
            await control_call("/entered")
            cancelled.cancel()
            try:
                await cancelled
            except asyncio.CancelledError:
                pass
            else:
                message = "The cancelled local call unexpectedly resolved."
                raise AssertionError(message)
            await effects_count(4)
            assert (await invoke("read", "before-late-response", 11)).ok
            await effects_count(5)
            await control_call("/release")
            await control_call("/settled")
            assert (await invoke("read", "after-late-response", 12)).ok
            await effects_count(6)
            observed = await snapshot()
            assert_wire_observations(observed, mode=mode)
            print(
                json.dumps(
                    {
                        "mode": mode,
                        "effects": observed.effects,
                        "observations": [entry.model_dump() for entry in observed.observations],
                        "mcpVersion": importlib.metadata.version("mcp"),
                        "httpx2Version": importlib.metadata.version("httpx2"),
                        "childPid": ready.child_pid,
                    },
                ),
                flush=True,
            )
        finally:
            await control_call("/release")
            await client.close()
            await client.close()
            if mode == "http":
                await control_call("/shutdown")
    await assert_child_closed(child, ready.child_pid)
    assert await receipt_path.with_name(f"{receipt_path.name}.closed").is_file()


def assert_wire_observations(observed: HostSnapshot, *, mode: str) -> None:
    assert not any(entry.method == "initialize" for entry in observed.observations)
    for entry in observed.observations:
        if entry.method not in {"tools/call", "resources/read"}:
            continue
        assert entry.meta is not None
        assert entry.meta["io.modelcontextprotocol/protocolVersion"] == "2026-07-28"
        assert "io.modelcontextprotocol/clientInfo" in entry.meta
        if mode == "http":
            assert entry.headers is not None
            assert entry.headers["authorization"] == "Bearer credential-agent-a"
            assert entry.headers["mcp-protocol-version"] == "2026-07-28"
            assert entry.headers["mcp-method"] == entry.method
    assert any(entry.meta is not None and "agent-vm/tool-portal-approval-token" in entry.meta for entry in observed.observations)
    assert len([entry for entry in observed.observations if entry.method == "resources/read"]) == 2
    assert all(entry.meta is not None and "agent-vm/artifact-read-request" in entry.meta for entry in observed.observations if entry.method == "resources/read")
    assert len([entry for entry in observed.observations if entry.method == "tools/call"]) == 10


async def assert_child_closed(child: asyncio.subprocess.Process | None, child_pid: int) -> None:
    if child is not None:
        assert await asyncio.wait_for(child.wait(), timeout=30) == 0
        return
    try:
        os.kill(child_pid, 0)
    except ProcessLookupError:
        return
    message = "Client.close() left its stdio child alive."
    raise AssertionError(message)


async def main() -> None:
    async with asyncio.timeout(45):
        await run_journey()


if __name__ == "__main__":
    asyncio.run(main())
