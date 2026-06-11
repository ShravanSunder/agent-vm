# Codex SDK Upgrade (^0.130.0 → ^0.139.0) and Streaming Adoption

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 7 (currency + capability — low-risk upgrade, optional streaming win)

## Problem

`agent-vm-worker` pins `@openai/codex-sdk` at `^0.130.0`. Research (npm
registry checked 2026-06-10) shows:

- Latest stable is **0.139.0** (published 2026-06-09); `0.140.0-alpha.7` is
  the bleeding edge.
- **There is no separate "v2 Codex SDK" package.** "v2" in the Codex
  ecosystem refers to the SDK↔app-server protocol version, not a new npm
  package or major. The upgrade path is simply the latest `@openai/codex-sdk`
  minor.
- The API surface this repo uses (`new Codex(...)`, `startThread`,
  `resumeThread`, `thread.run`, `thread.id`, `result.finalResponse`,
  `result.usage.output_tokens`) is stable across 0.130 → 0.139; no breaking
  changes were found at these call sites.
- Capability to adopt: `thread.runStreamed()` (async generator of thread
  events — existence in latest confirmed via SDK docs; whether 0.130.0
  already shipped it is unverified, so do not frame it as "new" — check the
  installed 0.130 d.ts at execution time). Today the worker buffers a whole
  turn via `thread.run()`; long work-phase turns (tens of minutes) produce
  no intermediate progress events for the task event log.
- Model aliases: review research (2026-06-11) found NO source for a specific
  sunset date affecting `gpt-5.4` / `gpt-5.4-mini`. Treat any sunset claim
  as unverified; the task below simply checks the live deprecation list and
  acts only on what it documents.

## Current Evidence

- `packages/agent-vm-worker/package.json:48` — `"@openai/codex-sdk": "^0.130.0"`.
- `packages/agent-vm-worker/src/work-executor/codex-executor.ts:5,108-149,182-189`
  — the full SDK call-site inventory (constructor, startThread, resumeThread,
  run, usage fields).
- `packages/agent-vm-worker/src/work-executor/persistent-thread.ts` — wraps
  the executor; no SDK types.
- `npm view @openai/codex-sdk version` → `0.139.0` (2026-06-10).
- `packages/agent-vm-worker/src/config/worker-config.ts:182-195` —
  `MODEL_ALIASES` (codex: gpt-5.4 / gpt-5.4-mini).

## Non-Goals

- No executor-interface redesign (that is plan 08).
- No mandatory adoption of streaming for all phases — start where it pays
  (work phase turn progress), keep `run()` elsewhere if simpler.
- No model alias changes unless the deprecation check requires them.

## Scope

Write surfaces:
- `packages/agent-vm-worker/package.json`: bump to `^0.139.0`;
  `pnpm-lock.yaml` via install.
- `packages/agent-vm-worker/src/work-executor/codex-executor.ts`: compile
  against the new minor; if adopting streaming, add an optional
  `onTurnEvent` callback to the executor config consumed from
  `runStreamed()` events (tool calls, intermediate output), falling back to
  buffered `run()` when no callback is provided.
- (If streaming adopted) `packages/agent-vm-worker/src/coordinator/task-runner.ts`
  + `packages/agent-vm-worker/src/state/task-event-types.ts`: optionally add
  a low-volume progress event (e.g. `work-agent-progress`) — only if the
  event-log consumers are updated in the same pass (hard cutover, no dual
  formats).

Read-only context:
- `packages/agent-vm-worker/src/work-executor/codex-executor.unit.test.ts`
  and `persistent-thread.unit.test.ts` — mock seams that must keep passing.
- Codex SDK 0.139.0 changelog/types in `node_modules/@openai/codex-sdk`
  after install — confirm option names (`modelReasoningEffort`,
  `networkAccessEnabled`, `sandboxMode`) are unchanged in the shipped d.ts.

## Task Sequence

0. Re-confirm package landscape (cheap, read-only):
   `npm view @openai/codex-sdk version` (verified 0.139.0 on 2026-06-10,
   0.140.0-alpha.7 bleeding edge) and confirm no successor package exists
   (`npm search` for codex-sdk variants). The "v2 = protocol, not package"
   claim is medium-confidence inference — if a successor package surfaces,
   stop and reconverge.
1. Bump the dependency, `pnpm install`, `pnpm build`, `pnpm typecheck`.
   Inspect the installed d.ts for the six call-site option names; fix any
   renames (none expected — but if typecheck fails, stop and bring the diff
   back rather than patching around renames).
2. Run worker unit + integration suites.
3. Check `MODEL_ALIASES.codex` targets against OpenAI's current model
   deprecation list; update aliases only if a target is scheduled for
   sunset.
4. Decision gate (small): adopt `runStreamed()` now or defer. If adopting:
   implement the optional `onTurnEvent` seam with unit tests using a mocked
   async generator; keep the buffered path as the no-callback default.
5. Run the gated worker E2E lane if credentials are present:
   `pnpm --filter @agent-vm/agent-vm-worker test:e2e:worker`
   (requires `AGENT_VM_WORKER_E2E=1` + `AGENT_VM_TEST_OPENAI_API_KEY` + the
   `codex` binary); report skipped-with-reason otherwise.

## Proof Gates

- Focused validation: `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src`
- Integration: `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm-worker/src`
- Full validation: `pnpm check && pnpm test:unit`
- E2E (gated): worker E2E lane as above, or explicit skip reason.

## Stop Conditions

- Stop if the d.ts diff shows renamed/removed options at any used call site
  — bring the diff back before patching around it.
- Stop if streaming adoption forces an event-log schema change consumers
  aren't ready for; ship the bump alone and split streaming into its own
  follow-up.

## Risks

- Minor-version behavior drift inside the SDK's CLI bridging (the SDK shells
  to the bundled codex binary); the worker E2E lane is the real proof here —
  if it cannot run for credential reasons, say so explicitly in the
  completion report.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/07-codex-sdk-upgrade.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
