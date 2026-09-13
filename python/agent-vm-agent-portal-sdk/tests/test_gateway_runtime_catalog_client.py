import asyncio
from collections.abc import Mapping

import pytest
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import BaseModel, ValidationError

ATTACHMENT: dict[str, object] = {
    "attachmentGeneration": 1,
    "clientKind": "hermes-managed-plugin",
    "configuredAgentIds": ["main"],
    "frameworkEpoch": "framework-1",
    "gatewayEpoch": "gateway-1",
    "projectionCohortDigest": f"projection-cohort:{'a' * 64}",
    "protocolVersion": 1,
    "runtimeEpoch": "runtime-1",
    "schemaVersion": 1,
}
TRUSTED_CONTEXT: dict[str, object] = {
    "correlation": {"runId": "run-1", "sessionId": "session-1", "toolCallId": "turn-1"},
    "principal": {
        "agentId": "main",
        "frameworkIdentity": {"kind": "hermes", "profileName": "main"},
        "profileAssignmentRevision": "assignment-1",
        "toolPortalProfileId": "profile-1",
    },
    "requester": {"authenticatedSubjectId": "subject-1"},
}
FINGERPRINT = "b" * 64
MANIFEST: dict[str, object] = {
    "bundleByteLength": 123,
    "bundleSha256": f"sha256:{'c' * 64}",
    "definitionFingerprint": FINGERPRINT,
    "files": [{"byteLength": 10, "namespace": "google", "path": "google.ts", "sha256": "d" * 64}],
    "generatorVersion": "generator-1",
    "namespaces": [{"exportedFactoryName": "bindGoogleTools", "modulePath": "google.ts", "namespace": "google"}],
    "sdkContractVersion": "sdk-1",
}


class _CatalogTransport:
    def __init__(self) -> None:
        self.requests: list[tuple[str, Mapping[str, object]]] = []

    async def connect(self, socket_path: str) -> None:
        assert socket_path

    async def handshake(self, attachment: Mapping[str, object]) -> Mapping[str, object]:
        assert attachment
        return {"kind": "accepted"}

    async def request(self, method: str, params: Mapping[str, object]) -> Mapping[str, object]:
        self.requests.append((method, params))
        results: dict[str, Mapping[str, object]] = {
            "portal.catalog.prepare": {"cacheDisposition": "prepared", "kind": "complete", "manifest": MANIFEST},
            "portal.catalog.offer": {"kind": "offered", "manifest": MANIFEST, "offerId": "offer-1"},
            "portal.catalog.read": {"byteLength": 3, "contentBase64": "YWJj", "eof": False, "kind": "content", "totalLength": 123},
            "portal.catalog.release": {"kind": "released"},
        }
        return results[method]

    async def disconnect(self) -> None:
        pass


def test_private_catalog_client_validates_and_correlates_all_operations() -> None:
    async def scenario() -> None:
        transport = _CatalogTransport()
        client = GatewayRuntimeClient(attachment=ATTACHMENT, transport=transport)
        await client.connect()
        requests = (
            (client.catalog.prepare, {}),
            (client.catalog.offer, {"definitionFingerprint": FINGERPRINT}),
            (client.catalog.read, {"definitionFingerprint": FINGERPRINT, "length": 3, "offerId": "offer-1", "offset": 0}),
            (client.catalog.release, {"definitionFingerprint": FINGERPRINT, "offerId": "offer-1"}),
        )
        for operation, request in requests:
            result = await operation(request, trusted_context=TRUSTED_CONTEXT)
            assert isinstance(result, BaseModel)
        assert [method for method, _params in transport.requests] == [
            "portal.catalog.prepare",
            "portal.catalog.offer",
            "portal.catalog.read",
            "portal.catalog.release",
        ]
        assert all(params["trustedContext"] == TRUSTED_CONTEXT for _method, params in transport.requests)
        assert [params["publicRequest"] for _method, params in transport.requests] == [request for _operation, request in requests]

    asyncio.run(scenario())


def test_private_catalog_client_rejects_an_oversized_read_before_transport() -> None:
    async def scenario() -> None:
        transport = _CatalogTransport()
        client = GatewayRuntimeClient(attachment=ATTACHMENT, transport=transport)
        await client.connect()
        with pytest.raises(ValidationError):
            await client.catalog.read(
                {"definitionFingerprint": FINGERPRINT, "length": 65_537, "offerId": "offer-1", "offset": 0},
                trusted_context=TRUSTED_CONTEXT,
            )
        assert transport.requests == []

    asyncio.run(scenario())
