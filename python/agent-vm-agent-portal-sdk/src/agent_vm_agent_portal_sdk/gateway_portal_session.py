"""Trusted managed embedding of the reusable guest Portal relay."""

import asyncio
import base64
import secrets
import shlex
import typing as t
from collections.abc import Mapping
from contextlib import suppress
from time import monotonic

from pydantic import BaseModel, ConfigDict, Field

from .gateway_approval_bridge import PresentApproval, execute_portal_call_with_approval
from .gateway_runtime_client import GatewayRuntimeClient
from .managed_relay_process_port import ManagedRelayProcessPort
from .portal_bridge_connection import PortalBridgeConnection
from .portal_execution_bridge import PortalExecutionBridge


class GatewayPortalSessionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    environment: dict[str, object]
    sandbox_context: dict[str, object]
    portal_context: dict[str, object]
    maximum_runtime_ms: int = Field(gt=0, le=86_400_000)


def _mapping(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise TypeError("Managed relay response must contain an object.")
    return t.cast("dict[str, object]", value)


class GatewayPortalSession:
    def __init__(self, *, client: GatewayRuntimeClient, config: GatewayPortalSessionConfig, present_approval: PresentApproval) -> None:
        self._client = client
        self._config = config
        self._present = present_approval
        self._bridge = PortalExecutionBridge(invoke=self._invoke, deadline_monotonic=monotonic() + config.maximum_runtime_ms / 1000)
        self._connection: PortalBridgeConnection | None = None
        self._pump: asyncio.Task[None] | None = None
        self._stderr: asyncio.Task[None] | None = None
        self._closed = False
        self._process: dict[str, object] | None = None
        self._cleanup_task: asyncio.Task[None] | None = None
        # Guest path, created exclusively by the helper; never a host temporary directory.
        self._directory = f"/tmp/agent-vm-portal-{secrets.token_hex(12)}"  # noqa: S108
        self.socket_path = f"{self._directory}/p.sock"

    async def open(self) -> None:
        if self._closed or self._connection is not None:
            raise RuntimeError("Portal invocation session was already opened or closed.")
        config = self._config
        command = f"exec python3 -m agent_vm_agent_portal_sdk.guest_portal_relay_process --socket {shlex.quote(self.socket_path)} --create-directory"
        started = await self._client.sandbox.process.start(
            {
                "environment": config.environment,
                "command": command,
                "cwd": "/work",
                "maxRuntimeMs": config.maximum_runtime_ms,
                "retainOutputBytes": 4 * 1024 * 1024,
                "ioProfile": "portal-relay",
            },
            trusted_context=config.sandbox_context,
        )
        result = started.model_dump(by_alias=True, mode="json", exclude_none=True)
        process = _mapping(result["process"])
        self._process = process
        try:
            await self._attach(process, result)
        except BaseException:
            await self.close()
            raise

    async def _attach(self, process: dict[str, object], result: dict[str, object]) -> None:
        config = self._config
        streams = result["streams"]
        if not isinstance(streams, list):
            raise TypeError("Managed relay process did not provide streams.")
        handles = {_mapping(value)["channel"]: _mapping(value) for value in streams}

        async def close_process(request: Mapping[str, object]) -> BaseModel:
            # A broken stream must not prevent cancellation of the owned process.
            with suppress(Exception):
                async with asyncio.timeout(3):
                    await self._client.sandbox.stream.close({"stream": handles["stdin"]}, trusted_context=config.sandbox_context)
                    waited = await self._client.sandbox.process.wait({**request, "timeoutMs": 2000}, trusted_context=config.sandbox_context)
                    if waited.model_dump().get("kind") == "terminal":
                        return waited
            return await self._client.sandbox.process.cancel(request, trusted_context=config.sandbox_context)

        port = ManagedRelayProcessPort(
            process=process,
            stdin=handles["stdin"],
            stdout=handles["stdout"],
            read_stream=lambda request: self._client.sandbox.stream.read(request, trusted_context=config.sandbox_context),
            write_stream=lambda request: self._client.sandbox.stream.write(request, trusted_context=config.sandbox_context),
            cancel_process=close_process,
        )
        self._connection = PortalBridgeConnection(process=port, bridge=self._bridge, stream_artifact=self._stream_artifact)
        self._pump = asyncio.create_task(self._connection.run())
        self._stderr = asyncio.create_task(self._drain_stderr(handles["stderr"]))
        await self._connection.wait_ready()

    async def _drain_stderr(self, stream: Mapping[str, object]) -> None:
        cursor: str | None = None
        while not self._closed:
            result = await self._client.sandbox.stream.read(
                {"stream": dict(stream), "maxBytes": 65_536, "waitMs": 250, **({"cursor": cursor} if cursor is not None else {})},
                trusted_context=self._config.sandbox_context,
            )
            payload = result.model_dump(by_alias=True, mode="json", exclude_none=True)
            if payload.get("eof") is True:
                return
            next_cursor = payload.get("nextCursor")
            if next_cursor is not None and not isinstance(next_cursor, str):
                raise TypeError("Relay stderr omitted its cursor.")
            cursor = next_cursor

    async def _invoke(self, operation: str, request: Mapping[str, object]) -> BaseModel:
        context = self._config.portal_context
        if operation == "list":
            return await self._client.portal.list(request, trusted_context=context)
        if operation == "search":
            return await self._client.portal.search(request, trusted_context=context)
        if operation == "describe":
            return await self._client.portal.describe(request, trusted_context=context)
        if operation == "call":
            return await execute_portal_call_with_approval(
                request,
                call_portal=lambda payload: self._bridge.scope.admit(lambda: self._client.portal.call(payload, trusted_context=context)),
                decide_approval=lambda payload: self._bridge.scope.admit(lambda: self._client.approvals.decide(payload, trusted_context=context)),
                present_approval=self._present,
            )
        raise ValueError("Unsupported Portal operation.")

    async def _stream_artifact(self, request: Mapping[str, object], send: t.Callable[[dict[str, object]], t.Awaitable[None]]) -> None:
        reference = _mapping(request["reference"])
        maximum = request["maxBytes"]
        offset = request.get("offsetBytes", 0)
        if not isinstance(maximum, int) or not isinstance(offset, int):
            raise TypeError("Invalid artifact range.")
        received_bytes = 0
        last: dict[str, object] = {}
        while received_bytes < maximum:
            requested_bytes = min(65_536, maximum - received_bytes)
            result = await self._client.artifacts.read(
                {"reference": reference, "offsetBytes": offset + received_bytes, "maxBytes": requested_bytes},
                trusted_context=self._config.portal_context,
            )
            last = result.model_dump(by_alias=True, mode="json", exclude_none=True)
            if last.get("reference") != reference or last.get("offsetBytes") != offset + received_bytes:
                raise ValueError("Artifact read returned mismatched authority or range.")
            chunk = base64.b64decode(str(last["contentBase64"]), validate=True)
            if len(chunk) > requested_bytes:
                raise ValueError("Artifact read exceeded its requested chunk size.")
            if chunk:
                await send(
                    {
                        "kind": "artifact-chunk",
                        "reference": reference,
                        "offsetBytes": offset + received_bytes,
                        "contentBase64": base64.b64encode(chunk).decode("ascii"),
                    },
                )
            received_bytes += len(chunk)
            if not chunk or last.get("truncated") is False:
                break
        total_bytes = reference.get("byteLength")
        if not isinstance(total_bytes, int) or received_bytes != min(maximum, max(0, total_bytes - offset)):
            raise ValueError("Artifact read ended before the requested range completed.")
        await send(
            {
                "kind": "artifact-end",
                "reference": reference,
                "offsetBytes": offset,
                "byteLength": received_bytes,
                "truncated": offset + received_bytes < total_bytes,
                **({"mediaType": last["mediaType"]} if "mediaType" in last else {}),
            },
        )

    async def close(self) -> None:
        self._closed = True
        self._bridge.close()
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._close_once())
        await asyncio.shield(self._cleanup_task)

    async def _close_once(self) -> None:
        tasks = [task for task in (self._pump, self._stderr) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self._connection is not None:
            await self._connection.close()
        elif self._process is not None:
            await self._client.sandbox.process.cancel({"process": self._process}, trusted_context=self._config.sandbox_context)
