import unittest

from agent_vm_hermes_adapter.managed_profile_adapter import CanonicalManagedAgentProjection
from agent_vm_hermes_adapter.managed_tool_portal.gateway_runtime_inventory_port import (
    GatewayRuntimeInventoryPort,
    RedactedInventoryAttemptLogSink,
)
from agent_vm_hermes_adapter.managed_tool_portal.inventory import (
    InventoryAttemptLog,
    InventoryAuthorityError,
    InventoryFailureClass,
    InventoryListItemRequest,
    InventoryListRequest,
    InventoryPortalListResult,
    InventoryProjection,
    InventoryRetryDisposition,
)
from agent_vm_hermes_adapter.managed_tool_portal.models import NamespaceDiscovery


def _projection() -> CanonicalManagedAgentProjection:
    return CanonicalManagedAgentProjection.model_validate(
        {
            "agentId": "researcher",
            "frameworkIdentity": {"kind": "hermes", "profileName": "researcher"},
            "profileAssignmentRevision": "revision-researcher",
            "toolPortalNamespaces": [
                {"namespace": "filesystem"},
                {"namespace": "github", "summary": "Repository access."},
            ],
            "toolPortalProfileId": "policy-researcher",
        }
    )


def _inventory_projection() -> InventoryProjection:
    return InventoryProjection(
        gateway_epoch="gateway-epoch-1",
        profile_assignment_revision="revision-researcher",
        agent_id="researcher",
        profile_name="researcher",
        tool_portal_profile_id="policy-researcher",
        namespaces=(
            NamespaceDiscovery(namespace="filesystem"),
            NamespaceDiscovery(namespace="github", summary="Repository access."),
        ),
    )


class _FakePortal:
    def __init__(self) -> None:
        self.calls: list[tuple[dict[str, object], dict[str, object]]] = []

    async def list(
        self,
        request: dict[str, object],
        *,
        trusted_context: dict[str, object],
    ) -> InventoryPortalListResult:
        self.calls.append((request, trusted_context))
        return InventoryPortalListResult(items=(), ok=True)


class _FakeClient:
    def __init__(self) -> None:
        self.portal = _FakePortal()


class _FakeAdapter:
    def __init__(self) -> None:
        self.client = _FakeClient()

    def gateway_runtime_client_for_profile(self, profile_name: str) -> _FakeClient:
        if profile_name != "researcher":
            raise AssertionError(f"unexpected profile {profile_name!r}")
        return self.client

    def projection_for_profile(self, profile_name: str) -> CanonicalManagedAgentProjection:
        if profile_name != "researcher":
            raise AssertionError(f"unexpected profile {profile_name!r}")
        return _projection()


class GatewayRuntimeInventoryPortTests(unittest.IsolatedAsyncioTestCase):
    async def test_lists_with_explicit_projection_and_typed_trusted_context(self) -> None:
        adapter = _FakeAdapter()
        port = GatewayRuntimeInventoryPort(
            adapter=adapter,
            gateway_epoch="gateway-epoch-1",
        )
        request = InventoryListRequest(
            requestId="inventory-1-0",
            requests=(InventoryListItemRequest(id="probe-0", namespaces=("filesystem",)),),
        )

        result = await port.list_for_projection(
            _inventory_projection(),
            request,
            timeout_seconds=1,
        )

        self.assertEqual(result, InventoryPortalListResult(items=(), ok=True))
        self.assertEqual(
            adapter.client.portal.calls,
            [
                (
                    {
                        "requestId": "inventory-1-0",
                        "requests": [{"id": "probe-0", "namespaces": ["filesystem"], "limit": 8}],
                    },
                    {
                        "principal": {
                            "agentId": "researcher",
                            "frameworkIdentity": {"kind": "hermes", "profileName": "researcher"},
                            "profileAssignmentRevision": "revision-researcher",
                            "toolPortalProfileId": "policy-researcher",
                        },
                    },
                )
            ],
        )

    async def test_rejects_projection_that_does_not_match_admitted_authority(self) -> None:
        adapter = _FakeAdapter()
        port = GatewayRuntimeInventoryPort(
            adapter=adapter,
            gateway_epoch="gateway-epoch-1",
        )
        mismatched_projection = _inventory_projection().model_copy(
            update={"tool_portal_profile_id": "different-policy"},
        )
        request = InventoryListRequest(
            requestId="inventory-1-0",
            requests=(InventoryListItemRequest(id="probe-0", namespaces=("filesystem",)),),
        )

        with self.assertRaisesRegex(
            InventoryAuthorityError,
            "inventory projection does not match managed authority",
        ):
            await port.list_for_projection(
                mismatched_projection,
                request,
                timeout_seconds=1,
            )

        self.assertEqual(adapter.client.portal.calls, [])


class RedactedInventoryAttemptLogSinkTests(unittest.TestCase):
    def test_emits_only_bounded_inventory_failure_fields(self) -> None:
        record = InventoryAttemptLog(
            gateway_epoch="gateway-epoch-1",
            profile_name="researcher",
            attempt_number=2,
            failure_class=InventoryFailureClass.TRANSPORT,
            retry_disposition=InventoryRetryDisposition.RETRY,
        )
        with self.assertLogs(
            "agent_vm_hermes_adapter.managed_tool_portal.gateway_runtime_inventory_port",
            level="WARNING",
        ) as logs:
            RedactedInventoryAttemptLogSink().record_inventory_attempt(record)

        self.assertEqual(
            logs.output,
            [
                "WARNING:agent_vm_hermes_adapter.managed_tool_portal."
                "gateway_runtime_inventory_port:managed Tool Portal inventory attempt failed: "
                "gateway_epoch=gateway-epoch-1 profile=researcher attempt=2 "
                "failure=transport disposition=retry"
            ],
        )


if __name__ == "__main__":
    unittest.main()
