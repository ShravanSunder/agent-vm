# 2026-05-19 MCP Portal Review Handoff

This note is the reviewer-facing map for the MCP Portal refactor after the
long review and repair cycle on `fix/mcp-portal-env-secrets`. It records the
current intended design, the safety boundaries that should hold, what was
implemented, and the verification commands a reviewer should rerun.

It is intentionally a `docs/wip` artifact. It is not the canonical subsystem
documentation. The canonical docs are still `docs/subsystems/mcp-portal.md`,
`docs/architecture/openclaw-gateway.md`, generated manual templates, and the
package README.

## Branch Snapshot

- Branch: `fix/mcp-portal-env-secrets`.
- Relevant commits:
  - `1bf40a5` refactors MCP Portal into core library adapters.
  - `a3d3fa2` hardens the cutover and closes earlier critical review gaps.
  - `49dc977` closes the latest review gaps around command shape, package
    exports, auth hardening, runtime resource limits, and policy/materializer
    edge cases.
- `origin/master` was merged into the branch before the latest repair pass.
- No legacy migration command remains for `zones[].mcp`; the config cutover is
  hard. Existing deployments need authored config updated directly.

## Target Model

The intended model is a library-first MCP Portal with one CLI command surface
and three runtime adapters.

```text
@agent-vm/mcp-portal
  core
    adapter-neutral execution, trusted scope, policies, approval checks,
    redaction, streaming events, abort handling, scoped descriptors

  mcp-proxy
    Hono HTTP server plus MCP Streamable HTTP transport for external clients

  cli
    operator commands and local direct-to-core calls

  portal-auth
    HMAC primitives, approval tokens, agent bearer derivation

  portal-config
    catalog artifact generation and JSON-schema to Zod helpers

  testing
    fake upstream MCP server used by integration tests
```

The CLI is intentionally CLI-first:

```text
mcp-portal mcp-proxy serve --config-dir <dir>
mcp-portal mcp-proxy print-client-config --config-dir <dir> --agent <id> ...
mcp-portal call --config-dir <dir> --agent <id> --input <request.json>
mcp-portal validate <catalog.json>
mcp-portal generate-helper <catalog.json> --out <dir>
```

Top-level `mcp-portal serve` and credential commands are rejected on purpose.
The `mcp-proxy` namespace is the adapter boundary.

## Boundaries That Should Hold

### Managed OpenClaw

- Managed OpenClaw uses the in-process native plugin.
- It does not start an MCP Portal HTTP server inside the gateway VM.
- The controller materializes an effective MCP Portal config directory under
  cache, then passes that directory into OpenClaw plugin config.
- The gateway VM should not receive `OP_*` variables, run `op read`, or resolve
  `op://` references itself.
- Secret values either become runtime env vars for env injection or mediated
  secret bindings for HTTP mediation.

### External MCP Proxy

- External MCP clients use `mcp-portal mcp-proxy serve`.
- The proxy is a Hono server because the MCP proxy adapter is HTTP transport.
- Hono should stay in the `mcp-proxy` subpath and not leak into `/core` or the
  OpenClaw plugin dependency closure.
- Published package subpath exports must be emitted in `dist`, not just
  available through workspace TypeScript path aliases.

### Standalone And Local Operation

- Standalone/local proxy operation can resolve environment secrets and
  1Password refs through the host-side `@agent-vm/secret-management` resolver.
- This is distinct from managed OpenClaw. Managed gateway mode must keep
  1Password resolution host/controller-side.
- Loopback upstream MCP providers are allowed. URL validation rejects non-HTTP
  schemes but intentionally does not reject `localhost` or private IPs.

### Credentials

- `print-client-config` derives a per-agent HMAC bearer and prints a client
  config to stdout.
- The CLI prints loud warnings on stderr because stdout contains bearer
  credential material.
- MCP Portal no longer owns durable credential-file persistence.
- Operators may redirect stdout to a file or secret store, but that storage
  decision is explicit and outside the portal command.
