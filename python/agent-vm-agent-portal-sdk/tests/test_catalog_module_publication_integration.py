import hashlib
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from agent_vm_agent_portal_sdk.catalog_module_publication import (
    CatalogPublicationIdentity,
    cached_catalog_publication,
    publish_catalog_bundle,
)


def encoded_bundle(paths: tuple[str, ...] = ("example-12345678.ts",), source: str = "export const value = 42;\n") -> tuple[bytes, CatalogPublicationIdentity]:
    encoded_source = source.encode()
    fingerprint = "a" * 64
    bundle = {
        "definitionFingerprint": fingerprint,
        "files": [
            {
                "path": path,
                "namespace": f"example-{index}",
                "source": source,
                "byteLength": len(encoded_source),
                "sha256": hashlib.sha256(encoded_source).hexdigest(),
            }
            for index, path in enumerate(paths)
        ],
        "manifest": {"definitionFingerprint": fingerprint, "generatorVersion": "test", "namespaces": [], "tools": []},
    }
    content = json.dumps(bundle, separators=(",", ":")).encode()
    return content, CatalogPublicationIdentity(
        definition_fingerprint=fingerprint,
        bundle_sha256=f"sha256:{hashlib.sha256(content).hexdigest()}",
        bundle_byte_length=len(content),
    )


class CatalogModulePublicationIntegrationTests(unittest.TestCase):
    def test_publishes_complete_source_and_reuses_without_rewriting(self) -> None:
        content, identity = encoded_bundle()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assert cached_catalog_publication(identity, root=root) is None
            publication = publish_catalog_bundle(content, identity, root=root)
            module = publication.directory / "example-12345678.ts"
            assert module.read_text() == "export const value = 42;\n"
            modified = module.stat().st_mtime_ns
            assert publish_catalog_bundle(content, identity, root=root) == publication
            assert module.stat().st_mtime_ns == modified
            assert cached_catalog_publication(identity, root=root) == publication
            assert json.loads(publication.manifest_path.read_text())["definitionFingerprint"] == identity.definition_fingerprint

    def test_rejects_incomplete_bytes_and_traversal_before_publication(self) -> None:
        content, identity = encoded_bundle()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with pytest.raises(ValueError, match="length"):
                publish_catalog_bundle(content[:-1], identity, root=root)
            assert not (root / identity.definition_fingerprint).exists()
            unsafe_content, unsafe_identity = encoded_bundle(("../outside.ts",))
            with pytest.raises(ValueError, match="path"):
                publish_catalog_bundle(unsafe_content, unsafe_identity, root=root)
            assert not (root / identity.definition_fingerprint).exists()

    def test_corrupt_existing_source_is_rejected_not_repaired(self) -> None:
        content, identity = encoded_bundle()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            publication = publish_catalog_bundle(content, identity, root=root)
            module = publication.directory / "example-12345678.ts"
            module.write_text("corrupted")
            with pytest.raises(ValueError, match="modified"):
                cached_catalog_publication(identity, root=root)
            with pytest.raises(ValueError, match="modified"):
                publish_catalog_bundle(content, identity, root=root)
            assert module.read_text() == "corrupted"

    def test_rejects_symlinked_cached_module(self) -> None:
        content, identity = encoded_bundle()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            publication = publish_catalog_bundle(content, identity, root=root)
            module = publication.directory / "example-12345678.ts"
            destination = root / "outside.txt"
            destination.write_bytes(module.read_bytes())
            module.unlink()
            module.symlink_to(destination)
            with pytest.raises(ValueError, match="symlinked"):
                cached_catalog_publication(identity, root=root)

    def test_concurrent_publishers_select_one_complete_directory(self) -> None:
        content, identity = encoded_bundle()
        with tempfile.TemporaryDirectory() as directory, ThreadPoolExecutor(max_workers=2) as executor:
            root = Path(directory)
            futures = [executor.submit(publish_catalog_bundle, content, identity, root=root) for _ in range(2)]
            publications = [future.result(timeout=5) for future in futures]
            assert publications[0] == publications[1]
            assert list(root.iterdir()) == [publications[0].directory]

    def test_catalog_over_one_megabyte_uses_its_own_publication_bound(self) -> None:
        content, identity = encoded_bundle(("first.ts", "second.ts"), "//" + "x" * 600_000)
        assert len(content) > 1024 * 1024
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            publication = publish_catalog_bundle(content, identity, root=root)
            assert (publication.directory / "first.ts").stat().st_size == 600002
            assert cached_catalog_publication(identity, root=root) == publication
