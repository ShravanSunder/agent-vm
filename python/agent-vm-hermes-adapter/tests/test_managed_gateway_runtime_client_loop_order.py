import asyncio
import threading
import typing as t
import unittest

from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient

from agent_vm_hermes_adapter.managed_gateway_runtime_client_loop import (
    GatewayRuntimeClientLoop,
)


class _RecordingClient:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.cancelled = threading.Event()

    async def disconnect(self) -> None:
        self.events.append("disconnect")


class GatewayRuntimeClientLoopOrderTests(unittest.TestCase):
    def test_cancels_pending_tasks_before_disconnect(self) -> None:
        client = _RecordingClient()
        client_loop = GatewayRuntimeClientLoop(t.cast(GatewayRuntimeClient, client))

        async def wait_until_cancelled() -> None:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                client.events.append("inventory-cancelled")
                client.cancelled.set()
                raise

        try:
            client_loop.submit(wait_until_cancelled())
            self.assertTrue(client_loop.run(asyncio.sleep(0), timeout=1) is None)
            client_loop.close(disconnect=True)
        finally:
            client_loop.close(disconnect=False)

        self.assertTrue(client.cancelled.is_set())
        self.assertEqual(client.events, ["inventory-cancelled", "disconnect"])


if __name__ == "__main__":
    unittest.main()
