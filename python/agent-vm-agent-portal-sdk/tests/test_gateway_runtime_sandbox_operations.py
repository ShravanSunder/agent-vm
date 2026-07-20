import asyncio
import json
import typing as t
from collections.abc import Mapping
from pathlib import Path

import pytest
from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from agent_vm_agent_portal_sdk.gateway_runtime_sandbox_operations import (
    SandboxWireMethod,
    _sandbox_method_schema_ids,
)
from pydantic import BaseModel, ValidationError

type JsonObject = dict[str, object]
type SandboxOperation = t.Callable[..., t.Coroutine[object, object, BaseModel]]
type SandboxProjectionCase = tuple[str, str, SandboxWireMethod]


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
PORTABLE_CONTRACT_COVERAGE_ROOT = REPOSITORY_ROOT / "packages" / "agent-portal-sdk" / "contract-fixtures" / "portable-contracts" / "coverage"

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
}

SANDBOX_PROJECTION_CASES: tuple[SandboxProjectionCase, ...] = (
    ("environment", "open", "sandbox.environment.open"),
    ("environment", "close", "sandbox.environment.close"),
    ("environment", "status", "sandbox.environment.status"),
    ("execution", "start", "sandbox.exec.start"),
    ("execution", "wait", "sandbox.exec.wait"),
    ("execution", "cancel", "sandbox.exec.cancel"),
    ("retained_results", "lookup", "sandbox.retained-result.lookup"),
    ("filesystem", "stat", "sandbox.fs.stat"),
    ("filesystem", "list", "sandbox.fs.list"),
    ("filesystem", "read", "sandbox.fs.read"),
    ("filesystem", "write", "sandbox.fs.write"),
    ("filesystem", "mkdir", "sandbox.fs.mkdir"),
    ("filesystem", "rename", "sandbox.fs.rename"),
    ("filesystem", "remove", "sandbox.fs.remove"),
    ("process", "start", "sandbox.process.start"),
    ("process", "status", "sandbox.process.status"),
    ("process", "wait", "sandbox.process.wait"),
    ("process", "logs", "sandbox.process.logs"),
    ("process", "cancel", "sandbox.process.cancel"),
    ("stream", "read", "sandbox.stream.read"),
    ("stream", "write", "sandbox.stream.write"),
    ("stream", "close", "sandbox.stream.close"),
    ("terminal", "attach", "sandbox.terminal.attach"),
    ("terminal", "resize", "sandbox.terminal.resize"),
)


def _require_json_object(value: object, *, label: str) -> JsonObject:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        invalid_object_message = f"{label} must be a JSON object."
        raise TypeError(invalid_object_message)
    return t.cast("JsonObject", value)


def _load_accepted_contract_values() -> Mapping[str, tuple[JsonObject, JsonObject]]:
    required_schema_ids = {schema_id for _, _, wire_method in SANDBOX_PROJECTION_CASES for schema_id in _sandbox_method_schema_ids(wire_method)}
    accepted_values: dict[str, tuple[JsonObject, JsonObject]] = {}
    for fixture_path in sorted(PORTABLE_CONTRACT_COVERAGE_ROOT.parent.rglob("*.fixture.json")):
        fixture = _require_json_object(
            json.loads(fixture_path.read_text(encoding="utf-8")),
            label=fixture_path.as_posix(),
        )
        schema_id = fixture.get("schemaId")
        if not isinstance(schema_id, str) or schema_id not in required_schema_ids:
            continue
        expectation = _require_json_object(
            fixture.get("expectation"),
            label=f"{fixture_path.as_posix()}.expectation",
        )
        if expectation.get("kind") != "accepted":
            continue
        accepted_values[schema_id] = (
            _require_json_object(fixture.get("input"), label=f"{fixture_path.as_posix()}.input"),
            _require_json_object(
                expectation.get("normalized"),
                label=f"{fixture_path.as_posix()}.expectation.normalized",
            ),
        )
    missing_schema_ids = required_schema_ids - accepted_values.keys()
    if missing_schema_ids:
        missing_fixtures_message = f"Missing accepted sandbox fixtures: {sorted(missing_schema_ids)}"
        raise AssertionError(missing_fixtures_message)
    return accepted_values


ACCEPTED_CONTRACT_VALUES = _load_accepted_contract_values()


def _public_attribute_names(value: object) -> set[str]:
    return {attribute_name for attribute_name in dir(value) if not attribute_name.startswith("_")}


class RecordingGatewayRuntimeTransport:
    def __init__(
        self,
        *,
        result_overrides: Mapping[str, Mapping[str, object]] | None = None,
    ) -> None:
        self.requests: list[tuple[str, Mapping[str, object]]] = []
        self._result_overrides = result_overrides or {}

    async def connect(self, socket_path: str) -> None:
        _ = socket_path

    async def handshake(self, attachment: Mapping[str, object]) -> Mapping[str, object]:
        _ = attachment
        return {"kind": "accepted"}

    async def request(
        self,
        method: str,
        params: Mapping[str, object],
    ) -> Mapping[str, object]:
        self.requests.append((method, params))
        if method in self._result_overrides:
            return self._result_overrides[method]
        wire_method = t.cast("SandboxWireMethod", method)
        _, result_schema_id = _sandbox_method_schema_ids(wire_method)
        return ACCEPTED_CONTRACT_VALUES[result_schema_id][0]

    async def disconnect(self) -> None:
        return None


