import asyncio
import json
import typing as t
from collections.abc import Mapping
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from agent_vm_agent_portal_sdk.gateway_runtime_uds_transport import (
    GatewayRuntimeUdsRemoteError,
    GatewayRuntimeUdsTransport,
    GatewayRuntimeUdsTransportError,
)

type JsonObject = dict[str, object]
type CapturedFrame = tuple[bytes, bytes, JsonObject]

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

_EXPECTED_MAXIMUM_PENDING_REQUESTS = 64


async def _read_test_frame(reader: asyncio.StreamReader) -> CapturedFrame:
    header_with_delimiter = await reader.readuntil(b"\r\n\r\n")
    header = header_with_delimiter[:-4]
    header_name, header_value = header.decode("ascii").split(":", 1)
    if header_name != "Content-Length":
        invalid_header_message = "The client request did not use a Content-Length header."
        raise ValueError(invalid_header_message)
    body = await reader.readexactly(int(header_value.strip()))
    decoded = t.cast("object", json.loads(body.decode("utf-8")))
    if not isinstance(decoded, dict):
        invalid_body_message = "The client request was not a JSON object."
        raise TypeError(invalid_body_message)
    decoded_mapping = t.cast("dict[object, object]", decoded)
    if not all(isinstance(key, str) for key in decoded_mapping):
        invalid_key_message = "The client request contained a non-string JSON key."
        raise TypeError(invalid_key_message)
    return header, body, t.cast("JsonObject", decoded_mapping)


