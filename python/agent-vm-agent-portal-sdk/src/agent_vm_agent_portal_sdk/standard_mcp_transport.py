"""Official Python MCP SDK transport for the portable Tool Portal client."""

import asyncio
import typing as t
from collections.abc import Mapping
from contextlib import AsyncExitStack
from pathlib import Path

import httpx
from mcp import types
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamable_http_client
from pydantic import BaseModel, ConfigDict, Field, SecretStr

if t.TYPE_CHECKING:
    from anyio.streams.memory import MemoryObjectReceiveStream, MemoryObjectSendStream
    from mcp.shared.message import SessionMessage


class ToolPortalStreamableHttpMcpConfig(BaseModel):
    """Authenticated Streamable HTTP connection owned by the SDK transport."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    authorization: SecretStr
    endpoint: str = Field(min_length=1)


class ToolPortalStdioMcpConfig(BaseModel):
    """Scoped stdio child-process connection owned by the SDK transport."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    arguments: tuple[str, ...] = ()
    cwd: Path | None = None
    environment: dict[str, str] | None = None
    executable: str = Field(min_length=1)


type ToolPortalStandardMcpConfig = ToolPortalStreamableHttpMcpConfig | ToolPortalStdioMcpConfig


class StandardMcpToolPortalTransport:
    """One initialized official MCP session over Streamable HTTP or stdio."""

    def __init__(self, config: ToolPortalStandardMcpConfig) -> None:
        self._config = config
        self._lifecycle_lock = asyncio.Lock()
        self._exit_stack: AsyncExitStack | None = None
        self._session: ClientSession | None = None
        self._closed = False

    async def connect(self) -> None:
        """Open the configured transport and publish state only after initialization."""
        async with self._lifecycle_lock:
            if self._closed:
                error_message = "Tool Portal MCP transport is closed."
                raise RuntimeError(error_message)
            if self._session is not None:
                return

            pending_stack = AsyncExitStack()
            await pending_stack.__aenter__()
            try:
                read_stream, write_stream = await self._enter_transport(pending_stack)
                pending_session = await pending_stack.enter_async_context(
                    ClientSession(read_stream, write_stream),
                )
                await pending_session.initialize()
            except BaseException:
                await pending_stack.aclose()
                raise

            self._exit_stack = pending_stack
            self._session = pending_session

    async def close(self) -> None:
        """Close the session and its owned transport exactly once."""
        async with self._lifecycle_lock:
            pending_stack = self._exit_stack
            self._exit_stack = None
            self._session = None
            self._closed = True

        if pending_stack is not None:
            await pending_stack.aclose()

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, object],
        *,
        metadata: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]:
        """Call one standard MCP tool through the initialized session."""
        session = self._require_session()
        result = await session.call_tool(
            name,
            arguments=dict(arguments),
            meta=None if metadata is None else dict(metadata),
        )
        if result.structuredContent is None:
            return {}
        return {"structuredContent": result.structuredContent}

    async def read_resource(
        self,
        request: Mapping[str, object],
    ) -> Mapping[str, object]:
        """Read and normalize one standard MCP resource response."""
        session = self._require_session()
        resource_uri = request.get("uri")
        if not isinstance(resource_uri, str):
            error_message = "Tool Portal MCP resource request requires one URI string."
            raise TypeError(error_message)
        result = await session.read_resource(types.AnyUrl(resource_uri))
        return {
            "contents": [self._normalize_resource_content(content) for content in result.contents],
        }

    async def _enter_transport(
        self,
        pending_stack: AsyncExitStack,
    ) -> "tuple[MemoryObjectReceiveStream[SessionMessage | Exception], MemoryObjectSendStream[SessionMessage]]":
        if isinstance(self._config, ToolPortalStreamableHttpMcpConfig):
            http_client = await pending_stack.enter_async_context(
                httpx.AsyncClient(
                    follow_redirects=True,
                    headers={
                        "Authorization": f"Bearer {self._config.authorization.get_secret_value()}",
                    },
                    timeout=httpx.Timeout(30.0, read=300.0),
                ),
            )
            read_stream, write_stream, _ = await pending_stack.enter_async_context(
                streamable_http_client(
                    self._config.endpoint,
                    http_client=http_client,
                    terminate_on_close=True,
                ),
            )
            return read_stream, write_stream

        server_parameters = StdioServerParameters(
            command=self._config.executable,
            args=list(self._config.arguments),
            cwd=self._config.cwd,
            env=None if self._config.environment is None else dict(self._config.environment),
        )
        return await pending_stack.enter_async_context(stdio_client(server_parameters))

    def _require_session(self) -> ClientSession:
        if self._closed:
            error_message = "Tool Portal MCP transport is closed."
            raise RuntimeError(error_message)
        if self._session is None:
            error_message = "Tool Portal MCP transport is not connected."
            raise RuntimeError(error_message)
        return self._session

    @staticmethod
    def _normalize_resource_content(
        content: types.TextResourceContents | types.BlobResourceContents,
    ) -> dict[str, object]:
        normalized_content: dict[str, object] = {"uri": str(content.uri)}
        if content.mimeType is not None:
            normalized_content["mimeType"] = content.mimeType
        if isinstance(content, types.BlobResourceContents):
            normalized_content["blob"] = content.blob
        else:
            normalized_content["text"] = content.text
        return normalized_content
