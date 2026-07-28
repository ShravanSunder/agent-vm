"""Portable rich-sandbox operations for one Gateway Runtime attachment."""

import typing as t
from collections.abc import Mapping

from pydantic import BaseModel

from .contracts import PORTABLE_CONTRACT_ADAPTERS

type SandboxWireMethod = t.Literal[
    "sandbox.environment.open",
    "sandbox.environment.close",
    "sandbox.environment.status",
    "sandbox.exec.start",
    "sandbox.exec.wait",
    "sandbox.exec.cancel",
    "sandbox.retained-result.lookup",
    "sandbox.fs.stat",
    "sandbox.fs.list",
    "sandbox.fs.read",
    "sandbox.fs.write",
    "sandbox.fs.mkdir",
    "sandbox.fs.rename",
    "sandbox.fs.remove",
    "sandbox.process.start",
    "sandbox.process.status",
    "sandbox.process.wait",
    "sandbox.process.logs",
    "sandbox.process.cancel",
    "sandbox.stream.read",
    "sandbox.stream.write",
    "sandbox.stream.close",
    "sandbox.terminal.attach",
    "sandbox.terminal.resize",
]


SANDBOX_WIRE_METHOD_SCHEMA_IDS: t.Final[dict[SandboxWireMethod, tuple[str, str]]] = {
    "sandbox.retained-result.lookup": (
        "sandbox.retained-result.lookup-request",
        "sandbox.retained-result.lookup-result",
    ),
}


def _sandbox_method_schema_ids(method: SandboxWireMethod) -> tuple[str, str]:
    explicit_schema_ids = SANDBOX_WIRE_METHOD_SCHEMA_IDS.get(method)
    if explicit_schema_ids is not None:
        return explicit_schema_ids
    return f"{method}.request", f"{method}.result"


class GatewayRuntimeSandboxRequestClient(t.Protocol):
    async def request(
        self,
        method: str,
        params: Mapping[str, object],
    ) -> Mapping[str, object]: ...


def _validate_portable_mapping(
    schema_id: str,
    value: Mapping[str, object],
) -> dict[str, object]:
    validated_value = PORTABLE_CONTRACT_ADAPTERS[schema_id].validate_python(dict(value))
    if not isinstance(validated_value, BaseModel):
        invalid_mapping_message = f"Portable contract {schema_id!r} did not produce a typed model."
        raise TypeError(invalid_mapping_message)
    normalized_value = validated_value.model_dump(
        by_alias=True,
        exclude_none=True,
        mode="json",
    )
    if not isinstance(normalized_value, dict):
        invalid_mapping_message = f"Portable contract {schema_id!r} did not produce a JSON object."
        raise TypeError(invalid_mapping_message)
    return t.cast("dict[str, object]", normalized_value)


async def _execute_sandbox_operation(
    *,
    client: GatewayRuntimeSandboxRequestClient,
    method: SandboxWireMethod,
    public_request: Mapping[str, object],
    trusted_context: Mapping[str, object],
) -> BaseModel:
    request_schema_id, result_schema_id = _sandbox_method_schema_ids(method)
    normalized_public_request = _validate_portable_mapping(
        request_schema_id,
        public_request,
    )
    normalized_trusted_context = _validate_portable_mapping(
        "gateway.trusted-invocation-context",
        trusted_context,
    )
    response = await client.request(
        method,
        {
            "publicRequest": normalized_public_request,
            "trustedContext": normalized_trusted_context,
        },
    )
    validated_result = PORTABLE_CONTRACT_ADAPTERS[result_schema_id].validate_python(dict(response))
    if not isinstance(validated_result, BaseModel):
        invalid_result_message = f"Sandbox operation {method!r} did not produce a typed result."
        raise TypeError(invalid_result_message)
    return validated_result


