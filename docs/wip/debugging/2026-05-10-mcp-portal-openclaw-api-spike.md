# MCP Portal OpenClaw API Spike

Date: 2026-05-10
Pinned OpenClaw package: `openclaw@2026.5.7`
Evidence source: `npm pack openclaw@2026.5.7` extracted under
`tmp/openclaw-spike/extracted/package`.

## Outcome A: Hono Streamable HTTP portal binding supported

- API name: OpenClaw MCP client registry, consumed by embedded Pi bundle MCP
  runtime.
- Config path: `mcp.servers.<serverName>`.
- Route shape:
  `/mcp-portal/bindings/:bindingId/mcp`.
- Per-agent secret header source: a generated per-binding server entry under
  `mcp.servers.<portalServerName>.headers`, paired with an agent-specific
  `agents.list[].tools.allow` entry for the four materialized portal tools from
  that server.
- Cleanup hook: OpenClaw's per-session MCP runtime disposes connected MCP
  client transports and terminates Streamable HTTP sessions when the session
  runtime is disposed.

Evidence:

- `docs/cli/mcp.md:349-370` states OpenClaw stores reusable MCP server
  definitions under `mcp.servers`, and runtime adapters normalize those
  definitions into the shape each downstream MCP client expects.
- `docs/cli/mcp.md:382-389` documents `openclaw mcp set`, including
  `transport: "streamable-http"` and CLI-native `type: "http"` normalization.
- `docs/cli/mcp.md:467-479` documents Streamable HTTP as a first-class remote
  MCP transport, with `url`, `transport`, `headers`, and
  `connectionTimeoutMs`.
- `dist/mcp-config-DYHOkN9M.js:30-43` loads configured servers from
  `sourceConfig.mcp?.servers`.
- `dist/mcp-config-DYHOkN9M.js:46-84` writes one named server back under
  `next.mcp.servers`.
- `dist/mcp-config-normalize-Df4xMZIV.js:3-8` maps CLI `type: "http"` and
  `transport: "streamable-http"` to OpenClaw's canonical Streamable HTTP
  transport.
- `dist/embedded-pi-mcp-CtXIs-BX.js:27-40` merges bundle MCP config with
  configured `cfg.mcp.servers`.
- `dist/pi-bundle-mcp-runtime-CIPs13HF.js:201-233` resolves stdio, SSE, and
  Streamable HTTP MCP transport configs.
- `dist/pi-bundle-mcp-runtime-CIPs13HF.js:289-305` constructs
  `StreamableHTTPClientTransport` for Streamable HTTP and `SSEClientTransport`
  for SSE.
- `dist/pi-bundle-mcp-materialize-C94DY4UJ.js:31-80` materializes upstream MCP
  tools into agent tools and prefixes them with the safe MCP server name.
- `dist/pi-bundle-mcp-names-BL4uJxD6.js:29-43` builds materialized names as
  `<serverName>__<toolName>`.
- `docs/tools/multi-agent-sandbox-tools.md:191-237` documents per-agent tool
  restriction precedence through `agents.list[].tools.allow/deny`.

Important constraint:

OpenClaw 2026.5.7 does not expose a native `agents.list[].mcp.servers` path in
the inspected docs/schema. Per-agent MCP binding is therefore achieved by:

1. generating one `mcp.servers.<portalServerName>` entry per agent binding,
   with a URL containing the server-generated `bindingId`;
2. materializing the four portal tools from that server as
   `<safePortalServerName>__mcp_portal_list`,
   `<safePortalServerName>__mcp_portal_search`,
   `<safePortalServerName>__mcp_portal_describe`, and
   `<safePortalServerName>__mcp_portal_call`;
3. setting the target agent's `agents.list[].tools.allow` to those four names.

This binding path does not require model-supplied `agentId`. The model never
receives the generated `bindingId` or binding secret as tool arguments. Agent A
and Agent B can have different portal configs by receiving different
`mcp.servers` entries and different per-agent tool allowlists.

