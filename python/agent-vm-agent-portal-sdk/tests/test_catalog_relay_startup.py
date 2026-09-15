import asyncio
import base64
import hashlib
import json
import sys
import typing as t
from collections.abc import Mapping
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from agent_vm_agent_portal_sdk.catalog_module_publication import CatalogPublicationIdentity, publish_catalog_bundle
from agent_vm_agent_portal_sdk.catalog_relay_startup import (
    GatewayPortalCatalogSource,
    read_catalog_source_bundle,
)
from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from agent_vm_agent_portal_sdk.portal_bridge_connection import PortalBridgeConnection
from agent_vm_agent_portal_sdk.portal_execution_bridge import PortalExecutionBridge
from agent_vm_agent_portal_sdk.portal_relay_protocol import PortalRelayProtocolError
from pydantic import BaseModel


def _catalog_bundle(definition_fingerprint: str, source_sizes: tuple[int, ...]) -> bytes:
    files: list[dict[str, object]] = []
    namespaces: list[dict[str, object]] = []
    for index, source_size in enumerate(source_sizes):
        source = chr(ord("a") + index) * source_size
        path = f"namespace-{index}.ts"
        namespace = f"namespace-{index}"
        files.append(
            {
                "byteLength": len(source.encode()),
                "namespace": namespace,
                "path": path,
                "sha256": hashlib.sha256(source.encode()).hexdigest(),
                "source": source,
            },
        )
        namespaces.append({"exportedFactoryName": f"bindNamespace{index}Tools", "modulePath": path, "namespace": namespace})
    bundle = {
        "definitionFingerprint": definition_fingerprint,
        "files": files,
        "manifest": {
            "definitionFingerprint": definition_fingerprint,
            "generatorVersion": "2",
            "namespaces": namespaces,
            "sdkContractVersion": "1",
        },
        "nativeTools": [],
    }
    return json.dumps(bundle, separators=(",", ":"), sort_keys=True).encode()


def _catalog_identity(content: bytes, definition_fingerprint: str) -> CatalogPublicationIdentity:
    return CatalogPublicationIdentity(
        definition_fingerprint=definition_fingerprint,
        bundle_sha256=f"sha256:{hashlib.sha256(content).hexdigest()}",
        bundle_byte_length=len(content),
    )


class _SubprocessPort:
    def __init__(self, process: asyncio.subprocess.Process) -> None:
        assert process.stdin is not None
        assert process.stdout is not None
        self._process = process
        self._stdin = process.stdin
        self._stdout = process.stdout

    async def read(self) -> bytes:
        return await self._stdout.read(65_536)

    async def write(self, content: bytes) -> None:
        self._stdin.write(content)
        await self._stdin.drain()

    async def close(self) -> None:
        if not self._stdin.is_closing():
            self._stdin.close()
        try:
            await asyncio.wait_for(self._process.wait(), timeout=5)
        except TimeoutError:
            self._process.kill()
            await self._process.wait()


async def _start_catalog_helper(socket_path: Path, root: Path, identity: CatalogPublicationIdentity) -> asyncio.subprocess.Process:
    helper = """
import asyncio
import sys
from pathlib import Path
from agent_vm_agent_portal_sdk.catalog_module_publication import CatalogPublicationIdentity
from agent_vm_agent_portal_sdk.guest_portal_relay_process import run_guest_relay

identity = CatalogPublicationIdentity(
    definition_fingerprint=sys.argv[3],
    bundle_sha256=sys.argv[4],
    bundle_byte_length=int(sys.argv[5]),
)
asyncio.run(run_guest_relay(sys.argv[1], catalog_identity=identity, catalog_root=Path(sys.argv[2]), create_directory=True))
"""
    return await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        helper,
        str(socket_path),
        str(root),
        identity.definition_fingerprint,
        identity.bundle_sha256,
        str(identity.bundle_byte_length),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


async def _run_catalog_connection(
    *,
    socket_path: Path,
    root: Path,
    source: GatewayPortalCatalogSource,
) -> tuple[PortalBridgeConnection, asyncio.Task[None], asyncio.subprocess.Process]:
    process = await _start_catalog_helper(socket_path, root, source.identity)

    async def invoke(_operation: str, _request: Mapping[str, object]) -> BaseModel:
        raise AssertionError("Catalog startup must not dispatch a public Portal request.")

    connection = PortalBridgeConnection(
        process=_SubprocessPort(process),
        bridge=PortalExecutionBridge(invoke=invoke),
        catalog_source=source,
        startup_deadline_monotonic=asyncio.get_running_loop().time() + 10,
    )
    pump = asyncio.create_task(connection.run())
    try:
        await connection.wait_ready()
    except Exception as error:
        assert process.stderr is not None
        diagnostics = (await process.stderr.read()).decode()
        helper_failure_message = f"Catalog helper failed before readiness: {diagnostics}"
        raise AssertionError(helper_failure_message) from error
    return connection, pump, process


