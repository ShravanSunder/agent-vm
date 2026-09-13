"""Publish one trusted, bounded catalog bundle before admitting guest callers."""

import hashlib
import json
import os
import shutil
import stat
import tempfile
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, JsonValue

MAXIMUM_CATALOG_BUNDLE_BYTES = 16 * 1024 * 1024
MAXIMUM_CATALOG_FILE_BYTES = 1024 * 1024
CATALOG_PUBLICATION_ROOT = Path("/run/agent-vm/tool-portal-sdk")


class CatalogPublicationIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    definition_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    bundle_sha256: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    bundle_byte_length: int = Field(gt=0, le=MAXIMUM_CATALOG_BUNDLE_BYTES)


class CatalogPublication(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    directory: Path
    manifest_path: Path


class _CatalogSourceFile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    path: str = Field(pattern=r"^[A-Za-z0-9_.-]+\.ts$", max_length=240)
    namespace: str = Field(min_length=1)
    source: str
    byte_length: int = Field(alias="byteLength", ge=0, le=MAXIMUM_CATALOG_FILE_BYTES)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class _CatalogSourceBundle(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    definition_fingerprint: str = Field(alias="definitionFingerprint", pattern=r"^[a-f0-9]{64}$")
    files: list[_CatalogSourceFile] = Field(max_length=256)
    manifest: dict[str, JsonValue]


def _validated_bundle(content: bytes, identity: CatalogPublicationIdentity) -> _CatalogSourceBundle:
    if len(content) != identity.bundle_byte_length:
        raise ValueError("Catalog bundle length does not match its trusted manifest.")
    if f"sha256:{hashlib.sha256(content).hexdigest()}" != identity.bundle_sha256:
        raise ValueError("Catalog bundle digest does not match its trusted manifest.")
    bundle = _CatalogSourceBundle.model_validate_json(content)
    if bundle.definition_fingerprint != identity.definition_fingerprint:
        raise ValueError("Catalog bundle belongs to another definition fingerprint.")
    if bundle.manifest.get("definitionFingerprint") != identity.definition_fingerprint:
        raise ValueError("Catalog import manifest belongs to another fingerprint.")
    if len({item.path for item in bundle.files}) != len(bundle.files):
        raise ValueError("Catalog bundle contains duplicate file paths.")
    for item in bundle.files:
        encoded = item.source.encode("utf-8")
        if len(encoded) != item.byte_length or hashlib.sha256(encoded).hexdigest() != item.sha256:
            raise ValueError("Catalog source does not match its declared size or digest.")
    return bundle


def _read_regular_file(path: Path, maximum_bytes: int) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum_bytes:
                raise ValueError("Catalog cache contains a nonregular or oversized file.")
            content = stream.read(maximum_bytes + 1)
            if len(content) > maximum_bytes:
                raise ValueError("Catalog cached file exceeds its bound.")
            return content
    except OSError as error:
        raise ValueError("Catalog cached file is unavailable or symlinked.") from error


def cached_catalog_publication(
    identity: CatalogPublicationIdentity,
    *,
    root: Path = CATALOG_PUBLICATION_ROOT,
) -> CatalogPublication | None:
    directory = root / identity.definition_fingerprint
    if root.is_symlink() or directory.is_symlink():
        raise ValueError("Catalog cache directories must not be symbolic links.")
    if not directory.exists():
        return None
    if not directory.is_dir():
        raise ValueError("Catalog publication path is not a directory.")
    # Retaining the exact bundle provides a trusted digest check on cache hits;
    # file hashes supplied by an unverified local manifest are insufficient.
    content = _read_regular_file(directory / ".bundle.json", identity.bundle_byte_length)
    bundle = _validated_bundle(content, identity)
    for item in bundle.files:
        source = _read_regular_file(directory / item.path, item.byte_length)
        if len(source) != item.byte_length or hashlib.sha256(source).hexdigest() != item.sha256:
            raise ValueError("Published catalog source was modified.")
    manifest_path = directory / "manifest.json"
    manifest_content = _read_regular_file(manifest_path, MAXIMUM_CATALOG_BUNDLE_BYTES)
    if json.loads(manifest_content) != bundle.manifest:
        raise ValueError("Published catalog import manifest was modified.")
    return CatalogPublication(directory=directory, manifest_path=manifest_path)


def publish_catalog_bundle(
    content: bytes,
    identity: CatalogPublicationIdentity,
    *,
    root: Path = CATALOG_PUBLICATION_ROOT,
) -> CatalogPublication:
    bundle = _validated_bundle(content, identity)
    existing = cached_catalog_publication(identity, root=root)
    if existing is not None:
        return existing
    root.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{identity.definition_fingerprint}.", dir=root))
    destination = root / identity.definition_fingerprint
    try:
        for item in bundle.files:
            (stage / item.path).write_bytes(item.source.encode("utf-8"))
        (stage / ".bundle.json").write_bytes(content)
        (stage / "manifest.json").write_text(json.dumps(bundle.manifest, ensure_ascii=True), encoding="utf-8")
        try:
            stage.rename(destination)
        except OSError:
            # Another publisher may have won. Adopt only its complete verified
            # snapshot; never repair or overwrite an existing corrupt directory.
            concurrent = cached_catalog_publication(identity, root=root)
            if concurrent is None:
                raise
            return concurrent
        publication = cached_catalog_publication(identity, root=root)
        if publication is None:
            raise ValueError("Catalog publication disappeared before readiness.")
        return publication
    finally:
        if stage.exists():
            shutil.rmtree(stage)
