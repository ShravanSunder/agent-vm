import asyncio
import importlib
import secrets
import sys
import typing as t
from collections.abc import Mapping
from types import ModuleType

import pytest
from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from pydantic import BaseModel, ValidationError

type JsonObject = dict[str, object]
type PortalOperation = t.Callable[..., t.Coroutine[object, object, BaseModel]]
type PortalOperationCase = tuple[str, JsonObject, JsonObject]


DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH = "/run/agent-vm/gateway-runtime/managed-plugin.sock"
TOOL_PORTAL_MCP_CLIENT_MODULE = "agent_vm_agent_portal_sdk.tool_portal_mcp_client"
GATEWAY_RUNTIME_CLIENT_MODULE = "agent_vm_agent_portal_sdk.gateway_runtime_client"

CURRENT_ATTACHMENT: JsonObject = {
    "attachmentGeneration": 7,
    "clientKind": "hermes-managed-plugin",
    "configuredAgentIds": ["main", "research"],
    "frameworkEpoch": "framework-epoch-current",
    "gatewayEpoch": "gateway-epoch-current",
    "projectionCohortDigest": f"projection-cohort:{'a' * 64}",
    "protocolVersion": 1,
    "runtimeEpoch": "runtime-epoch-current",
    "schemaVersion": 1,
}

CURRENT_TRUSTED_INVOCATION_CONTEXT: JsonObject = {
    "correlation": {
        "runId": "run-main",
        "sessionId": "session-main",
        "toolCallId": "tool-call-main",
    },
    "principal": {
        "agentId": "main",
        "frameworkIdentity": {"kind": "hermes", "profileName": "main"},
        "profileAssignmentRevision": "profile-assignment:main:1",
        "toolPortalProfileId": "tool-portal-profile-main",
    },
    "requester": {"authenticatedSubjectId": "subject-main"},
}

SAMPLED_TRACE_CONTEXT: JsonObject = {
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "tracestate": "vendor=opaque-value,tenant@system=value-2",
}

UNSAMPLED_TRACE_CONTEXT: JsonObject = {
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
}

FUTURE_VERSION_TRACE_CONTEXT: JsonObject = {
    "traceparent": "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03-vendor-extension",
}

EMPTY_TRACESTATE_CONTEXT: JsonObject = {
    "traceparent": SAMPLED_TRACE_CONTEXT["traceparent"],
    "tracestate": "",
}

OWS_AND_EMPTY_MEMBER_TRACESTATE_CONTEXT: JsonObject = {
    "traceparent": SAMPLED_TRACE_CONTEXT["traceparent"],
    "tracestate": "\tvendor=one,\t, other=two\t",
}

PORTAL_ARTIFACT_READ_REQUEST: JsonObject = {
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

PORTAL_ARTIFACT_READ_RESULT: JsonObject = {
    "contentBase64": "aGVsbG8=",
    "mediaType": "text/plain",
    "offsetBytes": 0,
    "reference": PORTAL_ARTIFACT_READ_REQUEST["reference"],
    "truncated": True,
}

PORTAL_ARTIFACT_MCP_RESOURCE_REQUEST: JsonObject = {
    "_meta": {
        "agent-vm/artifact-read-request": PORTAL_ARTIFACT_READ_REQUEST,
    },
    "uri": "agent-vm-artifact://read?id=artifact-1",
}

PORTAL_CALL_REQUEST: JsonObject = {
    "calls": [
        {
            "arguments": {"query": "current status"},
            "id": "call-status",
            "name": "search",
            "namespace": "project",
        },
    ],
    "requestId": "portal-request-17",
}

PORTAL_CALL_SUCCESS: JsonObject = {
    "items": [
        {
            "id": "call-status",
            "operationId": "operation-17",
            "outcome": {
                "certainty": "proven",
                "completion": "succeeded",
                "kind": "completed",
                "retryClass": "forbidden",
            },
            "owningGeneration": "tool-vm-generation-4",
            "status": "ok",
            "value": {"summary": "ready"},
        },
    ],
    "ok": True,
}

PORTAL_CALL_ERROR: JsonObject = {
    "items": [
        {
            "error": {
                "code": "provider_unavailable",
                "message": "The selected provider is unavailable.",
            },
            "id": "call-status",
            "operationId": "operation-18",
            "outcome": {
                "certainty": "proven",
                "kind": "not-dispatched",
                "retryClass": "safe-before-dispatch",
            },
            "owningGeneration": "tool-vm-generation-4",
            "status": "error",
        },
    ],
    "ok": False,
}

PORTAL_OPERATION_CASES: tuple[PortalOperationCase, ...] = (
    (
        "list",
        {
            "requestId": "portal-list-request-1",
            "requests": [{"id": "list-project", "namespaces": ["project"]}],
        },
        {
            "auditCorrelationId": "audit-list-1",
            "items": [
                {
                    "id": "list-project",
                    "status": "ok",
                    "value": {"namespaces": ["project"], "tools": []},
                },
            ],
            "ok": True,
        },
    ),
    (
        "search",
        {
            "requestId": "portal-search-request-1",
            "requests": [{"id": "search-project", "query": "status"}],
        },
        {
            "auditCorrelationId": "audit-search-1",
            "items": [
                {
                    "id": "search-project",
                    "status": "ok",
                    "value": {"tools": []},
                },
            ],
            "ok": True,
        },
    ),
    (
        "describe",
        {
            "requestId": "portal-describe-request-1",
            "requests": [
                {
                    "id": "describe-project",
                    "tools": [{"name": "search", "namespace": "project"}],
                },
            ],
        },
        {
            "auditCorrelationId": "audit-describe-1",
            "items": [
                {
                    "id": "describe-project",
                    "status": "ok",
                    "value": {"tools": []},
                },
            ],
            "ok": True,
        },
    ),
    ("call", PORTAL_CALL_REQUEST, PORTAL_CALL_SUCCESS),
)

PORTAL_LIST_REQUEST = PORTAL_OPERATION_CASES[0][1]
PORTAL_LIST_RESULT = PORTAL_OPERATION_CASES[0][2]


class ToolPortalMcpTransport(t.Protocol):
    async def connect(self) -> None: ...

    async def close(self) -> None: ...

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, object],
    ) -> Mapping[str, object]: ...

    async def read_resource(
        self,
        request: Mapping[str, object],
    ) -> Mapping[str, object]: ...