def test_real_helper_publishes_large_catalog_then_reuses_verified_cache(tmp_path: Path) -> None:
    async def scenario() -> None:
        fingerprint = "a" * 64
        content = _catalog_bundle(fingerprint, (600_000, 600_000))
        identity = _catalog_identity(content, fingerprint)
        read_offsets: list[int] = []

        async def read(request: Mapping[str, object]) -> BaseModel:
            offset = t.cast("int", request["offset"])
            length = t.cast("int", request["length"])
            read_offsets.append(offset)
            chunk = content[offset : offset + length]
            result = PORTABLE_CONTRACT_ADAPTERS["portal.catalog.read-result"].validate_python(
                {
                    "byteLength": len(chunk),
                    "contentBase64": base64.b64encode(chunk).decode(),
                    "eof": offset + len(chunk) == len(content),
                    "kind": "content",
                    "totalLength": len(content),
                },
            )
            assert isinstance(result, BaseModel)
            return result

        source = GatewayPortalCatalogSource(offer_id="offer-exact", identity=identity, read=read, publication_root=tmp_path / "catalogs")
        with TemporaryDirectory(prefix="catalog-relay-", dir="/tmp") as relay_root:
            socket_path = Path(relay_root) / "first" / "p.sock"
            connection, pump, process = await _run_catalog_connection(socket_path=socket_path, root=tmp_path / "catalogs", source=source)
            assert socket_path.exists()
            assert connection.catalog_manifest_path == str(tmp_path / "catalogs" / fingerprint / "manifest.json")
            assert len(read_offsets) > 16
            await connection.close()
            await asyncio.gather(pump, return_exceptions=True)
            assert process.returncode == 0

        async def reject_cache_read(_request: Mapping[str, object]) -> BaseModel:
            raise AssertionError("A verified cache hit must transfer no catalog bytes.")

        cached_source = GatewayPortalCatalogSource(
            offer_id="offer-second",
            identity=identity,
            read=reject_cache_read,
            publication_root=tmp_path / "catalogs",
        )
        with TemporaryDirectory(prefix="catalog-relay-", dir="/tmp") as relay_root:
            cached_socket_path = Path(relay_root) / "second" / "p.sock"
            cached_connection, cached_pump, cached_process = await _run_catalog_connection(
                socket_path=cached_socket_path,
                root=tmp_path / "catalogs",
                source=cached_source,
            )
            assert cached_socket_path.exists()
            await cached_connection.close()
            await asyncio.gather(cached_pump, return_exceptions=True)
            assert cached_process.returncode == 0

    asyncio.run(scenario())


def test_trusted_startup_reader_authenticates_the_complete_bundle() -> None:
    async def scenario() -> None:
        fingerprint = "f" * 64
        content = _catalog_bundle(fingerprint, (70_000,))
        identity = _catalog_identity(content, fingerprint)
        offsets: list[int] = []

        async def read(request: Mapping[str, object]) -> BaseModel:
            offset = t.cast("int", request["offset"])
            length = t.cast("int", request["length"])
            offsets.append(offset)
            chunk = content[offset : offset + length]
            result = PORTABLE_CONTRACT_ADAPTERS["portal.catalog.read-result"].validate_python(
                {
                    "byteLength": len(chunk),
                    "contentBase64": base64.b64encode(chunk).decode(),
                    "eof": offset + len(chunk) == len(content),
                    "kind": "content",
                    "totalLength": len(content),
                },
            )
            assert isinstance(result, BaseModel)
            return result

        source = GatewayPortalCatalogSource(
            offer_id="startup-offer",
            identity=identity,
            read=read,
        )
        assert await read_catalog_source_bundle(source) == content
        assert offsets == [0, 65_536]

        mismatched_source = GatewayPortalCatalogSource(
            offer_id="startup-offer",
            identity=identity.model_copy(update={"bundle_sha256": f"sha256:{'0' * 64}"}),
            read=read,
        )
        with pytest.raises(PortalRelayProtocolError, match="selected digest"):
            await read_catalog_source_bundle(mismatched_source)

    asyncio.run(scenario())


