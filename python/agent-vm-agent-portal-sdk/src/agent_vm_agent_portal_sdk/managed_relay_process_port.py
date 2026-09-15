"""Adapt managed process streams without closing stdin before relay responses."""

import asyncio
import base64
import hashlib
import typing as t
from collections.abc import Mapping

from pydantic import BaseModel

type StreamOperation = t.Callable[[Mapping[str, object]], t.Awaitable[BaseModel]]


class ManagedRelayProcessPort:
    def __init__(  # noqa: PLR0913 -- Three opaque handles and three separately authorized operations form this boundary.
        self,
        *,
        process: Mapping[str, object],
        stdin: Mapping[str, object],
        stdout: Mapping[str, object],
        read_stream: StreamOperation,
        write_stream: StreamOperation,
        cancel_process: StreamOperation,
    ) -> None:
        self._process = dict(process)
        self._stdin = dict(stdin)
        self._stdout = dict(stdout)
        self._read_stream = read_stream
        self._write_stream = write_stream
        self._cancel_process = cancel_process
        self._write_lock = asyncio.Lock()
        self._sequence = 0
        self._acknowledged = -1
        self._cursor: str | None = None
        self._closed = False
        self._eof = False

    async def write(self, content: bytes) -> None:
        async with self._write_lock:
            if self._closed:
                raise RuntimeError("Managed relay process is closed.")
            result = await self._write_stream(
                {
                    "stream": self._stdin,
                    "sequence": self._sequence,
                    "acknowledgedThrough": self._acknowledged,
                    "content": {"encoding": "base64", "byteLength": len(content), "contentBase64": base64.b64encode(content).decode("ascii")},
                    "contentDigest": f"sha256:{hashlib.sha256(content).hexdigest()}",
                },
            )
            received = result.model_dump(by_alias=True, mode="json")
            if received.get("sequence") != self._sequence or received.get("kind") not in {"written", "already-written"}:
                raise RuntimeError("Managed relay stdin write was not acknowledged; do not replay.")
            self._acknowledged = self._sequence
            self._sequence += 1

    async def read(self) -> bytes:
        while not self._closed and not self._eof:
            result = await self._read_stream(
                {
                    "stream": self._stdout,
                    "maxBytes": 65_536,
                    "waitMs": 250,
                    **({"cursor": self._cursor} if self._cursor is not None else {}),
                },
            )
            received = result.model_dump(by_alias=True, mode="json", exclude_none=True)
            chunk = received.get("chunk")
            if not isinstance(chunk, dict) or not isinstance(chunk.get("contentBase64"), str):
                raise TypeError("Managed relay stdout read omitted its bytes.")
            content = base64.b64decode(chunk["contentBase64"], validate=True)
            if len(content) != chunk.get("byteLength"):
                raise RuntimeError("Managed relay stdout byte count does not match.")
            cursor = received.get("nextCursor")
            if cursor is not None and not isinstance(cursor, str):
                raise RuntimeError("Managed relay stdout cursor is invalid.")
            self._cursor = cursor
            self._eof = received.get("eof") is True
            if content:
                return content
        return b""

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._cancel_process({"process": self._process})
