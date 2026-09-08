"""Explicit native file delivery; no text fallback, caller-selected recipient, or automatic resend."""

import asyncio
import hashlib
import os
import re
import stat
import typing as t
from pathlib import PurePosixPath

from agent_vm_agent_portal_sdk.contracts import PORTABLE_CONTRACT_ADAPTERS
from gateway.config import Platform
from pydantic import BaseModel, ConfigDict

from .hermes_approval_presenter import HermesGatewayApprovalRoute, HermesGatewayApprovalRouteStore

NATIVE_SEND_TIMEOUT_SECONDS = 30


@t.runtime_checkable
class NativeSendResult(t.Protocol):
    success: bool
    message_id: str | None


@t.runtime_checkable
class NativeFileAdapter(t.Protocol):
    async def _send_file_attachment(
        self, chat_id: str, file_path: str, caption: str | None = None, file_name: str | None = None
    ) -> NativeSendResult: ...


@t.runtime_checkable
class NativeSessionSource(t.Protocol):
    platform: str | Platform


class NativeAttachmentInvocation(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True, frozen=True)
    profile_name: str
    session_id: str
    request: dict[str, object]
    routes: HermesGatewayApprovalRouteStore
    portal: t.Callable[[dict[str, object]], t.Awaitable[BaseModel]]


def _fields(model: BaseModel) -> dict[str, object]:
    fields = model.model_dump(by_alias=True, mode="json", exclude_none=True)
    return {key: value for key, value in fields.items() if isinstance(key, str)}


def _result(fields: dict[str, object]) -> BaseModel:
    result = PORTABLE_CONTRACT_ADAPTERS["portal.file.result"].validate_python(fields)
    if not isinstance(result, BaseModel):
        raise TypeError("Native file result must be a validated model.")
    return result


def _current(invocation: NativeAttachmentInvocation, route: HermesGatewayApprovalRoute) -> bool:
    try:
        return (
            invocation.routes.read_by_session_id(invocation.session_id) is route
            and route.source.profile == invocation.profile_name
            and route.authority_is_current()
        )
    except Exception:
        return False


def _verify_staged_file(path: str, byte_length: int, sha256: str) -> bool:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as file:
            status = os.fstat(file.fileno())
            return (
                stat.S_ISREG(status.st_mode)
                and status.st_size == byte_length
                and hashlib.file_digest(file, "sha256").hexdigest() == sha256
            )
    except OSError:
        return False


async def _settle(invocation: NativeAttachmentInvocation, staging_id: str, outcome: str) -> str:
    try:
        result = await invocation.portal(
            {"action": "settle", "stagingId": staging_id, "outcome": outcome}
        )
        return "complete" if _fields(result).get("kind") == "cleaned" else "pending"
    except Exception:
        return "pending"


def _observe_completion(future: asyncio.Future[NativeSendResult | None]) -> None:
    if not future.cancelled():
        _ = future.exception()


async def execute_native_attachment(invocation: NativeAttachmentInvocation) -> BaseModel:
    route = invocation.routes.read_by_session_id(invocation.session_id)
    if (
        route is None
        or not _current(invocation, route)
        or not isinstance(route.adapter, NativeFileAdapter)
        or not isinstance(route.source, NativeSessionSource)
        or route.source.platform not in ("discord", Platform.DISCORD)
    ):
        return _result(
            {"kind": "attachment-failed", "reason": "route-unavailable", "cleanup": "complete"}
        )
    adapter = route.adapter
    try:
        staged = _fields(
            await invocation.portal({"action": "stage", "source": invocation.request["source"]})
        )
    except Exception:
        return _result(
            {"kind": "attachment-failed", "reason": "staging-failed", "cleanup": "pending"}
        )
    path, staging_id = staged.get("path"), staged.get("stagingId")
    byte_length, sha256 = staged.get("byteLength"), staged.get("sha256")
    if (
        staged.get("kind") != "staged"
        or not isinstance(path, str)
        or not isinstance(staging_id, str)
        or not isinstance(byte_length, int)
        or not isinstance(sha256, str)
    ):
        return _result(
            {"kind": "attachment-failed", "reason": "staging-failed", "cleanup": "pending"}
        )
    document = PurePosixPath(path)
    expected_parent_name = f"portal-native-{invocation.profile_name}-{staging_id}"
    if (
        len(document.parents) < 4
        or document.parents[3] != PurePosixPath("/home/hermes/.cache/agent-vm-native")
        or re.fullmatch(r"[a-f0-9]{64}", document.parents[2].name) is None
        or re.fullmatch(r"[a-f0-9]{64}", document.parents[1].name) is None
        or document.parent.name != expected_parent_name
        or not _current(invocation, route)
        or not await asyncio.to_thread(_verify_staged_file, path, byte_length, sha256)
    ):
        cleanup = await _settle(invocation, staging_id, "failed")
        return _result(
            {"kind": "attachment-failed", "reason": "route-unavailable", "cleanup": cleanup}
        )
    caption_value = invocation.request.get("caption")
    caption = caption_value if isinstance(caption_value, str) else None

    async def send_on_gateway_loop() -> NativeSendResult | None:
        if not _current(invocation, route):
            return None
        # Hermes 0.20.6 / 5fc308a: send_document can return a successful TEXT
        # fallback. This pinned helper instead verifies native attachments,
        # including forum starter messages. Qualification must retain this check.
        return await adapter._send_file_attachment(
            route.source.chat_id, path, caption, file_name=document.name
        )

    future = asyncio.wrap_future(
        asyncio.run_coroutine_threadsafe(send_on_gateway_loop(), route.gateway_loop)
    )
    future.add_done_callback(_observe_completion)
    try:
        sent = await asyncio.wait_for(asyncio.shield(future), NATIVE_SEND_TIMEOUT_SECONDS)
    except TimeoutError:
        # Keep the native request alive; cancellation cannot prove it was not sent.
        # Its file and quota remain retained until actual sender settlement.
        async def settle_late() -> None:
            try:
                late = await future
                outcome = (
                    "failed"
                    if late is None
                    else "sent"
                    if late.success is True and isinstance(late.message_id, str) and late.message_id
                    else "unconfirmed"
                )
            except Exception:
                outcome = "unconfirmed"
            await _settle(invocation, staging_id, outcome)

        task = asyncio.create_task(settle_late())
        task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        await _settle(invocation, staging_id, "sender-pending")
        return _result(
            {"kind": "attachment-unconfirmed", "reason": "send-timeout", "cleanup": "pending"}
        )
    except Exception:
        cleanup = await _settle(invocation, staging_id, "unconfirmed")
        return _result(
            {"kind": "attachment-unconfirmed", "reason": "send-error", "cleanup": cleanup}
        )
    if sent is None:
        cleanup = await _settle(invocation, staging_id, "failed")
        return _result(
            {"kind": "attachment-failed", "reason": "native-send-failed", "cleanup": cleanup}
        )
    # The pinned forum helper also returns success=False for caught network
    # failures. That cannot prove non-delivery or invite an automatic resend.
    # The sender has nevertheless settled, so its temporary file can be cleaned.
    if sent.success is not True or not isinstance(sent.message_id, str) or not sent.message_id:
        cleanup = await _settle(invocation, staging_id, "unconfirmed")
        return _result(
            {"kind": "attachment-unconfirmed", "reason": "send-error", "cleanup": cleanup}
        )
    cleanup = await _settle(invocation, staging_id, "sent")
    return _result(
        {
            "kind": "attached",
            "messageId": sent.message_id,
            "fileName": document.name,
            "byteLength": byte_length,
            "sha256": sha256,
            "cleanup": cleanup,
        }
    )
