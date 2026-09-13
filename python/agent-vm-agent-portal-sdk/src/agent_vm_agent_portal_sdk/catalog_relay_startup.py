"""Bounded trusted-source transfer before the guest relay admits clients."""

import base64
import dataclasses
import typing as t
from collections.abc import Mapping
from pathlib import Path

from pydantic import BaseModel

from .catalog_module_publication import (
    CATALOG_PUBLICATION_ROOT,
    CatalogPublicationIdentity,
    cached_catalog_publication,
    publish_catalog_bundle,
)
from .portal_relay_protocol import RELAY_STREAM_CHUNK_BYTES, PortalRelayProtocolError

type CatalogSourceRead = t.Callable[[Mapping[str, object]], t.Awaitable[BaseModel]]
type SendRelayMessage = t.Callable[[dict[str, object]], t.Awaitable[None]]
type ReceiveRelayMessage = t.Callable[[], t.Awaitable[dict[str, object]]]


@dataclasses.dataclass(frozen=True, slots=True)
class GatewayPortalCatalogSource:
    """One exact trusted offer retained outside the guest-visible process contract."""

    offer_id: str
    identity: CatalogPublicationIdentity
    read: CatalogSourceRead
    publication_root: Path = CATALOG_PUBLICATION_ROOT

    @property
    def expected_manifest_path(self) -> str:
        return str(self.publication_root / self.identity.definition_fingerprint / "manifest.json")


async def stream_catalog_source_to_relay(source: GatewayPortalCatalogSource, send: SendRelayMessage) -> None:
    """Read an immutable offer sequentially without retaining the complete bundle."""
    identity = source.identity
    offset = 0
    while offset < identity.bundle_byte_length:
        requested_length = min(RELAY_STREAM_CHUNK_BYTES, identity.bundle_byte_length - offset)
        result = await source.read(
            {
                "definitionFingerprint": identity.definition_fingerprint,
                "length": requested_length,
                "offerId": source.offer_id,
                "offset": offset,
            },
        )
        payload = result.model_dump(by_alias=True, mode="json", exclude_none=True)
        if payload.get("kind") != "content":
            raise PortalRelayProtocolError("Offered catalog source became unavailable during startup.")
        if payload.get("totalLength") != identity.bundle_byte_length or payload.get("byteLength") != requested_length:
            raise PortalRelayProtocolError("Catalog source returned mismatched range metadata.")
        encoded = payload.get("contentBase64")
        if not isinstance(encoded, str):
            raise PortalRelayProtocolError("Catalog source omitted its content bytes.")
        try:
            content = base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise PortalRelayProtocolError("Catalog source returned invalid base64 content.") from error
        if len(content) != requested_length:
            raise PortalRelayProtocolError("Catalog source returned a truncated range.")
        expected_eof = offset + requested_length == identity.bundle_byte_length
        if payload.get("eof") is not expected_eof:
            raise PortalRelayProtocolError("Catalog source returned an invalid end marker.")
        await send(
            {
                "kind": "catalog-bundle-chunk",
                "definitionFingerprint": identity.definition_fingerprint,
                "offset": offset,
                "byteLength": len(content),
                "contentBase64": encoded,
            },
        )
        offset += len(content)
    await send(
        {
            "kind": "catalog-bundle-end",
            "definitionFingerprint": identity.definition_fingerprint,
            "bundleSha256": identity.bundle_sha256,
            "bundleByteLength": identity.bundle_byte_length,
        },
    )


async def publish_catalog_before_relay(
    identity: CatalogPublicationIdentity,
    *,
    receive: ReceiveRelayMessage,
    send: SendRelayMessage,
    root: Path = CATALOG_PUBLICATION_ROOT,
) -> Path:
    """Select a verified cache hit or publish one complete streamed bundle."""
    publication = cached_catalog_publication(identity, root=root)
    await send(
        {
            "kind": "catalog-cache-status",
            "definitionFingerprint": identity.definition_fingerprint,
            "disposition": "cache-hit" if publication is not None else "content-required",
        },
    )
    if publication is None:
        content = bytearray()
        expected_offset = 0
        while True:
            message = await receive()
            if message.get("kind") == "catalog-bundle-end":
                if (
                    message.get("definitionFingerprint") != identity.definition_fingerprint
                    or message.get("bundleSha256") != identity.bundle_sha256
                    or message.get("bundleByteLength") != identity.bundle_byte_length
                    or expected_offset != identity.bundle_byte_length
                ):
                    raise PortalRelayProtocolError("Catalog bundle end did not match the selected identity.")
                break
            if message.get("kind") != "catalog-bundle-chunk":
                raise PortalRelayProtocolError("Catalog startup received an invalid host frame.")
            if message.get("definitionFingerprint") != identity.definition_fingerprint or message.get("offset") != expected_offset:
                raise PortalRelayProtocolError("Catalog bundle chunks must be sequential and match the selected identity.")
            encoded = message.get("contentBase64")
            byte_length = message.get("byteLength")
            if not isinstance(encoded, str) or not isinstance(byte_length, int):
                raise PortalRelayProtocolError("Catalog bundle chunk omitted its bytes.")
            try:
                chunk = base64.b64decode(encoded, validate=True)
            except ValueError as error:
                raise PortalRelayProtocolError("Catalog bundle chunk was not valid base64.") from error
            if not chunk or len(chunk) != byte_length or len(chunk) > RELAY_STREAM_CHUNK_BYTES:
                raise PortalRelayProtocolError("Catalog bundle chunk length was invalid.")
            if expected_offset + len(chunk) > identity.bundle_byte_length:
                raise PortalRelayProtocolError("Catalog bundle exceeded its selected byte length.")
            content.extend(chunk)
            expected_offset += len(chunk)
        publication = publish_catalog_bundle(bytes(content), identity, root=root)
    await send(
        {
            "kind": "catalog-ready",
            "definitionFingerprint": identity.definition_fingerprint,
            "manifestPath": str(publication.manifest_path),
        },
    )
    return publication.manifest_path
