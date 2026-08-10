"""Dedicated asyncio-loop ownership for the managed Gateway Runtime client."""

import asyncio
import concurrent.futures
import threading
from collections.abc import Coroutine

from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient


class GatewayRuntimeClientLoop:
    """Own the asyncio loop used by one long-lived Python UDS client."""

    def __init__(self, client: GatewayRuntimeClient) -> None:
        self._client = client
        self._loop = asyncio.new_event_loop()
        self._started = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="agent-vm-hermes-gateway-runtime",
        )
        self._thread.start()
        if not self._started.wait(timeout=5):
            message = "Gateway Runtime client loop did not start"
            raise RuntimeError(message)
        self._closed = False

    def _run(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._started.set()
        self._loop.run_forever()

    def submit[TResult](
        self,
        coroutine: Coroutine[object, object, TResult],
    ) -> concurrent.futures.Future[TResult]:
        if self._closed:
            coroutine.close()
            message = "Gateway Runtime client loop is closed"
            raise RuntimeError(message)
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop)

    def run[TResult](
        self,
        coroutine: Coroutine[object, object, TResult],
        *,
        timeout: float | None = None,
    ) -> TResult:
        submitted_future = self.submit(coroutine)
        try:
            return submitted_future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            _ = submitted_future.cancel()
            raise

    def connect(self) -> None:
        self.run(self._client.connect())

    async def _cancel_pending_tasks(self) -> None:
        current_task = asyncio.current_task(loop=self._loop)
        pending_tasks = [
            task
            for task in asyncio.all_tasks(loop=self._loop)
            if task is not current_task and not task.done()
        ]
        for task in pending_tasks:
            task.cancel()
        if pending_tasks:
            await asyncio.gather(*pending_tasks, return_exceptions=True)

    def close(self, *, disconnect: bool) -> None:
        if self._closed:
            return
        self.run(self._cancel_pending_tasks())
        if disconnect:
            self.run(self._client.disconnect())
        self._closed = True
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)
        if self._thread.is_alive():
            message = "Gateway Runtime client loop did not stop"
            raise RuntimeError(message)
        self._loop.close()
