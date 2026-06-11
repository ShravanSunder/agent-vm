# Task Event Stream (SSE) and Library Embedding Surface

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 9 (extensibility — hooking external systems into agent-vm)

## Problem

External systems can only observe a worker task by polling
`GET /zones/:zoneId/tasks/:taskId` (full replayed snapshot) on an interval.
There is no SSE/webhook/event surface anywhere in the controller HTTP app,
even though the per-task JSONL event log already contains exactly the event
stream an integrator wants. For 45-minute work phases that is hundreds of
redundant snapshot replays, and integrators cannot react to fine-grained
events (phase transitions, reviewer turns, git push results).

Separately, embedding agent-vm in-process is half-supported:
`createControllerApp`/`createControllerService` are exported, but the actual
runtime composition (`startControllerRuntime`-equivalent in
`controller-runtime.ts`) is not part of the public package surface, so an
embedder must re-wire the runtime from internals. The internal DI hooks
(`onWorkerTaskPrepared`, `onWorkerTaskIngress`, `onWorkerTaskFinished`)
exist but are not reachable through any exported entry point.

## Current Evidence

- `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`
  — no SSE/stream/webhook route; `GET /zones/:zoneId/tasks/:taskId` (~line
  563) returns a one-shot replay via `createTaskStateReader`.
- `packages/agent-vm-worker/src/state/event-log.ts` — append-only JSONL with
  `replayEvents`; the file is host-visible at
  `stateDir/tasks/{taskId}/state/tasks/{taskId}.jsonl`
  (`task-state-reader.ts:99-100`).
- `packages/agent-vm/src/index.ts` — 18 exports; no runtime entrypoint
  export.
- `packages/agent-vm/src/controller/controller-runtime-types.ts:64-70` —
  lifecycle DI hooks exist but are internal-only.
- Hono (the controller's HTTP framework) ships a built-in SSE helper
  (`hono/streaming`), so no new dependency is needed.

## Non-Goals

- No webhooks (outbound push) in this slice — SSE covers the
  "react without polling" need without delivery/retry semantics; webhooks
  can layer on later.
- No WebSocket surface.
- No change to the event log format or writers.

## Scope

Write surfaces:
- New route in
  `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`:
  `GET /zones/:zoneId/tasks/:taskId/events` — SSE stream that (a) replays
  existing log lines from an optional `Last-Event-ID`/`?after=` cursor
  (line index), (b) tails the JSONL file for appends (fs.watch with polling
  fallback), and (c) closes after emitting a terminal event
  (`task-completed`/`task-failed`/`task-closed`) or when the sentinel
  fallback reports failure. Auth/readiness posture (review-verified
  2026-06-11): the existing snapshot route
  (`controller-zone-operation-routes.ts:561-577`) applies NO per-request
  auth and NO `rejectIfRuntimeNotReady` gate — if the SSE route mirrors it,
  that is a conscious choice; state it in the route comment. Because this
  endpoint is long-lived, it additionally MUST (d) check
  `options.runtimeReadiness?.()` on every heartbeat tick and terminate the
  stream when the state is `stopping` — `runtimeReadiness.set('stopping')`
  (`controller-runtime.ts:759/805`) has no push/abort signal today, so the
  heartbeat-tick poll is the shutdown observation mechanism (no new wiring
  needed).
- New module
  `packages/agent-vm/src/controller/task-event-stream.ts` (tail + cursor
  logic, separated from the route for unit testing; corrupt-final-line
  tolerance mirrors `replayEvents`).
- `packages/agent-vm/src/index.ts`: export `startControllerRuntime`
  (confirmed symbol — `controller-runtime.ts:328`, signature
  `(options: StartControllerRuntimeOptions, dependencies:
  ControllerRuntimeDependencies) => Promise<ControllerRuntime>`) with an
  embedding-contract doc comment. Also export BOTH parameter types:
  `StartControllerRuntimeOptions` and `ControllerRuntimeDependencies` —
  the lifecycle hooks (`onWorkerTaskPrepared`/`onWorkerTaskIngress`/
  `onWorkerTaskFinished`) live on the DEPENDENCIES parameter
  (`controller-runtime-types.ts:63-70`), not on options.
- `docs/subsystems/controller.md` + `CLAUDE.md` Controller API list: add the
  events route.

Read-only context:
- `packages/agent-vm-worker/src/state/event-log.ts` — line framing and
  corrupt-line policy to mirror.
- `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
  — auth/validation helpers the new route must reuse.
- `packages/agent-vm/src/controller/task-state-reader.ts` — path resolution
  for the log file (reuse, don't duplicate).

## Task Sequence

1. Implement `task-event-stream.ts` as a pure-ish tailer: given a file path
   and cursor, yield parsed events; unit tests cover replay-from-cursor,
   append-while-tailing, corrupt final line (wait, don't crash), terminal
   detection, and missing-file → sentinel fallback.
2. Add the SSE route using Hono's streaming helper; event id = line index;
   heartbeat comment frames on an interval so proxies don't kill idle
   streams; hard cap concurrent streams per task (small constant) to bound
   fd usage.
3. Integration test: start the controller app with a fake task log, connect
   an SSE client, append events to the file, assert ordered delivery and
   stream close on terminal event.
4. Export the runtime entrypoint + hook types from `index.ts`; add a minimal
   embedding example to `docs/subsystems/controller.md`; typecheck a
   consumer-style import in a unit test (import-from-package-entry test).
5. Update the route tables (`controller.md`, CLAUDE.md Controller API).

## Proof Gates

- Red/green proof: integration test in step 3 fails before the route
  exists, passes after.
- Focused validation:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller`
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`

## Stop Conditions

- Stop if `fs.watch` semantics on the relevant filesystems (host stateDir is
  plain local fs for the controller — confirm) are unreliable in integration
  tests; fall back to interval-stat tailing (bounded, documented) rather
  than shipping flaky watch behavior.
- Stop if exporting the runtime entrypoint would freeze an options type that
  is still churning (check recent git history on `controller-runtime-types.ts`);
  if so, export with an explicitly-documented unstable tag or defer that
  half.

## Risks

- Long-lived connections vs. controller shutdown: tie stream lifetimes to
  the runtime abort/close path so `close()` doesn't hang on open SSE
  sockets (the shutdown sequence already closes the HTTP server last —
  streams must end when readiness flips to `stopping`).
- Event log lines can be large (effectiveConfig in `task-accepted`); SSE
  frames must not assume small lines.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/09-task-event-stream-and-embedding.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
