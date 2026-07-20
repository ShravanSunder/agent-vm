"""Fail-closed Hermes profile-origin adapter for managed mode."""

import re
import types
import typing as t
from collections.abc import Coroutine
from concurrent.futures import Future

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from pydantic import BaseModel

from .managed_gateway_runtime_client_loop import GatewayRuntimeClientLoop

CanonicalManagedAgentProjection = t.Mapping[str, object]
_HERMES_PROFILE_NAME_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
_PROJECTION_COHORT_DIGEST_PATTERN = re.compile(r"projection-cohort:[a-f0-9]{64}")


def _validate_canonical_managed_projection(value: object) -> CanonicalManagedAgentProjection:
    validated_value = PORTABLE_CONTRACT_ADAPTERS[
        "gateway.managed-agent-projection"
    ].validate_python(value)
    if not isinstance(validated_value, BaseModel):
        message = "canonical managed-agent projection did not produce a typed model"
        raise TypeError(message)
    normalized_value = validated_value.model_dump(mode="json")
    if not isinstance(normalized_value, dict):
        message = "canonical managed-agent projection did not produce an object"
        raise TypeError(message)
    projection = t.cast("dict[str, object]", normalized_value)
    framework_identity_value = projection.get("frameworkIdentity")
    if not isinstance(framework_identity_value, dict):
        message = "canonical managed-agent projection has no framework identity"
        raise ValueError(message)
    framework_identity = t.cast("dict[str, object]", framework_identity_value)
    if framework_identity.get("kind") != "hermes":
        message = "managed Hermes projection must carry a Hermes framework identity"
        raise ValueError(message)
    profile_name = framework_identity.get("profileName")
    if (
        not isinstance(profile_name, str)
        or profile_name == "default"
        or _HERMES_PROFILE_NAME_PATTERN.fullmatch(profile_name) is None
    ):
        message = "profileName must be an explicit non-default Hermes profile identifier"
        raise ValueError(message)
    agent_id = projection.get("agentId")
    if not isinstance(agent_id, str):
        message = "canonical managed-agent projection has no agentId"
        raise ValueError(message)
    return types.MappingProxyType(
        {
            **projection,
            "frameworkIdentity": types.MappingProxyType(framework_identity),
        }
    )


def _projection_string_field(
    projection: CanonicalManagedAgentProjection,
    field_name: str,
) -> str:
    value = projection.get(field_name)
    if not isinstance(value, str):
        message = f"canonical managed-agent projection field {field_name!r} is not a string"
        raise TypeError(message)
    return value


def _projection_profile_name(projection: CanonicalManagedAgentProjection) -> str:
    framework_identity_value = projection.get("frameworkIdentity")
    if not isinstance(framework_identity_value, t.Mapping):
        message = "canonical managed-agent projection has no framework identity"
        raise TypeError(message)
    framework_identity = t.cast("t.Mapping[str, object]", framework_identity_value)
    profile_name = framework_identity.get("profileName")
    if not isinstance(profile_name, str):
        message = "canonical managed-agent projection has no Hermes profileName"
        raise TypeError(message)
    return profile_name


def build_managed_trusted_context(
    projection: CanonicalManagedAgentProjection,
    *,
    session_id: str | None = None,
) -> dict[str, object]:
    """Build the shared trusted principal from one admitted Hermes projection."""
    framework_identity = projection.get("frameworkIdentity")
    if not isinstance(framework_identity, t.Mapping):
        message = "canonical managed-agent projection has no framework identity"
        raise TypeError(message)
    return {
        **({"correlation": {"sessionId": session_id}} if session_id is not None else {}),
        "principal": {
            "agentId": _projection_string_field(projection, "agentId"),
            "frameworkIdentity": dict(framework_identity),
            "profileAssignmentRevision": _projection_string_field(
                projection,
                "profileAssignmentRevision",
            ),
            "toolPortalProfileId": _projection_string_field(
                projection,
                "toolPortalProfileId",
            ),
        },
    }


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
        profiles: t.Iterable[object],
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
        unique_fields = {
            "agentId": [
                _projection_string_field(projection, "agentId") for projection in validated_profiles
            ],
            "profileName": [
                _projection_profile_name(projection) for projection in validated_profiles
            ],
        }
        for label, values in unique_fields.items():
            if len(values) != len(set(values)):
                message = f"{label} must be unique in the managed Hermes cohort"
                raise ValueError(message)
        self._profiles = tuple(sorted(validated_profiles, key=_projection_profile_name))
        self.projection_cohort_digest = projection_cohort_digest
        self.protected_hermes_home = protected_hermes_home

    @property
    def profiles(self) -> tuple[CanonicalManagedAgentProjection, ...]:
        return self._profiles


class HermesSessionSource(t.Protocol):
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
