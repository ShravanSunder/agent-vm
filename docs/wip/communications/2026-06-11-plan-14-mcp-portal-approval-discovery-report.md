# Plan 14 - MCP Portal Approval and Discovery Hardening

Date: 2026-06-11
Branch: `improve/plan-14-mcp-portal-approval-discovery`
Base branch: `improve-v1`
Implementation commit: `6c72c0b fix: harden mcp portal approvals and discovery`
Push state: pushed to `origin/improve/plan-14-mcp-portal-approval-discovery`
PR URL: https://github.com/ShravanSunder/agent-vm/pull/new/improve/plan-14-mcp-portal-approval-discovery

## Scope

Implemented the reviewed plan at
`docs/superpowers/plans/2026-06-10-repo-improvements/14-mcp-portal-approval-and-discovery-hardening.md`.

Changed surfaces:

- `docs/subsystems/mcp-portal.md`
- `packages/mcp-portal/src/core/portal-core.integration.test.ts`
- `packages/mcp-portal/src/portal-session.ts`
- `packages/mcp-portal/src/portal-session.unit.test.ts`
- `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`
- `packages/mcp-portal/src/upstream-mcp-client-runtime.integration.test.ts`
- `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts`
- `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.unit.test.ts`
- `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`

## Implementation Summary

- Removed the plugin-side raw-argument approval digest fallback and made the
  digest resolver required.
- Changed mixed `mcp_portal_call` batches so the OpenClaw hook prompts only for
  approval-required calls with prepared core digests; approval-free, hidden,
  blocked, invalid, or unknown siblings remain governed by MCP Portal core
  item-level policy.
- Changed production plugin registration to use the core digest map directly.
  Per-call preparation misses return no prompt for those calls instead of
  blocking the whole outer batch; infrastructure failures still block closed.
- Replaced recursive `listAllTools` discovery with bounded cursor iteration:
  100 page cap and 10,000 accumulated tool cap, with cap failures wrapped as
  structured `upstream_mcp_failed` / `list_tools` diagnostics.
- Changed portal session caching so partial runtime discovery failures are cached
  for `min(catalogTtlMs, 10s)` from discovery completion time, total runtime
  discovery outages are not cached, static configured diagnostics do not shorten
  a healthy catalog TTL, and generation invalidation still prevents stale writes.
- Updated MCP Portal docs for approval-subset prompts and degraded discovery
  cache behavior.

## Red Proof

- Mixed-batch/degraded-cache red proof:
  - Command: `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.unit.test.ts packages/mcp-portal/src/portal-session.unit.test.ts`
  - Exit: 1
  - Result: 2 failed files, 5 failed tests, 23 passed.
  - Expected failures: mixed approval-free/approval-required batches still
    passed through without prompt; degraded discovery was not cached.
- Endless-pagination red proof:
  - Command: `pnpm vitest run --config vitest.config.ts --project integration packages/mcp-portal/src/upstream-mcp-client-runtime.integration.test.ts`
  - Result: pre-fix infinite-cursor test hung with no page cap and was
    interrupted after proving the no-cap behavior.

## Review Swarm

Ran four read-only reviewer lanes:

- Spec compliance and implementation proof: accepted slow degraded TTL finding,
  accepted missing coercion-regression proof, accepted full-gate proof gap.
- Security and approval-token trust boundary: no findings.
- Reliability and performance: accepted slow degraded TTL, wrong degraded-cache
  scope, and oversized-page pre-append cap findings.
- Contracts and tests: accepted mixed-invalid approval batch whole-block finding
  and duplicate total-outage cache finding.

Accepted fixes:

- Degraded cache expiry now starts after discovery completes.
- Short degraded TTL now applies only when runtime discovery has both successes
  and failures.
- Total runtime discovery outages are uncached.
- Static configured discovery diagnostics keep the full healthy catalog TTL.
- Tool cap is checked before appending an oversized page.
- Core integration proves real digest preparation handles `"42"` to `42`
  coercion and authorizes the normalized upstream call.
- Hook and core tests prove an invalid approval-required sibling does not
  whole-batch block approval-free execution.
- Required full gates were rerun after review fixes.

## Proof Gates

- `pnpm fmt`
  - Exit: 0
  - Result: Oxfmt completed on 621 files.
- `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.unit.test.ts packages/mcp-portal/src/portal-session.unit.test.ts`
  - Exit: 0
  - Result: 2 files passed, 31 tests passed.
- `pnpm vitest run --config vitest.config.ts --project integration packages/mcp-portal/src/upstream-mcp-client-runtime.integration.test.ts packages/mcp-portal/src/core/portal-core.integration.test.ts`
  - Exit: 0
  - Result: 2 files passed, 55 tests passed.
- `pnpm vitest run --config vitest.config.ts --project unit packages/mcp-portal/src packages/openclaw-mcp-portal-plugin/src`
  - Exit: 0
  - Result: 33 files passed, 196 tests passed.
- `pnpm test:taxonomy`
  - Exit: 0
  - Result: Test taxonomy audit passed.
- `pnpm check`
  - Exit: 0
  - Result: 6 passed, 0 failed.
  - Sub-gates: package version sync, zod guard, taxonomy, format, type-aware lint, typecheck.
- `pnpm test:unit`
  - Exit: 0
  - Result: 197 files passed, 1806 tests passed.
- `pnpm test:integration`
  - Exit: 0
  - Result: 23 files passed, 331 tests passed.
- `git diff --check`
  - Exit: 0
- `mise run lint`
  - Exit: 0
  - Result: Oxlint found 0 warnings and 0 errors.

## Notes

- `pnpm check` still emits existing warning-only type-aware lint diagnostics in
  scripts, but the gate summary was 6 passed and 0 failed.
- The first signed commit attempt failed because the 1Password signing agent
  returned an error; the scoped implementation commit was made with
  `--no-gpg-sign` per repo guidance not to block local commits on signing.
