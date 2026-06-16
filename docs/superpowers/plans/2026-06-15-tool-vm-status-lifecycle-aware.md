# Tool VM Status Lifecycle-Aware Aggregation

Planned at: fix-health-lease worktree, 2026-06-15
Repo: `/Users/shravansunder/Documents/dev/project-dev/agent-vm.fix-health-lease`
Status: proposed, pending plan review
Source spec: `tmp/research-workflows/2026-06-15-tool-vm-health-lease-spec/tool-vm-health-state-spec.md`
Spec review synthesis: `tmp/research-workflows/2026-06-15-tool-vm-health-lease-spec/spec-review-synthesis.md`

## Goal

Fix `agent-vm controller status` so stale or historical Tool VM health-event
buckets do not degrade current zone readiness unless they correspond to current
lease authority and a readiness-relevant proof scope.

The target behavior is:

- status means gateway/controller ready plus current lease work healthy;
- idle cached Tool VMs are opportunistic cache, not continuously certified
  capacity;
- health events remain diagnostic evidence;
- lease authority remains in `LeaseManager`;
- v1 does not add a new public lease-state enum.

## Non-Goals

- Do not add a plugin idle SSH monitor.
- Do not make `GET /controller-status`, `GET /zones/:zoneId/status`, or CLI
  status calls renew, touch, release, or otherwise mutate leases.
- Do not delete or hide diagnostic health-event history to make status green.
- Do not reclassify raw `health-snapshot` output in v1. It remains diagnostic.
- Do not add a new public lease-state API in v1.
- Do not make `tool-vm-ssh/command`, `tool-vm-ssh/file-bridge`, or
  `tool-vm-ssh/finalize` readiness inputs until those events carry active-use
  scope.

## Source Coverage

- `tool-vm-health-state-spec.md`: 429 lines after spec review revision.
- `spec-review-synthesis.md`: 138 lines.
- Current code evidence checked:
  - `packages/agent-vm/src/controller/controller-runtime.ts`
  - `packages/agent-vm/src/controller/controller-runtime-operations.ts`
  - `packages/agent-vm/src/controller/leases/lease-manager.ts`
  - `packages/agent-vm/src/controller/health/health-event-store.ts`
  - `packages/gateway-interface/src/health/agent-vm-health.ts`
  - `packages/agent-vm/src/controller/controller-runtime.unit.test.ts`
  - `packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`

## Current Evidence

- `controller-runtime.ts` is 1050 lines. Avoid adding more policy bulk there.
- `aggregateToolVmPlane(...)` currently maps any stale Tool VM-plane event to
  `degraded` without joining against current leases or active uses.
- Runtime diagnosis currently reads `healthEventStore.listLatestEventsForZone`
  and aggregates all `lease-heartbeat`, `lease-renew`, and `tool-vm-ssh` events.
- `HealthEventStore` retains latest buckets independently of lease lifecycle.
- `LeaseManager` exposes enough current authority for v1:
  - `listLeases()`
  - `peekLease(leaseId)`
  - `getActiveUses(leaseId)`
  - `getActiveUseCount(leaseId)`
- `tool-vm-ssh` events currently include `leaseId` and `operation`, but not
  `useId`, so use-local SSH operations cannot be safely joined to current
  active work.

## Requirements/Proof Matrix

