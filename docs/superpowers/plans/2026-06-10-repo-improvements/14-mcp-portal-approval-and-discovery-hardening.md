# MCP Portal: Approval Batch Gaps and Discovery Resilience

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 14 (security/UX on the approval path + reliability on discovery)

## Problem

Four verified gaps in the MCP portal subsystem (a fifth — generation-map
growth — was removed from scope after adversarial review; see Non-Goals):

1. **Mixed batches never reach the operator — via TWO distinct
   pass-through exits.** In the OpenClaw `before_tool_call` hook: (a) if a
   batch contains at least one profile-disabled call, the handler returns
   `undefined` at `before-tool-call-handler.ts:175` *before* the approval
   scan; (b) if the batch mixes approval-free and approval-required calls,
   it returns `undefined` at `:188-189`. In both cases approval-required
   calls fail at core with `approval_required` and no token — the operator
   is never prompted. An agent batching a read together with a write gets
   the write silently refused with no approval flow. BOTH exits must be
   fixed.
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
- `portal-approval-evaluator.ts:109-122` (review-verified, load-bearing for
  the fix choice): `verifyApprovalToken` is called with
  `approvalTokenCallDigests(callsRequiringApproval)` — the token covers
  ONLY the approval-required subset, never the whole batch. A token scoped
  to the approval subset of a mixed batch verifies correctly while
  disabled/blocked siblings fail per-item at core.
- Pinned tests that encode the current pass-through behavior and MUST
  change with this plan (`before-tool-call-handler.unit.test.ts`): line 95
  "passes mixed batches through so core can fail only gated calls"; line
  124 "...when one visible call is blocked by call policy"; line 153
  "...when one sibling is hidden". All assert `.resolves.toBeUndefined()`.
- `docs/subsystems/mcp-portal.md` — documents mixed-batch item-level
  errors, but not the "approval-required calls in a mixed batch never
  prompt" consequence, nor the discovery-failure cache behavior.

## Non-Goals

- No redesign of the approval token format or HMAC scheme (verified sound:
  agentId-bound payload, JTI replay protection, timing-safe comparisons).
- No change to the broader approval UX — the fix scopes tokens to the
  approval subset of a batch; it does not build partial-approval prompts.
- Generation-map cleanup (`agentScopeGenerations` in
  `upstream-mcp-client-runtime.ts` and `portal-session.ts`) is REMOVED from
  this plan after adversarial review: `generationForAgentScope` defaults to
  0 for missing entries, and the stale-connection guard
  (`upstream-mcp-client-runtime.ts:598-615`) relies on the post-close
  incremented value being present — delete-on-close would let an in-flight
  client captured at generation 0 be promoted after close (`0 !== 0` is
  false). Unbounded growth stays a backlog item to be solved with a
  size-capped structure or a proven scope-ID-never-reused invariant, not
  deletion.
- The auth rate-limit bucket eviction nuance (`portal-http-server.ts`) is
  recorded in the backlog, not this plan.

## Scope

Write surfaces:
- `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts`:
  - mixed batches (BOTH exits, `:175` and `:188-189`): PREFERRED fix
    (revised after review) — inject a token scoped to the
    approval-required subset. This is verified feasible: the core
    evaluator hashes only `callsRequiringApproval`
    (`portal-approval-evaluator.ts:109-122`), so disabled/blocked siblings
    still fail per-item at core while approved writes prompt and proceed.
    No UX regression for the read half of a mixed batch, and no dependency
    on OpenClaw surfacing `blockReason` text to the model. Fall back to
    batch-block-with-reason ONLY if scoped injection proves incompatible
    with the approval-prompt flow — and in that case first verify (not just
    the hook type shape `OpenClawBeforeToolCallResult.blockReason`,
    `openclaw-plugin-api.ts:69-82`) that OpenClaw actually delivers
    `blockReason` to the model context; if it doesn't, a block is WORSE
    than today's behavior.
  - fallback digests: make `resolveApprovalTokenCallDigests` REQUIRED
    (hard cutover per repo policy) — the raw-arguments fallback
    (`:77-85`) hashes pre-validation values while the verifier hashes
    post-Zod `validatedArguments`, so the fallback can never verify for
    coerced inputs. No circular-dependency concern: the plugin already
    depends on `@agent-vm/mcp-portal` (package.json). This touches ~10
    test setups in `before-tool-call-handler.unit.test.ts` that construct
    the handler without the resolver — update them in the same pass.
- `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`: page cap +
  accumulated tool cap in `listAllTools` (`:391-413`). Implementation
  note: `listAllTools` has no server context for
  `transportSummaryFromServer` — throw a recognizable error inside and let
  the existing catch in `listTools` (`:744-777`) wrap it into the
  structured `UpstreamMcpError` with `phase: 'list_tools'` (phase value
  confirmed valid, `upstream-mcp-errors.ts:6`).
- `packages/mcp-portal/src/portal-session.ts`: cache failure-degraded
  sessions with a short TTL (e.g. min(catalogTtl, 10s)) retaining
  `discoveryFailures` diagnostics. The generation invariant is preserved:
  the degraded-cache write must keep the same
  `generationForScope(key) === generation` guard, and
  `invalidateAgentScope` already deletes cached entries (`:231-238`) —
  review-verified safe.
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

1. Mixed-batch fix + unit tests: both pass-through exits replaced with
   scoped-subset token injection; tests assert batch(disabled +
   requires_approval) and batch(approval-free + requires_approval) both
   produce a token covering exactly the approval subset — never silent
   pass-through. Update the three pinned pass-through tests (lines 95, 124,
   153) citing this plan.
2. Fallback digest fix + the coercion regression test (`"42"` →
   integer-typed field; token must verify end-to-end through core).
3. Pagination caps + fake-infinite-upstream test (assert structured
   `upstream_mcp_failed`/`list_tools` error after the page cap, not a
   hang).
4. Degraded-session caching + flapping-upstream test (healthy namespace
   called once per short-TTL window, not per tool call; invalidation during
   build still prevents the cache write).
5. Update mcp-portal.md (mixed-batch behavior + degraded-cache TTL); run
   portal + plugin unit suites and the full gate.

## Proof Gates

- Red/green proof: tests in steps 1-4 fail before, pass after.
- Focused validation:
  `pnpm vitest run --config vitest.config.ts --project unit packages/mcp-portal/src packages/openclaw-mcp-portal-plugin/src`
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`

## Stop Conditions

- Stop if scoped-subset token injection proves incompatible with the
  OpenClaw approval-prompt flow (the prompt is raised by the hook's
  `requireApproval` path — verify the prompt can describe only the subset).
  Before falling back to batch-block, verify OpenClaw actually delivers
  `blockReason` to the model context — the hook type shape
  (`openclaw-plugin-api.ts:69-82`) proves expressibility, not model
  visibility; if unverifiable, a block regresses mixed-batch reads and
  needs a user decision.
- Stop if degraded-session caching interacts badly with the generation
  invalidation contract (cache must still drop on
  `invalidateAgentScope`) — the generation check in the cache write is the
  invariant to preserve.

## Risks

- Changing mixed-batch behavior alters agent-visible semantics (writes in
  mixed batches now prompt instead of silently failing); the
  mcp-portal.md update is part of the change, not optional.
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
