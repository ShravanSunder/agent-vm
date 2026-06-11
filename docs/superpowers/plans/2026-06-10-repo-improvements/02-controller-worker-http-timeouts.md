# Controller→Worker HTTP Timeouts

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 2 (stability — unbounded controller hangs on a stalled VM)

## Problem

The controller's HTTP calls into the in-VM worker have no explicit timeout or
`AbortSignal`:

1. `fetchJson` is used both to submit the task (`POST /tasks`, before the
   poll loop starts) and inside the 1-second poll loop (`GET /tasks/:id`). If
   the VM's HTTP server is reachable but stalled (hung Hono process, half-open
   TCP, slow-dripping response), the call blocks far beyond the intended
   cadence — undici's defaults allow minutes per attempt, and a trickling
   response body can extend indefinitely. The overall task timeout
   (`computeTotalTaskTimeoutMs`) only fires between loop iterations, so a hung
   submission blocks the task forever and a hung poll freezes the timeout
   clock.
2. `closeActiveWorkerTask` does a raw `fetch` to `POST /tasks/:id/close` with
   no signal. This is on the zone-destroy path, so a stalled VM blocks zone
   destroy (and the external `POST /zones/:zoneId/destroy` caller)
   indefinitely.

The contrast: `heartbeat-sender.ts` already does this right (5s
`AbortController` timeout), and all git `execa` calls carry explicit
timeouts. These two surfaces are the gap.

## Current Evidence

- `packages/agent-vm/src/controller/worker-task-runner.ts:690-699` —
  `fetchJson(url, init)` calls `fetch` with whatever `init` is passed; no
  caller passes a signal.
- `packages/agent-vm/src/controller/worker-task-runner.ts:852` — task
  submission `POST ${baseUrl}/tasks` via `fetchJson`, outside the poll loop's
  elapsed-time bound.
- `packages/agent-vm/src/controller/worker-task-runner.ts:874-922` — poll
  loop; elapsed time is checked only between iterations; per-request
  `fetchJson` at line 883 is unbounded.
- `packages/agent-vm/src/controller/zone-runtimes/worker-zone-runtime.ts:91-95`
  — `closeActiveWorkerTask` fetch with `{ method: 'POST' }` only.
- `packages/agent-vm/src/controller/heartbeat-sender.ts` — existing in-repo
  pattern: `HEARTBEAT_REQUEST_TIMEOUT_MS = 5_000` with AbortController.

## Non-Goals

- Do not change the 3-consecutive-poll-failures threshold or poll cadence.
- Do not add retries to task submission (non-idempotent; a timeout should
  fail the task through the existing failure path).
- Do not touch the worker-side server.

## Scope

Write surfaces:
- `packages/agent-vm/src/controller/worker-task-runner.ts`: add an
  `AbortController + setTimeout` timeout to `fetchJson` (NOT
  `AbortSignal.timeout` — `vi.useFakeTimers()` mocks `setTimeout` but not
  the native `AbortSignal.timeout`, and the test taxonomy forbids wall-clock
  waits); named constants, e.g.
  `WORKER_TASK_SUBMIT_TIMEOUT_MS = 30_000`,
  `WORKER_TASK_POLL_TIMEOUT_MS = 10_000`.
- `packages/agent-vm/src/controller/zone-runtimes/worker-zone-runtime.ts`:
  `WORKER_TASK_CLOSE_TIMEOUT_MS = 10_000` on the close fetch; a timeout maps
  to the existing `ControllerZoneWorkerCloseError` shape.
- Unit tests adjacent to both files.

Read-only context:
- `packages/agent-vm/src/controller/heartbeat-sender.ts`: precedent — note
  its abort timer at line 89 is a REAL `setTimeout` (not injectable); the
  injectable piece is `fetchImpl`. Mirror the `fetchImpl` injection for
  testing the abort path (never-resolving mock fetch + fake timers), not a
  custom abort-clock seam.
- `packages/agent-vm/src/controller/worker-task-runner.integration.test.ts`:
  fixtures verified (review 2026-06-11): the `globalThis.fetch` mock at
  lines ~233-250 resolves synchronously, so 30s/10s bounds cannot fire
  against existing fixtures. Same for
  `worker-zone-runtime.unit.test.ts:68-161` (close path).

## Task Sequence

1. Add a timeout parameter to `fetchJson` (explicit per call site, not a
   hidden global) and thread `AbortSignal` through; classify an abort as a
   poll failure (counts toward the 3-strike rule) rather than an immediate
   task failure for the poll path; submission timeout fails the task.
2. Add the close timeout in `worker-zone-runtime.ts`; wrap abort into
   `ControllerZoneWorkerCloseError` with `httpStatus: 0` and a clear
   "timed out after Nms" body so destroy-path callers see why.
3. Unit tests using `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`
   (no wall-clock sleeps — taxonomy-enforced): (a) submission fetch never
   resolves → `executeWorkerTask` rejects within the deadline and runs its
   cleanup path (`vm.close`, `postStopGateway`); (b) poll fetch hangs →
   abort counted as consecutive poll failure (AbortError is not a ZodError,
   so the strict-schema guard at `worker-task-runner.ts:887` does not
   intercept it — verified), task fails after 3; (c) close fetch hangs →
   `ControllerZoneWorkerCloseError` within deadline.
4. Re-run the worker-task-runner integration suite; adjust fixture servers
   only if they legitimately respond slower than the new bounds (do not
   widen the bounds to mask a slow fixture without understanding why).

## Proof Gates

- Red/green proof: the three unit tests above fail on current code (hang →
  vitest timeout) and pass after.
- Focused validation:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller`
- Taxonomy: run `pnpm test:taxonomy` after adding test files (focused vitest
  runs skip it).
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`

## Stop Conditions

- Stop if existing integration tests rely on long-blocking fetches by design
  (would indicate the poll contract is intentionally unbounded somewhere —
  reconverge before changing semantics).
- Stop if `pollClock` injection cannot express abort timing without real
  timers; flag rather than introducing wall-clock sleeps in unit tests.

## Risks

- Too-tight submission bound on slow VM boots: the worker server is already
  up before submission (gateway start waits for readiness), so 30s is
  generous; verify against `startGatewayZone` readiness semantics during
  execution.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/02-controller-worker-http-timeouts.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
