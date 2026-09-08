"""Loop-owned admission for one trusted Portal composition invocation."""

import asyncio
import hashlib
import json
import secrets
import typing as t
from time import monotonic


class PortalScopeClosedError(RuntimeError):
    """The originating execution can no longer admit Portal work."""


class _CancellableOperation(t.Protocol):
    def done(self) -> bool: ...

    def cancel(self, msg: object = None) -> bool: ...


class PortalInvocationScope:
    """Register work before yielding so close cannot race an unowned retry.

    Callers supply authority through their callbacks, never through this scope.
    A scope owns only invocation lifetime and qualified item correlation.
    """

    def __init__(self, *, deadline_monotonic: float | None = None) -> None:
        self._loop = asyncio.get_running_loop()
        self._nonce = secrets.token_hex(32)
        self._closed = False
        self._deadline_monotonic = deadline_monotonic
        self._pending: set[_CancellableOperation] = set()

    @property
    def pending_count(self) -> int:
        self._require_loop()
        return sum(not operation.done() for operation in self._pending)

    def _require_loop(self) -> None:
        if asyncio.get_running_loop() is not self._loop:
            raise RuntimeError("Portal invocation scope belongs to another event loop.")

    def _require_active(self) -> None:
        self._require_loop()
        if self._deadline_monotonic is not None and monotonic() >= self._deadline_monotonic:
            self.close()
        if self._closed:
            raise PortalScopeClosedError("The originating Portal execution has ended.")

    def admit[TResult](
        self,
        factory: t.Callable[[], t.Awaitable[TResult]],
    ) -> asyncio.Task[TResult]:
        self._require_active()
        registered = asyncio.Event()

        async def run_registered() -> TResult:
            # Also fence eager task factories used by other SDK embeddings.
            await registered.wait()
            # Task scheduling may happen after close; never call the factory then.
            self._require_active()
            return await factory()

        operation = self._loop.create_task(run_registered())
        self._pending.add(operation)
        operation.add_done_callback(self._pending.discard)
        registered.set()
        return operation

    def qualify_call_id(self, caller_item_id: str) -> str:
        self._require_active()
        if not caller_item_id:
            raise ValueError("Portal call item ID must not be empty.")
        payload = json.dumps([self._nonce, caller_item_id], ensure_ascii=False, separators=(",", ":"))
        return f"bridge-{hashlib.sha256(payload.encode('utf-8')).hexdigest()}"

    def close(self) -> None:
        self._require_loop()
        if self._closed:
            return
        self._closed = True
        for operation in self._pending:
            if not operation.done():
                operation.cancel()
