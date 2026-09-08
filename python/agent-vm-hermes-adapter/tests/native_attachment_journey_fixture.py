"""Cross-runtime native-attachment journey fixture driven by the TypeScript host proof."""

import asyncio
import contextlib
import hashlib
import json
import os
import typing as t
import urllib.request
from collections.abc import Iterator, Mapping

import discord
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from gateway.config import Platform
from plugins.platforms.discord.adapter import DiscordAdapter

from agent_vm_hermes_adapter.managed_framework_observability import (
    ManagedFrameworkObservability,
)
from agent_vm_hermes_adapter.managed_profile_adapter import (
    CanonicalManagedAgentProjection,
    HermesManagedAdapter,
    HermesManagedAdapterConfig,
    ManagedFrameworkIdentity,
)
from agent_vm_hermes_adapter.managed_tool_portal.cache import PluginStateCache
from agent_vm_hermes_adapter.managed_tool_portal.inventory import InventoryCoordinator
from agent_vm_hermes_adapter.managed_tool_portal.models import (
    InjectionCacheKey,
    InjectionMarker,
    NamespaceDiscovery,
)
from agent_vm_hermes_adapter.managed_tool_portal_capability_tools import (
    _ManagedToolPortalPluginRuntime,
    _ToolHandler,
)
from agent_vm_hermes_adapter.managed_tool_portal_observability import (
    HermesToolPortalTelemetry,
)

