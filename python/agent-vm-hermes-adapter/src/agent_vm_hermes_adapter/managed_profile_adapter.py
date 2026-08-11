"""Fail-closed Hermes profile-origin adapter for managed mode."""

import re
from collections.abc import Coroutine, Iterable
from concurrent.futures import Future
from typing import Annotated, Literal, Protocol

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
)

from .managed_gateway_runtime_client_loop import GatewayRuntimeClientLoop

_HERMES_PROFILE_NAME_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
_PROJECTION_COHORT_DIGEST_PATTERN = re.compile(r"projection-cohort:[a-f0-9]{64}")
_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH = 256
type ManagedToolPortalNamespaceName = Annotated[str, Field(min_length=1)]


def _coerce_portable_namespace_names(value: object) -> object:
    if isinstance(value, list):
        return tuple(value)
    return value


class ManagedFrameworkIdentity(BaseModel):
    """The Hermes framework identity admitted by a managed projection."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )

    kind: Literal["hermes"]
    profile_name: str = Field(
        alias="profileName",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )

    @field_validator("profile_name")
    @classmethod
    def _validate_profile_name(cls, profile_name: str) -> str:
        if (
            profile_name == "default"
            or _HERMES_PROFILE_NAME_PATTERN.fullmatch(profile_name) is None
        ):
            message = "profileName must be an explicit non-default Hermes profile identifier"
            raise ValueError(message)
        return profile_name


class CanonicalManagedAgentProjection(BaseModel):
    """Strict immutable projection received from the portable contract boundary."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )

    agent_id: str = Field(
        alias="agentId",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )
    framework_identity: ManagedFrameworkIdentity = Field(alias="frameworkIdentity")
    profile_assignment_revision: str = Field(
        alias="profileAssignmentRevision",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )
    tool_portal_namespace_names: Annotated[
        tuple[ManagedToolPortalNamespaceName, ...],
        BeforeValidator(_coerce_portable_namespace_names),
    ] = Field(alias="toolPortalNamespaceNames", min_length=0)
    tool_portal_profile_id: str = Field(
        alias="toolPortalProfileId",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )

    @field_validator("tool_portal_namespace_names")
    @classmethod
    def _validate_namespace_names(
        cls,
        namespace_names: tuple[ManagedToolPortalNamespaceName, ...],
    ) -> tuple[ManagedToolPortalNamespaceName, ...]:
        if len(namespace_names) != len(set(namespace_names)):
            message = "Managed Agent Projection Tool Portal namespace names must be unique."
            raise ValueError(message)
        if namespace_names != tuple(sorted(namespace_names)):
            message = "Managed Agent Projection Tool Portal namespace names must be sorted."
            raise ValueError(message)
        return namespace_names


class ManagedTrustedInvocationPrincipal(BaseModel):
    """Managed principal carried to Gateway Runtime operations."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )

    agent_id: str = Field(
        alias="agentId",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )
    framework_identity: ManagedFrameworkIdentity = Field(alias="frameworkIdentity")
    profile_assignment_revision: str = Field(
        alias="profileAssignmentRevision",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )
    tool_portal_profile_id: str = Field(
        alias="toolPortalProfileId",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )


class ManagedTrustedInvocationCorrelation(BaseModel):
    """Optional correlation values for a trusted Gateway Runtime call."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )

    run_id: str | None = Field(
        default=None,
        alias="runId",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )
    session_id: str | None = Field(
        default=None,
        alias="sessionId",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )
    session_key: str | None = Field(
        default=None,
        alias="sessionKey",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )
    tool_call_id: str | None = Field(
        default=None,
        alias="toolCallId",
        min_length=1,
        max_length=_BOUNDED_IDENTIFIER_MAXIMUM_LENGTH,
    )


