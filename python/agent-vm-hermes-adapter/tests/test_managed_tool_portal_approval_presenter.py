import asyncio
from unittest.mock import patch

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from pydantic import BaseModel

from agent_vm_hermes_adapter.managed_tool_portal.hermes_approval_presenter import (
    HermesGatewayApprovalPresenter,
    HermesGatewayApprovalRouteStore,
)


class FakeSource:
    def __init__(self, *, profile: str | None, chat_id: str = "chat-a") -> None:
        self.chat_id = chat_id
        self.profile = profile


class FakeAdapter:
    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: list[str],
        clarify_id: str,
        session_key: str,
        metadata: dict[str, object] | None = None,
    ) -> object:
        del chat_id, question, choices, clarify_id, session_key, metadata
        return object()


class FakeGateway:
    def __init__(self, *, authorized: bool) -> None:
        self.adapter = FakeAdapter()
        self.authorized = authorized

    def _adapter_for_source(self, source: object) -> FakeAdapter | None:
        del source
        return self.adapter

    def _is_user_authorized(self, source: object) -> bool:
        del source
        return self.authorized

    def _session_key_for_source(self, source: object) -> str:
        del source
        return "routing-key-a"


class FakeSessionStore:
    def peek_session_id(self, session_key: str) -> str | None:
        return "session-a" if session_key == "routing-key-a" else None


def _presentation_request() -> BaseModel:
    request = PORTABLE_CONTRACT_ADAPTERS["gateway.approval.presentation-request"].validate_python(
        {
            "allowedDecisions": ["approve", "deny"],
            "challengeId": "11111111-1111-4111-8111-111111111111",
            "display": {"argumentsPreview": '{"path":"README.md"}'},
            "expiresAt": "2099-08-20T21:00:00.000Z",
            "itemId": "call-a",
            "name": "write",
            "namespace": "files",
        }
    )
    assert isinstance(request, BaseModel)
    return request


def _outcome_mapping(outcome: BaseModel) -> dict[str, object]:
    mapping = outcome.model_dump(by_alias=True, exclude_none=True, mode="json")
    if not isinstance(mapping, dict):
        raise AssertionError("Approval outcome did not produce a JSON object.")
    if not all(isinstance(key, str) for key in mapping):
        raise AssertionError("Approval outcome produced a non-string key.")
    return {key: value for key, value in mapping.items() if isinstance(key, str)}


def test_route_capture_requires_existing_gateway_actor_admission() -> None:
    routes = HermesGatewayApprovalRouteStore()
    source = FakeSource(profile="researcher")

    async def capture_routes() -> tuple[object, object]:
        denied = routes.capture(
            gateway=FakeGateway(authorized=False),
            session_store=FakeSessionStore(),
            source=source,
        )
        admitted = routes.capture(
            gateway=FakeGateway(authorized=True),
            session_store=FakeSessionStore(),
            source=source,
        )
        return denied, admitted

    denied, admitted = asyncio.run(capture_routes())

    assert denied is None
    assert admitted is not None
    assert routes.read_by_session_id("session-a") is admitted


def test_presenter_projects_only_approve_and_deny_as_decisions() -> None:
    routes = HermesGatewayApprovalRouteStore()

    async def capture_route() -> None:
        _ = routes.capture(
            gateway=FakeGateway(authorized=True),
            session_store=FakeSessionStore(),
            source=FakeSource(profile="researcher"),
        )

    asyncio.run(capture_route())
    presenter = HermesGatewayApprovalPresenter(routes)

    with patch(
        "agent_vm_hermes_adapter.managed_tool_portal.hermes_approval_presenter._send_and_wait_for_native_response",
        return_value="Approve",
    ):
        approved = asyncio.run(presenter.present("session-a", _presentation_request()))
    with patch(
        "agent_vm_hermes_adapter.managed_tool_portal.hermes_approval_presenter._send_and_wait_for_native_response",
        return_value="Deny",
    ):
        denied = asyncio.run(presenter.present("session-a", _presentation_request()))
    with patch(
        "agent_vm_hermes_adapter.managed_tool_portal.hermes_approval_presenter._send_and_wait_for_native_response",
        return_value="Always",
    ):
        cancelled = asyncio.run(presenter.present("session-a", _presentation_request()))

    assert _outcome_mapping(approved) == {"kind": "approved"}
    assert _outcome_mapping(denied) == {"kind": "denied"}
    assert _outcome_mapping(cancelled) == {
        "kind": "cancelled",
        "reason": "user-cancelled",
    }


def test_presenter_is_unavailable_without_the_originating_session_route() -> None:
    presenter = HermesGatewayApprovalPresenter(HermesGatewayApprovalRouteStore())

    outcome = asyncio.run(presenter.present("missing-session", _presentation_request()))

    assert _outcome_mapping(outcome) == {
        "kind": "unavailable",
        "reason": "presenter-missing",
    }
