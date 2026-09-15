"""Prepared catalog registration and exact Hermes turn bindings."""

import threading
import typing as t
from collections.abc import Mapping

from agent_vm_agent_portal_sdk.catalog_module_publication import (
    CATALOG_SOURCE_GENERATOR_VERSION,
    CATALOG_SOURCE_SDK_CONTRACT_VERSION,
    CatalogPublicationIdentity,
)
from agent_vm_agent_portal_sdk.catalog_relay_startup import (
    GatewayPortalCatalogSource,
    read_catalog_source_bundle,
)
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator, model_validator

from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    build_managed_trusted_context,
)


class ManagedCatalogAdapter(t.Protocol):
    @property
    def profiles(self) -> tuple[CanonicalManagedAgentProjection, ...]: ...

    def gateway_runtime_client_for_profile(self, profile_name: str) -> GatewayRuntimeClient: ...

    def run_gateway_runtime_coroutine[TResult](
        self,
        coroutine: t.Coroutine[object, object, TResult],
        *,
        timeout: float | None = None,
    ) -> TResult: ...


class _FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class CatalogNamespaceImport(_FrozenModel):
    namespace: str = Field(min_length=1)
    module_path: str = Field(alias="modulePath", min_length=1)
    exported_factory_name: str = Field(alias="exportedFactoryName", min_length=1)

    @field_validator("module_path")
    @classmethod
    def validate_module_path(cls, value: str) -> str:
        return _validated_catalog_relative_path(value)


class CatalogSourceFile(_FrozenModel):
    byte_length: int = Field(alias="byteLength", ge=0, le=1024 * 1024)
    namespace: str = Field(min_length=1, max_length=256)
    path: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return _validated_catalog_relative_path(value)


class PreparedCatalogManifest(_FrozenModel):
    definition_fingerprint: str = Field(alias="definitionFingerprint", pattern=r"^[a-f0-9]{64}$")
    bundle_sha256: str = Field(alias="bundleSha256", pattern=r"^sha256:[a-f0-9]{64}$")
    bundle_byte_length: int = Field(alias="bundleByteLength", gt=0, le=16 * 1024 * 1024)
    files: t.Annotated[
        tuple[CatalogSourceFile, ...],
        BeforeValidator(lambda value: tuple(value) if isinstance(value, list) else value),
    ] = Field(max_length=256)
    generator_version: str = Field(alias="generatorVersion", min_length=1, max_length=256)
    namespaces: t.Annotated[
        tuple[CatalogNamespaceImport, ...],
        BeforeValidator(lambda value: tuple(value) if isinstance(value, list) else value),
    ] = Field(max_length=256)
    sdk_contract_version: str = Field(alias="sdkContractVersion", min_length=1, max_length=256)

    @model_validator(mode="after")
    def validate_file_relationships(self) -> t.Self:
        file_paths = tuple(item.path for item in self.files)
        if len(file_paths) != len(set(file_paths)):
            raise ValueError("Catalog source manifest file paths must be unique.")
        namespace_names = tuple(item.namespace for item in self.namespaces)
        if len(namespace_names) != len(set(namespace_names)):
            raise ValueError("Catalog source manifest namespaces must be unique.")
        if any(item.module_path not in file_paths for item in self.namespaces):
            raise ValueError("Catalog namespace module path must name a source file.")
        return self


def _validated_catalog_relative_path(value: str) -> str:
    segments = value.split("/")
    if (
        value.startswith("/")
        or value.endswith("/")
        or "\x00" in value
        or "//" in value
        or any(segment in {"", ".", ".."} for segment in segments)
    ):
        raise ValueError("Catalog source path must be a normalized relative path.")
    return value


class ManagedNativeCatalogTool(_FrozenModel):
    registered_name: str = Field(alias="registeredName", min_length=1, max_length=128)
    namespace: str = Field(min_length=1)
    tool_name: str = Field(alias="toolName", min_length=1)
    description: str = ""
    input_schema: dict[str, object] = Field(alias="inputSchema")