- Revocation is through `credentialVersion` or master-key rotation.

## Review Gaps Closed

### Command And Package Shape

- `mcp-portal` now runs correctly when invoked through a package-manager
  symlink named `mcp-portal`.
- External proxy commands live under `mcp-portal mcp-proxy ...`.
- The old `write-credential` file writer is disabled. Use
  `print-client-config` for stdout-only per-agent client config.
- Package exports for `portal-auth` are now represented in `tsdown.config.ts`
  so published consumers do not hit missing `dist/portal-auth/*` files.
- Docs and generated manuals were updated away from stale
  `agent-vm-mcp-portal serve` and top-level `mcp-portal serve` wording.

### Auth And Audit Surface

- External bearer failures now return opaque 401 responses.
- Unknown agents and bad bearers are not distinguishable by client response
  shape.
- The HTTP server has an audit sink hook for auth allow/deny decisions.
- The HTTP server has a bounded in-memory auth failure limiter.
- Approval tokens use JTI replay protection and max lifetime caps from the
  earlier repair pass.
- Agent bearer tokens include `credentialVersion` for per-agent revocation.

### Policy And Config Semantics

- Explicit empty `enabledNamespaces: []` means deny all. In resolved managed
  profiles, a missing `enabledNamespaces` field inherits the default profile's
  empty list, so managed OpenClaw agents deny all unless a profile explicitly
  enables namespaces.
- `enabledToolsByNamespace` is enforced by the filtered session catalog on the
  call path, with regression coverage proving excluded tools cannot be invoked.
- Materialized secret env-name collisions report both colliding source secrets.
- Remote MCP URLs are validated to `http:` or `https:` schemes.
- Loopback hosts remain allowed for local and sidecar MCP providers.

### Runtime Safety

- Approval-token replay protection is process-local in `mcp-proxy serve`.
  Keep one serving process per external endpoint unless/until a shared replay
  store is added, and keep approval token TTLs short.
- Upstream MCP progress uses SDK `onprogress`. Uncorrelated fallback
  notifications are no longer forwarded into per-call stream events.
- Abort handling does not drop already queued events before reporting abort.
- Event queues are bounded.
- Upstream response size is capped before redaction and serialization.
- `callTool` timeout aborts the underlying SDK request instead of only racing
  the promise. Connect/list timeout hardening remains a follow-up unless this
  pass has since updated it.
- Recursive error redaction covers `cause` chains from the earlier repair pass.
- Effective-config temporary files use process and UUID suffixes to avoid
  deterministic `.tmp` races.

## Test Coverage Added Or Strengthened

- CLI tests cover the new `mcp-proxy` command shape, top-level rejection, and
  package-manager symlink entrypoint behavior.
- Package export tests cover `portal-auth` subpath build entries.
- HTTP server tests cover opaque 401s, audit events, and auth failure limiting.
- Core tests cover queued abort behavior and bounded event queues.
- Upstream runtime tests cover timeout cancellation, response size caps, and
  dropping uncorrelated non-progress notifications.
- Config-contract tests cover remote URL scheme validation while preserving
  loopback support.
- Materializer tests cover collision diagnostics.
- Integration tests cover wrong bearer rejection and progress propagation.
- OpenClaw smoke covers managed/native path boundaries:
  - effective config materialized;
  - no legacy portal server ingress;
  - no guest port 18790;
  - no `OP_*`, `op read`, or `spawn op` strings in managed artifacts;
  - native portal tools list and call upstream tools;
  - unsigned write calls are blocked.

## Verification Commands

Run from the monorepo root.

```sh
pnpm build
pnpm check
pnpm test:unit
pnpm test:integration
mise exec -- pnpm test:smoke
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts
git diff --check
```

Use `mise exec -- pnpm test:smoke` for smoke tests. The repo-pinned Zig from
`mise.toml` is required for the live Gondolin/OpenClaw smoke path.

