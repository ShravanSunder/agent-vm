import asyncio
import typing as t
from unittest.mock import AsyncMock, MagicMock

import pytest
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
