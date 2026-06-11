# Docs / Architecture Drift Reconciliation

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 11 (onboarding integrity — the documented mental model diverges from code)

## Problem

The repo's progressive-disclosure docs are the primary orientation surface
for agents, and several load-bearing pieces are stale:

1. **CLAUDE.md package map lists 7 of 11 packages** — missing
   `config-contracts`, `mcp-portal`, `secret-management`,
   `openclaw-mcp-portal-plugin` (all load-bearing).
2. **`docs/architecture/overview.md`** repeats the same 4-package omission,
   understates the HTTP API by ~9 routes (renew, uses/heartbeat, close,
   pull-default, service-health, health-events, health-snapshot, …), and
   omits 5 startup-sequence subsystems. `docs/subsystems/controller.md` is
   accurate — overview.md is the stale layer.
3. **`docs/architecture/agent-worker-gateway.md` documents event names that
   don't exist**: `plan-created`, `work-started`, `review-result`,
   `verification-result`, `fix-applied` (actual union:
   `plan-finalized`, `phase-started`, `plan-reviewer-turn`/
   `work-reviewer-turn`, etc., 21 variants including the
   `controller-git-push/pull-*` family); the status names in its state
   diagram don't match `taskStatusValues`. Anyone building an event-log
   consumer from this doc writes broken code.
4. **`docs/README.md` omits `docs/subsystems/mcp-portal.md`** from the docs
   map, making it unreachable via the documented entry path.
5. **CLAUDE.md calls `pnpm check` the "full quality gate"** but
   `run-check-gate.ts` deliberately excludes unit/integration tests — an
   agent claiming done on `pnpm check` alone has not run tests.
6. **Undocumented external heartbeat contract**: `heartbeat-sender.ts` POSTs
   to `${CALLER_URL}/tasks/:requestTaskId/heartbeat` — an endpoint the
   *caller* must host. Nothing documents this; a wrong CALLER_URL silently
   kills heartbeats on the first 404 (terminal status). Document the
   contract or remove the feature (decision gate below).

## Current Evidence

- `CLAUDE.md` Packages section (7 entries) vs `ls packages` (11).
- `docs/architecture/overview.md:171-228` (package graph/table),
  `:260-279` (14-row API table) vs `docs/subsystems/controller.md:87-122`
  (22 routes, verified accurate) and route registrations in
  `controller-http-routes.ts` / `controller-zone-operation-routes.ts` /
  `controller-health-event-routes.ts`.
- `docs/architecture/agent-worker-gateway.md:441,466-480,699-717` —
  `plan-created` et al.; `grep -rn "'plan-created'" packages` → no matches;
  actual union in
  `packages/agent-vm-worker/src/state/task-event-types.ts`.
- `docs/README.md` — no `mcp-portal.md` entry; file exists at
  `docs/subsystems/mcp-portal.md`.
- `scripts/run-check-gate.ts:58-107` — phases are static-analysis only.
- `packages/agent-vm/src/controller/heartbeat-sender.ts:36` +
  `controller-runtime.ts:540` (CALLER_URL) — no matching route anywhere; no
  doc mentions CALLER_URL.

## Non-Goals

- No code changes except (possibly) deleting the heartbeat feature if the
  decision lands that way — and that deletion would be split into its own
  change, not bundled silently into a docs pass.
- No rewriting of accurate docs (controller.md, storage-model.md).

## Scope

Write surfaces:
- `CLAUDE.md`: add the 4 missing packages to the map (one-line
  responsibilities, dependency arrows consistent with package.json deps);
  clarify the `pnpm check` sentence ("static gate; run `pnpm test:unit` /
  `pnpm test:integration` separately"); add the events route if plan 09 has
  landed (coordinate, don't assume).
- `docs/architecture/overview.md`: packages graph/table; replace the
  drifting API table with the short core list plus an explicit pointer to
  `controller.md` as the authoritative route reference; add the missing
  startup-sequence subsystems.
- `docs/architecture/agent-worker-gateway.md`: regenerate the event table
  from `task-event-types.ts` (all variants, including controller-git-*),
  fix the state-machine diagram status names to `taskStatusValues`, fix the
  example JSONL lines.
- `docs/README.md`: add `mcp-portal.md` to the subsystems list.
- `docs/subsystems/worker-task-pipeline.md` or `controller.md`: document
  the CALLER_URL heartbeat contract (endpoint shape, cadence, terminal
  statuses) — or, if the decision is removal, note it and stop (see gate).
- Optional guard (small, high leverage): a unit test that cross-checks the
  event names listed in `agent-worker-gateway.md`'s table against the Zod
  union keys in `task-event-types.ts`, so this class of drift fails CI
  instead of recurring.

Read-only context:
- `packages/agent-vm-worker/src/state/task-event-types.ts`,
  `task-state.ts` — source of truth for events/statuses.
- Route registration files for the API list.

## Task Sequence

1. Regenerate the event table + status names in agent-worker-gateway.md
   directly from `task-event-types.ts`; add the doc↔schema cross-check test
   if cheap (target: `packages/agent-vm-worker/src/state/`).
2. Fix CLAUDE.md package map + check-gate clarification.
3. Fix overview.md (packages, API pointer, startup sequence).
4. Add mcp-portal.md to docs/README.md.
5. Decision gate with the user: document vs delete the CALLER_URL heartbeat
   feature. Then do the chosen half.
6. Re-verify every edited claim against source (each route name greppable;
   each event name present in the union).

## Proof Gates

- Cross-check test (if added):
  `pnpm vitest run --root . --config vitest.config.ts --project unit packages/agent-vm-worker/src/state`
- Full validation: `pnpm check` (fmt over edited markdown included) and
  `pnpm test:unit` if the guard test was added.
- Manual gate: diff review — every changed doc line traceable to a source
  file fact.

## Stop Conditions

- Stop at step 5 if the user is unavailable for the heartbeat decision;
  land steps 1-4 independently.
- Stop if regeneration reveals *additional* semantic drift in
  agent-worker-gateway.md beyond events/statuses (e.g. pipeline phase
  descriptions that no longer match `task-runner.ts`) — report scope before
  expanding.

## Risks

- Docs edits silently rotting again: the cross-check test is the mitigation;
  prefer pointers to single sources of truth over duplicated tables.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/11-docs-architecture-drift.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
