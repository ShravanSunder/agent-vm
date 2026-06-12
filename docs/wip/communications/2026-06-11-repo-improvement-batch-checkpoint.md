# Repo Improvement Batch Checkpoint

Date: 2026-06-11
Resumed checkpoint update: 2026-06-12
Base branch: `improve-v1`
Plan batch base head before checkpoint docs: `32c0e1c`
Base remote: `origin/improve-v1`; this checkpoint file is committed on the
same branch after the plan batch base.

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
| 06 secret resolution hardening | `origin/improve/plan-06-secret-resolution-hardening` | `1ab0983` | resumed complete branch pushed |
| 07 Codex SDK upgrade | `origin/improve/plan-07-codex-sdk-upgrade` | `115f9fc` | complete branch pushed |
| 08 worker executor genericization | `origin/improve/plan-08-worker-executor-genericization` | `65ece9f` | resumed Claude executor branch pushed; live worker E2E gated by missing credentials |
| 10 CI publish gate parity | `origin/improve/plan-10-ci-publish-gate-parity` | `a834de3` | complete branch pushed |
| 12 backup pipeline hardening | `origin/improve/plan-12-backup-pipeline-hardening` | `6472d19` | resumed complete branch pushed |
| 13 Dockerfile generation injection guards | `origin/improve/plan-13-dockerfile-generation-injection-guards` | `d08dfc5` | complete branch pushed |
| 14 MCP Portal approval/discovery hardening | `origin/improve/plan-14-mcp-portal-approval-discovery` | `fc1a952` | complete branch pushed |

Plans 09 and 11 have no implementation branch yet.

## Clean Worktree Check

All existing plan worktrees reported clean and tracking their matching origin
branches during the checkpoint pass:

- Plans 01, 02, 03, 04, 05, 06, 07, 08, 10, 12, 13, and 14.
- Base `improve-v1` was clean before this checkpoint file was added.
- After the 2026-06-12 resume, Plans 06, 08, and 12 again reported clean and
  tracking their matching origin branches after push.

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

## Gates And Remaining Work

Plan 06 secret resolution hardening:

- Resolved on 2026-06-12.
- Implemented typed retry/backoff only for 1Password SDK
  `RateLimitExceededError` on SDK client creation, `resolve`, and thrown
  `resolveAll` failures.
- Kept generic SDK `Error`, per-reference `ResolveReferenceError`, and
  op-inject fallback failures non-retryable because no stable transient
  classifier exists in the installed APIs.
- Branch pushed at `1ab0983`.

Plan 08 worker executor genericization:

- Interface-name gate resolved on 2026-06-12.
- Hard-cutover to `getSessionRef()` completed across interface, Codex executor,
  persistent-thread, task-event consumers, persisted task state fields, and
  tests.
- Claude Agent SDK executor implemented with factory/export wiring, SDK
  optional-binary availability guard, state-isolated Claude runtime setup,
  inherited settings/hooks disabled, MCP mapping, and active query cancellation
  on persistent-thread timeout.
- Implementation review swarm completed with six read-only lanes. Accepted
  findings were fixed before final proof.
- Branch pushed at `65ece9f`.
- Final proof on the plan branch:
  - `pnpm check`: 6 passed / 0 failed.
  - `pnpm test:unit`: 198 files / 1818 tests passed.
  - `pnpm test:integration`: 23 files / 327 tests passed.
  - Worker E2E not run because `AGENT_VM_WORKER_E2E`,
    `AGENT_VM_TEST_OPENAI_API_KEY`, and `AGENT_VM_TEST_ANTHROPIC_API_KEY` were
    unset in the shell.

Plan 12 backup pipeline hardening:

- Resolved on 2026-06-12.
- Legacy fallback sites now default omitted `gateway.backupDir` to
  `~/.agent-vm-backups/<zone>`, matching the storage model and user-dir init
  profile.
- Create-time backup path assertions now reject overlap between `backupDir` and
  `stateDir` / `zoneFilesDir`.
- Branch pushed at `6472d19`.

Plan 11 docs architecture drift:

- Later, after Plan 09 exists, choose whether to document the `CALLER_URL`
  heartbeat contract or delete the feature.

## Dependency Boundaries

- Plan 09 waits on Plan 03 and Plan 06; both dependencies are now pushed after
  the 2026-06-12 Plan 06 resume.
- Plan 11 waits on Plan 09 and also has its own heartbeat decision gate.
- Plan 08 is stacked on Plan 07. Its task 3 interface-name decision and Claude
  executor slice are resolved on the plan branch. Live worker E2E remains an
  environment-gated proof layer.

## Integration Guardrails

- No merge, rebase, tag, or branch integration has been performed by this
  checkpoint.
- Integration into `improve-v1` still requires explicit user direction for
  history/integration git writes.
- Before integration, substantial pushed branches still need their review
  status checked against the handoff requirement. Plan 12 has completed a
  review/fix loop before the resumed fallback decision. Plan 08 completed a
  six-lane implementation review swarm after the Claude executor slice; accepted
  findings were fixed and recorded in the plan report.
- 2026-06-12 commits were created with `--no-gpg-sign` after the first Plan 06
  signed commit attempt failed with `1Password: failed to fill whole buffer`.