def test_gateway_runtime_client_exposes_exact_canonical_sandbox_surface() -> None:
    # Arrange
    client = GatewayRuntimeClient(
        attachment=CURRENT_ATTACHMENT,
        transport=RecordingGatewayRuntimeTransport(),
    )
    expected_operations_by_group: dict[str, set[str]] = {}
    for group_name, operation_name, _ in SANDBOX_PROJECTION_CASES:
        expected_operations_by_group.setdefault(group_name, set()).add(operation_name)
    expected_wire_methods = {wire_method for _, _, wire_method in SANDBOX_PROJECTION_CASES}
    canonical_sandbox_wire_methods = {
        wire_method
        for _, _, wire_method in SANDBOX_PROJECTION_CASES
        if all(schema_id in PORTABLE_CONTRACT_ADAPTERS for schema_id in _sandbox_method_schema_ids(wire_method))
    }

    # Act
    actual_group_names = _public_attribute_names(client.sandbox)
    actual_operations_by_group = {group_name: _public_attribute_names(getattr(client.sandbox, group_name)) for group_name in expected_operations_by_group}

    # Assert
    assert expected_wire_methods == canonical_sandbox_wire_methods
    assert actual_group_names == set(expected_operations_by_group)
    assert actual_operations_by_group == expected_operations_by_group
    assert sum(len(operation_names) for operation_names in actual_operations_by_group.values()) == 24
    assert all(
        callable(getattr(getattr(client.sandbox, group_name), operation_name))
        for group_name, operation_names in actual_operations_by_group.items()
        for operation_name in operation_names
    )


def test_gateway_runtime_client_exposes_retained_result_lookup() -> None:
    # Arrange
    client = GatewayRuntimeClient(
        attachment=CURRENT_ATTACHMENT,
        transport=RecordingGatewayRuntimeTransport(),
    )

    # Act
    retained_result_lookup = getattr(client.sandbox.retained_results, "lookup", None)

    # Assert
    assert callable(retained_result_lookup)


def test_gateway_runtime_client_adds_trace_context_to_sandbox_transport_without_changing_public_request() -> None:
    # Arrange
    transport = RecordingGatewayRuntimeTransport()
    client = GatewayRuntimeClient(
        attachment=CURRENT_ATTACHMENT,
        trace_context_provider=lambda: SAMPLED_TRACE_CONTEXT,
        transport=transport,
    )
    request_schema_id, _ = _sandbox_method_schema_ids("sandbox.environment.open")
    public_request = ACCEPTED_CONTRACT_VALUES[request_schema_id][0]
    asyncio.run(client.connect())

    # Act
    _ = asyncio.run(
        client.sandbox.environment.open(
            public_request,
            trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
        ),
    )

    # Assert
    request_envelope = transport.requests[0][1]
    assert request_envelope["traceContext"] == SAMPLED_TRACE_CONTEXT
    assert request_envelope["publicRequest"] == public_request
    assert "traceContext" not in t.cast("Mapping[str, object]", request_envelope["publicRequest"])


def test_retained_result_lookup_does_not_replay_execution() -> None:
    async def invoke_lookup() -> tuple[RecordingGatewayRuntimeTransport, BaseModel]:
        transport = RecordingGatewayRuntimeTransport(
            result_overrides={
                "sandbox.retained-result.lookup": {
                    "kind": "unavailable",
                    "reason": "not-retained-or-not-authorized",
                },
            },
        )
        client = GatewayRuntimeClient(
            attachment=CURRENT_ATTACHMENT,
            transport=transport,
        )
        await client.connect()
        result = await client.sandbox.retained_results.lookup(
            {"operation": {"operationId": "operation-1", "owningGeneration": "generation-1"}},
            trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
        )
        return transport, result

    # Act
    transport, result = asyncio.run(invoke_lookup())

    # Assert
    assert result.model_dump(by_alias=True, exclude_none=True, mode="json") == {
        "kind": "unavailable",
        "reason": "not-retained-or-not-authorized",
    }
    assert transport.requests == [
        (
            "sandbox.retained-result.lookup",
            {
                "publicRequest": {
                    "operation": {
                        "operationId": "operation-1",
                        "owningGeneration": "generation-1",
                    },
                },
                "trustedContext": CURRENT_TRUSTED_INVOCATION_CONTEXT,
            },
        ),
    ]
    assert not {"portal.call", "sandbox.exec.start", "sandbox.process.start"} & {method for method, _ in transport.requests}


