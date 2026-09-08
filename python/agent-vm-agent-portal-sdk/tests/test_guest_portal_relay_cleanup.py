import asyncio
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from agent_vm_agent_portal_sdk.portal_relay_protocol import PortalRelayDecoder


def test_helper_removes_only_its_owned_socket_directory_on_stdin_eof() -> None:
    async def scenario(parent: Path) -> None:
        owned = parent / "invocation"
        unrelated = parent / "keep.txt"
        unrelated.write_text("retained")
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "agent_vm_agent_portal_sdk.guest_portal_relay_process",
            "--socket",
            str(owned / "p.sock"),
            "--create-directory",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        try:
            ready = PortalRelayDecoder().feed(await asyncio.wait_for(process.stdout.read(65_536), timeout=5))
            assert ready
            assert ready[0]["kind"] == "ready"
            assert owned.is_dir()
            process.stdin.close()
            assert await asyncio.wait_for(process.wait(), timeout=5) == 0
            assert not owned.exists()
            assert unrelated.read_text() == "retained"
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    with TemporaryDirectory(prefix="prb-cleanup-", dir="/tmp") as directory:
        asyncio.run(scenario(Path(directory)))
