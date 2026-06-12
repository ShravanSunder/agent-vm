# MCP Portal: Approval Batch Gaps and Discovery Resilience

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 14 (security/UX on the approval path + reliability on discovery)

## Problem

Five verified gaps in the MCP portal subsystem:

1. **Mixed disabled+approval batches never reach the operator.** In the
   OpenClaw `before_tool_call` hook, if a batch contains at least one
   profile-disabled call, the handler returns `undefined` *before* the
   approval scan. Approval-required calls in that batch fail at core with
   `approval_required` and no token — the operator is never prompted. An
   agent batching a typo'd namespace together with a write tool gets the
   write silently refused with no approval flow.
2. **Fallback approval digests hash pre-validation arguments.** When
   `createBeforeToolCallHandler` is used without
   `resolveApprovalTokenCallDigests`, tokens are signed over raw arguments,
   but the core verifier hashes post-Zod-normalized arguments
   (`validatedArguments`). Any coerced argument (`"42"` → `42`) yields
   `call-mismatch` and a refused operator-approved call. This is the
   residual edge of the "argument type preservation" fix (45cc58d). The
   production plugin wiring always supplies the resolver, so this bites
   only direct API users — but it is a public API that silently fails.
3. **`listAllTools` pagination is unbounded.** Recursive with no page or
   tool-count cap; a buggy upstream returning endless cursors consumes
   memory/time bounded only by per-page timeouts (30s × pages).
4. **Any discovery failure disables session caching entirely.** A session
   with `discoveryFailures.length > 0` is never cached, so every portal
   tool call re-runs full discovery across *all* namespaces while one
   upstream flaps — hammering healthy upstreams and adding up-to-timeout
   latency per call.
5. **`agentScopeGenerations` maps grow unboundedly** in both
   `upstream-mcp-client-runtime.ts` and `portal-session.ts` — one permanent
   entry per session-scoped key, never deleted on close.

## Current Evidence

- `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts:163-176`
  — partial-disabled → `return undefined` before the approval scan at
  178-190; homogeneous-approval-only token injection at 188-189.
- `before-tool-call-handler.ts:77-85,198-204` — fallback digest over
  `call.arguments` (raw); core digest preparation
  (`portal-tools.ts` `preparePortalApprovalCallDigests`) and the verifier
  (`portal-approval-evaluator.ts`) both hash `validatedArguments`.
- `packages/mcp-portal/src/upstream-mcp-client-runtime.ts:391-413` —
  recursive `listAllTools`, no page/count cap.
- `packages/mcp-portal/src/portal-session.ts:221-228` — cache write gated
  on `discoveryFailures.length === 0`.
- `upstream-mcp-client-runtime.ts` (~:469) and `portal-session.ts` (~:134)
  — generation maps with increment-only lifecycle.
- `docs/subsystems/mcp-portal.md` — documents mixed-batch item-level
  errors, but not the "approval-required calls in a mixed batch never
  prompt" consequence, nor the discovery-failure cache behavior.

## Non-Goals

- No redesign of the approval token format or HMAC scheme (verified sound:
  agentId-bound payload, JTI replay protection, timing-safe comparisons).
- No change to the documented v1 stance that approval tokens are only
  injected for *homogeneous* approval batches — the fix scopes tokens to
  the approval subset or blocks with a structured error; it does not build
  partial-approval UX.
- The auth rate-limit bucket eviction nuance (`portal-http-server.ts`) is
  recorded in the backlog, not this plan.

## Scope

Write surfaces:
- `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts`:
  - mixed disabled+approval batches: block the batch with a structured
    reason instructing the agent to split the batch (preferred: simplest
    correct behavior that guarantees no silent approval bypass), or inject
    a token scoped to the approval subset — decide with a quick test of
    how OpenClaw surfaces block reasons to the agent; either way the
    write-without-prompt path must die;
  - fallback digests: require `resolveApprovalTokenCallDigests` (hard
    cutover per repo policy) or route the fallback through core
    `prepareCallDigests`; eliminate the pre/post-validation divergence.
- `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`: page cap +
  accumulated tool cap in `listAllTools`, structured `UpstreamMcpError` on
  breach; delete generation entries on scope close.
- `packages/mcp-portal/src/portal-session.ts`: cache failure-degraded
  sessions with a short TTL (e.g. min(catalogTtl, 10s)) retaining
  `discoveryFailures` diagnostics; delete generation entries on
  invalidate-after-close.
- `docs/subsystems/mcp-portal.md`: document the corrected mixed-batch
  behavior and the degraded-cache TTL.
- Unit tests adjacent to every changed file.

Read-only context:
- `packages/mcp-portal/src/core/portal-approval-evaluator.ts`,
  `portal-tools.ts` (digest preparation), `zod-schema-loader.ts`
  (coercion behaviors that make the digest divergence reproducible).
- `before-tool-call-handler.unit.test.ts` — existing tests encode the
  current mixed-batch pass-through as intended; those tests change with
  this plan (that is the point — cite this plan in the test change).

## Task Sequence

1. Mixed-batch fix + unit tests: batch(disabled + requires_approval) →
   structured block (or scoped token), never silent pass-through; existing
   pass-through tests updated with rationale.
2. Fallback digest fix + the coercion regression test (`"42"` →
   integer-typed field; token must verify end-to-end).
3. Pagination caps + fake-infinite-upstream test.
4. Degraded-session caching + flapping-upstream test (healthy namespace
   called once per short-TTL window, not per tool call).
5. Generation-map cleanup + bounded-size test over 10k open/close cycles.
6. Update mcp-portal.md; run portal + plugin unit suites and the full gate.

## Proof Gates

- Red/green proof: tests in steps 1-5 fail before, pass after.
- Focused validation:
  `pnpm vitest run --root . --config vitest.config.ts --project unit packages/mcp-portal/src packages/openclaw-mcp-portal-plugin/src`
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`

## Stop Conditions

- Stop if OpenClaw's hook contract cannot express a per-batch block with an
  agent-readable reason (would force the scoped-token alternative; verify
  against `openclaw-plugin-api.ts` before choosing).
- Stop if degraded-session caching interacts badly with the generation
  invalidation contract (cache must still drop on
  `invalidateAgentScope`) — the generation check in the cache write is the
  invariant to preserve.

## Risks

- Changing mixed-batch behavior alters agent-visible semantics; the doc
  update and a clear block reason are part of the change, not optional.
- Short-TTL degraded caching trades up-to-10s staleness of failure
  diagnostics for upstream protection — acceptable, documented.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/14-mcp-portal-approval-and-discovery-hardening.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
