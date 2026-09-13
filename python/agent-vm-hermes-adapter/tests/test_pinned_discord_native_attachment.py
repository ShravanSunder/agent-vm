"""Pinned Hermes native helper proof with a recording Discord transport, never a recipient."""

import asyncio
from pathlib import Path

import discord
import pytest
from gateway.config import Platform
from plugins.platforms.discord.adapter import DiscordAdapter


class RecordedMessage:
    def __init__(self, *, attached: bool) -> None:
        self.id = 456
        self.attachments: list[object] = [object()] if attached else []


class RecordingChannel:
    id = 123
    type = 0

    def __init__(self, outcome: str) -> None:
        self.outcome = outcome
        self.files: list[tuple[str, bytes]] = []

    async def send(self, *, content: str | None, files: list[discord.File]) -> RecordedMessage:
        assert content == "Native proof"
        for file in files:
            self.files.append((file.filename, file.fp.read()))
            file.close()
        if self.outcome == "error":
            raise OSError("remote acknowledgement lost")
        return RecordedMessage(attached=self.outcome == "attached")


class RecordingDiscordClient:
    def __init__(self, channel: RecordingChannel) -> None:
        self.channel = channel
        self.lookups: list[int] = []

    def get_channel(self, chat_id: int) -> RecordingChannel:
        self.lookups.append(chat_id)
        return self.channel


@pytest.mark.parametrize("outcome", ["attached", "missing-attachment", "error"])
def test_pinned_helper_requires_a_native_attachment_and_propagates_unknown_send(
    outcome: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Arrange: use the actual helper from the immutable Hermes runtime image.
    # Bypass constructor side effects; only its native-client boundary is replaced.
    adapter = DiscordAdapter.__new__(DiscordAdapter)
    adapter.platform = Platform.DISCORD
    channel = RecordingChannel(outcome)
    client = RecordingDiscordClient(channel)
    monkeypatch.setattr(adapter, "_client", client, raising=False)
    document = tmp_path / "report.bin"
    document.write_bytes(b"\x00\xff\x80\x01")

    async def run() -> None:
        # Act / Assert: no wrapper text fallback can turn an exception into success.
        operation = adapter._send_file_attachment(
            "123", str(document), "Native proof", file_name="report.bin"
        )
        if outcome == "error":
            with pytest.raises(OSError, match="acknowledgement lost"):
                await operation
        else:
            result = await operation
            assert result.success is (outcome == "attached")
            assert result.message_id == "456"

    asyncio.run(run())
    assert client.lookups == [123]
    assert channel.files == [("report.bin", b"\x00\xff\x80\x01")]
