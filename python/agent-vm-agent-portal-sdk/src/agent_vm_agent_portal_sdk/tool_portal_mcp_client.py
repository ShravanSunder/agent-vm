"""Standard-MCP client projection for the bounded Tool Portal surface."""

import base64
import binascii
import typing as t
from collections.abc import Mapping
from types import TracebackType

from pydantic import BaseModel, ConfigDict, Field

from .artifact_read_resource_uri import create_portal_artifact_read_resource_request
from .contracts import PORTABLE_CONTRACT_ADAPTERS


class ToolPortalMcpTransport(t.Protocol):
    async def connect(self) -> None: ...

    async def close(self) -> None: ...

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, object],
        *,
        metadata: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]: ...

    async def read_resource(self, request: Mapping[str, object]) -> Mapping[str, object]: ...


class _McpBlobResource(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    blob: str
    mime_type: str = Field(alias="mimeType")
    uri: str


class _McpReadResourceResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    contents: list[_McpBlobResource] = Field(min_length=1, max_length=1)


class _ToolPortalMcpArtifactOperations:
    def __init__(self, transport: ToolPortalMcpTransport) -> None:
        self._transport = transport

    async def read(self, request: Mapping[str, object]) -> BaseModel:
        validated_request = PORTABLE_CONTRACT_ADAPTERS["portal.artifact.read-request"].validate_python(request)
        if not isinstance(validated_request, BaseModel):
            error_message = "Artifact read request did not produce a typed model."
            raise TypeError(error_message)
        request_payload = t.cast(
            "dict[str, object]",
            validated_request.model_dump(by_alias=True, mode="json", exclude_none=True),
        )
        resource_request = create_portal_artifact_read_resource_request(request_payload)
        resource_result = _McpReadResourceResult.model_validate(await self._transport.read_resource(resource_request))
        content = resource_result.contents[0]
        resource_uri = resource_request.get("uri")
        if not isinstance(resource_uri, str) or content.uri != resource_uri:
            error_message = "Tool Portal MCP artifact resource URI did not match the request."
            raise TypeError(error_message)
        try:
            returned_bytes = base64.b64decode(content.blob, validate=True)
        except binascii.Error as error:
            error_message = "Tool Portal MCP artifact content is not canonical base64."
            raise TypeError(error_message) from error
        max_bytes_value = request_payload["maxBytes"]
        offset_bytes_value = request_payload["offsetBytes"]
        reference_value = request_payload["reference"]
        if (
            isinstance(max_bytes_value, bool)
            or not isinstance(max_bytes_value, int)
            or isinstance(offset_bytes_value, bool)
            or not isinstance(offset_bytes_value, int)
            or not isinstance(reference_value, dict)
        ):
            error_message = "Artifact read request did not retain its typed bounds."
            raise TypeError(error_message)
        max_bytes = max_bytes_value
        offset_bytes = offset_bytes_value
        reference = t.cast("dict[str, object]", reference_value)
        if len(returned_bytes) > max_bytes:
            error_message = "Tool Portal MCP artifact read exceeded the requested byte range."
            raise TypeError(error_message)
        byte_length = reference.get("byteLength")
        if not isinstance(byte_length, int):
            error_message = "Artifact reference did not retain its byte length."
            raise TypeError(error_message)
        validated_result = PORTABLE_CONTRACT_ADAPTERS["portal.artifact.read-result"].validate_python(
            {
                "contentBase64": content.blob,
                "mediaType": content.mime_type,
                "offsetBytes": offset_bytes,
                "reference": reference,
                "truncated": offset_bytes + len(returned_bytes) < byte_length,
            },
        )
        if not isinstance(validated_result, BaseModel):
            error_message = "Artifact read result did not produce a typed model."
            raise TypeError(error_message)
        return validated_result


class ToolPortalMcpClient:
    """Validate portable contracts around an injected standard-MCP transport."""

    def __init__(self, *, transport: ToolPortalMcpTransport) -> None:
        self._transport = transport
        self.artifacts = _ToolPortalMcpArtifactOperations(transport)

    async def __aenter__(self) -> t.Self:
        await self.connect()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        _ = exc_type, exc_value, traceback
        await self.close()

    async def connect(self) -> None:
        await self._transport.connect()

    async def close(self) -> None:
        await self._transport.close()

    async def _execute_portal_operation(
        self,
        *,
        operation_name: t.Literal["list", "search", "describe", "call"],
        request: Mapping[str, object],
        approval_token: str | None = None,
    ) -> BaseModel:
        validated_request = PORTABLE_CONTRACT_ADAPTERS[f"portal.{operation_name}.request"].validate_python(request)
        if not isinstance(validated_request, BaseModel):
            invalid_request_message = f"Portal {operation_name} request did not produce a typed model."
            raise TypeError(invalid_request_message)

        tool_name = f"tool_portal_{operation_name}"
        arguments = validated_request.model_dump(by_alias=True, mode="json", exclude_none=True)
        response = (
            await self._transport.call_tool(tool_name, arguments)
            if approval_token is None
            else await self._transport.call_tool(
                tool_name,
                arguments,
                metadata={
                    "agent-vm/tool-portal-approval-token": approval_token,
                },
            )
        )
        structured_content = response.get("structuredContent")
        validated_result = PORTABLE_CONTRACT_ADAPTERS[f"portal.{operation_name}.result"].validate_python(structured_content)
        if not isinstance(validated_result, BaseModel):
            invalid_result_message = f"Portal {operation_name} result did not produce a typed model."
            raise TypeError(invalid_result_message)
        return validated_result

    async def list(self, request: Mapping[str, object]) -> BaseModel:
        return await self._execute_portal_operation(operation_name="list", request=request)

    async def search(self, request: Mapping[str, object]) -> BaseModel:
        return await self._execute_portal_operation(operation_name="search", request=request)

    async def describe(self, request: Mapping[str, object]) -> BaseModel:
        return await self._execute_portal_operation(operation_name="describe", request=request)

    async def call(
        self,
        request: Mapping[str, object],
        *,
        approval_token: str | None = None,
    ) -> BaseModel:
        return await self._execute_portal_operation(
            operation_name="call",
            request=request,
            approval_token=approval_token,
        )
