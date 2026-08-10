"""Gateway Runtime adapter for explicit, profile-scoped Portal inventory."""

import asyncio
import logging
import typing as t

from agent_vm_agent_portal_sdk.gateway_runtime_client import (
    GatewayRuntimeClientError,
)
from pydantic import BaseModel

from ..managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesProfileAdmissionError,
    build_managed_trusted_context,
)
from .inventory import (
    InventoryAttemptLog,
    InventoryAuthorityError,
)
from .inventory_contracts import (
    InventoryListRequest,
    InventoryPortalListResult,
    InventoryProjection,
    validate_inventory_portal_list_result,
)

_LOGGER = logging.getLogger(__name__)


class InventoryPortalListOperationsPort(t.Protocol):
    async def list(
        self,
        request: dict[str, object],
        *,
        trusted_context: dict[str, object],
    ) -> BaseModel: ...


class InventoryGatewayRuntimeClientPort(t.Protocol):
    @property
    def portal(self) -> InventoryPortalListOperationsPort: ...


class InventoryGatewayRuntimeAdapterPort(t.Protocol):
    def projection_for_profile(
        self,
        profile_name: str,
    ) -> CanonicalManagedAgentProjection: ...

    def gateway_runtime_client_for_profile(
        self,
        profile_name: str,
    ) -> InventoryGatewayRuntimeClientPort: ...


def _projection_matches(
    projection: InventoryProjection,
    admitted_projection: CanonicalManagedAgentProjection,
) -> bool:
    return (
        projection.profile_assignment_revision == admitted_projection.profile_assignment_revision
        and projection.agent_id == admitted_projection.agent_id
        and projection.profile_name == admitted_projection.framework_identity.profile_name
        and projection.tool_portal_profile_id == admitted_projection.tool_portal_profile_id
        and projection.namespace_names == admitted_projection.tool_portal_namespace_names
    )


@t.final
class GatewayRuntimeInventoryPort:
    """Use one admitted projection to perform one bounded Portal list operation."""

    def __init__(
        self,
        *,
        adapter: InventoryGatewayRuntimeAdapterPort,
        gateway_epoch: str,
    ) -> None:
        if not gateway_epoch:
            raise ValueError("gateway_epoch must not be empty")
        self._adapter = adapter
        self._gateway_epoch = gateway_epoch

    async def list_for_projection(
        self,
        projection: InventoryProjection,
        request: InventoryListRequest,
        *,
        timeout_seconds: float,
    ) -> InventoryPortalListResult:
        """Call only the existing Portal list operation for the explicit profile."""
        if projection.gateway_epoch != self._gateway_epoch:
            raise InventoryAuthorityError(
                "inventory projection belongs to a different Gateway epoch"
            )
        try:
            admitted_projection = self._adapter.projection_for_profile(projection.profile_name)
            client = self._adapter.gateway_runtime_client_for_profile(projection.profile_name)
        except HermesProfileAdmissionError as error:
            raise InventoryAuthorityError(
                "inventory profile is outside managed authority"
            ) from error
        if not _projection_matches(projection, admitted_projection):
            raise InventoryAuthorityError("inventory projection does not match managed authority")

        request_payload = request.model_dump(
            by_alias=True,
            mode="json",
            exclude_none=True,
        )
        trusted_context = build_managed_trusted_context(admitted_projection).model_dump(
            by_alias=True,
            mode="json",
            exclude_none=True,
        )
        try:
            async with asyncio.timeout(timeout_seconds):
                raw_result = await client.portal.list(
                    request_payload,
                    trusted_context=trusted_context,
                )
        except GatewayRuntimeClientError as error:
            raise InventoryAuthorityError("Gateway Runtime rejected inventory authority") from error
        return validate_inventory_portal_list_result(raw_result)


@t.final
class RedactedInventoryAttemptLogSink:
    """Emit bounded inventory failure evidence without request or result payloads."""

    def __init__(self, *, logger: logging.Logger | None = None) -> None:
        self._logger = _LOGGER if logger is None else logger

    def record_inventory_attempt(self, record: InventoryAttemptLog) -> None:
        self._logger.warning(
            "managed Tool Portal inventory attempt failed: gateway_epoch=%s "
            "profile=%s attempt=%d failure=%s disposition=%s",
            record.gateway_epoch,
            record.profile_name,
            record.attempt_number,
            record.failure_class.value,
            record.retry_disposition.value,
        )


__all__ = (
    "GatewayRuntimeInventoryPort",
    "InventoryGatewayRuntimeAdapterPort",
    "InventoryGatewayRuntimeClientPort",
    "InventoryPortalListOperationsPort",
    "RedactedInventoryAttemptLogSink",
)