| Requirement or claim | Owning task | Proof owner | Proof gate | Layer | Stale-proof guard | Red/green required |
| --- | --- | --- | --- | --- | --- | --- |
| V1 preserves status API shape and adds no public lease-state enum | 2 | parent | controller status route/unit assertions inspect JSON shape | unit | current diff only | yes |
| Released or missing lease Tool VM buckets do not degrade status | 1, 2 | implementation | new failing unit in Tool VM status aggregation tests | unit | event remains retained in fixture | yes |
| Current idle stale successful renew/probe evidence is neutral | 1, 2 | implementation | new fake-time unit with `nowMs > staleAfterMs` | unit | assert status and raw evidence separately | yes |
| Active-use degradation follows `LeaseManager` active-use authority | 1, 2 | implementation | unit with active use before/after `expiresAt`; 30s health staleness alone is not enough | unit | assert 30s vs 120s windows | yes |
| Use-local SSH events are diagnostic-only in V1 | 1, 2 | implementation | unit with failed `command` / `file-bridge` on current lease | unit | event retained, status not degraded | yes |
| Lease-scoped renew/probe failure still degrades current lease status | 1, 2 | implementation | unit with failed `lease-renew` and failed `tool-vm-ssh/probe` | unit | release or same-kind success clears | yes |
| `HealthEventStore` remains diagnostic evidence, not lifecycle authority | 1, 2 | implementation | existing/new store tests plus status tests that do not delete evidence | unit | inspect retained latest/history | yes |
| External timestamp trust is enforced for readiness-affecting external events | 3 | implementation | `controller-health-event-routes.unit.test.ts` proves controller receive time replaces publisher `observedAtMs` for accepted external events | unit | fake `now` controls receive time | yes |
| Status route uses lifecycle-aware diagnosis | 2 | implementation | `/zones/:zoneId/status` route or runtime test | integration/unit | current route returns revised readiness | yes |
| Targeted unit suite passes | 5 | parent | `pnpm vitest run packages/agent-vm/src/controller/health/tool-vm-status-aggregation.unit.test.ts packages/agent-vm/src/controller/controller-runtime.unit.test.ts packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/controller/http/controller-health-event-routes.unit.test.ts packages/agent-vm/src/controller/health/health-event-store.unit.test.ts packages/agent-vm/src/controller/health/gateway-service-health-monitor.unit.test.ts packages/agent-vm/src/controller/leases/lease-manager.unit.test.ts packages/agent-vm/src/cli/manual-templates.unit.test.ts` | unit | run after implementation | no, final green |
| Repo quality gate passes | 4 | parent | `pnpm check` | quality | current worktree | no, final green |
| E2E inventory remains valid | 4 | parent | `pnpm test:e2e:inventory` | inventory | inventory only; no live proof claim | no, final green |
| Live OpenClaw proof passes or blocker is explicit | 5 | parent | `mise exec -- pnpm test:e2e:openclaw`; if no status assertion is added there, report it as non-status live regression proof | e2e | no skipped live proof counted as pass | no, final green |
| Default e2e proof passes or blocker is explicit | 5 | parent | `mise exec -- pnpm test:e2e` | e2e | prerequisites and no-skip result reported | no, final green |
| Beta deployment smoke proves user-visible status behavior | 5 | parent | `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`, beta build/start with process preflight, CLI status, direct `/zones/:zoneId/status`, and health-snapshot comparison | beta smoke | verify installed package source/version and current beta controller process | no, final green |

## Task Sequence

### Task 1: Extract a lifecycle-aware Tool VM status aggregation policy

Write surfaces:

- New file:
  `packages/agent-vm/src/controller/health/tool-vm-status-aggregation.ts`
- New test:
  `packages/agent-vm/src/controller/health/tool-vm-status-aggregation.unit.test.ts`

Implementation shape:

- Define a small input model that does not expose `LeaseManager` itself:
  - current leases for a zone;
  - active uses for those leases;
  - latest health events for the zone;
  - `nowMs`;
  - `staleAfterMs`.
- Export a pure classifier that returns `GatewayToolVmPlane`.
- Treat missing/released lease events as ignored for readiness.
- Treat idle-expired leases still present in memory as not current by filtering
  raw leases with `lastUsedAt`, `effectiveIdleTtlMs`, and active-use count
  before classifying events.
- Treat stale successful idle `lease-renew` and `tool-vm-ssh/probe` as neutral.
- Treat current `lease-renew` failure and current `tool-vm-ssh/probe` failure as
  degraded/failed only because they are observed during a concrete cached-reuse
  attempt. They represent current reuse health, not background idle capacity.
- Treat current `lease-heartbeat` failure for exact active `leaseId/useId` as
  degraded/failed.
- Treat active uses past `expiresAt` as degraded even if latest health events
  are merely stale or absent.
- Treat use-local `tool-vm-ssh/command`, `file-bridge`, and `finalize` as
  diagnostic-only in v1.

Red tests first:

- stale released lease bucket currently degrades, expected not degraded;
- idle-expired lease still present in `listLeases()` has stale/failed buckets,
  expected ignored because the lease is not current for status;
- stale successful idle renew/probe currently degrades, expected neutral;
- failed command bucket on current lease currently degrades, expected neutral;
- failed probe on current non-expired lease still degrades as current reuse
  evidence;
- same-lease renew success clears prior renew failure;
- same-lease probe success or lease release clears prior probe failure;
- active use expired by `expiresAt` degrades;
- active use end/reap clears prior heartbeat impact;
- active use not expired but heartbeat event older than `staleAfterMs` does not
  degrade solely from the global health freshness clock.

