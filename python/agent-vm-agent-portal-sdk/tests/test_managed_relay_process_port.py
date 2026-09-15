import asyncio
from collections.abc import Mapping

from agent_vm_agent_portal_sdk.managed_relay_process_port import ManagedRelayProcessPort
from pydantic import BaseModel


def test_stream_writer_advances_ack_only_after_matching_successful_response() -> None:
    async def scenario() -> None:
        requests: list[Mapping[str, object]] = []

        class WriteResult(BaseModel):
            kind: str
            sequence: int

        async def write(request: Mapping[str, object]) -> BaseModel:
            requests.append(request)
            return WriteResult(kind="written", sequence=len(requests) - 1)

        async def unused(request: Mapping[str, object]) -> BaseModel:
            raise AssertionError("Unexpected read or close")

        port = ManagedRelayProcessPort(process={}, stdin={}, stdout={}, read_stream=unused, write_stream=write, cancel_process=unused)
        await port.write(b"first")
        await port.write(b"second")
        assert [request["sequence"] for request in requests] == [0, 1]
        assert [request["acknowledgedThrough"] for request in requests] == [-1, 0]

    asyncio.run(scenario())