class _GatewayRuntimeSandboxOperationGroup:
    def __init__(self, client: GatewayRuntimeSandboxRequestClient) -> None:
        self._client = client

    async def _execute(
        self,
        method: SandboxWireMethod,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await _execute_sandbox_operation(
            client=self._client,
            method=method,
            public_request=request,
            trusted_context=trusted_context,
        )


class GatewayRuntimeSandboxEnvironmentOperations(_GatewayRuntimeSandboxOperationGroup):
    async def open(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute(
            "sandbox.environment.open",
            request,
            trusted_context=trusted_context,
        )

    async def close(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute(
            "sandbox.environment.close",
            request,
            trusted_context=trusted_context,
        )

    async def status(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute(
            "sandbox.environment.status",
            request,
            trusted_context=trusted_context,
        )


class GatewayRuntimeSandboxExecutionOperations(_GatewayRuntimeSandboxOperationGroup):
    async def start(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute(
            "sandbox.exec.start",
            request,
            trusted_context=trusted_context,
        )

    async def wait(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute(
            "sandbox.exec.wait",
            request,
            trusted_context=trusted_context,
        )

    async def cancel(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute(
            "sandbox.exec.cancel",
            request,
            trusted_context=trusted_context,
        )


class GatewayRuntimeSandboxRetainedResultOperations(_GatewayRuntimeSandboxOperationGroup):
    async def lookup(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute(
            "sandbox.retained-result.lookup",
            request,
            trusted_context=trusted_context,
        )


class GatewayRuntimeSandboxFilesystemOperations(_GatewayRuntimeSandboxOperationGroup):
    async def stat(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.fs.stat", request, trusted_context=trusted_context)

    async def list(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.fs.list", request, trusted_context=trusted_context)

    async def read(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.fs.read", request, trusted_context=trusted_context)

    async def write(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.fs.write", request, trusted_context=trusted_context)

    async def mkdir(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.fs.mkdir", request, trusted_context=trusted_context)

    async def rename(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.fs.rename", request, trusted_context=trusted_context)

    async def remove(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.fs.remove", request, trusted_context=trusted_context)


class GatewayRuntimeSandboxProcessOperations(_GatewayRuntimeSandboxOperationGroup):
    async def start(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.process.start", request, trusted_context=trusted_context)

    async def status(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.process.status", request, trusted_context=trusted_context)

    async def wait(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.process.wait", request, trusted_context=trusted_context)

    async def logs(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.process.logs", request, trusted_context=trusted_context)

    async def cancel(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.process.cancel", request, trusted_context=trusted_context)


class GatewayRuntimeSandboxStreamOperations(_GatewayRuntimeSandboxOperationGroup):
    async def read(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.stream.read", request, trusted_context=trusted_context)

    async def write(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.stream.write", request, trusted_context=trusted_context)

    async def close(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.stream.close", request, trusted_context=trusted_context)


class GatewayRuntimeSandboxTerminalOperations(_GatewayRuntimeSandboxOperationGroup):
    async def attach(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.terminal.attach", request, trusted_context=trusted_context)

    async def resize(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel:
        return await self._execute("sandbox.terminal.resize", request, trusted_context=trusted_context)


class GatewayRuntimeSandboxOperations:
    """All portable rich-sandbox groups backed by one Gateway Runtime client."""

    def __init__(self, client: GatewayRuntimeSandboxRequestClient) -> None:
        self.environment: GatewayRuntimeSandboxEnvironmentOperations = GatewayRuntimeSandboxEnvironmentOperations(client)
        self.execution: GatewayRuntimeSandboxExecutionOperations = GatewayRuntimeSandboxExecutionOperations(client)
        self.filesystem: GatewayRuntimeSandboxFilesystemOperations = GatewayRuntimeSandboxFilesystemOperations(client)
        self.process: GatewayRuntimeSandboxProcessOperations = GatewayRuntimeSandboxProcessOperations(client)
        self.retained_results: GatewayRuntimeSandboxRetainedResultOperations = GatewayRuntimeSandboxRetainedResultOperations(client)
        self.stream: GatewayRuntimeSandboxStreamOperations = GatewayRuntimeSandboxStreamOperations(client)
        self.terminal: GatewayRuntimeSandboxTerminalOperations = GatewayRuntimeSandboxTerminalOperations(client)
