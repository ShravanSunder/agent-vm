# Cloudflare Tool Portal host

Local development only. From the workspace root:

```sh
mise exec node@24.7.0 -- pnpm --filter @agent-collaboration/tool-host-cloudflare dev
```

The checked-in `wrangler.example.jsonc` declares workspace removal marks and approval replay storage,
call analytics and the required variable names. Local development uses this same
configuration with the source entrypoint. It contains no account, route, or
deployment command. Remote Cloudflare resources and deployment require a separate owner decision (B4).

Only `/workspaces/<workspace-uuid>/mcp` serves agent MCP (`?tools=direct` selects
native listing). `TOOL_PORTAL_ORIGIN` is trusted deployment configuration;
`WORKSPACE_CONFIGURATIONS` maps each workspace UUID to its organization, name,
provider configuration, profiles and approval-key binding. Tokens carry the principal,
persona, organization, workspace, grant mark and grant expiry. The Portal checks
both expiries on every call and uses `FLEET_CENTRAL_CLIENT_ID` to pin the client
allowed to issue session principals. Session policy intersects
`portal.sessionDefaultProfile` with any named persona; bots use their named profile.

`POST /internal/v1/removal-notices` accepts issuer service tokens with the pinned
central client, the configured Portal notice audience and `removal-notices` scope.
`WorkspaceAuthority`, reached through `WORKSPACES`, records the highest mark and
notice ID atomically before acknowledgment and retains them for 61 minutes.
Approval uses are bound to the principal. Fleet owns membership and management.
Migration v2 retains existing storage; no legacy membership rows are read or migrated.

Controlled signers establish the local admission and adapter contracts. Real
issuer/Fleet integration and deployed notice delivery have separate proof gates.

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
