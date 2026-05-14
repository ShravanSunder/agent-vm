# @agent-vm/mcp-portal

Agent-scoped MCP Portal server and Tool VM helpers.

## What This Package Owns

- The standalone `agent-vm-mcp-portal-server` HTTP MCP server.
- The four model-facing portal tools: `mcp_portal_list`, `mcp_portal_search`, `mcp_portal_describe`, and `mcp_portal_call`.
- JSON-Schema-derived Zod validation before upstream tool calls.
- HMAC approval-token verification for portal calls that OpenClaw approved.
- Tool VM helper exports for agents that need to reconstruct derived schemas.

## Runtime Shape

The server is launched in the OpenClaw gateway VM and listens on a loopback port,
normally `127.0.0.1:18790`.

Each agent receives a distinct MCP URL:

```text
http://127.0.0.1:18790/agents/<agentId>/mcp
```

The portal loads two files from `--config-dir`:

- `mcp.config.jsonc`: upstream MCP provider catalog and credentials.
- `mcp-portal.config.jsonc`: portal access header, agents, profiles, and policy.

## Start Reading

- `src/bin/portal-server.ts` for CLI boot and config loading.
- `src/mcp-server/portal-http-server.ts` for Hono routing and MCP transport.
- `src/mcp-server/portal-tools.ts` for portal tool behavior.
- `src/auth/hmac-token.ts` for approval-token signing and verification.
