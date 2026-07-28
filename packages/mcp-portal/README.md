# @agent-vm/mcp-portal

Standalone MCP Portal core library, external proxy, CLI, and Tool VM helpers.

## What This Package Owns

- `/core`, the adapter-neutral execution library used by this package's standalone CLI and proxy.
- `mcp-portal mcp-proxy serve`, the external `/mcp-proxy` MCP server command.
- The four model-facing portal tools: `mcp_portal_list`, `mcp_portal_search`, `mcp_portal_describe`, and `mcp_portal_call`.
- JSON-Schema-derived Zod validation before upstream tool calls.
- HMAC approval-token verification for standalone portal calls.
- Tool VM helper exports for agents that need to reconstruct derived schemas.

## Standalone Runtime Shape

External MCP clients can use the proxy command:

```text
mcp-portal mcp-proxy serve --config-dir <dir>
```

The portal loads two files from `--config-dir`:

- `mcp.config.jsonc`: upstream MCP provider catalog and credentials.
- `mcp-portal.config.jsonc`: agents, profiles, policy, and optional external proxy auth.

## Managed Gateway Boundary

Managed Gateway does not author or load `mcp-portal.config.jsonc`, does not use
`/core` as its managed policy authority, and does not use this package's bearer
credentials, HMAC approval tokens, `credentialVersion`, or `externalAuth` policy.
Managed deployments author `mcp.config.jsonc` plus `tool-portal.config.jsonc`;
the latter owns agent assignments, complete cross-backend capability profiles,
explicit backend kinds, tool selectors, and managed call approval policy.

External `serve` resolves `source: "1password"` refs through `@agent-vm/secret-management`.
Use `AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE=env` or `keychain` plus the matching
source-specific env settings when the proxy host needs 1Password access. Token
bootstrap does not support ambient `op` CLI auth; service-account tokens must
come from an environment variable or macOS Keychain. If no token source is
configured, env-only configs still work. The built-in
HTTP bearer server is loopback-only; use a TLS reverse proxy and `mcp-portal
mcp-proxy print-client-config --proxy-url <url>` for public endpoints. The printed
client config contains bearer credential material on stdout. Treat it like an API
token, keep it out of logs and commits, and rotate `credentialVersion` or the
portal `masterKey` to revoke issued credentials.

`mcp-proxy serve` keeps approval-token replay state in process. Run one serving
process per external endpoint unless a future shared replay store is added.
Restarting the process clears consumed approval JTIs, so approval token TTLs
must stay short.

Provider secrets are raw by default. Add `format: { "kind": "bearer" }` for
`Bearer <token>` presentation, or `format: { "kind": "prefix", "prefix": "Token" }`
for provider-specific schemes. The prefix form always inserts exactly one space
between the prefix and the resolved raw secret or mediated placeholder.

Upstream MCP provider URLs are deployment-owned config. The schema rejects
non-HTTP schemes, but it intentionally allows loopback and private-network HTTP
targets because local sidecars and private service MCP providers are supported.
Do not load provider config from untrusted sources. If a future workflow imports
less-trusted provider definitions, put an explicit per-provider network
allowlist in front of private-network targets instead of blanket-blocking
loopback.

## Start Reading

- `src/core/portal-core.ts` for adapter-neutral execution.
- `src/bin/mcp-portal.ts` for CLI commands.
- `src/mcp-proxy/portal-http-server.ts` for Hono routing and MCP transport.
- `src/core/portal-tools.ts` for portal tool behavior.
- `src/portal-auth/hmac-token.ts` for approval-token signing and verification.
