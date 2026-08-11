"""Dedicated asyncio-loop ownership for the managed Gateway Runtime client."""

import asyncio
import concurrent.futures
import logging
import threading
import typing as t
from collections.abc import Coroutine

_LOGGER = logging.getLogger(__name__)
_CANCELLATION_DRAIN_TIMEOUT_SECONDS = 5.0
_SHUTDOWN_OPERATION_TIMEOUT_SECONDS = 6.0


class _GatewayRuntimeLoopClient(t.Protocol):
    async def connect(self) -> None: ...

    async def disconnect(self) -> None: ...


class GatewayRuntimeClientLoop:
    """Own the asyncio loop used by one long-lived Python UDS client."""

    def __init__(self, client: _GatewayRuntimeLoopClient) -> None:
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

    async def _cancel_pending_tasks(self) -> int:
        current_task = asyncio.current_task(loop=self._loop)
        pending_tasks = [
            task
            for task in asyncio.all_tasks(loop=self._loop)
            if task is not current_task and not task.done()
        ]
        for task in pending_tasks:
            task.cancel()
        if not pending_tasks:
            return 0
        _, still_pending = await asyncio.wait(
            pending_tasks,
            timeout=_CANCELLATION_DRAIN_TIMEOUT_SECONDS,
        )
        return len(still_pending)

    def close(self, *, disconnect: bool) -> None:
        if self._closed:
            return
        pending_task_count: int | None = None
        try:
            try:
                pending_task_count = self.run(
                    self._cancel_pending_tasks(),
                    timeout=_SHUTDOWN_OPERATION_TIMEOUT_SECONDS,
                )
                if pending_task_count > 0:
                    _LOGGER.warning(
                        "Gateway Runtime client loop cancellation drain expired: pending_tasks=%d",
                        pending_task_count,
                    )
            except concurrent.futures.TimeoutError:
                _LOGGER.warning("Gateway Runtime client loop cancellation did not complete")
            try:
                if disconnect:
                    self.run(
                        self._client.disconnect(),
                        timeout=_SHUTDOWN_OPERATION_TIMEOUT_SECONDS,
                    )
            except concurrent.futures.TimeoutError:
                _LOGGER.warning("Gateway Runtime client disconnect did not complete")
            finally:
                try:
                    pending_task_count = self.run(
                        self._cancel_pending_tasks(),
                        timeout=_SHUTDOWN_OPERATION_TIMEOUT_SECONDS,
                    )
                except concurrent.futures.TimeoutError:
                    pending_task_count = None
                    _LOGGER.warning("Gateway Runtime client loop final drain did not complete")
        finally:
            self._closed = True
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=_SHUTDOWN_OPERATION_TIMEOUT_SECONDS)
            if self._thread.is_alive():
                message = "Gateway Runtime client loop did not stop"
                raise RuntimeError(message)
            if pending_task_count == 0:
                self._loop.close()
            else:
                _LOGGER.warning(
                    "Gateway Runtime event loop retained because owned tasks remain pending"
                )