_PROJECTION_COHORT_DIGEST = (
    "projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)


class _CallbackTransport:
    def __init__(self, callback_url: str) -> None:
        self._callback_url = callback_url

    async def connect(self, socket_path: str) -> None:
        del socket_path

    async def handshake(self, attachment: Mapping[str, object]) -> Mapping[str, object]:
        del attachment
        return {"kind": "accepted"}

    async def request(
        self,
        method: str,
        params: Mapping[str, object],
    ) -> Mapping[str, object]:
        request_bytes = json.dumps(
            {"method": method, "params": dict(params)},
            separators=(",", ":"),
        ).encode()

        def post() -> Mapping[str, object]:
            request = urllib.request.Request(
                self._callback_url,
                data=request_bytes,
                headers={
                    "authorization": (
                        f"Bearer {os.environ['AGENT_VM_NATIVE_ATTACHMENT_CALLBACK_TOKEN']}"
                    ),
                    "content-type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
                value: object = json.loads(response.read())
            if not isinstance(value, dict):
                raise TypeError("Native attachment callback did not return a JSON object.")
            result: dict[str, object] = {}
            for key, item in value.items():
                if not isinstance(key, str):
                    raise TypeError("Native attachment callback returned a non-string key.")
                result[key] = item
            return result

        return await asyncio.to_thread(post)

    async def disconnect(self) -> None:
        return None


class _RecordingTelemetry:
    observer_hooks_enabled = False
    max_inflight_observations = 0

    @contextlib.contextmanager
    def observe_tool_operation(self, tool_name: str) -> Iterator[None]:
        assert tool_name == "tool_portal_file"
        yield

    def shutdown(self) -> None:
        return None

    def start_turn(self, record: object) -> None:
        del record

    def complete_turn(self, handle: object, record: object) -> None:
        del handle, record

    def start_provider_attempt(self, parent_handle: object, record: object) -> None:
        del parent_handle, record

    def complete_provider_attempt(self, handle: object, record: object) -> None:
        del handle, record

    def emit_tool_call(self, parent_handle: object, record: object) -> None:
        del parent_handle, record


class _SessionSource:
    profile: str | None = "sun"
    chat_id = "123"
    platform = Platform.DISCORD


class _SessionStore:
    def peek_session_id(self, session_key: str) -> str:
        assert session_key == "captured-session-key"
        return "captured-session"


class _RecordedMessage:
    def __init__(self, *, attached: bool, include_message_id: bool) -> None:
        self.attachments: list[object] = [object()] if attached else []
        if include_message_id:
            self.id = "recording-native-message"


class _RecordedForumThread:
    def __init__(self, message: _RecordedMessage) -> None:
        self.message = message


class _RecordingChannel:
    id = "captured-discord-chat"
    type = 0

    def __init__(self, outcome: str) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, object]] = []

    def _record_files(
        self,
        *,
        content: str | None,
        files: list[discord.File],
    ) -> None:
        for file in files:
            selected_bytes = file.fp.read()
            self.calls.append(
                {
                    "byteLength": len(selected_bytes),
                    "caption": content,
                    "fileName": file.filename,
                    "sha256": hashlib.sha256(selected_bytes).hexdigest(),
                }
            )
            file.close()

    async def send(
        self,
        *,
        content: str | None,
        files: list[discord.File],
    ) -> _RecordedMessage:
        self._record_files(content=content, files=files)
        return _RecordedMessage(
            attached=self.outcome != "failed",
            include_message_id=True,
        )

    async def create_thread(self, **kwargs: object) -> _RecordedForumThread:
        content = kwargs.get("content")
        files = kwargs.get("files")
        assert content is None or isinstance(content, str)
        assert isinstance(files, list)
        assert all(isinstance(file, discord.File) for file in files)
        self._record_files(content=content, files=files)
        return _RecordedForumThread(_RecordedMessage(attached=True, include_message_id=False))


class _RecordingDiscordClient:
    def __init__(self, channel: _RecordingChannel) -> None:
        self._channel = channel
        self.lookups: list[int] = []

    def get_channel(self, chat_id: int) -> _RecordingChannel:
        self.lookups.append(chat_id)
        return self._channel


class _Gateway:
    def __init__(self, sender: DiscordAdapter) -> None:
        self._sender = sender

    def _is_user_authorized(self, source: object) -> bool:
        return source is _SOURCE

    def _adapter_for_source(self, source: object) -> DiscordAdapter | None:
        return self._sender if source is _SOURCE else None

    def _session_key_for_source(self, source: object) -> str:
        return "captured-session-key" if source is _SOURCE else ""


def _projection() -> CanonicalManagedAgentProjection:
    return CanonicalManagedAgentProjection(
        agent_id="sun",
        framework_identity=ManagedFrameworkIdentity(kind="hermes", profile_name="sun"),
        profile_assignment_revision="revision-sun",
        tool_portal_namespaces=(NamespaceDiscovery(namespace="google"),),
        tool_portal_profile_id="policy-sun",
    )


_SOURCE = _SessionSource()


async def _run_journey(callback_url: str, sender_outcome: str) -> dict[str, object]:
    telemetry = _RecordingTelemetry()
    client = GatewayRuntimeClient(
        attachment={
            "attachmentGeneration": 1,
            "clientKind": "hermes-managed-plugin",
            "configuredAgentIds": ["sun"],
            "frameworkEpoch": "framework-epoch",
            "gatewayEpoch": "gateway-epoch",
            "protocolVersion": 1,
            "projectionCohortDigest": _PROJECTION_COHORT_DIGEST,
            "runtimeEpoch": "runtime-epoch",
            "schemaVersion": 1,
        },
        transport=_CallbackTransport(callback_url),
    )
    projection = _projection()
    adapter = HermesManagedAdapter(
        config=HermesManagedAdapterConfig(
            profiles=(projection,),
            projection_cohort_digest=_PROJECTION_COHORT_DIGEST,
            protected_hermes_home="/home/hermes/.hermes",
        ),
        gateway_runtime_client=client,
    )
    runtime = _ManagedToolPortalPluginRuntime(
        adapter=adapter,
        current_projection=lambda: projection,
        framework_observability=ManagedFrameworkObservability(
            sink=t.cast("HermesToolPortalTelemetry", telemetry),
            max_inflight_observations=telemetry.max_inflight_observations,
        ),
        telemetry=t.cast("HermesToolPortalTelemetry", telemetry),
        inventory_coordinator=t.cast("InventoryCoordinator", object()),
        injection_state_cache=t.cast(
            "PluginStateCache[InjectionCacheKey, InjectionMarker]", object()
        ),
        gateway_epoch="gateway-epoch",
    )
    channel = _RecordingChannel(sender_outcome)
    channel.type = 15 if sender_outcome == "missing-message-id" else 0
    discord_client = _RecordingDiscordClient(channel)
    sender = DiscordAdapter.__new__(DiscordAdapter)
    sender.platform = Platform.DISCORD
    object.__setattr__(sender, "_client", discord_client)
    try:
        await asyncio.to_thread(adapter.connect_gateway_runtime)
        assert (
            runtime.approval_routes.capture(
                gateway=_Gateway(sender),
                session_store=_SessionStore(),
                source=_SOURCE,
            )
            is not None
        )
        result_json = await asyncio.to_thread(
            _ToolHandler(runtime, "tool_portal_file"),
            {
                "action": "attach",
                "caption": "Fake Google export",
                "source": {
                    "kind": "operation-file",
                    "referenceId": "11111111-1111-4111-8111-111111111111",
                    "path": "fake-google-export.bin",
                },
            },
            session_id="captured-session",
        )
        result = json.loads(result_json)
        expected_kind = "attached" if sender_outcome == "sent" else "attachment-unconfirmed"
        assert result["kind"] == expected_kind, result
        assert result["cleanup"] == "complete"
        assert discord_client.lookups == [int(_SOURCE.chat_id)]
        assert len(channel.calls) == 1
        return {"result": result, "senderCalls": channel.calls}
    finally:
        runtime.approval_routes.close()
        await asyncio.to_thread(adapter.close)


def main() -> None:
    callback_url = os.environ["AGENT_VM_NATIVE_ATTACHMENT_CALLBACK_URL"]
    sender_outcome = os.environ["AGENT_VM_NATIVE_ATTACHMENT_SENDER_OUTCOME"]
    if sender_outcome not in {"sent", "failed", "missing-message-id"}:
        raise ValueError("Unknown recording native sender outcome.")
    print(json.dumps(asyncio.run(_run_journey(callback_url, sender_outcome))))


if __name__ == "__main__":
    main()
