"""Real-protocol proof for the official Python MCP Tool Portal transport."""

import asyncio
import importlib
import socket
import sys
import typing as t
from contextlib import asynccontextmanager
from pathlib import Path
from types import TracebackType

import pytest
import uvicorn
from agent_vm_agent_portal_sdk.standard_mcp_transport import (
    StandardMcpToolPortalTransport,
    ToolPortalStdioMcpConfig,
    ToolPortalStreamableHttpMcpConfig,
)
from agent_vm_agent_portal_sdk.tool_portal_mcp_client import ToolPortalMcpClient
from mcp import types
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, SecretStr
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

TEST_AUTHORIZATION = "test-only-bearer-token"
TEST_PORTAL_CALL_REQUEST: dict[str, object] = {
    "calls": [
        {
            "arguments": {"query": "current status"},
            "id": "call-status",
            "name": "search",
            "namespace": "project",
        },
    ],
    "requestId": "portal-request-http",
}
TEST_ARTIFACT_READ_REQUEST: dict[str, object] = {
    "maxBytes": 5,
    "offsetBytes": 0,
    "reference": {
        "byteLength": 11,
        "expiresAt": "2030-01-02T03:04:05.000Z",
        "fingerprint": f"sha256:{'a' * 64}",
        "id": "artifact-1",
        "mediaType": "text/plain",
    },
}


def _portal_call_result(*, operation_id: str, transport_kind: str) -> dict[str, object]:
    return {
        "items": [
            {
                "id": "call-status",
                "operationId": operation_id,
                "outcome": {
                    "certainty": "proven",
                    "completion": "succeeded",
                    "kind": "completed",
                    "retryClass": "forbidden",
                },
                "owningGeneration": f"tool-vm-generation-{transport_kind}",
                "status": "ok",
                "value": {"transport": transport_kind},
            },
        ],
        "ok": True,
    }


class _RecordingBearerMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app: ASGIApp,
        *,
        request_observations: list[tuple[str, str | None]],
    ) -> None:
        super().__init__(app)
        self._request_observations = request_observations

    @t.override
    async def dispatch(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        authorization = request.headers.get("authorization")
        self._request_observations.append((request.method, authorization))
        if authorization != f"Bearer {TEST_AUTHORIZATION}":
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)


class _EventedUvicornServer(uvicorn.Server):
    def __init__(self, config: uvicorn.Config, *, started: asyncio.Event) -> None:
        super().__init__(config)
        self._started_event = started

    @t.override
    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets=sockets)
        self._started_event.set()


def _stdio_server_path() -> Path:
    return Path(__file__).with_name("stdio_tool_portal_mcp_test_server.py")


def _assert_portal_call_result(result: object, *, transport_kind: str) -> None:
    assert isinstance(result, BaseModel)
    serialized_result = result.model_dump(by_alias=True, mode="json")
    assert serialized_result["ok"] is True
    assert serialized_result["items"][0]["value"] == {"transport": transport_kind}


def test_stdio_transport_initializes_calls_reads_and_closes_owned_process(
    tmp_path: Path,
) -> None:
    async def exercise_stdio_transport() -> None:
        exit_receipt_path = tmp_path / "stdio-server-exited.txt"
        transport = StandardMcpToolPortalTransport(
            ToolPortalStdioMcpConfig(
                executable=sys.executable,
                arguments=(str(_stdio_server_path()),),
                environment={"AGENT_VM_MCP_TEST_EXIT_RECEIPT": str(exit_receipt_path)},
            ),
        )
        client = ToolPortalMcpClient(transport=transport)

        with pytest.raises(RuntimeError, match="not connected"):
            _ = await client.call(TEST_PORTAL_CALL_REQUEST)

        await client.connect()
        call_result = await client.call(TEST_PORTAL_CALL_REQUEST)
        artifact_result = await client.artifacts.read(TEST_ARTIFACT_READ_REQUEST)
        await client.close()
        await client.close()

        _assert_portal_call_result(call_result, transport_kind="stdio")
        assert artifact_result.model_dump(by_alias=True, mode="json") == {
            "contentBase64": "aGVsbG8=",
            "mediaType": "text/plain",
            "offsetBytes": 0,
            "reference": TEST_ARTIFACT_READ_REQUEST["reference"],
            "truncated": True,
        }
        assert await asyncio.to_thread(exit_receipt_path.read_text, encoding="utf-8") == "closed\n"
        with pytest.raises(RuntimeError, match="closed"):
            _ = await client.call(TEST_PORTAL_CALL_REQUEST)

    asyncio.run(exercise_stdio_transport())


