"""Real stdio MCP fixture for the Tool Portal Python client integration tests."""

import os

import anyio
from mcp import types
from mcp.server.fastmcp import FastMCP

TEST_PORTAL_CALL_RESULT: dict[str, object] = {
    "items": [
        {
            "id": "call-status",
            "operationId": "operation-stdio",
            "outcome": {
                "certainty": "proven",
                "completion": "succeeded",
                "kind": "completed",
                "retryClass": "forbidden",
            },
            "owningGeneration": "tool-vm-generation-stdio",
            "status": "ok",
            "value": {"transport": "stdio"},
        },
    ],
    "ok": True,
}


def create_test_server() -> FastMCP[None]:
    server = FastMCP("agent-vm-tool-portal-stdio-test", log_level="ERROR")

    @server.tool(name="tool_portal_call")
    async def call_tool_portal(
        calls: list[dict[str, object]],
        requestId: str,  # noqa: N803 - MCP wire field name is camelCase.
    ) -> types.CallToolResult:
        _ = calls, requestId
        return types.CallToolResult(
            content=[types.TextContent(type="text", text="bounded stdio fixture result")],
            structuredContent=TEST_PORTAL_CALL_RESULT,
        )

    @server.resource(
        "agent-vm-artifact://read?id=artifact-1",
        mime_type="text/plain",
    )
    async def read_test_artifact() -> bytes:
        return b"hello"

    return server


async def main() -> None:
    exit_receipt_path = os.environ.get("AGENT_VM_MCP_TEST_EXIT_RECEIPT")
    try:
        await create_test_server().run_stdio_async()
    finally:
        if exit_receipt_path is not None:
            await anyio.Path(exit_receipt_path).write_text("closed\n", encoding="utf-8")


if __name__ == "__main__":
    anyio.run(main)
