"""Guest helper entrypoint: stdout is protocol, stderr is bounded diagnostics."""

import argparse
import asyncio
import os
import sys
from pathlib import Path

from .guest_portal_relay import GuestPortalRelay
from .portal_relay_protocol import MAX_RELAY_MESSAGE_BYTES, PortalRelayDecoder, encode_relay_frame


def _write_frame(frame: bytes) -> None:
    sys.stdout.buffer.write(frame)
    sys.stdout.buffer.flush()


async def run_guest_relay(socket_path: str, *, create_directory: bool = False) -> None:
    if not Path(socket_path).is_absolute() or "\0" in socket_path:
        raise ValueError("Guest relay socket must be absolute.")
    write_lock = asyncio.Lock()

    async def send(message: dict[str, object]) -> None:
        frame = encode_relay_frame(message)
        async with write_lock:
            await asyncio.to_thread(_write_frame, frame)

    relay = GuestPortalRelay(socket_path=socket_path, send_to_host=send)
    decoder = PortalRelayDecoder()
    owned_directory = Path(socket_path).parent if create_directory else None
    if owned_directory is not None:
        # Exclusive creation establishes cleanup ownership; never adopt an existing directory.
        owned_directory.mkdir(mode=0o700)
    try:
        await relay.start()
        await send({"kind": "ready", "version": 1, "maxMessageBytes": MAX_RELAY_MESSAGE_BYTES, "maxPendingRequests": 16})
        while data := await asyncio.to_thread(os.read, sys.stdin.fileno(), 65_536):
            for message in decoder.feed(data):
                await relay.receive_from_host(message)
                if message["kind"] == "close":
                    return
    finally:
        await relay.close()
        if owned_directory is not None:
            owned_directory.rmdir()


def main() -> int:
    parser = argparse.ArgumentParser(description="Invocation-local Tool Portal message relay.")
    parser.add_argument("--socket", required=True)
    parser.add_argument("--create-directory", action="store_true")
    arguments = parser.parse_args()
    try:
        asyncio.run(run_guest_relay(arguments.socket, create_directory=arguments.create_directory))
    except (OSError, ValueError, RuntimeError):
        sys.stderr.write("Tool Portal guest relay unavailable.\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