### Task 2: Wire the classifier into controller runtime status

Write surfaces:

- `packages/agent-vm/src/controller/controller-runtime.ts`
- Existing or new runtime tests:
  `packages/agent-vm/src/controller/controller-runtime.unit.test.ts`

Implementation shape:

- Keep `HealthEventStore` unchanged.
- In `getRuntimeDiagnosisByZone`, build a zone-local lease authority snapshot:
  - leases from `leaseManager.listLeases()`;
  - active uses from `leaseManager.getActiveUses(lease.id)`.
- Build a current-lease projection before classification:
  - raw leases with zero active uses and expired idle TTL are not current for
    status even if the reaper has not run yet;
  - leases with active uses remain current until active-use authority says
    otherwise.
- Replace the current direct `aggregateToolVmPlane(latestToolVmPlaneEvents, ...)`
  call with the new lifecycle-aware classifier.
- Narrow the current zero-event short-circuit. The classifier must run when a
  zone has current lease/use authority even if there are zero Tool VM health
  events, so expired active-use authority can degrade status without depending
  on retained event buckets.
- Keep channel-provider and gateway-runtime health aggregation behavior
  unchanged.
- Keep `selectedZoneReadiness` folding unchanged except for the revised
  Tool VM plane input.

Red tests first:

- Update the existing immediate `tool-vm-ssh failed command => degraded` test to
  reflect V1 diagnostic-only command behavior or split it so failed `probe`
  remains the readiness-affecting case.
- Add `/zones/:zoneId/status` or runtime diagnosis tests for released/stale idle
  buckets, idle-expired leases still in memory, and expired active uses with
  zero Tool VM health events.

### Task 3: Enforce controller receive time for external health events

Write surfaces:

- `packages/agent-vm/src/controller/http/controller-health-event-routes.ts`
- `packages/agent-vm/src/controller/http/controller-health-event-routes.unit.test.ts`

Implementation shape:

- For accepted events posted to `/zones/:zoneId/health-events`, record the event
  with `observedAtMs: options.now()` instead of trusting the publisher-supplied
  `observedAtMs`.
- Keep event schema unchanged in V1. Do not add publisher timestamp metadata in
  this plan.
- Keep controller-recorded `lease-renew`, `lease-heartbeat`, and
  `gateway-service-health` events unchanged; those are already generated by the
  controller code path.

Red tests first:

- future-dated external `tool-vm-ssh/probe` is stored with controller receive
  time, not posted time;
- old externally posted event is stored with controller receive time, so
  freshness reflects receipt rather than publisher clock;
- ignored wrong-owner Tool VM SSH events remain ignored and do not mutate stored
  evidence.

### Task 4: Update operator docs/manuals for status vs snapshot

Write surfaces:

