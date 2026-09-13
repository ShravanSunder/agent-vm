"""Prepared catalog registration and exact Hermes turn bindings."""

import hashlib
import json
import threading
import typing as t
from collections.abc import Mapping

from agent_vm_agent_portal_sdk.catalog_module_publication import CatalogPublicationIdentity
from agent_vm_agent_portal_sdk.catalog_relay_startup import GatewayPortalCatalogSource
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
    registered_name: str = Field(min_length=1, max_length=128)
    namespace: str = Field(min_length=1)
    tool_name: str = Field(min_length=1)
    description: str = ""
    input_schema: dict[str, object]


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


def _required_mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise TypeError(f"{label} must be an object.")
    return {str(key): item for key, item in value.items()}


def _required_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise TypeError(f"{label} must be a non-empty string.")
    return value


def _read_items(payload: Mapping[str, object], label: str) -> list[dict[str, object]]:
    items = payload.get("items")
    if payload.get("ok") is not True or not isinstance(items, list):
        raise ManagedCatalogPreparationError(f"{label} was incomplete.")
    return [_required_mapping(item, f"{label} item") for item in items]


def _read_item_value(item: Mapping[str, object], label: str) -> dict[str, object]:
    if item.get("status") != "ok" or item.get("diagnostics"):
        raise ManagedCatalogPreparationError(f"{label} returned an unavailable capability.")
    return _required_mapping(item.get("value"), f"{label} value")


def _read_tools(value: Mapping[str, object], label: str) -> list[dict[str, object]]:
    tools = value.get("tools")
    if not isinstance(tools, list):
        raise ManagedCatalogPreparationError(f"{label} omitted tools.")
    return [_required_mapping(tool, f"{label} tool") for tool in tools]


def _readable_tool_name_segment(value: str) -> str:
    characters = [
        character if character.isascii() and (character.isalnum() or character in "_-") else "_"
        for character in value
    ]
    segment = "".join(characters)
    while "__" in segment:
        segment = segment.replace("__", "_")
    return segment or "tool"


def managed_catalog_tool_name(namespace: str, tool_name: str) -> str:
    """Mirror the standalone collision-safe readable catalog name contract."""
    identity = json.dumps([namespace, tool_name], ensure_ascii=False, separators=(",", ":"))
    suffix = hashlib.sha256(identity.encode()).hexdigest()[:10]
    prefix = f"{_readable_tool_name_segment(namespace)}__{_readable_tool_name_segment(tool_name)}"
    return f"{prefix[: 128 - len(suffix) - 2]}__{suffix}"


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
        native_tools = await self._prepare_native_tools(projection, trusted_context, client=client)
        return PreparedManagedProfileCatalog(
            profile_name=projection.framework_identity.profile_name,
            manifest=manifest,
            native_tools=native_tools,
        )

    async def _prepare_native_tools(
        self,
        projection: CanonicalManagedAgentProjection,
        trusted_context: Mapping[str, object],
        client: GatewayRuntimeClient,
    ) -> tuple[ManagedNativeCatalogTool, ...]:
        references: list[tuple[str, str]] = []
        for namespace_projection in projection.tool_portal_namespaces:
            cursor: str | None = None
            seen_cursors: set[str] = set()
            while True:
                list_request: dict[str, object] = {
                    "requestId": f"catalog-native-list-{namespace_projection.namespace}",
                    "requests": [
                        {
                            "id": "catalog-native-list",
                            "limit": 100,
                            "namespaces": [namespace_projection.namespace],
                            **({"cursor": cursor} if cursor is not None else {}),
                        }
                    ],
                }
                listed = _model_payload(
                    await client.portal.list(list_request, trusted_context=trusted_context)
                )
                items = _read_items(listed, "Managed native catalog listing")
                if len(items) != 1:
                    raise ManagedCatalogPreparationError(
                        "Managed native catalog listing returned an unexpected item count."
                    )
                value = _read_item_value(items[0], "Managed native catalog listing")
                for tool in _read_tools(value, "Managed native catalog listing"):
                    namespace = _required_string(tool.get("namespace"), "catalog namespace")
                    name = _required_string(tool.get("name"), "catalog tool name")
                    if namespace != namespace_projection.namespace:
                        raise ManagedCatalogPreparationError(
                            "Managed native catalog listing crossed namespaces."
                        )
                    references.append((namespace, name))
                next_cursor = value.get("nextCursor")
                if next_cursor is None:
                    break
                next_cursor = _required_string(next_cursor, "catalog next cursor")
                if next_cursor in seen_cursors:
                    raise ManagedCatalogPreparationError(
                        "Managed native catalog listing repeated a cursor."
                    )
                seen_cursors.add(next_cursor)
                cursor = next_cursor

        if len(references) != len(set(references)):
            raise ManagedCatalogPreparationError(
                "Managed native catalog contains duplicate capability identities."
            )
        descriptors: list[ManagedNativeCatalogTool] = []
        sorted_references = sorted(references)
        for offset in range(0, len(sorted_references), 100):
            selected = sorted_references[offset : offset + 100]
            described = _model_payload(
                await client.portal.describe(
                    {
                        "requestId": f"catalog-native-describe-{offset}",
                        "requests": [
                            {
                                "id": "catalog-native-describe",
                                "includeJsonSchema": True,
                                "includeRelated": False,
                                "includeTypescriptHelper": False,
                                "includeZod": False,
                                "tools": [
                                    {"namespace": namespace, "name": name}
                                    for namespace, name in selected
                                ],
                            }
                        ],
                    },
                    trusted_context=trusted_context,
                )
            )
            items = _read_items(described, "Managed native catalog description")
            if len(items) != 1:
                raise ManagedCatalogPreparationError(
                    "Managed native catalog description returned an unexpected item count."
                )
            value = _read_item_value(items[0], "Managed native catalog description")
            for tool in _read_tools(value, "Managed native catalog description"):
                namespace = _required_string(tool.get("namespace"), "catalog namespace")
                name = _required_string(tool.get("name"), "catalog tool name")
                schema = _required_mapping(tool.get("inputSchema"), "catalog input schema")
                description_value = tool.get("description", "")
                description = description_value if isinstance(description_value, str) else ""
                descriptors.append(
                    ManagedNativeCatalogTool(
                        registered_name=managed_catalog_tool_name(namespace, name),
                        namespace=namespace,
                        tool_name=name,
                        description=description,
                        input_schema=schema,
                    )
                )
        if {(item.namespace, item.tool_name) for item in descriptors} != set(sorted_references):
            raise ManagedCatalogPreparationError(
                "Managed native catalog description was incomplete."
            )
        if len({item.registered_name for item in descriptors}) != len(descriptors):
            raise ManagedCatalogPreparationError("Managed native catalog exported duplicate names.")
        return tuple(sorted(descriptors, key=lambda item: item.registered_name))


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
        with self._lock:
            selected = [
                binding
                for key, binding in self._bindings.items()
                if key[:2] == (projection.framework_identity.profile_name, session_id)
            ]
            for binding in selected:
                binding.turn_open = False
        for binding in selected:
            self._release_if_unused(projection, binding)

    def close(self) -> None:
        with self._lock:
            selected = tuple(self._bindings.values())
            for binding in selected:
                binding.turn_open = False
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
    "managed_catalog_tool_name",
)