The default smoke command still has env-gated skips. The explicit
`AGENT_VM_OPENCLAW_SMOKE=1` command is the related smoke that proves the MCP
Portal managed OpenClaw path.

## Manual Package-Shape Check

The latest repair pass also ran a manual temp-directory check against built
package artifacts, not the Vitest source runner:

- create temp config directory;
- symlink built `dist/bin/mcp-portal.js` as `mcp-portal`;
- start fake upstream MCP server;
- run `mcp-portal mcp-proxy print-client-config`;
- verify stdout bearer matches derived token and stderr contains warnings;
- run `mcp-portal mcp-proxy serve`;
- verify bad bearer returns opaque 401 without reason;
- connect an MCP SDK Streamable HTTP client;
- call `mcp_portal_call`;
- verify upstream progress arrives.

## What A Fresh Reviewer Should Re-check

1. Confirm Hono imports are contained to `mcp-proxy` and package root exports do
   not pull Hono into the OpenClaw plugin.
2. Confirm managed OpenClaw never receives `OP_*` values or invokes `op`.
3. Confirm `enabledToolsByNamespace` cannot be bypassed by naming a hidden tool
   directly in `mcp_portal_call`.
4. Confirm package exports are emitted after `pnpm build`, especially
   `dist/portal-auth/*`.
5. Confirm opaque auth responses do not leak `missing`, `malformed`,
   `signature-mismatch`, or `unknown_agent` to clients.
6. Confirm loopback MCP providers still work after URL scheme validation.
7. Confirm explicit empty namespace lists deny access while missing namespace
   lists still follow `defaultPolicy`.
8. Confirm scalar portal tools observe `AbortSignal` and do not keep local
   catalog/session work alive after cancellation.
9. Confirm the OpenClaw smoke is run explicitly with `mise`, not inferred from
   default skipped smoke output.

## Latest Fresh Verification

Fresh verification on 2026-05-20 after the SSRF documentation and scalar-abort
repair pass:

- `pnpm build`: passed, exit 0.
  - Confirms `packages/mcp-portal/dist/portal-auth/agent-bearer-token.js`,
    `hmac-env.js`, and `hmac-token.js` are emitted.
  - Existing warning remains in `openclaw-agent-vm-plugin`: tsdown says
    `external` is deprecated in favor of `deps.neverBundle`.
- `pnpm check`: passed, exit 0.
  - Package versions: 11 `@agent-vm/*` packages synced at `0.0.70`.
  - Type-aware lint: 0 warnings, 0 errors.
  - Format check: all 512 matched files correct.
  - Workspace typecheck: passed.
- `pnpm test:unit`: passed, exit 0.
  - 177 test files passed.
  - 1483 tests passed.
- `pnpm test:integration`: passed, exit 0.
  - 7 test files passed, 4 skipped.
  - 11 tests passed, 10 skipped.
- `mise exec -- pnpm test:smoke`: passed, exit 0.
  - 4 test files passed, 5 skipped.
  - 5 tests passed, 9 skipped.
- Explicit OpenClaw MCP Portal smoke:
  - Command:
    `mise exec -- env AGENT_VM_OPENCLAW_SMOKE=1 pnpm vitest run --root . --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts`
  - Passed, exit 0.
  - 1 test file passed.
  - 4 tests passed.
- Focused regression checks:
  - `manual-templates.test.ts`: passed after adding the private-network MCP
    provider documentation assertion.
  - `portal-core.test.ts` and `portal-tools.test.ts`: passed after confirming
    scalar tool streams receive and honor `AbortSignal`.
- Manual temp-directory package-shape check: passed.
  - Used built `dist/bin/mcp-portal.js` through a symlink named `mcp-portal`.
  - Verified `mcp-proxy print-client-config`, stdout client config, stderr
    warnings without bearer leakage, `mcp-proxy serve`, opaque 401, MCP SDK
    call, and progress updates.