def _encode_test_frame(message: object) -> bytes:
    body = json.dumps(
        message,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"Content-Length: {len(body)}\r\n\r\n".encode() + body


async def _exercise_real_uds_exchange(socket_path: str) -> tuple[CapturedFrame, Mapping[str, object], bytes]:
    running_loop = asyncio.get_running_loop()
    server_result: asyncio.Future[tuple[CapturedFrame, bytes]] = running_loop.create_future()
    server_tasks: set[asyncio.Task[None]] = set()

    async def handle_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            captured_frame = await _read_test_frame(reader)
            request = captured_frame[2]
            writer.write(
                _encode_test_frame(
                    {
                        "id": request.get("id"),
                        "jsonrpc": "2.0",
                        "result": {"kind": "accepted", "runtimeEpoch": "runtime-epoch-current"},
                    },
                ),
            )
            await writer.drain()
            end_of_stream = await reader.read(1)
            if not server_result.done():
                server_result.set_result((captured_frame, end_of_stream))
        except Exception as error:
            if not server_result.done():
                server_result.set_exception(error)
            raise
        finally:
            writer.close()
            await writer.wait_closed()

    def accept_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        server_task = asyncio.create_task(handle_client(reader, writer))
        server_tasks.add(server_task)

    server = await asyncio.start_unix_server(accept_client, path=socket_path)
    transport = GatewayRuntimeUdsTransport()
    try:
        await transport.connect(socket_path)
        response = await transport.request(
            "managed-plugin.handshake",
            {
                "attachmentGeneration": 7,
                "clientKind": "hermes-managed-plugin",
                "configuredAgentIds": ["main"],
            },
        )
        await transport.disconnect()
        captured_frame, end_of_stream = await server_result
        return captured_frame, response, end_of_stream
    finally:
        await transport.disconnect()
        server.close()
        await server.wait_closed()
        if server_tasks:
            _ = await asyncio.gather(*tuple(server_tasks))


async def _request_against_raw_response(
    socket_path: str,
    response_bytes: bytes,
) -> GatewayRuntimeUdsTransportError:
    running_loop = asyncio.get_running_loop()
    server_result: asyncio.Future[CapturedFrame] = running_loop.create_future()
    server_tasks: set[asyncio.Task[None]] = set()

    async def handle_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            captured_frame = await _read_test_frame(reader)
            writer.write(response_bytes)
            await writer.drain()
            if not server_result.done():
                server_result.set_result(captured_frame)
        except Exception as error:
            if not server_result.done():
                server_result.set_exception(error)
            raise
        finally:
            writer.close()
            await writer.wait_closed()

    def accept_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        server_task = asyncio.create_task(handle_client(reader, writer))
        server_tasks.add(server_task)

    server = await asyncio.start_unix_server(accept_client, path=socket_path)
    transport = GatewayRuntimeUdsTransport()
    try:
        await transport.connect(socket_path)
        with pytest.raises(GatewayRuntimeUdsTransportError) as captured_error:
            _ = await transport.request("portal.call", {"requestId": "portal-request-17"})
        _ = await server_result
        return captured_error.value
    finally:
        await transport.disconnect()
        server.close()
        await server.wait_closed()
        if server_tasks:
            _ = await asyncio.gather(*tuple(server_tasks))


async def _exercise_real_gateway_runtime_client(
    socket_path: str,
) -> tuple[tuple[CapturedFrame, CapturedFrame], JsonObject, bytes]:
    running_loop = asyncio.get_running_loop()
    server_result: asyncio.Future[tuple[tuple[CapturedFrame, CapturedFrame], bytes]] = running_loop.create_future()
    server_tasks: set[asyncio.Task[None]] = set()

    async def handle_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            handshake_frame = await _read_test_frame(reader)
            handshake_request = handshake_frame[2]
            writer.write(
                _encode_test_frame(
                    {
                        "id": handshake_request.get("id"),
                        "jsonrpc": "2.0",
                        "result": {"kind": "accepted"},
                    },
                ),
            )
            await writer.drain()
            portal_frame = await _read_test_frame(reader)
            portal_request = portal_frame[2]
            writer.write(
                _encode_test_frame(
                    {
                        "id": portal_request.get("id"),
                        "jsonrpc": "2.0",
                        "result": PORTAL_CALL_SUCCESS,
                    },
                ),
            )
            await writer.drain()
            end_of_stream = await reader.read(1)
            if not server_result.done():
                server_result.set_result(((handshake_frame, portal_frame), end_of_stream))
        except Exception as error:
            if not server_result.done():
                server_result.set_exception(error)
            raise
        finally:
            writer.close()
            await writer.wait_closed()

    def accept_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        server_task = asyncio.create_task(handle_client(reader, writer))
        server_tasks.add(server_task)

    server = await asyncio.start_unix_server(accept_client, path=socket_path)
    client = GatewayRuntimeClient(
        attachment=CURRENT_ATTACHMENT,
        socket_path=socket_path,
        trace_context_provider=lambda: {
            "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "tracestate": "vendor=opaque-value",
        },
    )
    try:
        await client.connect()
        result = await client.portal.call(
            PORTAL_CALL_REQUEST,
            trusted_context=CURRENT_TRUSTED_INVOCATION_CONTEXT,
        )
        await client.disconnect()
        captured_frames, end_of_stream = await server_result
        result_json = t.cast(
            "JsonObject",
            result.model_dump(by_alias=True, exclude_none=True, mode="json"),
        )
        return captured_frames, result_json, end_of_stream
    finally:
        await client.disconnect()
        server.close()
        await server.wait_closed()
        if server_tasks:
            _ = await asyncio.gather(*tuple(server_tasks))


async def _exercise_cancelled_request_discard_drain(
    socket_path: str,
) -> tuple[tuple[CapturedFrame, CapturedFrame, CapturedFrame], Mapping[str, object]]:
    running_loop = asyncio.get_running_loop()
    first_request_observed: asyncio.Future[None] = running_loop.create_future()
    server_result: asyncio.Future[tuple[CapturedFrame, CapturedFrame, CapturedFrame]] = running_loop.create_future()
    server_tasks: set[asyncio.Task[None]] = set()

    async def handle_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            first_request_frame = await _read_test_frame(reader)
            if not first_request_observed.done():
                first_request_observed.set_result(None)
            cancellation_frame = await _read_test_frame(reader)
            writer.write(
                _encode_test_frame(
                    {
                        "id": first_request_frame[2].get("id"),
                        "jsonrpc": "2.0",
                        "result": {"kind": "cancellation-pending"},
                    },
                ),
            )
            await writer.drain()
            second_request_frame = await _read_test_frame(reader)
            writer.write(
                _encode_test_frame(
                    {
                        "id": second_request_frame[2].get("id"),
                        "jsonrpc": "2.0",
                        "result": {"kind": "second-request-succeeded"},
                    },
                ),
            )
            await writer.drain()
            if not server_result.done():
                server_result.set_result(
                    (
                        first_request_frame,
                        cancellation_frame,
                        second_request_frame,
                    ),
                )
        except Exception as error:
            if not server_result.done():
                server_result.set_exception(error)
            raise
        finally:
            writer.close()
            await writer.wait_closed()

    def accept_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        server_task = asyncio.create_task(handle_client(reader, writer))
        server_tasks.add(server_task)

    server = await asyncio.start_unix_server(accept_client, path=socket_path)
    transport = GatewayRuntimeUdsTransport()
    try:
        await transport.connect(socket_path)
        cancelled_request = asyncio.create_task(
            transport.request("portal.call", {"requestId": "request-cancelled"}),
        )
        await first_request_observed
        cancelled_request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled_request
        second_result = await asyncio.wait_for(
            transport.request("portal.call", {"requestId": "request-after-cancel"}),
            timeout=1,
        )
        captured_frames = await asyncio.wait_for(server_result, timeout=1)
        return captured_frames, second_result
    finally:
        await transport.disconnect()
        server.close()
        await server.wait_closed()
        if server_tasks:
            _ = await asyncio.gather(*tuple(server_tasks), return_exceptions=True)


async def _exercise_remote_error_without_poisoning_connection(
    socket_path: str,
) -> tuple[GatewayRuntimeUdsRemoteError, Mapping[str, object]]:
    server_tasks: set[asyncio.Task[None]] = set()

    async def handle_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            first_request = await _read_test_frame(reader)
            writer.write(
                _encode_test_frame(
                    {
                        "error": {
                            "code": -32603,
                            "data": {"code": "dispatch-failed"},
                            "message": "Gateway runtime method dispatch failed.",
                        },
                        "id": first_request[2].get("id"),
                        "jsonrpc": "2.0",
                    },
                ),
            )
            await writer.drain()
            second_request = await _read_test_frame(reader)
            writer.write(
                _encode_test_frame(
                    {
                        "id": second_request[2].get("id"),
                        "jsonrpc": "2.0",
                        "result": {"kind": "second-request-succeeded"},
                    },
                ),
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    def accept_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        server_task = asyncio.create_task(handle_client(reader, writer))
        server_tasks.add(server_task)

    server = await asyncio.start_unix_server(accept_client, path=socket_path)
    transport = GatewayRuntimeUdsTransport()
    try:
        await transport.connect(socket_path)
        with pytest.raises(GatewayRuntimeUdsRemoteError) as captured_error:
            _ = await transport.request("portal.search", {"requestId": "request-failed"})
        second_result = await transport.request(
            "portal.search",
            {"requestId": "request-after-error"},
        )
        return captured_error.value, second_result
    finally:
        await transport.disconnect()
        server.close()
        await server.wait_closed()
        if server_tasks:
            _ = await asyncio.gather(*tuple(server_tasks), return_exceptions=True)


async def _exercise_concurrent_requests_with_reversed_responses(
    socket_path: str,
) -> tuple[tuple[CapturedFrame, CapturedFrame], tuple[Mapping[str, object], Mapping[str, object]]]:
    server_tasks: set[asyncio.Task[None]] = set()
    server_result: asyncio.Future[tuple[CapturedFrame, CapturedFrame]] = asyncio.get_running_loop().create_future()

    async def handle_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            first_request = await _read_test_frame(reader)
            second_request = await _read_test_frame(reader)
            writer.write(
                _encode_test_frame(
                    {
                        "id": second_request[2].get("id"),
                        "jsonrpc": "2.0",
                        "result": {"kind": "second-request-succeeded"},
                    },
                ),
            )
            writer.write(
                _encode_test_frame(
                    {
                        "id": first_request[2].get("id"),
                        "jsonrpc": "2.0",
                        "result": {"kind": "first-request-succeeded"},
                    },
                ),
            )
            await writer.drain()
            server_result.set_result((first_request, second_request))
        finally:
            writer.close()
            await writer.wait_closed()

    def accept_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        server_task = asyncio.create_task(handle_client(reader, writer))
        server_tasks.add(server_task)

    server = await asyncio.start_unix_server(accept_client, path=socket_path)
    transport = GatewayRuntimeUdsTransport()
    try:
        await transport.connect(socket_path)
        first_result, second_result = await asyncio.wait_for(
            asyncio.gather(
                transport.request("portal.list", {"requestId": "request-first"}),
                transport.request("portal.list", {"requestId": "request-second"}),
            ),
            timeout=1,
        )
        captured_frames = await asyncio.wait_for(server_result, timeout=1)
        return captured_frames, (first_result, second_result)
    finally:
        await transport.disconnect()
        server.close()
        await server.wait_closed()
        if server_tasks:
            _ = await asyncio.gather(*tuple(server_tasks), return_exceptions=True)


async def _exercise_pending_request_limit(socket_path: str) -> GatewayRuntimeUdsTransportError:
    server_tasks: set[asyncio.Task[None]] = set()
    requests_received = asyncio.Event()

    async def handle_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            for _ in range(_EXPECTED_MAXIMUM_PENDING_REQUESTS):
                await _read_test_frame(reader)
            requests_received.set()
            await reader.read()
        finally:
            writer.close()
            await writer.wait_closed()

    def accept_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        server_task = asyncio.create_task(handle_client(reader, writer))
        server_tasks.add(server_task)

    server = await asyncio.start_unix_server(accept_client, path=socket_path)
    transport = GatewayRuntimeUdsTransport()
    pending_requests: list[asyncio.Task[Mapping[str, object]]] = []
    try:
        await transport.connect(socket_path)
        pending_requests = [
            asyncio.create_task(transport.request("portal.list", {"requestId": f"pending-{request_index}"}))
            for request_index in range(_EXPECTED_MAXIMUM_PENDING_REQUESTS)
        ]
        await asyncio.wait_for(requests_received.wait(), timeout=1)
        with pytest.raises(GatewayRuntimeUdsTransportError) as captured_error:
            await asyncio.wait_for(
                transport.request("portal.list", {"requestId": "over-capacity"}),
                timeout=1,
            )
        return captured_error.value
    finally:
        await transport.disconnect()
        if pending_requests:
            _ = await asyncio.gather(*pending_requests, return_exceptions=True)
        server.close()
        await server.wait_closed()
        if server_tasks:
            _ = await asyncio.gather(*tuple(server_tasks), return_exceptions=True)


async def _exercise_write_failure_with_multiple_pending_requests(
    socket_path: str,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[tuple[BaseException, BaseException, BaseException], GatewayRuntimeUdsTransportError]:
    server_tasks: set[asyncio.Task[None]] = set()
    first_two_writes_drained = asyncio.Event()

    async def handle_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            await reader.read()
        finally:
            writer.close()
            await writer.wait_closed()

    def accept_client(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        server_task = asyncio.create_task(handle_client(reader, writer))
        server_tasks.add(server_task)

    server = await asyncio.start_unix_server(accept_client, path=socket_path)
    transport = GatewayRuntimeUdsTransport()
    request_tasks: list[asyncio.Task[Mapping[str, object]]] = []
    try:
        await transport.connect(socket_path)
        writer = transport._writer
        assert writer is not None
        original_drain = writer.drain
        drain_count = 0

        async def fail_third_drain() -> None:
            nonlocal drain_count
            drain_count += 1
            if drain_count == 3:
                raise ConnectionResetError("injected request write failure")
            await original_drain()
            if drain_count == 2:
                first_two_writes_drained.set()

        monkeypatch.setattr(writer, "drain", fail_third_drain)
        request_tasks = [
            asyncio.create_task(transport.request("portal.list", {"requestId": "pending-first"})),
            asyncio.create_task(transport.request("portal.list", {"requestId": "pending-second"})),
        ]
        await asyncio.wait_for(first_two_writes_drained.wait(), timeout=1)
        request_tasks.append(
            asyncio.create_task(transport.request("portal.list", {"requestId": "write-fails"})),
        )
        request_results = await asyncio.wait_for(
            asyncio.gather(*request_tasks, return_exceptions=True),
            timeout=1,
        )
        assert all(isinstance(request_result, BaseException) for request_result in request_results)
        with pytest.raises(GatewayRuntimeUdsTransportError) as disconnected_error:
            await transport.request("portal.list", {"requestId": "after-write-failure"})
        return (
            t.cast("tuple[BaseException, BaseException, BaseException]", tuple(request_results)),
            disconnected_error.value,
        )
    finally:
        await transport.disconnect()
        if request_tasks:
            _ = await asyncio.gather(*request_tasks, return_exceptions=True)
        server.close()
        await server.wait_closed()
        if server_tasks:
            _ = await asyncio.gather(*tuple(server_tasks), return_exceptions=True)


def test_gateway_runtime_uds_transport_exchanges_content_length_frames_over_real_unix_socket() -> None:
    # Arrange
    expected_request: JsonObject = {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "managed-plugin.handshake",
        "params": {
            "attachmentGeneration": 7,
            "clientKind": "hermes-managed-plugin",
            "configuredAgentIds": ["main"],
        },
    }
    expected_body = json.dumps(
        expected_request,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

    # Act
    with TemporaryDirectory(prefix="agent-vm-uds-", dir="/tmp") as socket_directory:
        socket_path = Path(socket_directory) / "gateway-runtime.sock"
        (captured_header, captured_body, captured_request), response, end_of_stream = asyncio.run(
            _exercise_real_uds_exchange(str(socket_path)),
        )

    # Assert
    assert captured_header == f"Content-Length: {len(expected_body)}".encode()
    assert captured_body == expected_body
    assert captured_request == expected_request
    assert response == {"kind": "accepted", "runtimeEpoch": "runtime-epoch-current"}
    assert end_of_stream == b""


def test_gateway_runtime_client_negotiates_and_calls_portal_over_real_unix_socket() -> None:
    # Arrange
    with TemporaryDirectory(prefix="agent-vm-client-uds-", dir="/tmp") as socket_directory:
        socket_path = Path(socket_directory) / "gateway-runtime.sock"

        # Act
        (handshake_frame, portal_frame), result_json, end_of_stream = asyncio.run(
            _exercise_real_gateway_runtime_client(str(socket_path)),
        )

    # Assert
    assert handshake_frame[2] == {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "managed-plugin.handshake",
        "params": CURRENT_ATTACHMENT,
    }
    assert portal_frame[2] == {
        "id": 2,
        "jsonrpc": "2.0",
        "method": "portal.call",
        "params": {
            "publicRequest": PORTAL_CALL_REQUEST,
            "traceContext": {
                "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                "tracestate": "vendor=opaque-value",
            },
            "trustedContext": CURRENT_TRUSTED_INVOCATION_CONTEXT,
        },
    }
    assert result_json == PORTAL_CALL_SUCCESS
    assert end_of_stream == b""


def test_gateway_runtime_uds_transport_discards_cancelled_response_without_poisoning_connection() -> None:
    # Arrange
    with TemporaryDirectory(prefix="agent-vm-uds-cancel-", dir="/tmp") as socket_directory:
        socket_path = Path(socket_directory) / "gateway-runtime.sock"

        # Act
        (first_request, cancellation, second_request), second_result = asyncio.run(
            _exercise_cancelled_request_discard_drain(str(socket_path)),
        )

    # Assert
    assert first_request[2] == {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "portal.call",
        "params": {"requestId": "request-cancelled"},
    }
    assert cancellation[2] == {
        "jsonrpc": "2.0",
        "method": "notifications/cancelled",
        "params": {"requestId": 1},
    }
    assert second_request[2] == {
        "id": 2,
        "jsonrpc": "2.0",
        "method": "portal.call",
        "params": {"requestId": "request-after-cancel"},
    }
    assert second_result == {"kind": "second-request-succeeded"}


def test_gateway_runtime_uds_transport_preserves_remote_error_without_poisoning_connection() -> None:
    # Arrange
    with TemporaryDirectory(prefix="agent-vm-uds-remote-error-", dir="/tmp") as socket_directory:
        socket_path = Path(socket_directory) / "gateway-runtime.sock"

        # Act
        remote_error, second_result = asyncio.run(
            _exercise_remote_error_without_poisoning_connection(str(socket_path)),
        )

    # Assert
    assert remote_error.code == "dispatch-failed"
    assert remote_error.json_rpc_code == "-32603"
    assert remote_error.data == {"code": "dispatch-failed"}
    assert second_result == {"kind": "second-request-succeeded"}


def test_gateway_runtime_uds_transport_correlates_concurrent_responses_by_request_id() -> None:
    # Arrange
    with TemporaryDirectory(prefix="agent-vm-uds-correlation-", dir="/tmp") as socket_directory:
        socket_path = Path(socket_directory) / "gateway-runtime.sock"

        # Act
        (first_request, second_request), (first_result, second_result) = asyncio.run(
            _exercise_concurrent_requests_with_reversed_responses(str(socket_path)),
        )

    # Assert
    assert first_request[2]["id"] == 1
    assert second_request[2]["id"] == 2
    assert first_result == {"kind": "first-request-succeeded"}
    assert second_result == {"kind": "second-request-succeeded"}


def test_gateway_runtime_uds_transport_bounds_pending_requests() -> None:
    # Arrange
    with TemporaryDirectory(prefix="agent-vm-uds-pending-limit-", dir="/tmp") as socket_directory:
        socket_path = Path(socket_directory) / "gateway-runtime.sock"

        # Act
        captured_error = asyncio.run(_exercise_pending_request_limit(str(socket_path)))

    # Assert
    assert captured_error.code == "pending-request-limit-exceeded"


def test_gateway_runtime_uds_transport_write_failure_fails_all_pending_requests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Arrange
    with TemporaryDirectory(prefix="agent-vm-uds-write-failure-", dir="/tmp") as socket_directory:
        socket_path = Path(socket_directory) / "gateway-runtime.sock"

        # Act
        request_errors, disconnected_error = asyncio.run(
            _exercise_write_failure_with_multiple_pending_requests(str(socket_path), monkeypatch),
        )

    # Assert
    assert all(isinstance(request_error, GatewayRuntimeUdsTransportError) and request_error.code == "request-write-failed" for request_error in request_errors)
    assert disconnected_error.code == "not-connected"


def test_gateway_runtime_uds_transport_disconnect_is_idempotent_and_requests_fail_closed() -> None:
    # Arrange
    transport = GatewayRuntimeUdsTransport()

    async def exercise_disconnected_transport() -> str:
        await transport.disconnect()
        await transport.disconnect()
        with pytest.raises(GatewayRuntimeUdsTransportError) as captured_error:
            _ = await transport.request("portal.call", {"requestId": "portal-request-17"})
        return captured_error.value.code

    # Act
    error_code = asyncio.run(exercise_disconnected_transport())

    # Assert
    assert error_code == "not-connected"


@pytest.mark.parametrize(
    ("response_bytes", "expected_error_code"),
    [
        pytest.param(
            b'Content-Length: 36\r\nContent-Length: 36\r\n\r\n{"id":1,"jsonrpc":"2.0","result":{}}',
            "invalid-header",
            id="duplicate-content-length-header",
        ),
        pytest.param(
            b'Content-Length 36\r\n\r\n{"id":1,"jsonrpc":"2.0","result":{}}',
            "invalid-header",
            id="malformed-content-length-header",
        ),
        pytest.param(
            b"Content-Length: not-a-length\r\n\r\n",
            "invalid-header",
            id="non-numeric-content-length",
        ),
        pytest.param(
            b"Content-Length: -1\r\n\r\n",
            "invalid-header",
            id="negative-content-length",
        ),
        pytest.param(
            b"Content-Length: 1048577\r\n\r\n",
            "content-too-large",
            id="oversized-content-length",
        ),
        pytest.param(
            b"X" * 8193 + b"\r\n\r\n",
            "header-too-large",
            id="oversized-header",
        ),
        pytest.param(
            b"Content-Length: 1\r\n\r\n\xff",
            "invalid-json",
            id="invalid-utf8-body",
        ),
        pytest.param(
            b"Content-Length: 1\r\n\r\n{",
            "invalid-json",
            id="invalid-json-body",
        ),
        pytest.param(
            b"Content-Length: 36\r\n",
            "incomplete-header",
            id="partial-header",
        ),
        pytest.param(
            b"Content-Length: 36\r\n\r\n{}",
            "incomplete-body",
            id="partial-body",
        ),
        pytest.param(
            _encode_test_frame(
                [{"id": 1, "jsonrpc": "2.0", "result": dict[str, object]()}],
            ),
            "invalid-envelope",
            id="batch-response",
        ),
        pytest.param(
            b"Content-Length: 4\r\n\r\nnull",
            "invalid-envelope",
            id="non-object-response",
        ),
        pytest.param(
            _encode_test_frame({"extra": True, "id": 1, "jsonrpc": "2.0", "result": {}}),
            "invalid-envelope",
            id="unknown-envelope-field",
        ),
        pytest.param(
            _encode_test_frame({"id": 1, "result": {}}),
            "invalid-envelope",
            id="missing-jsonrpc-version",
        ),
        pytest.param(
            _encode_test_frame({"id": 1, "jsonrpc": "1.0", "result": {}}),
            "invalid-envelope",
            id="incompatible-jsonrpc-version",
        ),
        pytest.param(
            _encode_test_frame({"jsonrpc": "2.0", "result": {}}),
            "unexpected-response",
            id="missing-response-id",
        ),
        pytest.param(
            _encode_test_frame({"id": 2, "jsonrpc": "2.0", "result": {}}),
            "unexpected-response",
            id="mismatched-response-id",
        ),
        pytest.param(
            _encode_test_frame({"id": True, "jsonrpc": "2.0", "result": {}}),
            "unexpected-response",
            id="boolean-response-id",
        ),
        pytest.param(
            _encode_test_frame(
                {
                    "error": {"code": "remote-error", "message": "remote failure"},
                    "id": 1,
                    "jsonrpc": "2.0",
                    "result": {},
                },
            ),
            "invalid-envelope",
            id="result-and-error-together",
        ),
        pytest.param(
            _encode_test_frame({"id": 1, "jsonrpc": "2.0"}),
            "invalid-envelope",
            id="missing-result-and-error",
        ),
    ],
)
def test_gateway_runtime_uds_transport_rejects_strict_framing_and_envelope_negatives(
    response_bytes: bytes,
    expected_error_code: str,
) -> None:
    # Arrange
    with TemporaryDirectory(prefix="agent-vm-uds-negative-", dir="/tmp") as socket_directory:
        socket_path = Path(socket_directory) / "gateway-runtime.sock"

        # Act
        captured_error = asyncio.run(
            _request_against_raw_response(str(socket_path), response_bytes),
        )

    # Assert
    assert captured_error.code == expected_error_code