def test_retained_result_lookup_rejects_invalid_request_before_transport() -> None:
    # Arrange
    transport = RecordingGatewayRuntimeTransport()
    client = GatewayRuntimeClient(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act / Assert
    with pytest.raises(ValidationError):
        _ = asyncio.run(
            client.sandbox.retained_results.lookup(
                {
                    "authority": "client-authored",
                    "operation": {
                        "operationId": "operation-1",
                        "owningGeneration": "generation-1",
                    },
                },
                trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
            ),
        )
    assert transport.requests == []


def test_retained_result_lookup_rejects_invalid_result_after_one_request() -> None:
    # Arrange
    transport = RecordingGatewayRuntimeTransport(
        result_overrides={
            "sandbox.retained-result.lookup": {
                "kind": "unavailable",
                "reason": "not-found",
            },
        },
    )
    client = GatewayRuntimeClient(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act / Assert
    with pytest.raises(ValidationError):
        _ = asyncio.run(
            client.sandbox.retained_results.lookup(
                {
                    "operation": {
                        "operationId": "operation-1",
                        "owningGeneration": "generation-1",
                    },
                },
                trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
            ),
        )
    assert [method for method, _ in transport.requests] == ["sandbox.retained-result.lookup"]


def test_gateway_runtime_client_projects_all_twenty_four_sandbox_methods() -> None:
    async def invoke_all_operations() -> tuple[RecordingGatewayRuntimeTransport, list[BaseModel]]:
        transport = RecordingGatewayRuntimeTransport()
        client = GatewayRuntimeClient(
            attachment=CURRENT_ATTACHMENT,
            transport=transport,
        )
        await client.connect()
        results: list[BaseModel] = []
        for group_name, operation_name, wire_method in SANDBOX_PROJECTION_CASES:
            operation_group = getattr(client.sandbox, group_name)
            operation = t.cast("SandboxOperation", getattr(operation_group, operation_name))
            request_schema_id, _ = _sandbox_method_schema_ids(wire_method)
            request = ACCEPTED_CONTRACT_VALUES[request_schema_id][0]
            results.append(
                await operation(
                    request,
                    trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
                ),
            )
        return transport, results

    # Act
    transport, results = asyncio.run(invoke_all_operations())

    # Assert
    assert len(SANDBOX_PROJECTION_CASES) == 24
    assert len({wire_method for _, _, wire_method in SANDBOX_PROJECTION_CASES}) == 24
    assert [method for method, _ in transport.requests] == [wire_method for _, _, wire_method in SANDBOX_PROJECTION_CASES]
    assert [params for _, params in transport.requests] == [
        {
            "publicRequest": ACCEPTED_CONTRACT_VALUES[_sandbox_method_schema_ids(wire_method)[0]][1],
            "trustedContext": CURRENT_TRUSTED_INVOCATION_CONTEXT,
        }
        for _, _, wire_method in SANDBOX_PROJECTION_CASES
    ]
    assert [result.model_dump(by_alias=True, exclude_none=True, mode="json") for result in results] == [
        ACCEPTED_CONTRACT_VALUES[_sandbox_method_schema_ids(wire_method)[1]][1] for _, _, wire_method in SANDBOX_PROJECTION_CASES
    ]


@pytest.mark.parametrize(
    ("public_request", "trusted_context"),
    [
        ({"unexpectedField": True}, CURRENT_TRUSTED_INVOCATION_CONTEXT),
        ({}, {**CURRENT_TRUSTED_INVOCATION_CONTEXT, "authority": "client-selected"}),
    ],
    ids=["invalid-public-request", "invalid-trusted-context"],
)
def test_gateway_runtime_sandbox_rejects_invalid_envelopes_before_transport(
    public_request: Mapping[str, object],
    trusted_context: Mapping[str, object],
) -> None:
    # Arrange
    transport = RecordingGatewayRuntimeTransport()
    client = GatewayRuntimeClient(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act / Assert
    with pytest.raises(ValidationError):
        _ = asyncio.run(
            client.sandbox.environment.open(
                public_request,
                trusted_context=trusted_context,
            ),
        )
    assert transport.requests == []


def test_gateway_runtime_sandbox_validates_result_after_transport() -> None:
    # Arrange
    transport = RecordingGatewayRuntimeTransport(
        result_overrides={"sandbox.environment.open": {"kind": "invalid"}},
    )
    client = GatewayRuntimeClient(
        attachment=CURRENT_ATTACHMENT,
        transport=transport,
    )
    asyncio.run(client.connect())

    # Act / Assert
    with pytest.raises(ValidationError):
        _ = asyncio.run(
            client.sandbox.environment.open(
                {},
                trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
            ),
        )
    assert len(transport.requests) == 1


def test_gateway_runtime_client_has_no_top_level_cancel_surface() -> None:
    # Arrange
    client = GatewayRuntimeClient(
        attachment=CURRENT_ATTACHMENT,
        transport=RecordingGatewayRuntimeTransport(),
    )

    # Act
    has_top_level_cancel = hasattr(client, "cancel")

    # Assert
    assert not has_top_level_cancel