def test_authenticated_streamable_http_transport_survives_local_task_cancellation() -> None:
    async def exercise_http_transport() -> None:
        cancelled_call_started = asyncio.Event()
        release_cancelled_call = asyncio.Event()
        cancelled_call_finished = asyncio.Event()
        request_observations: list[tuple[str, str | None]] = []
        server = FastMCP(
            "agent-vm-tool-portal-http-test",
            host="127.0.0.1",
            log_level="ERROR",
        )

        @server.tool(name="tool_portal_call")
        async def call_tool_portal(
            calls: list[dict[str, object]],
            requestId: str,  # noqa: N803 - MCP wire field name is camelCase.
        ) -> types.CallToolResult:
            _ = calls
            if requestId == "portal-request-cancelled":
                cancelled_call_started.set()
                try:
                    await release_cancelled_call.wait()
                finally:
                    cancelled_call_finished.set()
            return types.CallToolResult(
                content=[types.TextContent(type="text", text="bounded HTTP fixture result")],
                structuredContent=_portal_call_result(
                    operation_id=f"operation-{requestId}",
                    transport_kind="http",
                ),
            )

        @server.resource(
            "agent-vm-artifact://read?id=artifact-1",
            mime_type="text/plain",
        )
        async def read_test_artifact() -> bytes:
            return b"hello"

        application = _RecordingBearerMiddleware(
            server.streamable_http_app(),
            request_observations=request_observations,
        )
        listening_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listening_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listening_socket.bind(("127.0.0.1", 0))
        listening_socket.listen()
        listening_socket.settimeout(0.0)
        server_started = asyncio.Event()
        uvicorn_server = _EventedUvicornServer(
            uvicorn.Config(application, log_level="error", lifespan="on"),
            started=server_started,
        )
        server_task = asyncio.create_task(uvicorn_server.serve(sockets=[listening_socket]))
        await server_started.wait()
        server_port = t.cast("tuple[str, int]", listening_socket.getsockname())[1]
        transport = StandardMcpToolPortalTransport(
            ToolPortalStreamableHttpMcpConfig(
                authorization=SecretStr(TEST_AUTHORIZATION),
                endpoint=f"http://127.0.0.1:{server_port}/mcp",
            ),
        )
        client = ToolPortalMcpClient(transport=transport)

        try:
            await client.connect()
            initial_result = await client.call(TEST_PORTAL_CALL_REQUEST)
            artifact_result = await client.artifacts.read(TEST_ARTIFACT_READ_REQUEST)

            cancelled_request = {
                **TEST_PORTAL_CALL_REQUEST,
                "requestId": "portal-request-cancelled",
            }
            cancelled_call = asyncio.create_task(client.call(cancelled_request))
            await cancelled_call_started.wait()
            cancelled_call.cancel()
            with pytest.raises(asyncio.CancelledError):
                _ = await cancelled_call

            next_result = await client.call(
                {**TEST_PORTAL_CALL_REQUEST, "requestId": "portal-request-after-cancel"},
            )
            release_cancelled_call.set()
            await cancelled_call_finished.wait()
            final_result = await client.call(
                {**TEST_PORTAL_CALL_REQUEST, "requestId": "portal-request-after-late-response"},
            )
            await client.close()
            await client.close()

            _assert_portal_call_result(initial_result, transport_kind="http")
            _assert_portal_call_result(next_result, transport_kind="http")
            _assert_portal_call_result(final_result, transport_kind="http")
            assert artifact_result.model_dump(by_alias=True, mode="json")["contentBase64"] == "aGVsbG8="
            assert request_observations
            assert all(authorization == f"Bearer {TEST_AUTHORIZATION}" for _, authorization in request_observations)
            assert any(method == "DELETE" for method, _ in request_observations)
            with pytest.raises(RuntimeError, match="closed"):
                _ = await client.call(TEST_PORTAL_CALL_REQUEST)
        finally:
            release_cancelled_call.set()
            await client.close()
            uvicorn_server.should_exit = True
            await server_task
            listening_socket.close()

    asyncio.run(exercise_http_transport())


def test_failed_initialization_unwinds_session_and_stdio_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def exercise_failed_initialization() -> None:
        transport_module = importlib.import_module("agent_vm_agent_portal_sdk.standard_mcp_transport")
        lifecycle_events: list[str] = []

        @asynccontextmanager
        async def fake_stdio_client(*args: object, **kwargs: object) -> t.AsyncIterator[tuple[object, object]]:
            _ = args, kwargs
            lifecycle_events.append("stdio-enter")
            try:
                yield object(), object()
            finally:
                lifecycle_events.append("stdio-exit")

        class FailingClientSession:
            def __init__(self, read_stream: object, write_stream: object) -> None:
                _ = read_stream, write_stream

            async def __aenter__(self) -> t.Self:
                lifecycle_events.append("session-enter")
                return self

            async def __aexit__(
                self,
                exc_type: type[BaseException] | None,
                exc_value: BaseException | None,
                traceback: TracebackType | None,
            ) -> None:
                _ = exc_type, exc_value, traceback
                lifecycle_events.append("session-exit")

            async def initialize(self) -> None:
                lifecycle_events.append("initialize")
                raise RuntimeError("initialization rejected")

        monkeypatch.setattr(transport_module, "stdio_client", fake_stdio_client)
        monkeypatch.setattr(transport_module, "ClientSession", FailingClientSession)
        transport = transport_module.StandardMcpToolPortalTransport(
            transport_module.ToolPortalStdioMcpConfig(executable="unused-test-command"),
        )

        with pytest.raises(RuntimeError, match="initialization rejected"):
            await transport.connect()
        assert lifecycle_events == [
            "stdio-enter",
            "session-enter",
            "initialize",
            "session-exit",
            "stdio-exit",
        ]
        await transport.close()
        await transport.close()
        with pytest.raises(RuntimeError, match="closed"):
            await transport.connect()

    asyncio.run(exercise_failed_initialization())
