# Cloudflare Tool Portal host

Local development only. From the workspace root:

```sh
mise exec node@24.7.0 -- pnpm --filter @agent-collaboration/tool-host-cloudflare dev
```

The checked-in `wrangler.example.jsonc` declares workspace membership and replay storage,
call analytics and the required variable names. Local development uses this same
configuration with the source entrypoint. It contains no account, route, or
deployment command. Remote Cloudflare resources and deployment require a separate owner decision (B4).

Only `/workspaces/<workspace-uuid>/mcp` serves agent MCP (`?tools=direct` selects
native listing). `TOOL_PORTAL_ORIGIN` is trusted deployment configuration;
`WORKSPACE_CONFIGURATIONS` maps each workspace UUID to its organization, name,
provider configuration, profiles and approval-key binding. Membership and persona
live in `WorkspaceAuthority`, reached through `WORKSPACES`; `portal.agents` retains
credential metadata and no longer chooses a profile. Migration v2 renames the old
class without deleting its storage; legacy admission rows are never read.

Person-only management routes register/link an agent per workspace, remove a
workspace membership before unlinking, and retire across the organization’s
configured workspaces before disabling the client. `SIGN_IN` implements the named
management RPC port; `MANAGEMENT_AUDIENCE` is separate from workspace audiences.
Organizations with no configured workspace are refused before any sign-in RPC.
Per-user consents remain deferred. Controlled test signers establish refusal and
adapter regression behavior; real workspace issuance and management require the
separately deployed sign-in service.

Worker types are committed in `worker-configuration.gen.d.ts` and generated with
Wrangler 4.124.0 from that one example configuration. Build first so its
`dist/index.js` entry is available, then run from the workspace root:

```sh
pnpm --filter @agent-collaboration/tool-host-cloudflare types:generate
pnpm --filter @agent-collaboration/tool-host-cloudflare types:check
```

The package typecheck runs the stale-type check before TypeScript. The example
uses public placeholders; private deployment configuration is never a type input.

This generated file retains Wrangler’s raw bytes. Wrangler 4.124.0 compares its
runtime header literally, including a trailing space when no compatibility flags
are set; formatting removes that space and makes fresh types appear stale. The
root formatter excludes this exact file. Regenerate it rather than editing it.
