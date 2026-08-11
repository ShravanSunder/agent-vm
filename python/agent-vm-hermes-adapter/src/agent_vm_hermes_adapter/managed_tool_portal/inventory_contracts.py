"""Strict inventory authority, request, and validated Portal result contracts."""

import typing as t

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from agent_vm_hermes_adapter.managed_tool_portal.models import InventoryCacheKey

PORTAL_BATCH_MAX_ITEMS = 50


class _FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class InventoryProjection(_FrozenModel):
    """Immutable profile authority supplied by the managed startup projection."""

    gateway_epoch: str = Field(min_length=1)
    profile_assignment_revision: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)
    profile_name: str = Field(min_length=1)
    tool_portal_profile_id: str = Field(min_length=1)
    namespace_names: tuple[str, ...]

    @field_validator("namespace_names")
    @classmethod
    def validate_namespace_names(cls, names: tuple[str, ...]) -> tuple[str, ...]:
        if len(names) != len(set(names)):
            raise ValueError("inventory projection namespace names must be unique")
        if names != tuple(sorted(names)):
            raise ValueError("inventory projection namespace names must be sorted")
        if any(not name for name in names):
            raise ValueError("inventory projection namespace names must be non-empty")
        return names

    def cache_key(self) -> InventoryCacheKey:
        """Return the complete epoch/profile identity used by the state cache."""
        return InventoryCacheKey(
            gateway_epoch=self.gateway_epoch,
            profile_assignment_revision=self.profile_assignment_revision,
            agent_id=self.agent_id,
            profile_name=self.profile_name,
            tool_portal_profile_id=self.tool_portal_profile_id,
        )


class InventoryListItemRequest(_FrozenModel):
    """One namespace-only existence probe."""

    id: str = Field(min_length=1)
    namespaces: tuple[str, ...] = Field(min_length=1, max_length=1)
    limit: t.Literal[1] = 1

    @model_validator(mode="after")
    def validate_single_namespace(self) -> t.Self:
        if len(self.namespaces) != 1:
            raise ValueError("inventory probes must select exactly one namespace")
        return self


class InventoryListRequest(_FrozenModel):
    """A bounded existing Portal list request containing sequential probes."""

    request_id: str = Field(alias="requestId", min_length=1)
    requests: tuple[InventoryListItemRequest, ...] = Field(
        min_length=1,
        max_length=PORTAL_BATCH_MAX_ITEMS,
    )

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )


class InventoryPortalToolSummary(_FrozenModel):
    """The only live-result fields needed by the existence probe."""

    namespace: str = Field(min_length=1)
    name: str = Field(min_length=1)


class InventoryPortalDiagnostic(_FrozenModel):
    """Closed diagnostic evidence used to validate an existence-probe attempt."""

    code: t.Literal[
        "provider_unavailable",
        "capability_denied",
        "approval_required",
        "validation_failed",
        "execution_failed",
        "output_truncated",
        "timeout",
        "cancelled",
        "artifact_unavailable",
    ]
    level: t.Literal["debug", "info", "warn", "error"]


class InventoryPortalListValue(_FrozenModel):
    """Validated namespace and bounded tool summary returned by Portal list."""

    namespaces: tuple[str, ...]
    tools: tuple[InventoryPortalToolSummary, ...]


class InventoryPortalListItemResult(_FrozenModel):
    """One validated list result item; aggregate consistency is coordinator policy."""

    diagnostics: tuple[InventoryPortalDiagnostic, ...] = ()
    id: str = Field(min_length=1)
    status: t.Literal["ok", "error"]
    value: InventoryPortalListValue | None = None


class InventoryPortalListResult(_FrozenModel):
    """Typed Portal list aggregate supplied to the inventory coordinator."""

    diagnostics: tuple[InventoryPortalDiagnostic, ...] = ()
    items: tuple[InventoryPortalListItemResult, ...]
    ok: bool


class _ValidatedPortableModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )


class _ValidatedToolSchemaSummary(_ValidatedPortableModel):
    optional: list[str]
    property_count: int = Field(alias="propertyCount", ge=0)
    required: list[str]
    type: str = Field(min_length=1)


class _ValidatedToolSafetySummary(_ValidatedPortableModel):
    destructive_hint: bool | None = Field(default=None, alias="destructiveHint")
    read_only_hint: bool | None = Field(default=None, alias="readOnlyHint")


class _ValidatedToolSchemaHint(_ValidatedPortableModel):
    message: str = Field(max_length=500)
    next: t.Literal["call_ready", "describe_before_call"]


class _ValidatedCapabilitySummary(_ValidatedPortableModel):
    description: str | None = None
    input: _ValidatedToolSchemaSummary
    namespace: str = Field(min_length=1)
    output: _ValidatedToolSchemaSummary | None = None
    safety: _ValidatedToolSafetySummary
    schema_hint: _ValidatedToolSchemaHint | None = Field(default=None, alias="schemaHint")
    title: str | None = Field(default=None, min_length=1)
    name: str = Field(min_length=1)
    tool_ref: str = Field(alias="toolRef", min_length=1)


class _ValidatedPortalListValue(_ValidatedPortableModel):
    namespaces: list[str]
    next_cursor: str | None = Field(default=None, alias="nextCursor", pattern=r"^\d+$")
    tools: list[_ValidatedCapabilitySummary]


