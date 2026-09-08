import asyncio
import hashlib
import typing as t

import pytest
from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from pydantic import BaseModel

from agent_vm_hermes_adapter.managed_tool_portal.hermes_approval_presenter import (
    HermesGatewayApprovalRouteStore,
)
from agent_vm_hermes_adapter.managed_tool_portal.native_attachment_delivery import (
    NativeAttachmentInvocation,
    execute_native_attachment,
)


class Source:
    profile: str | None = "sun"
    chat_id = "current-chat"
    platform = "discord"


class SessionStore:
    def peek_session_id(self, _key: str) -> str:
        return "session"


class SendResult:
    def __init__(self, success: bool) -> None:
        self.success = success
        self.message_id = "native-message" if success else None


class Adapter:
    def __init__(self, outcome: str) -> None:
        self.outcome = outcome
        self.sent: list[str] = []

    async def send_clarify(self, *_args: object, **_kwargs: object) -> SendResult:
        raise AssertionError("Attachment must not use a text/clarification fallback")

    async def _send_file_attachment(
        self, chat_id: str, file_path: str, caption: str | None = None, file_name: str | None = None
    ) -> SendResult:
        del file_path, caption, file_name
        self.sent.append(chat_id)
        if self.outcome == "error":
            raise OSError("Unknown remote send outcome")
        result = SendResult(self.outcome in {"sent", "sent-without-id"})
        if self.outcome == "sent-without-id":
            result.message_id = None
        return result


class Gateway:
    def __init__(self, adapter: Adapter) -> None:
        self.adapter = adapter

    def _is_user_authorized(self, _source: object) -> bool:
        return True

    def _adapter_for_source(self, _source: object) -> Adapter:
        return self.adapter

    def _session_key_for_source(self, _source: object) -> str:
        return "session-key"


@pytest.mark.parametrize(
    "outcome,expected",
    [
        ("sent", "attached"),
        ("failed", "attachment-unconfirmed"),
        ("sent-without-id", "attachment-unconfirmed"),
        ("error", "attachment-unconfirmed"),
        ("changed-profile", "attachment-failed"),
    ],
)
def test_native_sender_is_bound_to_the_captured_profile_and_never_retries(
    outcome: str, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def run() -> None:
        # Arrange: fake VM staging and native API; real route store and delivery orchestration.
        adapter = Adapter(outcome)
        source = Source()
        routes = HermesGatewayApprovalRouteStore()
        assert (
            routes.capture(gateway=Gateway(adapter), session_store=SessionStore(), source=source)
            is not None
        )
        requests: list[dict[str, object]] = []

        async def portal(request: dict[str, object]) -> BaseModel:
            requests.append(request)
            result: dict[str, object] = {"kind": "cleaned"}
            if request["action"] == "stage":
                if outcome == "changed-profile":
                    source.profile = "ember"
                result = {
                    "kind": "staged",
                    "stagingId": "11111111-1111-4111-8111-111111111111",
                    "path": "/home/hermes/.cache/agent-vm-native/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/portal-native-sun-11111111-1111-4111-8111-111111111111/report.bin",
                    "byteLength": 4,
                    "sha256": hashlib.sha256(b"test").hexdigest(),
                }
            parsed = PORTABLE_CONTRACT_ADAPTERS["portal.attachment.result"].validate_python(result)
            assert isinstance(parsed, BaseModel)
            return parsed

        monkeypatch.setattr(
            "agent_vm_hermes_adapter.managed_tool_portal.native_attachment_delivery._verify_staged_file",
            lambda *_args: True,
        )
        # Act
        result = await execute_native_attachment(
            NativeAttachmentInvocation(
                profile_name="sun",
                session_id="session",
                request={
                    "action": "attach",
                    "source": {"kind": "tool-vm-file", "path": "report.bin"},
                },
                routes=routes,
                portal=portal,
            )
        )
        # Assert
        assert result.model_dump(by_alias=True)["kind"] == expected

        # Sender settlement permits cleanup even when delivery cannot be confirmed.
        assert result.model_dump(by_alias=True)["cleanup"] == "complete"
        assert adapter.sent == ([] if outcome == "changed-profile" else ["current-chat"])
        assert requests[-1]["action"] == "settle"
        assert requests[-1]["outcome"] == (
            "unconfirmed"
            if expected == "attachment-unconfirmed"
            else "sent"
            if outcome == "sent"
            else "failed"
        )

    asyncio.run(run())
