import asyncio
import typing as t
from collections.abc import Mapping
from unittest.mock import AsyncMock, MagicMock

import pytest
from agent_vm_agent_portal_sdk.catalog_module_publication import CatalogPublicationIdentity
from agent_vm_agent_portal_sdk.catalog_relay_startup import GatewayPortalCatalogSource
from agent_vm_agent_portal_sdk.gateway_portal_session import GatewayPortalSession, GatewayPortalSessionConfig
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import BaseModel, ValidationError


def test_session_requires_bounded_positive_runtime() -> None:
    with pytest.raises(ValidationError):
        GatewayPortalSessionConfig(environment={}, sandbox_context={}, portal_context={}, maximum_runtime_ms=0)


def test_session_rejects_unknown_authority_fields() -> None:
    with pytest.raises(ValidationError):
        GatewayPortalSessionConfig.model_validate(
            {"environment": {}, "sandbox_context": {}, "portal_context": {}, "maximum_runtime_ms": 1000, "agentId": "caller-override"},
        )


def test_open_failure_after_process_start_cancels_the_owned_process() -> None:
    class StartedProcess(BaseModel):
        process: dict[str, object]
        streams: list[dict[str, object]]

    async def scenario() -> None:
        client = MagicMock(spec=GatewayRuntimeClient)
        client.sandbox = MagicMock()
        client.sandbox.process.start = AsyncMock(return_value=StartedProcess(process={"id": "owned-process"}, streams=[]))
        client.sandbox.process.cancel = AsyncMock()
        session = GatewayPortalSession(
            client=t.cast("GatewayRuntimeClient", client),
            config=GatewayPortalSessionConfig(environment={}, sandbox_context={}, portal_context={}, maximum_runtime_ms=1000),
            present_approval=AsyncMock(),
        )
        with pytest.raises(KeyError):
            await session.open()
        client.sandbox.process.cancel.assert_awaited_once_with({"process": {"id": "owned-process"}}, trusted_context={})
        await session.close()
        assert client.sandbox.process.cancel.await_count == 1

    asyncio.run(scenario())


def test_catalog_process_receives_only_publication_identity_not_offer_authority() -> None:
    class StartedProcess(BaseModel):
        process: dict[str, object]
        streams: list[dict[str, object]]

    async def scenario() -> None:
        async def read_catalog(_request: Mapping[str, object]) -> BaseModel:
            raise AssertionError("Startup cannot read before the helper attaches.")

        client = MagicMock(spec=GatewayRuntimeClient)
        client.sandbox = MagicMock()
        client.sandbox.process.start = AsyncMock(return_value=StartedProcess(process={"id": "owned-process"}, streams=[]))
        client.sandbox.process.cancel = AsyncMock()
        source = GatewayPortalCatalogSource(
            offer_id="secret-offer-authority",
            identity=CatalogPublicationIdentity(
                definition_fingerprint="a" * 64,
                bundle_sha256=f"sha256:{'b' * 64}",
                bundle_byte_length=123,
            ),
            read=read_catalog,
        )
        session = GatewayPortalSession(
            client=t.cast("GatewayRuntimeClient", client),
            config=GatewayPortalSessionConfig(
                environment={},
                sandbox_context={},
                portal_context={},
                maximum_runtime_ms=1000,
                catalog_source=source,
            ),
            present_approval=AsyncMock(),
        )
        with pytest.raises(KeyError):
            await session.open()
        awaited_start = client.sandbox.process.start.await_args
        assert awaited_start is not None
        start_request = awaited_start.args[0]
        command = start_request["command"]
        assert isinstance(command, str)
        assert "--catalog-fingerprint " + "a" * 64 in command
        assert "--catalog-bundle-sha256 sha256:" + "b" * 64 in command
        assert "--catalog-bundle-byte-length 123" in command
        assert "secret-offer-authority" not in command
        assert start_request["environment"] == {}

    asyncio.run(scenario())