class _ValidatedArtifactReference(_ValidatedPortableModel):
    byte_length: int = Field(alias="byteLength", ge=0)
    expires_at: str = Field(alias="expiresAt", min_length=1)
    fingerprint: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    id: str = Field(min_length=1)
    media_type: str | None = Field(default=None, alias="mediaType")


class _ValidatedSafeDiagnostic(_ValidatedPortableModel):
    code: t.Literal[
        "provider_unavailable",
        "capability_denied",
        "approval_required",
        "validation_failed",
        "execution_failed",
        "output_truncated",
        "timeout",
        "cancelled",
        "artifact_unavailable",
    ]
    level: t.Literal["debug", "info", "warn", "error"]
    safe_message: str = Field(alias="safeMessage", max_length=500)
    safe_params: dict[str, str | int | float | bool] | None = Field(
        default=None,
        alias="safeParams",
    )


class _ValidatedTruncationMetadata(_ValidatedPortableModel):
    omitted_bytes: int | None = Field(default=None, alias="omittedBytes", ge=0)
    truncated: bool


class _ValidatedPortalError(_ValidatedPortableModel):
    code: t.Literal[
        "invalid_request",
        "not_found",
        "not_authorized",
        "approval_required",
        "capability_denied",
        "validation_failed",
        "provider_unavailable",
        "execution_failed",
        "cancelled",
        "timeout",
    ]
    message: str = Field(min_length=1, max_length=500)
    retryable: bool | None = None
    safe_diagnostic: _ValidatedSafeDiagnostic | None = Field(
        default=None,
        alias="safeDiagnostic",
    )


class _ValidatedPortalListSuccessItem(_ValidatedPortableModel):
    artifacts: list[_ValidatedArtifactReference] | None = None
    diagnostics: list[_ValidatedSafeDiagnostic] | None = None
    id: str = Field(min_length=1)
    status: t.Literal["ok"]
    truncation: _ValidatedTruncationMetadata | None = None
    value: _ValidatedPortalListValue


class _ValidatedPortalListErrorItem(_ValidatedPortableModel):
    diagnostics: list[_ValidatedSafeDiagnostic] | None = None
    error: _ValidatedPortalError
    id: str = Field(min_length=1)
    status: t.Literal["error"]


_ValidatedPortalListItem = t.Annotated[
    _ValidatedPortalListSuccessItem | _ValidatedPortalListErrorItem,
    Field(discriminator="status"),
]


class _ValidatedPortalListResult(_ValidatedPortableModel):
    audit_correlation_id: str | None = Field(default=None, alias="auditCorrelationId")
    diagnostics: list[_ValidatedSafeDiagnostic] | None = None
    items: list[_ValidatedPortalListItem]
    ok: bool


def _project_validated_diagnostics(
    diagnostics: list[_ValidatedSafeDiagnostic] | None,
) -> tuple[InventoryPortalDiagnostic, ...]:
    return tuple(
        InventoryPortalDiagnostic(code=diagnostic.code, level=diagnostic.level)
        for diagnostic in diagnostics or []
    )


def _project_validated_portal_list_result(model: BaseModel) -> InventoryPortalListResult:
    projected = _ValidatedPortalListResult.model_validate(
        model.model_dump(by_alias=True, mode="python", exclude_none=False),
    )
    return InventoryPortalListResult(
        items=tuple(
            InventoryPortalListItemResult(
                diagnostics=_project_validated_diagnostics(item.diagnostics),
                id=item.id,
                status="error",
            )
            if isinstance(item, _ValidatedPortalListErrorItem)
            else InventoryPortalListItemResult(
                diagnostics=_project_validated_diagnostics(item.diagnostics),
                id=item.id,
                status="ok",
                value=InventoryPortalListValue(
                    namespaces=tuple(item.value.namespaces),
                    tools=tuple(
                        InventoryPortalToolSummary(
                            namespace=tool.namespace,
                            name=tool.name,
                        )
                        for tool in item.value.tools
                    ),
                ),
            )
            for item in projected.items
        ),
        diagnostics=_project_validated_diagnostics(projected.diagnostics),
        ok=projected.ok,
    )


def validate_inventory_portal_list_result(raw_result: object) -> InventoryPortalListResult:
    """Validate the complete portable result before projecting probe fields."""
    if isinstance(raw_result, InventoryPortalListResult):
        return raw_result
    validation_input = (
        raw_result.model_dump(by_alias=True, mode="json", exclude_none=False)
        if isinstance(raw_result, BaseModel)
        else raw_result
    )
    try:
        validated_result = PORTABLE_CONTRACT_ADAPTERS["portal.list.result"].validate_python(
            validation_input,
        )
    except ValidationError:
        raise
    except Exception as error:
        raise ValueError("portable Portal list result validation failed") from error
    if not isinstance(validated_result, BaseModel):
        raise TypeError("portable Portal list validation did not return a Pydantic model")
    return _project_validated_portal_list_result(validated_result)


__all__ = (
    "InventoryListItemRequest",
    "InventoryListRequest",
    "InventoryPortalListItemResult",
    "InventoryPortalListResult",
    "InventoryPortalListValue",
    "InventoryPortalDiagnostic",
    "InventoryPortalToolSummary",
    "InventoryProjection",
    "PORTAL_BATCH_MAX_ITEMS",
    "validate_inventory_portal_list_result",
)
