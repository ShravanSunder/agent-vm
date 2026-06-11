# Repo Improvement Batch Checkpoint

Date: 2026-06-11
Base branch: `improve-v1`
Base head: `32c0e1c`
Base remote: `origin/improve-v1` pushed at `32c0e1c`

## Scope

This checkpoint records current execution state for the reviewed
2026-06-10 repo-improvement batch. It does not merge implementation branches
or resolve user-decision gates.

## Pushed Plan Branches

| Plan | Branch | Head | State |
| --- | --- | --- | --- |
| 01 tool-vm tcp slot quarantine recovery | `origin/improve/plan-01-tool-vm-tcp-slot-quarantine-recovery` | `5fb62fa` | complete branch pushed |
| 02 controller worker HTTP timeouts | `origin/improve/plan-02-controller-worker-http-timeouts` | `50e767d` | complete branch pushed |
| 03 orphaned task startup sweep | `origin/improve/plan-03-orphaned-task-startup-sweep` | `5335b28` | complete branch pushed |
| 04 gateway stale-close owner-safe recovery | `origin/improve/plan-04-gateway-stale-close-owner-safe-recovery` | `731d4b5` | complete branch pushed |
| 05 health monitor hygiene | `origin/improve/plan-05-health-monitor-hygiene` | `9df56f5` | complete branch pushed |
| 06 secret resolution hardening | `origin/improve/plan-06-secret-resolution-hardening` | `f8fe583` | stopped at research/user gate |
| 07 Codex SDK upgrade | `origin/improve/plan-07-codex-sdk-upgrade` | `115f9fc` | complete branch pushed |
| 08 worker executor genericization | `origin/improve/plan-08-worker-executor-genericization` | `00cc20c` | stopped at user gate; pre-gate branch pushed |
| 10 CI publish gate parity | `origin/improve/plan-10-ci-publish-gate-parity` | `a834de3` | complete branch pushed |
| 12 backup pipeline hardening | `origin/improve/plan-12-backup-pipeline-hardening` | `02c0218` | stopped at user gate; safe hardening branch pushed |
| 13 Dockerfile generation injection guards | `origin/improve/plan-13-dockerfile-generation-injection-guards` | `d08dfc5` | complete branch pushed |
| 14 MCP Portal approval/discovery hardening | `origin/improve/plan-14-mcp-portal-approval-discovery` | `fc1a952` | complete branch pushed |

Plans 09 and 11 have no implementation branch yet.

## Clean Worktree Check

All existing plan worktrees reported clean and tracking their matching origin
branches during the checkpoint pass:

- Plans 01, 02, 03, 04, 05, 06, 07, 08, 10, 12, 13, and 14.
- Base `improve-v1` was clean before this checkpoint file was added.

## Reports

Per-slice reports currently live on their respective plan branches until
integration:

- Plan 01: `docs/wip/communications/2026-06-11-plan-01-tool-vm-tcp-slot-quarantine-recovery-report.md`
- Plan 02: `docs/wip/communications/2026-06-11-plan-02-controller-worker-http-timeouts-report.md`
- Plan 03: `docs/wip/communications/2026-06-11-plan-03-orphaned-task-startup-sweep-report.md`
- Plan 04: `docs/wip/communications/2026-06-11-plan-04-gateway-stale-close-owner-safe-recovery-report.md`
- Plan 05: `docs/wip/communications/2026-06-11-plan-05-health-monitor-hygiene-report.md`
- Plan 06: `docs/wip/communications/2026-06-11-plan-06-secret-resolution-hardening-research-gate.md`
- Plan 07: `docs/wip/communications/2026-06-11-plan-07-codex-sdk-upgrade-report.md`
- Plan 08: `docs/wip/communications/2026-06-11-plan-08-worker-executor-genericization-report.md`
- Plan 10: `docs/wip/communications/2026-06-11-plan-10-ci-publish-gate-parity-report.md`
- Plan 12: `docs/wip/communications/2026-06-11-plan-12-backup-pipeline-hardening-report.md`
- Plan 13: `docs/wip/communications/2026-06-11-plan-13-dockerfile-generation-injection-guards-report.md`
- Plan 14: `docs/wip/communications/2026-06-11-plan-14-mcp-portal-approval-discovery-report.md`

## Open Gates

Plan 06 secret resolution hardening:

- Approve the evidence-backed narrower retry contract:
  retry only typed `RateLimitExceededError` from the 1Password SDK.
- Do not retry generic SDK `Error` values, per-reference `ResolveReferenceError`
  responses from `resolveAll`, or op-inject fallback failures unless a new
  typed classification surface is added.

Plan 08 worker executor genericization:

- Choose whether to keep `getThreadId()` as the provider-neutral session
  accessor or hard-cutover to `getSessionRef()` across interface, Codex
  executor, persistent-thread, task-event consumers, and tests.

Plan 12 backup pipeline hardening:

- Choose whether to change both legacy fallback sites to an external default,
  or keep the legacy `stateDir/backups` fallback and add a loud overlap
  assertion that forces explicit `gateway.backupDir` for unconfigured zones.

Plan 11 docs architecture drift:

- Later, after Plan 09 exists, choose whether to document the `CALLER_URL`
  heartbeat contract or delete the feature.

## Dependency Boundaries

- Plan 09 waits on Plan 03 and Plan 06; Plan 03 is pushed, Plan 06 is
  stopped at the retry-classification decision.
- Plan 11 waits on Plan 09 and also has its own heartbeat decision gate.
- Plan 08 is stacked on Plan 07 and remains stopped before the task 3
  interface-name decision.

## Integration Guardrails

- No merge, rebase, tag, or branch integration has been performed by this
  checkpoint.
- Integration into `improve-v1` still requires explicit user direction for
  history/integration git writes.
- Before integration, substantial pushed branches still need their review
  status checked against the handoff requirement. Plan 12 has completed a
  review/fix loop. Plan 08 pre-gate review was dispatched after the branch was
  pushed, but the three reviewer lanes were later closed while still reporting
  `previous_status: running`; no candidate findings were returned. Plan 08
  therefore still needs a successful review/reduction pass before integration.