class _PreparedManagedCatalogBundle(_FrozenModel):
    definition_fingerprint: str = Field(alias="definitionFingerprint", pattern=r"^[a-f0-9]{64}$")
    files: tuple[object, ...]
    manifest: dict[str, object]
    native_tools: tuple[ManagedNativeCatalogTool, ...] = Field(alias="nativeTools")

    @model_validator(mode="after")
    def validate_native_tools(self) -> t.Self:
        if self.manifest.get("definitionFingerprint") != self.definition_fingerprint:
            raise ValueError("Prepared catalog bundle manifest belongs to another fingerprint.")
        if self.manifest.get("generatorVersion") != CATALOG_SOURCE_GENERATOR_VERSION:
            raise ValueError("Prepared catalog bundle generator version is incompatible.")
        if self.manifest.get("sdkContractVersion") != CATALOG_SOURCE_SDK_CONTRACT_VERSION:
            raise ValueError("Prepared catalog bundle SDK contract version is incompatible.")
        identities = tuple((item.namespace, item.tool_name) for item in self.native_tools)
        registered_names = tuple(item.registered_name for item in self.native_tools)
        if len(identities) != len(set(identities)):
            raise ValueError("Prepared catalog bundle contains duplicate native identities.")
        if len(registered_names) != len(set(registered_names)):
            raise ValueError("Prepared catalog bundle contains duplicate native registered names.")
        if registered_names != tuple(sorted(registered_names)):
            raise ValueError(
                "Prepared catalog bundle native tools must be sorted by registered name."
            )
        return self


class PreparedManagedProfileCatalog(_FrozenModel):
    profile_name: str = Field(min_length=1)
    manifest: PreparedCatalogManifest
    native_tools: tuple[ManagedNativeCatalogTool, ...]


class ManagedCatalogPreparationError(RuntimeError):
    """A catalog-mode profile could not prepare a complete private catalog."""


def _model_payload(result: BaseModel) -> dict[str, object]:
    payload = result.model_dump(by_alias=True, mode="json", exclude_none=True)
    if not isinstance(payload, dict):
        raise TypeError("Managed catalog operation did not return an object.")
    return payload


def _required_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise TypeError(f"{label} must be a non-empty string.")
    return value


class ManagedCatalogCoordinator:
    """Prepare complete generated and native surfaces for admitted profiles."""

    def __init__(self, *, adapter: ManagedCatalogAdapter) -> None:
        self._adapter = adapter
        self._catalogs_by_profile: dict[str, PreparedManagedProfileCatalog] = {}
        self._lock = threading.RLock()

    def read_profile(self, profile_name: str) -> PreparedManagedProfileCatalog | None:
        with self._lock:
            return self._catalogs_by_profile.get(profile_name)

    async def prepare_all(self) -> None:
        for projection in self._adapter.profiles:
            try:
                catalog = await self._prepare_profile(projection)
            except Exception as error:
                if (projection.tool_portal_catalog_mode or "compact") == "catalog":
                    profile_name = projection.framework_identity.profile_name
                    raise ManagedCatalogPreparationError(
                        "Managed catalog preparation failed for profile "
                        f"{profile_name!r}: {type(error).__name__}."
                    ) from error
                continue
            with self._lock:
                self._catalogs_by_profile[catalog.profile_name] = catalog

    async def _prepare_profile(
        self, projection: CanonicalManagedAgentProjection
    ) -> PreparedManagedProfileCatalog:
        trusted_context = build_managed_trusted_context(projection).model_dump(
            by_alias=True, mode="json", exclude_none=True
        )
        client = self._adapter.gateway_runtime_client_for_profile(
            projection.framework_identity.profile_name
        )
        prepared = _model_payload(await client.catalog.prepare({}, trusted_context=trusted_context))
        if prepared.get("kind") != "complete":
            raise ManagedCatalogPreparationError("Generated catalog preparation was incomplete.")
        manifest = PreparedCatalogManifest.model_validate(prepared.get("manifest"))
        if (
            manifest.generator_version != CATALOG_SOURCE_GENERATOR_VERSION
            or manifest.sdk_contract_version != CATALOG_SOURCE_SDK_CONTRACT_VERSION
        ):
            raise ManagedCatalogPreparationError(
                "Prepared catalog source versions are incompatible with Hermes."
            )
        offered = _model_payload(
            await client.catalog.offer(
                {"definitionFingerprint": manifest.definition_fingerprint},
                trusted_context=trusted_context,
            )
        )
        if offered.get("kind") != "offered":
            raise ManagedCatalogPreparationError("Prepared startup catalog source was unavailable.")
        offered_manifest = PreparedCatalogManifest.model_validate(offered.get("manifest"))
        if offered_manifest != manifest:
            raise ManagedCatalogPreparationError(
                "Prepared startup catalog offer did not match its manifest."
            )
        offer_id = _required_string(offered.get("offerId"), "catalog startup offerId")

        async def read(request: Mapping[str, object]) -> BaseModel:
            return await client.catalog.read(request, trusted_context=trusted_context)

        source = GatewayPortalCatalogSource(
            offer_id=offer_id,
            identity=CatalogPublicationIdentity(
                definition_fingerprint=manifest.definition_fingerprint,
                bundle_sha256=manifest.bundle_sha256,
                bundle_byte_length=manifest.bundle_byte_length,
            ),
            read=read,
        )
        try:
            bundle_content = await read_catalog_source_bundle(source)
            bundle = _PreparedManagedCatalogBundle.model_validate_json(bundle_content)
        finally:
            released = _model_payload(
                await client.catalog.release(
                    {
                        "definitionFingerprint": manifest.definition_fingerprint,
                        "offerId": offer_id,
                    },
                    trusted_context=trusted_context,
                )
            )
            if released.get("kind") != "released":
                raise ManagedCatalogPreparationError(
                    "Prepared startup catalog offer could not be released."
                )
        if bundle.definition_fingerprint != manifest.definition_fingerprint:
            raise ManagedCatalogPreparationError(
                "Prepared startup catalog bundle belonged to another fingerprint."
            )
        return PreparedManagedProfileCatalog(
            profile_name=projection.framework_identity.profile_name,
            manifest=manifest,
            native_tools=bundle.native_tools,
        )