- `docs/subsystems/controller.md`
- `docs/architecture/openclaw-gateway.md`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.unit.test.ts`

Required wording:

- `controller status` is the operator readiness view.
- `health-snapshot` is retained diagnostic evidence and may show stale
  historical buckets.
- Idle cached Tool VM proof can age out without degrading readiness.
- Use-local SSH failures are diagnostic-only for readiness in v1 unless future
  schema work adds active-use scope.

Keep this concise. Do not copy the full design spec into generated manuals.

### Task 5: Validation and beta deployment smoke

Run targeted validation first:

```bash
pnpm vitest run packages/agent-vm/src/controller/health/tool-vm-status-aggregation.unit.test.ts packages/agent-vm/src/controller/controller-runtime.unit.test.ts packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/controller/http/controller-health-event-routes.unit.test.ts packages/agent-vm/src/controller/health/health-event-store.unit.test.ts packages/agent-vm/src/controller/health/gateway-service-health-monitor.unit.test.ts packages/agent-vm/src/controller/leases/lease-manager.unit.test.ts packages/agent-vm/src/cli/manual-templates.unit.test.ts
```

Generated manual smoke:

```bash
pnpm build
pnpm exec agent-vm manual update --config <temp-project>/config/system.jsonc
```

Use the repo's existing temporary-project/manual test harness if available; do
not write generated manuals into a live deployment for this proof.

Then repo quality:

```bash
pnpm check
```

Then e2e proof layers:

```bash
pnpm test:e2e:inventory
mise exec -- pnpm test:e2e:openclaw
mise exec -- pnpm test:e2e
```

If no OpenClaw e2e status assertion is added, report
`test:e2e:openclaw` as live OpenClaw regression proof, not direct proof of the
status aggregation bug. The direct user-visible status proof is the beta smoke
below.

Beta deployment smoke:

```bash
pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta
```

Before starting/restarting beta:

```bash
node -p "require('./package.json').dependencies['@agent-vm/agent-vm']"
pnpm list @agent-vm/agent-vm @agent-vm/gateway-interface @agent-vm/openclaw-agent-vm-plugin
```

Inspect current controller process/port state and decide reuse vs restart. If a
beta controller is already running, do not replace it or touch active leases
without explicit operator approval.

Then, from the beta deployment, run the deployment's normal build/start flow.
`pnpm start` is foreground; run status assertions from another terminal/session
or start it under the deployment's established background harness:

```bash
mise exec -- pnpm build
pnpm start
```

After beta controller is running, assert the user-visible status path:

```bash
pnpm exec agent-vm controller status --config config/system.jsonc
node -e "const http=require('node:http'); http.get('http://127.0.0.1:18800/zones/sunfam/status', r => { let b=''; r.on('data', c => b += c); r.on('end', () => { console.log(r.statusCode); console.log(b); if (r.statusCode !== 200) process.exit(1); }); }).on('error', e => { console.error(e); process.exit(1); });"
pnpm exec agent-vm controller health-snapshot --config config/system.jsonc --zone sunfam
pnpm exec agent-vm controller health --config config/system.jsonc --zone sunfam
pnpm exec agent-vm controller service-health --config config/system.jsonc --zone sunfam
```

Expected beta smoke proof:

- live `/readyz` and `/health` probes stay green;
- direct `/zones/sunfam/status` and CLI `controller status` agree on
  `selectedZoneReadiness`/`toolVmPlane`;
- `controller status` no longer reports stale idle/released Tool VM buckets as
  readiness degradation;
- `health-snapshot` may still show retained stale diagnostic buckets, and that
  distinction is reported explicitly.

Do not release active leases in beta smoke unless the operator explicitly
accepts interrupting cached Tool VM state.

## Validation Gates By Layer

Unit:

- New pure policy unit tests for lifecycle-aware Tool VM status aggregation.
- Updated runtime/status route tests.
- Existing HealthEventStore and lease-manager tests stay green.
- Timestamp receive-time route tests stay green.
- Manual-template unit tests stay green.

Integration:

- Route-level tests for `/zones/:zoneId/status` if pure runtime tests do not
  cover the served status shape.

Smoke / e2e:

- `pnpm test:e2e:inventory` for inventory only.
- `mise exec -- pnpm test:e2e:openclaw` for live OpenClaw regression proof;
  status-specific live proof must be explicit if claimed.
- `mise exec -- pnpm test:e2e` for default e2e lanes.

Beta:

- `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`.
- Beta build/start.
- Explicit status plus health-snapshot commands against beta config.
- Direct `/zones/:zoneId/status` proof against the current beta controller
  process.

## Risks

- If status consumes use-local `tool-vm-ssh` without `useId`, historical command
  failures can still poison readiness on reused leases.
- If status uses `staleAfterMs` for active-use freshness, active work can be
  marked degraded before `LeaseManager` considers the active use expired.
- If the fix deletes health buckets instead of filtering readiness inputs, it
  weakens diagnostics and can hide real historical evidence.
- If timestamp normalization is mixed into this patch without a small boundary,
  the work can become a schema/security refactor instead of the status fix.
  This plan intentionally uses receive-time overwrite without schema changes.
- Beta smoke can disturb active cached leases if it force-releases leases. The
  smoke must avoid lease release unless the operator explicitly approves it.

## Stop / Replan Triggers

- Stop if `LeaseManager` cannot provide current active-use `expiresAt` without
  widening public interfaces beyond the controller package.
- Stop if plan review rejects diagnostic-only use-local SSH events and requires
  `useId` in health events; that is a schema change and needs a revised plan.
- Stop if receive-time normalization cannot be handled without cross-package
  schema/API changes; split richer publisher-time diagnostics into a follow-up
  plan.
- Stop if beta deployment path `../shravan-claw-beta` is missing or not safe to
  start; report the blocker and finish local proof only.

## Recommended Next Workflow

Run `shravan-dev-workflow:plan-review-swarm` before implementation. After
accepted review findings are applied, route to
`shravan-dev-workflow:implementation-execute-plan`.
