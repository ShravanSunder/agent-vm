import asyncio
import base64
import typing as t
from collections.abc import Mapping
from unittest.mock import AsyncMock, MagicMock

import pytest
from agent_vm_agent_portal_sdk.gateway_portal_session import GatewayPortalSession, GatewayPortalSessionConfig
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import BaseModel, Field


class ArtifactChunk(BaseModel):
    reference: dict[str, object]
    offset_bytes: int = Field(alias="offsetBytes")
    content_base64: str = Field(alias="contentBase64")
    truncated: bool


@pytest.mark.parametrize("fault", [None, "reference", "offset", "short", "oversized"])
def test_artifact_ranges_are_authorized_and_emitted_before_reading_the_next_chunk(fault: str | None) -> None:
    async def scenario() -> None:
        payload = b"a" * 65_536 + b"tail"
        reference: dict[str, object] = {"byteLength": len(payload), "artifactId": "opaque"}
        frames: list[dict[str, object]] = []
        reads: list[Mapping[str, object]] = []
        client = MagicMock(spec=GatewayRuntimeClient)
        client.artifacts = MagicMock()

        async def read(request: Mapping[str, object], *, trusted_context: Mapping[str, object]) -> BaseModel:
            assert trusted_context == {"session": "origin"}
            assert len(frames) == len(reads)
            reads.append(request)
            offset = t.cast("int", request["offsetBytes"])
            maximum = t.cast("int", request["maxBytes"])
            content = payload[offset : offset + maximum]
            if fault == "short":
                content = b""
            if fault == "oversized":
                content = b"x" * (maximum + 1)
            return ArtifactChunk(
                reference={**reference, **({"artifactId": "other"} if fault == "reference" else {})},
                offsetBytes=offset + (1 if fault == "offset" else 0),
                contentBase64=base64.b64encode(content).decode("ascii"),
                truncated=offset + len(content) < len(payload),
            )

        client.artifacts.read = AsyncMock(side_effect=read)
        session = GatewayPortalSession(
            client=t.cast("GatewayRuntimeClient", client),
            config=GatewayPortalSessionConfig(environment={}, sandbox_context={}, portal_context={"session": "origin"}, maximum_runtime_ms=1000),
            present_approval=AsyncMock(),
        )

        async def send(frame: dict[str, object]) -> None:
            frames.append(frame)

        request = {"reference": reference, "maxBytes": len(payload), "offsetBytes": 0}
        if fault is not None:
            with pytest.raises(ValueError, match="Artifact read"):
                await session._stream_artifact(request, send)
            assert all(frame["kind"] != "artifact-end" for frame in frames)
        else:
            await session._stream_artifact(request, send)
            assert [request["maxBytes"] for request in reads] == [65_536, 4]
            assert [frame["kind"] for frame in frames] == ["artifact-chunk", "artifact-chunk", "artifact-end"]
            assert frames[-1]["byteLength"] == len(payload)
            assert frames[-1]["truncated"] is False
        await session.close()

    asyncio.run(scenario())
