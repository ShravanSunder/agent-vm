# @agent-vm/mcp-portal

Agent-scoped MCP Portal core library, external proxy, CLI, and Tool VM helpers.

## What This Package Owns

- `/core`, the adapter-neutral portal execution library used by OpenClaw.
- `mcp-portal serve`, the external `/mcp-proxy` MCP server command.
- The four model-facing portal tools: `mcp_portal_list`, `mcp_portal_search`, `mcp_portal_describe`, and `mcp_portal_call`.
- JSON-Schema-derived Zod validation before upstream tool calls.
- HMAC approval-token verification for portal calls that OpenClaw approved.
- Tool VM helper exports for agents that need to reconstruct derived schemas.

## Runtime Shape

Managed OpenClaw loads `/core` in process from a controller-materialized
effective config directory. It does not launch a portal server in the gateway VM.

External MCP clients can use the proxy command:

```text
mcp-portal serve --config-dir <dir>
```

The portal loads two files from `--config-dir`:

- `mcp.config.jsonc`: upstream MCP provider catalog and credentials.
- `mcp-portal.config.jsonc`: agents, profiles, policy, and optional external proxy auth.

External `serve` resolves `source: "1password"` refs through `@agent-vm/secrets`.
Use `AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE=env`, `op-cli`, or `keychain` plus the
matching source-specific env settings when the proxy host needs 1Password
access. If no token source is configured, env-only configs still work. The
built-in HTTP bearer server is loopback-only; use a TLS reverse proxy and
`write-credential --proxy-url <url>` for public endpoints.

## Start Reading

- `src/core/portal-core.ts` for adapter-neutral execution.
- `src/bin/mcp-portal.ts` for CLI commands.
- `src/mcp-proxy/portal-http-server.ts` for Hono routing and MCP transport.
- `src/mcp-proxy/portal-tools.ts` for portal tool behavior.
- `src/portal-auth/hmac-token.ts` for approval-token signing and verification.
