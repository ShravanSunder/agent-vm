import asyncio
import threading
import typing as t
import unittest
from unittest.mock import patch

import agent_vm_hermes_adapter.managed_gateway_runtime_client_loop as client_loop_module
from agent_vm_hermes_adapter.managed_gateway_runtime_client_loop import (
    GatewayRuntimeClientLoop,
)


class _RecordingClient:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.cancelled = threading.Event()

    async def connect(self) -> None:
        self.events.append("connect")

    async def disconnect(self) -> None:
        self.events.append("disconnect")


class GatewayRuntimeClientLoopOrderTests(unittest.TestCase):
    def test_cancels_pending_tasks_before_disconnect(self) -> None:
        client = _RecordingClient()
        client_loop = GatewayRuntimeClientLoop(client)

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

    def test_close_bounds_cancellation_before_disconnect(self) -> None:
        cancellation_observed = threading.Event()
        release_cancellation = threading.Event()
        task_finalized = threading.Event()
        close_completed = threading.Event()
        close_errors: list[BaseException] = []

        class CancellationReleasingClient(_RecordingClient):
            @t.override
            async def disconnect(self) -> None:
                self.events.append("disconnect")
                release_cancellation.set()

        client = CancellationReleasingClient()
        client_loop = GatewayRuntimeClientLoop(client)

        async def suppress_cancellation_until_disconnect() -> None:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                client.events.append("cancellation-observed")
                cancellation_observed.set()
                try:
                    await asyncio.to_thread(release_cancellation.wait)
                finally:
                    task_finalized.set()

        def close_client_loop() -> None:
            try:
                client_loop.close(disconnect=True)
            except BaseException as error:
                close_errors.append(error)
            finally:
                close_completed.set()

        client_loop.submit(suppress_cancellation_until_disconnect())
        self.assertTrue(client_loop.run(asyncio.sleep(0), timeout=1) is None)
        close_thread = threading.Thread(target=close_client_loop)
        try:
            with (
                patch.object(
                    client_loop_module,
                    "_CANCELLATION_DRAIN_TIMEOUT_SECONDS",
                    0.01,
                    create=True,
                ),
                patch.object(
                    client_loop_module,
                    "_SHUTDOWN_OPERATION_TIMEOUT_SECONDS",
                    0.1,
                    create=True,
                ),
            ):
                close_thread.start()
                self.assertTrue(cancellation_observed.wait(timeout=1))
                self.assertTrue(close_completed.wait(timeout=0.5))
        finally:
            release_cancellation.set()
            close_thread.join(timeout=1)
            client_loop.close(disconnect=False)

        self.assertEqual(close_errors, [])
        self.assertTrue(task_finalized.is_set())
        self.assertEqual(client.events, ["cancellation-observed", "disconnect"])

    def test_close_drains_tasks_created_during_timed_out_disconnect(self) -> None:
        disconnect_started = threading.Event()
        residual_task_finalized = threading.Event()

        class ResidualTaskClient(_RecordingClient):
            @t.override
            async def disconnect(self) -> None:
                async def wait_until_final_drain() -> None:
                    try:
                        await asyncio.Event().wait()
                    finally:
                        residual_task_finalized.set()

                _ = asyncio.create_task(wait_until_final_drain())
                disconnect_started.set()
                await asyncio.Event().wait()

        client_loop = GatewayRuntimeClientLoop(ResidualTaskClient())
        with patch.object(
            client_loop_module,
            "_SHUTDOWN_OPERATION_TIMEOUT_SECONDS",
            0.1,
        ):
            client_loop.close(disconnect=True)

        self.assertTrue(disconnect_started.is_set())
        self.assertTrue(residual_task_finalized.is_set())

    def test_close_drains_tasks_created_before_disconnect_failure(self) -> None:
        residual_task_finalized = threading.Event()

        class FailedDisconnectClient(_RecordingClient):
            @t.override
            async def disconnect(self) -> None:
                async def wait_until_final_drain() -> None:
                    try:
                        await asyncio.Event().wait()
                    finally:
                        residual_task_finalized.set()

                _ = asyncio.create_task(wait_until_final_drain())
                await asyncio.sleep(0)
                raise RuntimeError("disconnect failed")

        client_loop = GatewayRuntimeClientLoop(FailedDisconnectClient())
        with self.assertRaisesRegex(RuntimeError, "disconnect failed"):
            client_loop.close(disconnect=True)

        self.assertTrue(residual_task_finalized.is_set())


if __name__ == "__main__":
    unittest.main()