## Approval Bridge

- native approval API available? yes
- API name or event shape: plugin `before_tool_call` hook result
  `requireApproval`.
- how approval request is surfaced: OpenClaw plugin approval UI and `/approve`
  flow.
- how approval result is delivered back to the portal: the mcp-portal plugin's
  `before_tool_call` handler records an allow/deny decision in the gateway-local
  portal approval cache from the `requireApproval.onResolution` callback. The
  portal server reads that cache before forwarding `mcp_portal_call` upstream.
- fallback behavior when unavailable: if the hook runtime is unavailable or the
  approval cache has no matching allow decision, tools that require approval
  return `approval_required` and do not call upstream.

Evidence:

- `docs/plugins/hooks.md:20-49` shows typed plugin hook registration through
  `api.on("before_tool_call", ...)`.
- `docs/plugins/hooks.md:150-180` documents `before_tool_call` fields and the
  `requireApproval` result shape, including `onResolution`.
- `docs/plugins/hooks.md:187-192` states `requireApproval` pauses the agent run,
  routes through plugin approvals, and calls `onResolution` with
  `allow-once`, `allow-always`, `deny`, `timeout`, or `cancelled`.
- `dist/pi-tools.before-tool-call-D0Kb8Xtm.js:486-515` runs trusted tool
  policies and requests plugin tool approval when a policy returns
  `requireApproval`.
- `dist/pi-tools.before-tool-call-D0Kb8Xtm.js:523-552` runs normal
  `before_tool_call` hooks and requests plugin tool approval when a hook returns
  `requireApproval`.
- `dist/hook-runner-global-CCAcWVdN.js:831-843` initializes the global hook
  runner with `failurePolicyByHook: { before_tool_call: "fail-closed" }`.

Approval state is keyed server-side by portal binding, namespace, tool name, and
argument hash. It is never supplied by the model.

## Prompt Hook Permissions

Verified hooks:

- `agent_turn_prepare`
- `before_prompt_build`

Verified config path:

- `plugins.entries.<id>.hooks.allowPromptInjection`

Evidence:

- `docs/plugins/hooks.md:101-110` lists the agent-turn hooks, including
  `agent_turn_prepare` and `before_prompt_build`.
- `docs/plugins/hooks.md:216-233` documents what `agent_turn_prepare` and
  `before_prompt_build` receive and return.
- `dist/hook-runner-global-CCAcWVdN.js:406-418` implements
  `runBeforePromptBuild` and `runAgentTurnPrepare`.
- `dist/attempt.prompt-helpers-Di4VpJV1.js:48-67` calls
  `runAgentTurnPrepare` before `runBeforePromptBuild` for prompt assembly.
- `dist/config-normalization-shared-DamsNnJD.js:263-275` normalizes
  `plugins.entries.<id>.hooks.allowPromptInjection`.
- `dist/runtime-schema-OL6hE5dN.js:21092-21100` includes the JSON Schema field
  for `hooks.allowPromptInjection`.
- `dist/runtime-schema-OL6hE5dN.js:26214-26218` exposes the config help entry
  for `plugins.entries.*.hooks.allowPromptInjection`.

## MCP SDK/Hono Binding Evidence

- The installed MCP SDK includes a Hono example:
  `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.4.3/node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/honoWebStandardStreamableHttp.js:44-50`
  creates `WebStandardStreamableHTTPServerTransport`, connects an MCP server, and
  returns `transport.handleRequest(c.req.raw)`.
- The installed MCP SDK transport declaration:
  `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.4.3/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts:119-160`
  documents Streamable HTTP, Hono usage, and stateful/stateless session
  behavior.
- The installed MCP SDK request-handler context:
  `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.4.3/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts:173-185`
  carries `sessionId`.
- The installed MCP SDK annotations type:
  `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.4.3/node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.d.ts:1118-1128`
  includes `readOnlyHint` and `destructiveHint`.