def test_truncated_catalog_read_never_reaches_ready(tmp_path: Path) -> None:
    async def scenario() -> None:
        fingerprint = "b" * 64
        content = _catalog_bundle(fingerprint, (100,))
        identity = _catalog_identity(content, fingerprint)

        async def truncated_read(request: Mapping[str, object]) -> BaseModel:
            offset = t.cast("int", request["offset"])
            length = t.cast("int", request["length"])
            chunk = content[offset : offset + length - 1]
            result = PORTABLE_CONTRACT_ADAPTERS["portal.catalog.read-result"].validate_python(
                {
                    "byteLength": len(chunk),
                    "contentBase64": base64.b64encode(chunk).decode(),
                    "eof": False,
                    "kind": "content",
                    "totalLength": len(content),
                },
            )
            assert isinstance(result, BaseModel)
            return result

        source = GatewayPortalCatalogSource(
            offer_id="offer-truncated",
            identity=identity,
            read=truncated_read,
            publication_root=tmp_path / "catalogs",
        )

        async def invoke(_operation: str, _request: Mapping[str, object]) -> BaseModel:
            raise AssertionError("Catalog startup must not dispatch a public Portal request.")

        with TemporaryDirectory(prefix="catalog-relay-", dir="/tmp") as relay_root:
            process = await _start_catalog_helper(Path(relay_root) / "relay" / "p.sock", tmp_path / "catalogs", identity)
            connection = PortalBridgeConnection(
                process=_SubprocessPort(process),
                bridge=PortalExecutionBridge(invoke=invoke),
                catalog_source=source,
            )
            pump = asyncio.create_task(connection.run())
            with pytest.raises(PortalRelayProtocolError):
                await connection.wait_ready()
            await connection.close()
            await asyncio.gather(pump, return_exceptions=True)
            assert not (tmp_path / "catalogs" / fingerprint).exists()

    asyncio.run(scenario())


def test_catalog_startup_cancellation_closes_helper_without_publication(tmp_path: Path) -> None:
    async def scenario() -> None:
        fingerprint = "e" * 64
        content = _catalog_bundle(fingerprint, (100,))
        identity = _catalog_identity(content, fingerprint)
        read_started = asyncio.Event()

        async def blocked_read(_request: Mapping[str, object]) -> BaseModel:
            read_started.set()
            await asyncio.Event().wait()
            raise AssertionError("Unreachable")

        async def invoke(_operation: str, _request: Mapping[str, object]) -> BaseModel:
            raise AssertionError("Catalog startup must not dispatch a public Portal request.")

        source = GatewayPortalCatalogSource(
            offer_id="offer-cancelled",
            identity=identity,
            read=blocked_read,
            publication_root=tmp_path / "catalogs",
        )
        with TemporaryDirectory(prefix="catalog-relay-", dir="/tmp") as relay_root:
            process = await _start_catalog_helper(Path(relay_root) / "relay" / "p.sock", tmp_path / "catalogs", identity)
            connection = PortalBridgeConnection(
                process=_SubprocessPort(process),
                bridge=PortalExecutionBridge(invoke=invoke),
                catalog_source=source,
            )
            pump = asyncio.create_task(connection.run())
            await asyncio.wait_for(read_started.wait(), timeout=5)
            pump.cancel()
            await asyncio.gather(pump, return_exceptions=True)
            assert process.returncode is not None
            assert not (tmp_path / "catalogs" / fingerprint).exists()

    asyncio.run(scenario())


def test_corrupt_cached_catalog_stops_before_socket_admission(tmp_path: Path) -> None:
    async def scenario() -> None:
        fingerprint = "f" * 64
        content = _catalog_bundle(fingerprint, (100,))
        identity = _catalog_identity(content, fingerprint)
        publication_root = tmp_path / "catalogs"
        publication = publish_catalog_bundle(content, identity, root=publication_root)
        (publication.directory / "namespace-0.ts").write_text("tampered", encoding="utf-8")

        async def reject_read(_request: Mapping[str, object]) -> BaseModel:
            raise AssertionError("A corrupt final cache must not fall back to source transfer.")

        source = GatewayPortalCatalogSource(
            offer_id="offer-corrupt",
            identity=identity,
            read=reject_read,
            publication_root=publication_root,
        )
        with TemporaryDirectory(prefix="catalog-relay-", dir="/tmp") as relay_root:
            socket_path = Path(relay_root) / "relay" / "p.sock"
            with pytest.raises(AssertionError, match="Catalog helper failed before readiness"):
                await _run_catalog_connection(socket_path=socket_path, root=publication_root, source=source)
            assert not socket_path.exists()

    asyncio.run(scenario())