class OfferedDefinitionBinding:
    """One retained offer selected for an exact protected outer turn."""

    def __init__(
        self,
        *,
        profile_name: str,
        session_id: str,
        turn_id: str,
        offer_id: str,
        manifest: PreparedCatalogManifest,
        source: GatewayPortalCatalogSource,
    ) -> None:
        self.profile_name = profile_name
        self.session_id = session_id
        self.turn_id = turn_id
        self.offer_id = offer_id
        self.manifest = manifest
        self.source = source
        self.turn_open = True
        self.active_invocations = 0
        self.released = False


class ManagedCatalogTurnBindings:
    """Retain exact offers until their outer turn and invocations both close."""

    def __init__(
        self, *, adapter: ManagedCatalogAdapter, catalogs: ManagedCatalogCoordinator
    ) -> None:
        self._adapter = adapter
        self._catalogs = catalogs
        self._bindings: dict[tuple[str, str, str], OfferedDefinitionBinding] = {}
        self._last_fingerprint_by_session: dict[tuple[str, str], str] = {}
        self._lock = threading.RLock()

    def offer_for_turn(
        self, projection: CanonicalManagedAgentProjection, *, session_id: str, turn_id: str
    ) -> tuple[OfferedDefinitionBinding | None, bool]:
        profile_name = projection.framework_identity.profile_name
        key = (profile_name, session_id, turn_id)
        with self._lock:
            existing = self._bindings.get(key)
            if existing is not None and not existing.released:
                return existing, False
            previous = [
                binding
                for binding_key, binding in self._bindings.items()
                if binding_key[:2] == key[:2] and binding_key != key and binding.turn_open
            ]
            for binding in previous:
                binding.turn_open = False
        for binding in previous:
            self._release_if_unused(projection, binding)
        catalog = self._catalogs.read_profile(profile_name)
        if catalog is None:
            return None, False
        trusted_context = self._trusted_context(projection, session_id, turn_id)
        client = self._adapter.gateway_runtime_client_for_profile(profile_name)
        offered = _model_payload(
            self._adapter.run_gateway_runtime_coroutine(
                client.catalog.offer(
                    {"definitionFingerprint": catalog.manifest.definition_fingerprint},
                    trusted_context=trusted_context,
                )
            )
        )
        if offered.get("kind") != "offered":
            return None, False
        offered_manifest = PreparedCatalogManifest.model_validate(offered.get("manifest"))
        if offered_manifest != catalog.manifest:
            raise ManagedCatalogPreparationError(
                "Catalog offer did not match the selected prepared manifest."
            )
        offer_id = _required_string(offered.get("offerId"), "catalog offerId")

        async def read(request: Mapping[str, object]) -> BaseModel:
            return await client.catalog.read(request, trusted_context=trusted_context)

        source = GatewayPortalCatalogSource(
            offer_id=offer_id,
            identity=CatalogPublicationIdentity(
                definition_fingerprint=offered_manifest.definition_fingerprint,
                bundle_sha256=offered_manifest.bundle_sha256,
                bundle_byte_length=offered_manifest.bundle_byte_length,
            ),
            read=read,
        )
        binding = OfferedDefinitionBinding(
            profile_name=profile_name,
            session_id=session_id,
            turn_id=turn_id,
            offer_id=offer_id,
            manifest=offered_manifest,
            source=source,
        )
        with self._lock:
            concurrent = self._bindings.get(key)
            if concurrent is not None and not concurrent.released:
                duplicate = binding
                binding = concurrent
            else:
                duplicate = None
                self._bindings[key] = binding
            session_key = (profile_name, session_id)
            changed = (
                self._last_fingerprint_by_session.get(session_key)
                != binding.manifest.definition_fingerprint
            )
            self._last_fingerprint_by_session[session_key] = binding.manifest.definition_fingerprint
        if duplicate is not None:
            duplicate.turn_open = False
            self._release_if_unused(projection, duplicate)
        return binding, changed

    def acquire(
        self, projection: CanonicalManagedAgentProjection, *, session_id: str, turn_id: str | None
    ) -> OfferedDefinitionBinding | None:
        if turn_id is None:
            return None
        key = (projection.framework_identity.profile_name, session_id, turn_id)
        with self._lock:
            binding = self._bindings.get(key)
            if binding is None or binding.released or not binding.turn_open:
                return None
            binding.active_invocations += 1
            return binding

    def release_invocation(
        self, projection: CanonicalManagedAgentProjection, binding: OfferedDefinitionBinding
    ) -> None:
        with self._lock:
            if binding.active_invocations <= 0:
                raise RuntimeError("Managed catalog binding invocation count underflow.")
            binding.active_invocations -= 1
        self._release_if_unused(projection, binding)

    def close_session(self, projection: CanonicalManagedAgentProjection, session_id: str) -> None:
        profile_name = projection.framework_identity.profile_name
        with self._lock:
            selected = [
                binding
                for key, binding in self._bindings.items()
                if key[:2] == (profile_name, session_id)
            ]
            for binding in selected:
                binding.turn_open = False
            self._last_fingerprint_by_session.pop((profile_name, session_id), None)
        for binding in selected:
            self._release_if_unused(projection, binding)

    def close(self) -> None:
        with self._lock:
            selected = tuple(self._bindings.values())
            for binding in selected:
                binding.turn_open = False
            self._last_fingerprint_by_session.clear()
        projections = {
            projection.framework_identity.profile_name: projection
            for projection in self._adapter.profiles
        }
        for binding in selected:
            projection = projections.get(binding.profile_name)
            if projection is not None:
                self._release_if_unused(projection, binding)

    def _release_if_unused(
        self, projection: CanonicalManagedAgentProjection, binding: OfferedDefinitionBinding
    ) -> None:
        with self._lock:
            if binding.released or binding.turn_open or binding.active_invocations != 0:
                return
            binding.released = True
            key = (binding.profile_name, binding.session_id, binding.turn_id)
            if self._bindings.get(key) is binding:
                del self._bindings[key]
        trusted_context = self._trusted_context(projection, binding.session_id, binding.turn_id)
        client = self._adapter.gateway_runtime_client_for_profile(binding.profile_name)
        self._adapter.run_gateway_runtime_coroutine(
            client.catalog.release(
                {
                    "definitionFingerprint": binding.manifest.definition_fingerprint,
                    "offerId": binding.offer_id,
                },
                trusted_context=trusted_context,
            )
        )

    @staticmethod
    def _trusted_context(
        projection: CanonicalManagedAgentProjection, session_id: str, turn_id: str
    ) -> dict[str, object]:
        return build_managed_trusted_context(
            projection, session_id=session_id, turn_id=turn_id
        ).model_dump(by_alias=True, mode="json", exclude_none=True)


__all__ = (
    "CatalogNamespaceImport",
    "ManagedCatalogCoordinator",
    "ManagedCatalogPreparationError",
    "ManagedCatalogTurnBindings",
    "ManagedNativeCatalogTool",
    "OfferedDefinitionBinding",
    "PreparedCatalogManifest",
    "PreparedManagedProfileCatalog",
)
