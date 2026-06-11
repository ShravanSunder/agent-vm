# Gateway Health Monitor Hygiene

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 5 (reliability/observability — long-running controller hygiene)

## Problem

Four small defects in the health/recovery monitoring layer compound in
long-running controllers:

1. **Unbounded memory growth**: `recoveredChannelProviderEventKeys` is a
   `Set<string>` whose keys embed `observedAtMs` (every entry unique). Added
   on every successful channel-provider recovery, never pruned.
2. **Cross-zone probe starvation**: `tick()` runs all zones under one
   `Promise.all` with a single `runningTick` guard. One zone's slow recovery
   (which can hold its lifecycle mutex ~120s past a timeout) delays the next
   probe for *all* zones.
3. **Silent durable-log failures**: `#queueDurableWrite` swallows all append
   errors with an empty `.catch(() => {})`. Disk-full during an incident —
   exactly when evidence matters — silently stops the forensic log.
4. **Invisible mutex queueing**: when a lifecycle operation times out, the
   caller gets an error but the background operation keeps holding the
   serialization mutex (`withLifecycleTimeout` returns `lock` tied to the
   full operation). Subsequent operations queue silently with no log; an
   operator sees recovery "pause" for up to ~2 minutes with no explanation.

## Current Evidence

- `packages/agent-vm/src/controller/health/gateway-service-health-monitor.ts:172`
  — `const recoveredChannelProviderEventKeys = new Set<string>();` (no bound);
  `:561` — `.add(selectedDecision.eventKey)`; eventKey includes
  `observedAtMs` (`:135`).
- `gateway-service-health-monitor.ts:565-629` — `tick()` with `Promise.all`
  over `options.zoneIds` and a single `runningTick` guard (`:569-570`).
- `packages/agent-vm/src/controller/health/health-event-store.ts:93-99` —
  `.catch(() => { /* comment */ })` with no logging.
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts:514-538`
  — `withLifecycleTimeout` returns `lock: props.operation.then(...)`
  (resolves only when the full background operation ends); `:488-511` —
  `runAfterPrevious` awaits the previous `lifecycleOperation` with no
  queued-state logging.

## Non-Goals

- Do not redesign the recovery policy, budgets, or cooldown model.
- Do not abort in-flight background lifecycle operations on timeout (the
  generation-stale checkpoints already handle cancellation at safe points;
  forcing aborts mid-VM-operation is riskier than the disease).
- Do not add a metrics system; stderr warnings consistent with existing
  `writeLeaseManagerWarning`-style logging are enough.

## Scope

Write surfaces:
- `packages/agent-vm/src/controller/health/gateway-service-health-monitor.ts`:
  - bound `recoveredChannelProviderEventKeys` (insertion-order eviction at a
    fixed cap, e.g. 10k);
  - per-zone tick isolation: replace the global `runningTick` barrier with a
    per-zone in-flight guard so one zone's slow recovery does not delay other
    zones' probes (keep per-zone serialization).
- `packages/agent-vm/src/controller/health/health-event-store.ts`: replace
  the empty catch with a rate-limited stderr warning (e.g. once per minute),
  preserving the in-memory-is-serving-path behavior.
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`:
  emit a structured log line when `runAfterPrevious` actually has to wait on
  a prior background operation (queued-behind-mutex visibility), including
  zone id and how long it waited once it acquires.
- Unit tests adjacent to each file.

Read-only context:
- `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts` —
  `recoveryInFlight` guard semantics, to keep per-zone isolation consistent
  with the policy's own gating.

## Task Sequence

1. Set bound + eviction with unit test (50k simulated recoveries → size
   stays at cap).
2. Per-zone tick isolation with unit test (zone A recovery mocked slow; zone
   B receives its probe within 2× interval). Verify `stopped` shutdown still
   awaits all in-flight zone work.
3. Rate-limited durable-write warning with unit test (append throws → one
   warning, not N).
4. Mutex-queue logging with unit test (timeout fires; next operation logs a
   queued message; completes after background op resolves).
5. Run health + zone-runtime unit suites.

## Proof Gates

- Red/green proof: tests 1-4 each fail before, pass after.
- Focused validation:
  `pnpm vitest run --root . --config vitest.config.ts --project unit packages/agent-vm/src/controller/health packages/agent-vm/src/controller/zone-runtimes`
- Full validation: `pnpm check && pnpm test:unit`

## Stop Conditions

- Stop if per-zone tick isolation conflicts with shared state inside
  `tick()` (e.g. budget classification reads cross-zone aggregates) — verify
  the tick body is zone-independent before splitting the barrier; if it
  isn't, reconverge.

## Risks

- Per-zone isolation changes shutdown ordering; keep a join over all
  per-zone in-flight promises in `stop()` so the controller never exits with
  a recovery mid-flight.
- Rate-limited logging needs a monotonic clock injection for tests — follow
  the `options.now()` pattern already used in the lease manager.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/05-health-monitor-hygiene.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
