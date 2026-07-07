# Slice 16 - Tool VM And MCP Full-Path Proof

Status: proof-hardening slice, added after the SMA implementation exposed that
repo-owned Tool VM and MCP evidence was present but not one complete beta-agent
full-path proof chain.

## Source

- User requirement: prove Tool VM calls do real work, including writing and
  reading files, through the controller RPC path.
- User requirement: MCP Portal live discovery must run all namespaces
  concurrently with bounded timeout, use discovered namespaces, and mark failed
  namespaces disabled/unavailable with logs and schema-visible state.
- User requirement: default MCP namespace discovery timeout is 12 seconds and is
  configurable.
- Existing proof gap: same-zone `beta` agent Tool Portal profile separation is
  proven, but a real Tool VM lease from non-default agent `beta` is not yet a
  permanent e2e proof.

## Behavior

MCP Portal live discovery is a degraded-discovery process, not an all-or-nothing
startup gate. For every namespace referenced by the effective MCP Portal
profiles, discovery must:

1. start all namespace `tools/list` requests concurrently;
2. enforce a configurable per-namespace timeout, defaulting to 12 seconds;
3. settle all namespace attempts before returning validation/catalog output;
4. expose successful namespaces with their discovered tools;
5. expose failed or timed-out namespaces as disabled/unavailable, with a safe
   reason and log/check evidence;
6. fail closed for calls to disabled/unavailable namespace tools.

The disabled namespace state must be typed as a discriminated union rather than
represented by missing data, `any`, broad `unknown`, or stringly side channels.

The Tool VM proof must exercise a real controller-owned lease and actual Tool VM
work. A passing proof must show:

```text
OpenClaw beta agent
  -> gateway_control_rpc lease_create over /__agent-vm/gateway-control
  -> controller validates agentId/workspace/workMount/proof
  -> Tool VM starts
  -> gateway reaches Tool VM only over SSH
  -> Tool VM writes a proof file
  -> Tool VM reads the proof file back
  -> result returns to the OpenClaw caller
```

Only the gateway-to-Tool-VM leg may use raw SSH. Controller/gateway control,
lease creation, and lease/use state must not fall back to
`controller.vm.host:18800`, `CONTROLLER_BASE_URL`, or old direct controller HTTP
callbacks.

Any deterministic proof route added for this slice is not a general product API.
If the route is present in the plugin bundle, it must remain disabled by
default and must require a separate e2e proof key in addition to normal plugin
auth. The route must sign the exact request body, derive the effective agent
from the authenticated session key instead of trusting a caller-selected
`agentId`, reject foreign-agent bodies, reject absolute paths, `..`, NUL bytes,
and paths outside `.agent-vm/`, and cap request body size. A failure in any of
those checks must return a typed 4xx response without creating a Tool VM lease.

## Write Surface

Likely product files:

- `packages/agent-vm/src/operations/mcp-portal-live-validation.ts`
- `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`
- `packages/config-contracts/src/mcp-portal-config.ts` or adjacent schema owner,
  only if disabled namespace state becomes authored/effective config
- `packages/tool-portal/src/**`, if Tool Portal catalog/result shapes need a
  typed unavailable namespace variant
- `packages/openclaw-agent-vm-plugin/src/**`, if native Tool Portal tools need
  to surface disabled namespace state or structured unavailable errors

Likely proof files:

- `packages/agent-vm/src/operations/config-validation.integration.test.ts`
- `packages/mcp-portal/src/upstream-mcp-client-runtime.integration.test.ts`
- `packages/agent-vm/src/integration-tests/openclaw-mcp-portal.openclaw.e2e.test.ts`
- `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`
- `packages/agent-vm/src/integration-tests/openclaw-control-session.openclaw.e2e.test.ts`

## Checkpoint

- `validate --mcp-live` or its extracted discovery helper runs all referenced
  namespaces concurrently and returns settled results.
- A timed-out namespace returns a typed disabled/unavailable result and does not
  suppress successful namespace tool discovery. Referenced unavailable
  namespaces remain visible as unavailable but fail validation proof.
- Discovered tools build input-schema validators during live validation, so
  schema-unsupported tools fail before call time.
- The default per-namespace discovery timeout is 12 seconds.
- The timeout is configurable through the accepted config or runtime options,
  with docs/manual guidance and tests.
- A full MCP runtime call is proven, not only `tools/list`.
- A same-zone non-default `beta` agent creates a Tool VM lease, writes a file in
  the Tool VM, reads it back, and returns the marker.
- Hard-cutover scans still show no old raw controller callback path.

## Proof

Canonical rows:

- MCP-DISCOVERY-1
- MCP-DISCOVERY-2
- MCP-CALL-1
- TOOLVM-BETA-1
- TOOLVM-BETA-2

Required command layers:

- targeted unit/integration tests for discovery timeout, settled namespace
  results, and disabled namespace state
- `mise exec -- pnpm run test:e2e:openclaw` with the full Tool VM file
  write/read and full MCP call tests enabled
- `../shravan-claw-beta` current-head proof after local tarball sync:
  - `pnpm validate`
  - `pnpm exec agent-vm validate --config config/system.jsonc --mcp-live`
  - `mise exec -- pnpm build`
  - `mise exec -- pnpm start`
  - real beta-agent Tool VM file write/read or a recorded blocker if the live
    OpenClaw model cannot deterministically trigger that path
  - real MCP provider tool call for at least one available provider

## Split / Replan Triggers

- If disabled/unavailable namespace state changes public Tool Portal result
  contracts, split schema/catalog work from runtime MCP calls.
- If OpenClaw cannot deterministically trigger a beta-agent Tool VM write/read
  through the model surface, add a gateway API or e2e-only deterministic
  OpenClaw tool invocation path before using Discord as the only proof driver.
- If DeepWiki times out but another provider succeeds, do not block the Tool VM
  proof; record DeepWiki as disabled/unavailable for that run and prove a full
  call against an available provider.