class ToolPortalArtifactOperations(t.Protocol):
    async def read(self, request: Mapping[str, object]) -> BaseModel: ...


class ToolPortalMcpClientContract(t.Protocol):
    artifacts: ToolPortalArtifactOperations

    async def connect(self) -> None: ...

    async def close(self) -> None: ...

    async def list(self, request: Mapping[str, object]) -> BaseModel: ...

    async def search(self, request: Mapping[str, object]) -> BaseModel: ...

    async def describe(self, request: Mapping[str, object]) -> BaseModel: ...

    async def call(
        self,
        request: Mapping[str, object],
        *,
        approval_token: str | None = None,
    ) -> BaseModel: ...


class ToolPortalMcpClientFactory(t.Protocol):
    def __call__(
        self,
        *,
        transport: ToolPortalMcpTransport,
    ) -> ToolPortalMcpClientContract: ...


class GatewayRuntimeTransport(t.Protocol):
    async def connect(self, socket_path: str) -> None: ...

    async def handshake(
        self,
        attachment: Mapping[str, object],
    ) -> Mapping[str, object]: ...

    async def request(
        self,
        method: str,
        params: Mapping[str, object],
    ) -> Mapping[str, object]: ...

    async def disconnect(self) -> None: ...


class GatewayRuntimePortalOperations(t.Protocol):
    async def list(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel: ...

    async def search(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel: ...

    async def describe(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel: ...

    async def call(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel: ...


class GatewayRuntimeArtifactOperations(t.Protocol):
    async def read(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel: ...


class GatewayRuntimeApprovalOperations(t.Protocol):
    async def decide(
        self,
        request: Mapping[str, object],
        *,
        trusted_context: Mapping[str, object],
    ) -> BaseModel: ...


class GatewayRuntimeClientContract(t.Protocol):
    approvals: GatewayRuntimeApprovalOperations
    artifacts: GatewayRuntimeArtifactOperations
    portal: GatewayRuntimePortalOperations

    async def connect(self) -> None: ...

    async def disconnect(self) -> None: ...

    async def reconnect(self) -> None: ...


class GatewayRuntimeClientFactory(t.Protocol):
    def __call__(  # noqa: PLR0913
        self,
        *,
        attachment: Mapping[str, object],
        startup_retry_policy: object | None = None,
        startup_retry_scheduler: object | None = None,
        trace_context_provider: t.Callable[[], Mapping[str, object] | None] | None = None,
        transport: GatewayRuntimeTransport,
        socket_path: str = DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
    ) -> GatewayRuntimeClientContract: ...


class FakeToolPortalMcpTransport:
    def __init__(self, structured_content: Mapping[str, object]) -> None:
        self.structured_content = structured_content
        self.tool_calls: list[tuple[str, Mapping[str, object]]] = []
        self.tool_call_metadata: list[Mapping[str, object] | None] = []

    async def connect(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, object],
        *,
        metadata: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]:
        self.tool_calls.append((name, arguments))
        self.tool_call_metadata.append(metadata)
        return {
            "content": [{"text": "bounded diagnostic", "type": "text"}],
            "isError": False,
            "structuredContent": self.structured_content,
        }

    async def read_resource(
        self,
        request: Mapping[str, object],
    ) -> Mapping[str, object]:
        _ = request
        unexpected_resource_read_message = "Portal operation transport does not accept resource reads."
        raise AssertionError(unexpected_resource_read_message)


class FakeArtifactToolPortalMcpTransport:
    def __init__(
        self,
        resource_bodies: tuple[Mapping[str, object], ...],
    ) -> None:
        self.resource_bodies = resource_bodies
        self.resource_requests: list[Mapping[str, object]] = []
        self.tool_calls: list[tuple[str, Mapping[str, object]]] = []

    async def connect(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, object],
    ) -> Mapping[str, object]:
        self.tool_calls.append((name, arguments))
        unexpected_tool_call_message = "Artifact client test transport does not accept tool calls."
        raise AssertionError(unexpected_tool_call_message)

    async def read_resource(
        self,
        request: Mapping[str, object],
    ) -> Mapping[str, object]:
        resource_uri = request.get("uri")
        if not isinstance(resource_uri, str):
            invalid_resource_request_message = "Artifact resource request requires one URI string."
            raise TypeError(invalid_resource_request_message)
        self.resource_requests.append(request)
        return {
            "contents": [{**resource_body, "uri": resource_uri} for resource_body in self.resource_bodies],
        }


class FakeGatewayRuntimeTransport:
    def __init__(
        self,
        *,
        connect_errors: tuple[BaseException | None, ...] = (),
        handshake_decisions: tuple[Mapping[str, object], ...] = ({"kind": "accepted"},),
        method_results: Mapping[str, tuple[Mapping[str, object], ...]] | None = None,
    ) -> None:
        self.connect_errors = list(connect_errors)
        self.handshake_decisions = list(handshake_decisions)
        self.method_results = {method: list(results) for method, results in (method_results or {}).items()}
        self.connected_socket_paths: list[str] = []
        self.handshakes: list[Mapping[str, object]] = []
        self.requests: list[tuple[str, Mapping[str, object]]] = []
        self.disconnect_count = 0

    async def connect(self, socket_path: str) -> None:
        self.connected_socket_paths.append(socket_path)
        if self.connect_errors:
            connect_error = self.connect_errors.pop(0)
            if connect_error is not None:
                raise connect_error

    async def handshake(
        self,
        attachment: Mapping[str, object],
    ) -> Mapping[str, object]:
        self.handshakes.append(attachment)
        if not self.handshake_decisions:
            missing_decision_message = "The test transport has no queued handshake decision."
            raise AssertionError(missing_decision_message)
        return self.handshake_decisions.pop(0)

    async def request(
        self,
        method: str,
        params: Mapping[str, object],
    ) -> Mapping[str, object]:
        self.requests.append((method, params))
        results = self.method_results.get(method)
        if not results:
            missing_result_message = f"The test transport has no queued result for {method!r}."
            raise AssertionError(missing_result_message)
        return results.pop(0)

    async def disconnect(self) -> None:
        self.disconnect_count += 1


class BlockingReconnectGatewayRuntimeTransport(FakeGatewayRuntimeTransport):
    def __init__(
        self,
        *,
        reconnect_connect_started: asyncio.Event,
        release_reconnect_connect: asyncio.Event,
    ) -> None:
        super().__init__(
            handshake_decisions=(
                {"kind": "accepted"},
                {"kind": "accepted"},
                {"kind": "accepted"},
            ),
        )
        self._reconnect_connect_started = reconnect_connect_started
        self._release_reconnect_connect = release_reconnect_connect

    @t.override
    async def connect(self, socket_path: str) -> None:
        self.connected_socket_paths.append(socket_path)
        if len(self.connected_socket_paths) == 2:
            self._reconnect_connect_started.set()
            await self._release_reconnect_connect.wait()


class DeterministicGatewayRuntimeStartupRetryScheduler:
    def __init__(
        self,
        *,
        wait_started: asyncio.Event | None = None,
        release_wait: asyncio.Event | None = None,
    ) -> None:
        self.current_time_milliseconds = 0.0
        self.waits: list[float] = []
        self._wait_started = wait_started
        self._release_wait = release_wait

    def now_milliseconds(self) -> float:
        return self.current_time_milliseconds

    async def wait(self, delay_milliseconds: float) -> None:
        self.waits.append(delay_milliseconds)
        if self._wait_started is not None:
            self._wait_started.set()
        if self._release_wait is not None:
            await self._release_wait.wait()
        self.current_time_milliseconds += delay_milliseconds


def _purge_python_sdk_modules() -> None:
    for module_name in tuple(sys.modules):
        if module_name == "agent_vm_agent_portal_sdk" or module_name.startswith(
            "agent_vm_agent_portal_sdk.",
        ):
            del sys.modules[module_name]


def _import_isolated_module(module_name: str) -> tuple[ModuleType, frozenset[str]]:
    _purge_python_sdk_modules()
    modules_before_import = frozenset(sys.modules)
    module = importlib.import_module(module_name)
    new_module_names = frozenset(sys.modules) - modules_before_import
    return module, new_module_names


def _tool_portal_mcp_client_factory() -> ToolPortalMcpClientFactory:
    module = importlib.import_module(TOOL_PORTAL_MCP_CLIENT_MODULE)
    return t.cast("ToolPortalMcpClientFactory", module.ToolPortalMcpClient)


def _gateway_runtime_client_factory() -> GatewayRuntimeClientFactory:
    module = importlib.import_module(GATEWAY_RUNTIME_CLIENT_MODULE)
    return t.cast("GatewayRuntimeClientFactory", module.GatewayRuntimeClient)


def _gateway_runtime_error_type() -> type[Exception]:
    module = importlib.import_module(GATEWAY_RUNTIME_CLIENT_MODULE)
    return t.cast("type[Exception]", module.GatewayRuntimeClientError)


def _gateway_runtime_startup_unavailable_error_type() -> type[Exception]:
    module = importlib.import_module(GATEWAY_RUNTIME_CLIENT_MODULE)
    return t.cast("type[Exception]", module.GatewayRuntimeStartupUnavailableError)


def _gateway_runtime_startup_retry_policy(
    *,
    deadline_milliseconds: int = 1_000,
    maximum_attempts: int = 3,
    retry_interval_milliseconds: int = 1,
) -> object:
    module = importlib.import_module(GATEWAY_RUNTIME_CLIENT_MODULE)
    policy_type = t.cast("t.Callable[..., object]", module.GatewayRuntimeStartupRetryPolicy)
    return policy_type(
        deadlineMs=deadline_milliseconds,
        intervalMs=retry_interval_milliseconds,
        maxAttempts=maximum_attempts,
    )


def _captured_gateway_error(
    action: t.Callable[[], t.Coroutine[object, object, object]],
) -> Exception:
    with pytest.raises(_gateway_runtime_error_type()) as captured_error:
        _ = asyncio.run(action())
    return captured_error.value


def _error_code(error: Exception) -> str:
    error_code = getattr(error, "code", None)
    assert isinstance(error_code, str)
    assert error_code
    return error_code


def _validated_contract_model(
    schema_id: str,
    value: Mapping[str, object],
) -> BaseModel:
    validated_value = PORTABLE_CONTRACT_ADAPTERS[schema_id].validate_python(value)
    assert isinstance(validated_value, BaseModel)
    return validated_value


def test_importing_mcp_client_does_not_load_uds_or_gateway_runtime_modules() -> None:
    # Arrange
    forbidden_module_fragments = ("gateway_runtime", ".uds", "gondolin", "managed_vm")

    # Act
    module, imported_module_names = _import_isolated_module(TOOL_PORTAL_MCP_CLIENT_MODULE)

    # Assert
    assert hasattr(module, "ToolPortalMcpClient")
    assert not {module_name for module_name in imported_module_names if any(fragment in module_name for fragment in forbidden_module_fragments)}


def test_importing_gateway_runtime_client_does_not_load_mcp_ssh_vm_or_controller_modules() -> None:
    # Arrange
    forbidden_module_fragments = (
        "tool_portal_mcp_client",
        "mcp_portal",
        "paramiko",
        "ssh",
        "gondolin",
        "managed_vm",
        "controller",
    )

    # Act
    module, imported_module_names = _import_isolated_module(GATEWAY_RUNTIME_CLIENT_MODULE)

    # Assert
    assert hasattr(module, "GatewayRuntimeClient")
    assert not {module_name for module_name in imported_module_names if any(fragment in module_name for fragment in forbidden_module_fragments)}


@pytest.mark.parametrize(
    ("operation_name", "operation_request", "raw_result"),
    PORTAL_OPERATION_CASES,
    ids=[operation_name for operation_name, _, _ in PORTAL_OPERATION_CASES],
)
def test_mcp_client_exposes_all_typed_portal_operations_with_exact_tool_names(
    operation_name: str,
    operation_request: Mapping[str, object],
    raw_result: Mapping[str, object],
) -> None:
    # Arrange
    validated_request = _validated_contract_model(
        f"portal.{operation_name}.request",
        operation_request,
    )
    expected_arguments = validated_request.model_dump(
        by_alias=True,
        exclude_none=True,
        mode="json",
    )
    expected_result = _validated_contract_model(f"portal.{operation_name}.result", raw_result)
    transport = FakeToolPortalMcpTransport(raw_result)
    client = _tool_portal_mcp_client_factory()(transport=transport)
    operation = t.cast("PortalOperation", getattr(client, operation_name))

    # Act
    result = asyncio.run(operation(operation_request))

    # Assert
    assert isinstance(result, BaseModel)
    assert type(result).__name__ == type(expected_result).__name__
    assert result.model_dump(by_alias=True, exclude_none=True, mode="json") == raw_result
    assert transport.tool_calls == [(f"tool_portal_{operation_name}", expected_arguments)]


@pytest.mark.parametrize(
    ("operation_name", "operation_request", "raw_result"),
    PORTAL_OPERATION_CASES,
    ids=[operation_name for operation_name, _, _ in PORTAL_OPERATION_CASES],
)
def test_gateway_runtime_client_exposes_all_typed_portal_operations_with_exact_methods(
    operation_name: str,
    operation_request: Mapping[str, object],
    raw_result: Mapping[str, object],
) -> None:
    # Arrange
    validated_request = _validated_contract_model(
        f"portal.{operation_name}.request",
        operation_request,
    )
    expected_params = {
        "publicRequest": validated_request.model_dump(
            by_alias=True,
            exclude_none=True,
            mode="json",
        ),
        "trustedContext": CURRENT_TRUSTED_INVOCATION_CONTEXT,
    }
    expected_result = _validated_contract_model(f"portal.{operation_name}.result", raw_result)
    transport = FakeGatewayRuntimeTransport(
        method_results={f"portal.{operation_name}": (raw_result,)},
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())
    operation = t.cast("PortalOperation", getattr(client.portal, operation_name))

    # Act
    result = asyncio.run(
        operation(
            operation_request,
            trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
        ),
    )

    # Assert
    assert isinstance(result, BaseModel)
    assert type(result).__name__ == type(expected_result).__name__
    assert result.model_dump(by_alias=True, exclude_none=True, mode="json") == raw_result
    assert transport.requests == [(f"portal.{operation_name}", expected_params)]


@pytest.mark.parametrize(
    "trace_context",
    [
        SAMPLED_TRACE_CONTEXT,
        UNSAMPLED_TRACE_CONTEXT,
        FUTURE_VERSION_TRACE_CONTEXT,
        EMPTY_TRACESTATE_CONTEXT,
        OWS_AND_EMPTY_MEMBER_TRACESTATE_CONTEXT,
    ],
    ids=[
        "sampled",
        "unsampled",
        "future-version",
        "empty-tracestate",
        "ows-and-empty-member-tracestate",
    ],
)
def test_gateway_runtime_client_adds_canonical_trace_context_as_private_transport_metadata(
    trace_context: Mapping[str, object],
) -> None:
    # Arrange
    validated_request = _validated_contract_model("portal.list.request", PORTAL_LIST_REQUEST)
    transport = FakeGatewayRuntimeTransport(
        method_results={"portal.list": (PORTAL_LIST_RESULT,)},
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        trace_context_provider=lambda: trace_context,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act
    _ = asyncio.run(
        client.portal.list(
            PORTAL_LIST_REQUEST,
            trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
        ),
    )

    # Assert
    request_envelope = transport.requests[0][1]
    assert request_envelope == {
        "publicRequest": validated_request.model_dump(by_alias=True, exclude_none=True, mode="json"),
        "traceContext": trace_context,
        "trustedContext": CURRENT_TRUSTED_INVOCATION_CONTEXT,
    }
    assert "traceContext" not in t.cast("Mapping[str, object]", request_envelope["publicRequest"])


@pytest.mark.parametrize(
    "trace_context",
    [
        {"traceparent": "00-00000000000000000000000000000000-00f067aa0ba902b7-01"},
        {"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"},
        {"traceparent": f"{SAMPLED_TRACE_CONTEXT['traceparent']}-future"},
        {"traceparent": "00-4BF92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
        {"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0g"},
        {"traceparent": "0g-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
        {"traceparent": "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
        {"traceparent": f"01-{'a' * 509}"},
        {
            "traceparent": SAMPLED_TRACE_CONTEXT["traceparent"],
            "tracestate": f"vendor={'a' * 506}",
        },
        {
            "traceparent": SAMPLED_TRACE_CONTEXT["traceparent"],
            "tracestate": "vendor=one,vendor=two",
        },
        {
            "traceparent": SAMPLED_TRACE_CONTEXT["traceparent"],
            "tracestate": "1vendor=value",
        },
        {
            "traceparent": SAMPLED_TRACE_CONTEXT["traceparent"],
            "tracestate": "tenant@1system=value",
        },
        {
            "traceparent": SAMPLED_TRACE_CONTEXT["traceparent"],
            "tracestate": "tenant@system@extra=value",
        },
        {
            "traceparent": SAMPLED_TRACE_CONTEXT["traceparent"],
            "tracestate": ",".join(f"v{index}=x" for index in range(33)),
        },
        {
            "traceparent": SAMPLED_TRACE_CONTEXT["traceparent"],
            "tracestate": "Vendor=value",
        },
        {
            "traceparent": SAMPLED_TRACE_CONTEXT["traceparent"],
            "tracestate": "vendor=line\nbreak",
        },
        {"traceparent": SAMPLED_TRACE_CONTEXT["traceparent"], "traceState": "vendor=value"},
        {"traceparent": SAMPLED_TRACE_CONTEXT["traceparent"], "baggage": "secret=value"},
    ],
    ids=[
        "zero-trace-id",
        "zero-span-id",
        "version-00-extension",
        "uppercase-hex",
        "malformed-flags",
        "malformed-version",
        "forbidden-version",
        "oversized-traceparent",
        "oversized-tracestate",
        "duplicate-tracestate-key",
        "digit-starting-simple-key",
        "malformed-multi-tenant-key",
        "multiple-tenant-delimiters",
        "too-many-tracestate-members",
        "uppercase-tracestate-key",
        "tracestate-control-character",
        "unknown-field",
        "baggage",
    ],
)
def test_gateway_runtime_client_rejects_invalid_trace_context_before_transport(
    trace_context: Mapping[str, object],
) -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport(
        method_results={"portal.list": (PORTAL_LIST_RESULT,)},
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        trace_context_provider=lambda: trace_context,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act / Assert
    with pytest.raises(ValidationError):
        _ = asyncio.run(
            client.portal.list(
                PORTAL_LIST_REQUEST,
                trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
            ),
        )
    assert transport.requests == []


@pytest.mark.parametrize("structured_content", [PORTAL_CALL_SUCCESS, PORTAL_CALL_ERROR])
def test_mcp_client_decodes_canonical_success_and_error_items_as_typed_results(
    structured_content: Mapping[str, object],
) -> None:
    # Arrange
    transport = FakeToolPortalMcpTransport(structured_content)
    client = _tool_portal_mcp_client_factory()(transport=transport)

    # Act
    result = asyncio.run(client.call(PORTAL_CALL_REQUEST))

    # Assert
    assert isinstance(result, BaseModel)
    assert result.model_dump(by_alias=True, mode="json") == structured_content
    assert transport.tool_calls == [("tool_portal_call", PORTAL_CALL_REQUEST)]


def test_mcp_client_forwards_one_exact_batch_approval_token_as_protected_metadata() -> None:
    # Arrange
    transport = FakeToolPortalMcpTransport(PORTAL_CALL_SUCCESS)
    client = _tool_portal_mcp_client_factory()(transport=transport)
    approval_proof = secrets.token_urlsafe(24)

    # Act
    result = asyncio.run(
        client.call(
            PORTAL_CALL_REQUEST,
            approval_token=approval_proof,
        ),
    )

    # Assert
    assert isinstance(result, BaseModel)
    assert transport.tool_calls == [("tool_portal_call", PORTAL_CALL_REQUEST)]
    assert transport.tool_call_metadata == [
        {
            "agent-vm/tool-portal-approval-token": approval_proof,
        },
    ]
    assert "approvalToken" not in PORTAL_CALL_REQUEST


def test_mcp_client_reads_one_bounded_artifact_from_one_blob_resource() -> None:
    # Arrange
    transport = FakeArtifactToolPortalMcpTransport(
        (
            {
                "blob": PORTAL_ARTIFACT_READ_RESULT["contentBase64"],
                "mimeType": "text/plain",
            },
        ),
    )
    client = _tool_portal_mcp_client_factory()(transport=transport)

    # Act
    result = asyncio.run(client.artifacts.read(PORTAL_ARTIFACT_READ_REQUEST))

    # Assert
    assert isinstance(result, BaseModel)
    assert result.model_dump(by_alias=True, exclude_none=True, mode="json") == PORTAL_ARTIFACT_READ_RESULT
    assert transport.tool_calls == []
    assert transport.resource_requests == [PORTAL_ARTIFACT_MCP_RESOURCE_REQUEST]


@pytest.mark.parametrize(
    "resource_bodies",
    [
        (),
        (
            {"blob": PORTAL_ARTIFACT_READ_RESULT["contentBase64"], "mimeType": "text/plain"},
            {"blob": PORTAL_ARTIFACT_READ_RESULT["contentBase64"], "mimeType": "text/plain"},
        ),
        ({"mimeType": "text/plain", "text": "hello"},),
    ],
    ids=["missing-resource", "multiple-resources", "text-resource"],
)
def test_mcp_client_rejects_malformed_artifact_resources(
    resource_bodies: tuple[Mapping[str, object], ...],
) -> None:
    # Arrange
    transport = FakeArtifactToolPortalMcpTransport(resource_bodies)
    client = _tool_portal_mcp_client_factory()(transport=transport)

    # Act / Assert
    with pytest.raises((TypeError, ValidationError)):
        _ = asyncio.run(client.artifacts.read(PORTAL_ARTIFACT_READ_REQUEST))
    assert transport.tool_calls == []
    assert len(transport.resource_requests) == 1


@pytest.mark.parametrize(
    "invalid_request",
    [
        {"maxBytes": 5, "offsetBytes": 0, "reference": {"id": "artifact-1"}},
        {**PORTAL_ARTIFACT_READ_REQUEST, "authority": "client-authored-authority"},
    ],
    ids=["id-only-reference", "authority-field"],
)
def test_mcp_client_rejects_invalid_public_artifact_requests_before_transport(
    invalid_request: Mapping[str, object],
) -> None:
    # Arrange
    transport = FakeArtifactToolPortalMcpTransport(
        ({"blob": PORTAL_ARTIFACT_READ_RESULT["contentBase64"], "mimeType": "text/plain"},),
    )
    client = _tool_portal_mcp_client_factory()(transport=transport)

    # Act / Assert
    with pytest.raises(ValidationError):
        _ = asyncio.run(client.artifacts.read(invalid_request))
    assert transport.tool_calls == []
    assert transport.resource_requests == []


def test_gateway_runtime_client_uses_fixed_socket_and_binds_complete_handshake() -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport()
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )

    # Act
    asyncio.run(client.connect())

    # Assert
    assert transport.connected_socket_paths == [DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH]
    assert transport.handshakes == [CURRENT_ATTACHMENT]
    assert transport.requests == []


def test_gateway_runtime_client_sends_one_strict_private_approval_decision() -> None:
    # Arrange
    request: JsonObject = {
        "challengeId": "11111111-1111-4111-8111-111111111111",
        "decision": "approve",
    }
    result: JsonObject = {"kind": "recorded", "state": "approved"}
    transport = FakeGatewayRuntimeTransport(method_results={"approval.decide": (result,)})
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act
    decision_result = asyncio.run(
        client.approvals.decide(
            request,
            trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
        ),
    )

    # Assert
    assert decision_result.model_dump(by_alias=True, mode="json") == result
    assert transport.requests == [
        (
            "approval.decide",
            {
                "publicRequest": request,
                "trustedContext": CURRENT_TRUSTED_INVOCATION_CONTEXT,
            },
        ),
    ]


def test_gateway_runtime_client_rejects_calls_before_handshake() -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport(
        method_results={"portal.call": (PORTAL_CALL_SUCCESS,)},
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )

    # Act
    error = _captured_gateway_error(
        lambda: client.portal.call(
            PORTAL_CALL_REQUEST,
            trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
        ),
    )

    # Assert
    assert type(error).__module__ == GATEWAY_RUNTIME_CLIENT_MODULE
    assert _error_code(error) == "handshake-required"
    assert transport.requests == []


@pytest.mark.parametrize(
    ("field_name", "replacement", "rejection_code"),
    [
        ("protocolVersion", 2, "protocol-version-mismatch"),
        ("schemaVersion", 2, "schema-version-mismatch"),
        ("gatewayEpoch", "gateway-epoch-stale", "stale-gateway-epoch"),
        ("runtimeEpoch", "runtime-epoch-stale", "stale-runtime-epoch"),
        ("frameworkEpoch", "framework-epoch-stale", "stale-framework-epoch"),
        (
            "projectionCohortDigest",
            f"projection-cohort:{'b' * 64}",
            "wrong-projection-cohort",
        ),
        ("attachmentGeneration", 6, "stale-attachment-generation"),
        ("clientKind", "openclaw-managed-plugin", "wrong-client-kind"),
        ("configuredAgentIds", ["main", "unknown"], "wrong-configured-agent-set"),
    ],
)
def test_gateway_runtime_client_surfaces_handshake_binding_rejections(
    field_name: str,
    replacement: object,
    rejection_code: str,
) -> None:
    # Arrange
    attachment = {**CURRENT_ATTACHMENT, field_name: replacement}
    transport = FakeGatewayRuntimeTransport(
        handshake_decisions=({"code": rejection_code, "kind": "rejected"},),
    )
    client = _gateway_runtime_client_factory()(
        attachment=attachment,
        transport=transport,
    )

    # Act
    error = _captured_gateway_error(client.connect)

    # Assert
    assert type(error).__module__ == GATEWAY_RUNTIME_CLIENT_MODULE
    assert _error_code(error) == rejection_code
    assert transport.handshakes == [attachment]
    assert transport.requests == []


@pytest.mark.parametrize(
    "injected_field",
    ["authority", "surface", "principal", "allowedOperationGroups", "operationGroups"],
)
def test_gateway_runtime_client_rejects_public_authority_injection(
    injected_field: str,
) -> None:
    # Arrange
    attachment = {**CURRENT_ATTACHMENT, injected_field: "forbidden"}
    transport = FakeGatewayRuntimeTransport()

    # Act
    error = _captured_gateway_error(
        lambda: _gateway_runtime_client_factory()(
            attachment=attachment,
            transport=transport,
        ).connect(),
    )

    # Assert
    assert type(error).__module__ == GATEWAY_RUNTIME_CLIENT_MODULE
    assert _error_code(error) == "public-authority-injection"
    assert transport.connected_socket_paths == []
    assert transport.handshakes == []


@pytest.mark.parametrize(
    ("field_name", "invalid_value"),
    [
        ("attachmentGeneration", 9_007_199_254_740_992),
        ("configuredAgentIds", [f"agent-{index}" for index in range(129)]),
        ("frameworkEpoch", "e" * 257),
    ],
    ids=["unsafe-generation", "too-many-agent-ids", "epoch-too-long"],
)
def test_gateway_runtime_client_enforces_generated_attachment_bounds(
    field_name: str,
    invalid_value: object,
) -> None:
    # Arrange
    attachment = {**CURRENT_ATTACHMENT, field_name: invalid_value}
    transport = FakeGatewayRuntimeTransport()

    # Act
    error = _captured_gateway_error(
        lambda: _gateway_runtime_client_factory()(
            attachment=attachment,
            transport=transport,
        ).connect(),
    )

    # Assert
    assert _error_code(error) == "invalid-attachment"
    assert transport.connected_socket_paths == []
    assert transport.handshakes == []


@pytest.mark.parametrize("unknown_field", ["connectionId", "kind", "unexpectedField"])
def test_gateway_runtime_client_rejects_unknown_attachment_fields_before_transport(
    unknown_field: str,
) -> None:
    # Arrange
    attachment = {**CURRENT_ATTACHMENT, unknown_field: "client-supplied"}
    transport = FakeGatewayRuntimeTransport()

    # Act
    error = _captured_gateway_error(
        lambda: _gateway_runtime_client_factory()(
            attachment=attachment,
            transport=transport,
        ).connect(),
    )

    # Assert
    assert type(error).__module__ == GATEWAY_RUNTIME_CLIENT_MODULE
    assert _error_code(error) == "invalid-attachment"
    assert transport.connected_socket_paths == []
    assert transport.handshakes == []


def test_gateway_runtime_client_decodes_typed_portal_result_after_handshake() -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport(
        method_results={"portal.call": (PORTAL_CALL_ERROR,)},
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act
    result = asyncio.run(
        client.portal.call(
            PORTAL_CALL_REQUEST,
            trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
        ),
    )

    # Assert
    assert isinstance(result, BaseModel)
    assert result.model_dump(by_alias=True, mode="json") == PORTAL_CALL_ERROR
    assert transport.requests == [
        (
            "portal.call",
            {
                "publicRequest": PORTAL_CALL_REQUEST,
                "trustedContext": CURRENT_TRUSTED_INVOCATION_CONTEXT,
            },
        ),
    ]


def test_gateway_runtime_client_reads_artifact_with_exact_private_uds_params() -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport(
        method_results={"artifact.read": (PORTAL_ARTIFACT_READ_RESULT,)},
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act
    result = asyncio.run(
        client.artifacts.read(
            PORTAL_ARTIFACT_READ_REQUEST,
            trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
        ),
    )

    # Assert
    assert isinstance(result, BaseModel)
    assert result.model_dump(by_alias=True, exclude_none=True, mode="json") == PORTAL_ARTIFACT_READ_RESULT
    assert transport.requests == [
        (
            "artifact.read",
            {
                "publicRequest": PORTAL_ARTIFACT_READ_REQUEST,
                "trustedContext": CURRENT_TRUSTED_INVOCATION_CONTEXT,
            },
        ),
    ]


@pytest.mark.parametrize(
    "trusted_context",
    [
        {
            **CURRENT_TRUSTED_INVOCATION_CONTEXT,
            "principal": {
                field_name: field_value
                for field_name, field_value in t.cast("Mapping[str, object]", CURRENT_TRUSTED_INVOCATION_CONTEXT["principal"]).items()
                if field_name != "agentId"
            },
        },
        {**CURRENT_TRUSTED_INVOCATION_CONTEXT, "authority": "client-selected"},
        {
            **CURRENT_TRUSTED_INVOCATION_CONTEXT,
            "principal": {
                **t.cast("Mapping[str, object]", CURRENT_TRUSTED_INVOCATION_CONTEXT["principal"]),
                "frameworkIdentity": {"kind": "unknown-framework", "profileName": "main"},
            },
        },
        {
            **CURRENT_TRUSTED_INVOCATION_CONTEXT,
            "principal": {
                **t.cast("Mapping[str, object]", CURRENT_TRUSTED_INVOCATION_CONTEXT["principal"]),
                "toolPortalProfileId": "p" * 257,
            },
        },
    ],
    ids=["missing-required", "unknown-field", "invalid-enum", "field-above-bound"],
)
def test_gateway_runtime_client_rejects_invalid_trusted_context_before_transport(
    trusted_context: Mapping[str, object],
) -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport(
        method_results={"portal.call": (PORTAL_CALL_SUCCESS,)},
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act / Assert
    with pytest.raises(ValidationError):
        _ = asyncio.run(
            client.portal.call(
                PORTAL_CALL_REQUEST,
                trusted_context=trusted_context,
            ),
        )
    assert transport.requests == []


def test_gateway_runtime_client_places_only_normalized_trusted_context_in_portal_envelope() -> None:
    # Arrange
    trusted_context = {
        field_name: field_value for field_name, field_value in reversed(tuple(CURRENT_TRUSTED_INVOCATION_CONTEXT.items())) if field_name != "correlation"
    }
    transport = FakeGatewayRuntimeTransport(
        method_results={"portal.call": (PORTAL_CALL_SUCCESS,)},
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act
    _ = asyncio.run(
        client.portal.call(
            PORTAL_CALL_REQUEST,
            trusted_context=trusted_context,
        ),
    )

    # Assert
    request_envelope = transport.requests[0][1]
    normalized_context = request_envelope["trustedContext"]
    assert normalized_context == trusted_context
    assert normalized_context is not trusted_context


def test_gateway_runtime_client_places_only_normalized_trusted_context_in_artifact_envelope() -> None:
    # Arrange
    trusted_context = {
        field_name: field_value for field_name, field_value in reversed(tuple(CURRENT_TRUSTED_INVOCATION_CONTEXT.items())) if field_name != "correlation"
    }
    transport = FakeGatewayRuntimeTransport(
        method_results={"artifact.read": (PORTAL_ARTIFACT_READ_RESULT,)},
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act
    _ = asyncio.run(
        client.artifacts.read(
            PORTAL_ARTIFACT_READ_REQUEST,
            trusted_context=trusted_context,
        ),
    )

    # Assert
    request_envelope = transport.requests[0][1]
    normalized_context = request_envelope["trustedContext"]
    assert normalized_context == trusted_context
    assert normalized_context is not trusted_context


@pytest.mark.parametrize(
    "invalid_request",
    [
        {"maxBytes": 5, "offsetBytes": 0, "reference": {"id": "artifact-1"}},
        {**PORTAL_ARTIFACT_READ_REQUEST, "authority": "client-authored-authority"},
    ],
    ids=["id-only-reference", "authority-field"],
)
def test_gateway_runtime_client_rejects_invalid_public_artifact_requests_before_transport(
    invalid_request: Mapping[str, object],
) -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport(
        method_results={"artifact.read": (PORTAL_ARTIFACT_READ_RESULT,)},
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act / Assert
    with pytest.raises(ValidationError):
        _ = asyncio.run(
            client.artifacts.read(
                invalid_request,
                trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
            ),
        )
    assert transport.requests == []


def test_gateway_runtime_client_reconnects_only_after_disconnect_with_current_attachment() -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport(
        handshake_decisions=({"kind": "accepted"}, {"kind": "accepted"}),
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )

    # Act
    asyncio.run(client.connect())
    asyncio.run(client.reconnect())

    # Assert
    assert transport.connected_socket_paths == [
        DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
        DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
    ]
    assert transport.handshakes == [CURRENT_ATTACHMENT, CURRENT_ATTACHMENT]
    assert transport.disconnect_count == 1


def test_gateway_runtime_client_serializes_concurrent_reconnect_custody() -> None:
    async def run_concurrent_reconnects() -> tuple[BlockingReconnectGatewayRuntimeTransport, int]:
        reconnect_connect_started = asyncio.Event()
        release_reconnect_connect = asyncio.Event()
        second_reconnect_attempted = asyncio.Event()
        transport = BlockingReconnectGatewayRuntimeTransport(
            reconnect_connect_started=reconnect_connect_started,
            release_reconnect_connect=release_reconnect_connect,
        )
        client = _gateway_runtime_client_factory()(
            attachment=CURRENT_ATTACHMENT,
            transport=transport,
        )
        await client.connect()

        first_reconnect = asyncio.create_task(client.reconnect())
        await reconnect_connect_started.wait()

        async def run_second_reconnect() -> None:
            second_reconnect_attempted.set()
            await client.reconnect()

        second_reconnect = asyncio.create_task(run_second_reconnect())
        await second_reconnect_attempted.wait()
        disconnects_during_first_reconnect = transport.disconnect_count
        release_reconnect_connect.set()
        await asyncio.gather(first_reconnect, second_reconnect)
        return transport, disconnects_during_first_reconnect

    # Act
    transport, disconnects_during_first_reconnect = asyncio.run(run_concurrent_reconnects())

    # Assert
    assert disconnects_during_first_reconnect == 1
    assert transport.disconnect_count == 2
    assert transport.connected_socket_paths == [DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH] * 3
    assert transport.handshakes == [CURRENT_ATTACHMENT] * 3


def test_gateway_runtime_client_does_not_apply_startup_publication_retry_to_reconnect() -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport(
        connect_errors=(None, FileNotFoundError("previously attached socket disappeared")),
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        startup_retry_policy=_gateway_runtime_startup_retry_policy(maximum_attempts=3),
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act / Assert
    with pytest.raises(_gateway_runtime_startup_unavailable_error_type()) as captured_error:
        _ = asyncio.run(client.reconnect())
    assert getattr(captured_error.value, "kind", None) == "socket-absent"
    assert transport.connected_socket_paths == [
        DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
        DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
    ]
    assert transport.handshakes == [CURRENT_ATTACHMENT]


def test_gateway_runtime_client_retries_only_bounded_prepublication_socket_failures() -> None:
    # Arrange
    retry_scheduler = DeterministicGatewayRuntimeStartupRetryScheduler()
    transport = FakeGatewayRuntimeTransport(
        connect_errors=(
            FileNotFoundError("socket is not published"),
            ConnectionRefusedError("socket is not accepting connections"),
            None,
        ),
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        startup_retry_policy=_gateway_runtime_startup_retry_policy(),
        startup_retry_scheduler=retry_scheduler,
        transport=transport,
    )

    # Act
    asyncio.run(client.connect())

    # Assert
    assert transport.connected_socket_paths == [DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH] * 3
    assert transport.handshakes == [CURRENT_ATTACHMENT]
    assert retry_scheduler.waits == [1, 1]


def test_gateway_runtime_client_fails_after_the_bounded_startup_attempt_budget() -> None:
    # Arrange
    retry_scheduler = DeterministicGatewayRuntimeStartupRetryScheduler()
    transport = FakeGatewayRuntimeTransport(
        connect_errors=tuple(FileNotFoundError("socket is not published") for _ in range(3)),
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        startup_retry_policy=_gateway_runtime_startup_retry_policy(maximum_attempts=3),
        startup_retry_scheduler=retry_scheduler,
        transport=transport,
    )

    # Act
    error = _captured_gateway_error(client.connect)

    # Assert
    assert _error_code(error) == "startup-retry-exhausted"
    assert isinstance(error.__cause__, _gateway_runtime_startup_unavailable_error_type())
    assert getattr(error.__cause__, "kind", None) == "socket-absent"
    assert transport.connected_socket_paths == [DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH] * 3
    assert transport.handshakes == []
    assert retry_scheduler.waits == [1, 1]


def test_gateway_runtime_client_exhausts_startup_retry_at_injected_deadline() -> None:
    # Arrange
    retry_scheduler = DeterministicGatewayRuntimeStartupRetryScheduler()
    transport = FakeGatewayRuntimeTransport(
        connect_errors=(FileNotFoundError("socket is not published"),),
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        startup_retry_policy=_gateway_runtime_startup_retry_policy(
            deadline_milliseconds=2,
            maximum_attempts=100,
            retry_interval_milliseconds=2,
        ),
        startup_retry_scheduler=retry_scheduler,
        transport=transport,
    )

    # Act
    error = _captured_gateway_error(client.connect)

    # Assert
    assert _error_code(error) == "startup-retry-exhausted"
    assert getattr(error, "attempts", None) == 1
    assert retry_scheduler.waits == [2]
    assert transport.connected_socket_paths == [DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH]


def test_gateway_runtime_client_rejects_an_unbounded_startup_retry_policy() -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport()

    # Act
    error = _captured_gateway_error(
        lambda: _gateway_runtime_client_factory()(
            attachment=CURRENT_ATTACHMENT,
            startup_retry_policy={
                "deadlineMs": 60_001,
                "intervalMs": 1,
                "maxAttempts": 1_001,
            },
            transport=transport,
        ).connect(),
    )

    # Assert
    assert _error_code(error) == "invalid-startup-retry-policy"
    assert transport.connected_socket_paths == []


def test_gateway_runtime_client_does_not_retry_permission_or_handshake_failures() -> None:
    # Arrange
    permission_transport = FakeGatewayRuntimeTransport(
        connect_errors=(PermissionError("socket permission denied"),),
    )
    permission_client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        startup_retry_policy=_gateway_runtime_startup_retry_policy(),
        transport=permission_transport,
    )
    handshake_transport = FakeGatewayRuntimeTransport(
        handshake_decisions=({"code": "schema-version-mismatch", "kind": "rejected"},),
    )
    handshake_client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        startup_retry_policy=_gateway_runtime_startup_retry_policy(),
        transport=handshake_transport,
    )

    # Act / Assert
    with pytest.raises(PermissionError):
        _ = asyncio.run(permission_client.connect())
    handshake_error = _captured_gateway_error(handshake_client.connect)
    assert _error_code(handshake_error) == "schema-version-mismatch"
    assert permission_transport.connected_socket_paths == [DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH]
    assert handshake_transport.connected_socket_paths == [DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH]
    assert handshake_transport.handshakes == [CURRENT_ATTACHMENT]


def test_gateway_runtime_client_does_not_reclassify_transport_timeout_as_startup_absence() -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport(
        connect_errors=(TimeoutError("transport connect timed out"),),
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        startup_retry_policy=_gateway_runtime_startup_retry_policy(),
        transport=transport,
    )

    # Act / Assert
    with pytest.raises(TimeoutError, match="transport connect timed out"):
        _ = asyncio.run(client.connect())
    assert transport.connected_socket_paths == [DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH]
    assert transport.handshakes == []


def test_gateway_runtime_client_startup_retry_is_abortable() -> None:
    async def cancel_startup_retry() -> tuple[FakeGatewayRuntimeTransport, DeterministicGatewayRuntimeStartupRetryScheduler]:
        wait_started = asyncio.Event()
        release_wait = asyncio.Event()
        retry_scheduler = DeterministicGatewayRuntimeStartupRetryScheduler(
            wait_started=wait_started,
            release_wait=release_wait,
        )
        transport = FakeGatewayRuntimeTransport(
            connect_errors=(FileNotFoundError("socket is not published"),),
        )
        client = _gateway_runtime_client_factory()(
            attachment=CURRENT_ATTACHMENT,
            startup_retry_policy=_gateway_runtime_startup_retry_policy(
                deadline_milliseconds=60_000,
                maximum_attempts=100,
                retry_interval_milliseconds=60_000,
            ),
            startup_retry_scheduler=retry_scheduler,
            transport=transport,
        )
        connect_task = asyncio.create_task(client.connect())
        await wait_started.wait()
        connect_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await connect_task
        return transport, retry_scheduler

    # Act
    transport, retry_scheduler = asyncio.run(cancel_startup_retry())

    # Assert
    assert transport.connected_socket_paths == [DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH]
    assert transport.handshakes == []
    assert retry_scheduler.waits == [60_000]


@pytest.mark.parametrize(
    "rejection_code",
    [
        "duplicate-active-connection",
        "replayed-connection",
        "retired-attachment",
    ],
)
def test_gateway_runtime_client_rejects_duplicate_replay_and_retired_reconnects(
    rejection_code: str,
) -> None:
    # Arrange
    transport = FakeGatewayRuntimeTransport(
        handshake_decisions=(
            {"kind": "accepted"},
            {"code": rejection_code, "kind": "rejected"},
        ),
    )
    client = _gateway_runtime_client_factory()(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())
    asyncio.run(client.disconnect())

    # Act
    error = _captured_gateway_error(client.connect)

    # Assert
    assert type(error).__module__ == GATEWAY_RUNTIME_CLIENT_MODULE
    assert _error_code(error) == rejection_code
    assert transport.handshakes == [CURRENT_ATTACHMENT, CURRENT_ATTACHMENT]
