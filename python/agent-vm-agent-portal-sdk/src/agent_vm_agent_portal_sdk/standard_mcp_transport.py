"""Official Python MCP SDK transport for the portable Tool Portal client."""

import asyncio
import typing as t
from collections.abc import Mapping
from contextlib import AsyncExitStack
from pathlib import Path

import httpx2
from mcp import Client, types
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamable_http_client
from pydantic import BaseModel, ConfigDict, Field, SecretStr, TypeAdapter

if t.TYPE_CHECKING:
    from mcp.client._transport import Transport

_MCP_REQUEST_METADATA = TypeAdapter(types.RequestParamsMeta)


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
    """One explicitly pinned MCP session over Streamable HTTP or stdio."""

    def __init__(self, config: ToolPortalStandardMcpConfig) -> None:
        self._config = config
        self._lifecycle_lock = asyncio.Lock()
        self._exit_stack: AsyncExitStack | None = None
        self._session: ClientSession | None = None
        self._closed = False

    async def connect(self) -> None:
        """Let Client own the transport and adopt MCP 2026-07-28 without fallback."""
        async with self._lifecycle_lock:
            if self._closed:
                error_message = "Tool Portal MCP transport is closed."
                raise RuntimeError(error_message)
            if self._session is not None:
                return

            pending_stack = AsyncExitStack()
            await pending_stack.__aenter__()
            try:
                transport = await self._create_transport(pending_stack)
                pending_client = await pending_stack.enter_async_context(
                    Client(transport, mode="2026-07-28"),
                )
            except BaseException:
                await pending_stack.aclose()
                raise

            self._exit_stack = pending_stack
            self._session = pending_client.session

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
        """Use the low-level session for one call, without automatic approval retries."""
        session = self._require_session()
        result = await session.call_tool(
            name,
            arguments=dict(arguments),
            meta=None if metadata is None else _MCP_REQUEST_METADATA.validate_python(dict(metadata)),
        )
        if result.structured_content is None:
            return {}
        return {"structuredContent": result.structured_content}

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
        raw_metadata = request.get("_meta")
        if raw_metadata is not None and not isinstance(raw_metadata, Mapping):
            error_message = "Tool Portal MCP resource metadata must be an object."
            raise TypeError(error_message)
        result = await session.read_resource(
            resource_uri,
            meta=None if raw_metadata is None else _MCP_REQUEST_METADATA.validate_python(raw_metadata),
        )
        return {
            "contents": [self._normalize_resource_content(content) for content in result.contents],
        }

    async def _create_transport(
        self,
        pending_stack: AsyncExitStack,
    ) -> "Transport":
        if isinstance(self._config, ToolPortalStreamableHttpMcpConfig):
            http_client = await pending_stack.enter_async_context(
                httpx2.AsyncClient(
                    follow_redirects=True,
                    headers={
                        "Authorization": f"Bearer {self._config.authorization.get_secret_value()}",
                    },
                    timeout=httpx2.Timeout(30.0, read=300.0),
                ),
            )
            return streamable_http_client(
                self._config.endpoint,
                http_client=http_client,
                terminate_on_close=True,
            )

        server_parameters = StdioServerParameters(
            command=self._config.executable,
            args=list(self._config.arguments),
            cwd=self._config.cwd,
            env=None if self._config.environment is None else dict(self._config.environment),
        )
        return stdio_client(server_parameters)

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
        if content.mime_type is not None:
            normalized_content["mimeType"] = content.mime_type
        if isinstance(content, types.BlobResourceContents):
            normalized_content["blob"] = content.blob
        else:
            normalized_content["text"] = content.text
        return normalized_content
