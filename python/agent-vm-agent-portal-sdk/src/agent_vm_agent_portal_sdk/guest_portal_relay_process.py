"""Guest helper entrypoint: stdout is protocol, stderr is bounded diagnostics."""

import argparse
import asyncio
import os
import sys
from pathlib import Path

from .catalog_module_publication import CATALOG_PUBLICATION_ROOT, CatalogPublicationIdentity
from .catalog_relay_startup import publish_catalog_before_relay
from .guest_portal_relay import GuestPortalRelay
from .portal_relay_protocol import MAX_RELAY_MESSAGE_BYTES, PortalRelayDecoder, encode_relay_frame


def _write_frame(frame: bytes) -> None:
    sys.stdout.buffer.write(frame)
    sys.stdout.buffer.flush()


async def run_guest_relay(
    socket_path: str,
    *,
    catalog_identity: CatalogPublicationIdentity | None = None,
    catalog_root: Path = CATALOG_PUBLICATION_ROOT,
    create_directory: bool = False,
) -> None:
    if not Path(socket_path).is_absolute() or "\0" in socket_path:
        raise ValueError("Guest relay socket must be absolute.")
    write_lock = asyncio.Lock()

    async def send(message: dict[str, object]) -> None:
        frame = encode_relay_frame(message)
        async with write_lock:
            await asyncio.to_thread(_write_frame, frame)

    relay = GuestPortalRelay(socket_path=socket_path, send_to_host=send)
    decoder = PortalRelayDecoder()
    pending_messages: list[dict[str, object]] = []

    async def receive() -> dict[str, object]:
        while not pending_messages:
            data = await asyncio.to_thread(os.read, sys.stdin.fileno(), 65_536)
            if not data:
                raise EOFError("Tool Portal host closed during catalog startup.")
            pending_messages.extend(decoder.feed(data))
        return pending_messages.pop(0)

    owned_directory = Path(socket_path).parent if create_directory else None
    if owned_directory is not None:
        # Exclusive creation establishes cleanup ownership; never adopt an existing directory.
        owned_directory.mkdir(mode=0o700)
    try:
        if catalog_identity is not None:
            await publish_catalog_before_relay(catalog_identity, receive=receive, send=send, root=catalog_root)
        await relay.start()
        await send({"kind": "ready", "version": 1, "maxMessageBytes": MAX_RELAY_MESSAGE_BYTES, "maxPendingRequests": 16})
        while True:
            try:
                message = await receive()
            except EOFError:
                return
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
    parser.add_argument("--catalog-fingerprint")
    parser.add_argument("--catalog-bundle-sha256")
    parser.add_argument("--catalog-bundle-byte-length", type=int)
    arguments = parser.parse_args()
    try:
        catalog_arguments = (arguments.catalog_fingerprint, arguments.catalog_bundle_sha256, arguments.catalog_bundle_byte_length)
        if any(value is not None for value in catalog_arguments) and not all(value is not None for value in catalog_arguments):
            raise ValueError("Catalog startup identity is incomplete.")
        catalog_identity = (
            CatalogPublicationIdentity(
                definition_fingerprint=arguments.catalog_fingerprint,
                bundle_sha256=arguments.catalog_bundle_sha256,
                bundle_byte_length=arguments.catalog_bundle_byte_length,
            )
            if all(value is not None for value in catalog_arguments)
            else None
        )
        asyncio.run(run_guest_relay(arguments.socket, catalog_identity=catalog_identity, create_directory=arguments.create_directory))
    except (EOFError, OSError, ValueError, RuntimeError):
        sys.stderr.write("Tool Portal guest relay unavailable.\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