class ManagedTrustedContext(BaseModel):
    """Strict immutable trusted context before external wire serialization."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )

    correlation: ManagedTrustedInvocationCorrelation | None = None
    principal: ManagedTrustedInvocationPrincipal


def _validate_canonical_managed_projection(value: object) -> CanonicalManagedAgentProjection:
    portable_value = (
        value.model_dump(by_alias=True, mode="json")
        if isinstance(value, CanonicalManagedAgentProjection)
        else value
    )
    validated_value = PORTABLE_CONTRACT_ADAPTERS[
        "gateway.managed-agent-projection"
    ].validate_python(portable_value)
    if not isinstance(validated_value, BaseModel):
        message = "canonical managed-agent projection did not produce a typed model"
        raise TypeError(message)
    try:
        return CanonicalManagedAgentProjection.model_validate(
            validated_value.model_dump(mode="python")
        )
    except ValidationError as error:
        message = "canonical managed-agent projection did not satisfy the managed Hermes model"
        raise ValueError(message) from error


def _projection_string_field(
    projection: CanonicalManagedAgentProjection,
    field_name: str,
) -> str:
    if field_name == "agentId":
        return projection.agent_id
    if field_name == "profileAssignmentRevision":
        return projection.profile_assignment_revision
    if field_name == "toolPortalProfileId":
        return projection.tool_portal_profile_id
    message = f"canonical managed-agent projection field {field_name!r} is not a string"
    raise TypeError(message)


def _projection_profile_name(projection: CanonicalManagedAgentProjection) -> str:
    return projection.framework_identity.profile_name


def build_managed_trusted_context(
    projection: CanonicalManagedAgentProjection,
    *,
    session_id: str | None = None,
) -> ManagedTrustedContext:
    """Build the shared trusted principal from one admitted Hermes projection."""
    correlation = (
        ManagedTrustedInvocationCorrelation(session_id=session_id)
        if session_id is not None
        else None
    )
    return ManagedTrustedContext(
        correlation=correlation,
        principal=ManagedTrustedInvocationPrincipal(
            agent_id=projection.agent_id,
            framework_identity=projection.framework_identity,
            profile_assignment_revision=projection.profile_assignment_revision,
            tool_portal_profile_id=projection.tool_portal_profile_id,
        ),
    )


def _require_normalized_absolute_guest_path(value: str, label: str) -> str:
    segments = value.split("/")
    if (
        not value
        or not value.startswith("/")
        or "\x00" in value
        or "//" in value
        or (len(value) > 1 and value.endswith("/"))
        or any(segment in {".", ".."} for segment in segments)
    ):
        message = f"{label} must be a normalized absolute guest path"
        raise ValueError(message)
    return value


class HermesManagedAdapterConfig:
    """Immutable exact-cohort wrapper around canonical portable projections."""

    __slots__ = ("_profiles", "projection_cohort_digest", "protected_hermes_home")

    def __init__(
        self,
        *,
        profiles: Iterable[object],
        projection_cohort_digest: str,
        protected_hermes_home: str,
    ) -> None:
        if _PROJECTION_COHORT_DIGEST_PATTERN.fullmatch(projection_cohort_digest) is None:
            message = "projection_cohort_digest must be a canonical projection-cohort digest"
            raise ValueError(message)
        protected_hermes_home = _require_normalized_absolute_guest_path(
            protected_hermes_home,
            "protected_hermes_home",
        )
        if protected_hermes_home == "/":
            message = "protected_hermes_home cannot be the guest root"
            raise ValueError(message)
        if protected_hermes_home == "/zone" or protected_hermes_home.startswith("/zone/"):
            message = "protected_hermes_home cannot be inside Gateway zone files"
            raise ValueError(message)
        validated_profiles = tuple(
            _validate_canonical_managed_projection(value) for value in profiles
        )
        if not validated_profiles:
            message = "managed Hermes requires at least one explicitly configured profile"
            raise ValueError(message)
        agent_ids = tuple(projection.agent_id for projection in validated_profiles)
        if len(agent_ids) != len(set(agent_ids)):
            message = "agentId must be unique in the managed Hermes cohort"
            raise ValueError(message)
        profile_names = tuple(
            _projection_profile_name(projection) for projection in validated_profiles
        )
        if len(profile_names) != len(set(profile_names)):
            message = "profileName must be unique in the managed Hermes cohort"
            raise ValueError(message)
        self._profiles = tuple(sorted(validated_profiles, key=_projection_profile_name))
        self.projection_cohort_digest = projection_cohort_digest
        self.protected_hermes_home = protected_hermes_home

    @property
    def profiles(self) -> tuple[CanonicalManagedAgentProjection, ...]:
        return self._profiles


class HermesSessionSource(Protocol):
    profile: str | None


class HermesProfileAdmissionError(Exception):
    """The routed Hermes profile is absent from the immutable managed cohort."""


class HermesManagedAdapter:
    """Profile admission plus one injected GatewayRuntimeClient identity."""

    def __init__(
        self,
        *,
        config: HermesManagedAdapterConfig,
        gateway_runtime_client: GatewayRuntimeClient,
    ) -> None:
        self._gateway_runtime_client = gateway_runtime_client
        self._projection_by_profile_name = {
            _projection_profile_name(projection): projection for projection in config.profiles
        }
        self._gateway_runtime_client_loop = GatewayRuntimeClientLoop(gateway_runtime_client)

    def admit_session_source(
        self,
        source: HermesSessionSource,
    ) -> CanonicalManagedAgentProjection:
        profile_name = source.profile
        if not profile_name or profile_name == "default":
            raise HermesProfileAdmissionError(
                "Managed Hermes requires an explicit routed SessionSource.profile."
            )
        projection = self._projection_by_profile_name.get(profile_name)
        if projection is None:
            raise HermesProfileAdmissionError(
                f"Hermes profile {profile_name!r} is outside the immutable managed cohort."
            )
        return projection

    def gateway_runtime_client_for_profile(self, profile_name: str) -> GatewayRuntimeClient:
        if profile_name not in self._projection_by_profile_name:
            raise HermesProfileAdmissionError(
                f"Hermes profile {profile_name!r} is outside the immutable managed cohort."
            )
        return self._gateway_runtime_client

    @property
    def profiles(self) -> tuple[CanonicalManagedAgentProjection, ...]:
        return tuple(self._projection_by_profile_name.values())

    def projection_for_profile(
        self,
        profile_name: str,
    ) -> CanonicalManagedAgentProjection:
        projection = self._projection_by_profile_name.get(profile_name)
        if projection is None:
            raise HermesProfileAdmissionError(
                f"Hermes profile {profile_name!r} is outside the immutable managed cohort."
            )
        return projection

    def connect_gateway_runtime(self) -> None:
        self._gateway_runtime_client_loop.connect()

    def submit_gateway_runtime_coroutine[TResult](
        self,
        coroutine: Coroutine[object, object, TResult],
    ) -> Future[TResult]:
        return self._gateway_runtime_client_loop.submit(coroutine)

    def run_gateway_runtime_coroutine[TResult](
        self,
        coroutine: Coroutine[object, object, TResult],
        *,
        timeout: float | None = None,
    ) -> TResult:
        return self._gateway_runtime_client_loop.run(coroutine, timeout=timeout)

    def close(self, *, disconnect_gateway_runtime: bool = True) -> None:
        self._gateway_runtime_client_loop.close(
            disconnect=disconnect_gateway_runtime,
        )
