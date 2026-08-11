"""Typed consumer models for the managed Tool Portal state primitives."""

import enum
import typing as t

from pydantic import BaseModel, ConfigDict, Field, model_validator


class _FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class EvictionReason(enum.StrEnum):
    """Closed reasons for removing a cache entry from active state."""

    RUNTIME_SHUTDOWN = "runtime_shutdown"


class PopulationFailureClass(enum.StrEnum):
    """Closed terminal classes for a failed population."""

    INVALID_AUTHORITY = "invalid_authority"


class InventoryCacheKey(_FrozenModel):
    """Epoch and profile identity for one shared Tool Portal inventory."""

    gateway_epoch: str = Field(min_length=1)
    profile_assignment_revision: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)
    profile_name: str = Field(min_length=1)
    tool_portal_profile_id: str = Field(min_length=1)


class InjectionCacheKey(InventoryCacheKey):
    """Complete epoch/profile/exact-session identity for injection state."""

    session_id: str = Field(min_length=1)


class InjectionMarker(_FrozenModel):
    """Marker proving that the orientation was returned for one exact identity."""

    injected: t.Literal[True] = True


AvailabilityStatus = t.Literal["available", "unavailable"]


class NamespaceAvailability(_FrozenModel):
    """One admitted namespace and its fail-closed live availability status."""

    namespace: str = Field(min_length=1)
    status: AvailabilityStatus


class NamespaceInventory(_FrozenModel):
    """Complete, duplicate-free inventory for one profile and epoch."""

    inventory_id: str = Field(min_length=1)
    namespaces: tuple[NamespaceAvailability, ...]

    @model_validator(mode="after")
    def validate_namespace_names(self) -> t.Self:
        names = tuple(item.namespace for item in self.namespaces)
        if len(names) != len(set(names)):
            raise ValueError("namespace inventory names must be unique")
        return self


class RenderedOrientation(_FrozenModel):
    """A deterministic orientation block that is safe to append to a turn."""

    kind: t.Literal["rendered-orientation"] = "rendered-orientation"
    inventory_id: str = Field(min_length=1)
    orientation: str = Field(min_length=1)
    utf8_byte_count: int = Field(ge=1)
    displayed_count: int = Field(ge=0, le=20)
    total_count: int = Field(ge=0)
    omitted_count: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_rendered_metadata(self) -> t.Self:
        if self.orientation.endswith("\n"):
            raise ValueError("orientation must not end with a newline")
        if len(self.orientation.encode("utf-8")) != self.utf8_byte_count:
            raise ValueError("utf8_byte_count must match orientation bytes")
        if self.displayed_count + self.omitted_count != self.total_count:
            raise ValueError("orientation counts must account for every namespace")
        return self


class OrientationRenderFailure(_FrozenModel):
    """Fail-closed renderer result when even the mandatory block cannot fit."""

    kind: t.Literal["orientation-render-failure"] = "orientation-render-failure"
    inventory_id: str = Field(min_length=1)
    reason: t.Literal["zero-prefix-does-not-fit"] = "zero-prefix-does-not-fit"
    minimum_required_bytes: int = Field(ge=1)
    displayed_count: t.Literal[0] = 0
    total_count: int = Field(ge=0)
    omitted_count: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_omitted_count(self) -> t.Self:
        if self.omitted_count != self.total_count:
            raise ValueError("a zero-prefix render failure omits every namespace")
        return self


class InventoryReadyValue(_FrozenModel):
    """Resolved inventory plus its private model-visible rendering result."""

    inventory: NamespaceInventory
    orientation: RenderedOrientation | OrientationRenderFailure


class PopulationHandle[TKey: BaseModel](_FrozenModel):
    """Opaque generation token accepted by one population owner."""

    key: TKey
    generation: int = Field(ge=1)


class UnresolvedState(_FrozenModel):
    """No population has been started for the key."""

    kind: t.Literal["unresolved"] = "unresolved"


class PopulatingState(_FrozenModel):
    """One active population generation and its current attempt."""

    kind: t.Literal["populating"] = "populating"
    attempt_number: int = Field(ge=1)
    started_at_monotonic: float


class ReadyState[TValue: BaseModel](_FrozenModel):
    """Validated value published by the active generation."""

    kind: t.Literal["ready"] = "ready"
    value: TValue
    published_at_monotonic: float


class ExhaustedState(_FrozenModel):
    """Terminal population failure that is not an active value."""

    kind: t.Literal["exhausted"] = "exhausted"
    failure_class: PopulationFailureClass
    completed_at_monotonic: float


class EvictionRecord[TKey: BaseModel](_FrozenModel):
    """Inspectable, ordered record for one cache eviction."""

    key: TKey
    reason: EvictionReason
    sequence_number: int = Field(ge=1)
    evicted_at_monotonic: float


class EvictedState[TKey: BaseModel](_FrozenModel):
    """Terminal state carrying the reason the previous value disappeared."""

    kind: t.Literal["evicted"] = "evicted"
    eviction: EvictionRecord[TKey]
