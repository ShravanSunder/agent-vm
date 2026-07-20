# Tool Portal Beta PR Hard-Cut Implementation Plan

Status: Accepted for execution

## Goal

Produce one focused pull-request branch from `origin/master` that preserves the
proven OpenClaw and Hermes Tool Portal beta, removes the unapproved backup,
restore, and migration project, fixes Hermes durable state, and passes fresh
exact-HEAD proof. The pull request is prepared but not merged.

## Source Coverage

- Backup hard-cut contract: all 638 lines read.
- Storage-layout contract: all 1,184 lines previously reviewed and accepted;
  implementation re-anchors its backup and lease-path requirements before edits.
- Code inventory: completed at `cc895c5c` against `origin/master`; whole-file
  deletion and surgical mixed-file lists are recorded in the hard-cut spec.
- Beta remainder inventory: completed from live beta logs and proof artifacts.

## Non-Goals

No new backup architecture, restore transaction, crash recovery, archive
conversion, legacy migration, Gateway supervisor, service boundary, Gondolin
source change, OpenClaw or Hermes upstream change, SSH Git push, release,
production deployment, merge, exhaustive fault matrix, CI redesign, or second
review/remediation cycle.

## Execution Slices

### S1. Focused branch and backup hard cut

Requirements: R1-R8, R12.

Behavior:

- Construct the focused implementation branch from `origin/master` while
  preserving `beta-tool-portal-finalize-c2065` unchanged.
- Remove every HC1-HC11 production, test, contract, route, and documentation
  surface.
- Restore established direct create/list/simple-restore behavior.
- Include complete `stateDir` and `zoneFilesDir` for OpenClaw and Hermes.
- Exclude runtime Git, controller state, cache, backup, and observability data.
- Do not touch Gateway or Tool VM lifecycle during backup.

Write scope: the exact delete/restore/surgical lists in HC11 plus the backup
documentation named by HC10. Shared files are edited surgically; unrelated Tool
Portal, controller-state, Git, and lease behavior is preserved.

Checkpoint proof:

- Source search finds no excluded backup coordinator, generation, staging,
  publication, conversion, or migration symbols.
- Targeted backup/config/controller tests pass.
- Host create/list/restore proof verifies archive membership and exclusion.
- Lifecycle test proves backup does not stop a Gateway or close a Tool VM.
- `git diff --check` passes.

Commit checkpoint after the slice is green.

### S2. Hermes durable framework state

Requirements: R9.

Behavior:

- Reproduce the existing profile-scoped `state.db` write failure at the current
  Hermes projection.
- Select the smallest SQLite-compatible projection that remains owned by the
  configured zone `stateDir`.
- Preserve one stock Hermes process, profile isolation, managed Gateway
  lifecycle, and the existing Tool Portal boundary.
- Prove routing, session, and message writes for both profiles and persistence
  across a clean restart without SQLite disk-I/O warnings.

Write scope: `packages/hermes-gateway/**`, agent-vm Hermes composition/tests,
and directly owned documentation only. Any required Gondolin or upstream Hermes
change stops the slice for reconvergence.

Checkpoint proof:

- A permanent test fails for the observed persistence defect before the fix.
- Targeted unit/integration proof passes after the fix.
- Real Hermes Gateway main/beta turns write queryable state.
- Clean stop/start retains both profiles' state with no disk-I/O warnings.
- `git diff --check` passes.

Commit checkpoint after the slice is green.

### S3. Exact-HEAD beta acceptance

Requirements: R7-R11.

Behavior and proof:

- Sync final local packages and image overlays into the beta deployment.
- Run static beta validation before boot.
- Serialize OpenClaw and Hermes because they share Discord credentials.
- Exercise both identities/profiles with sequential, parallel, and mixed
  Sandbox and Capability operations.
- Prove file/process/stream operations, isolation, controller HTTPS Git push,
  default-branch refusal, Tool VM replacement, and positive lease/SSH health.
- Produce four real Discord turns and one Luna acceptance receipt per framework.
- Query the shared OTel sink for correlated logs, traces, metrics, and health.

No source edit is authorized merely to repair unrelated beta environment,
GitHub, model-provider, or CI failures.

Commit only if scoped deployment fixtures or proof artifacts tracked by the
repository require a verified update.

### S4. Quality, one review cycle, and PR

Requirements: R1-R12.

- Run targeted lower-layer tests while editing, then `pnpm check` and required
  host/VM/OpenClaw/Hermes e2e lanes against the exact final HEAD.
- Run one implementation review swarm.
- Apply one bounded remediation pass for accepted findings and rerun affected
  gates. Do not start another review/remediation cycle.
- Inspect the final diff against `origin/master` for excluded recovery code and
  unrelated changes.
- Commit the verified remediation/wrap-up checkpoint.
- Push and prepare/update the PR; report checks, comments, threads,
  mergeability, and any external GitHub outage. Do not merge.

## Execution DAG

```text
gate 0: clean worktree + accepted spec + preserved reference branch
  |
  v
S1 focused branch and backup hard cut
  |
  +---------------------------+
  |                           |
  v                           v
S2 Hermes persistence     S1 proof inventory
  |                           |
  +-------------+-------------+
                |
                v
S3 exact-HEAD beta acceptance
                |
                v
S4 quality + one review/remediation + PR readiness
```

S1 integration is parent-owned because the mixed files overlap controller and
Git behavior. Read-only inventory, targeted test execution, Hermes diagnosis,
and beta operation may be delegated. The parent verifies every returned diff
and receipt.

## Requirements/Proof Matrix

| Requirement | Owner | Proof layer and modality | Evidence source | Freshness guard |
| --- | --- | --- | --- | --- |
| R1-R2 archive membership | S1 | host e2e archive inspection | parent-run test | exact final HEAD |
| R3 Git pointer/runtime split | S1 | unit + real mount inspection | parent and VM lane | exact final HEAD |
| R4 no lifecycle interruption | S1 | integration lifecycle observation | parent-run test | exact final HEAD |
| R5 no Git readiness gate | S1 | source search + host e2e | parent | final diff |
| R6 recovery project absent | S1/S4 | source and diff inventory | parent + review | final diff |
| R7 retained Git behavior | S1/S3 | unit, host e2e, beta Git journey | parent + Luna | exact beta HEAD |
| R8 lease replacement intact | S3 | real VM replacement and health | beta operator + Luna | current process IDs |
| R9 Hermes persistence | S2/S3 | red/green, DB query, restart | parent + beta operator | post-restart DB |
| R10 Discord/Luna | S3 | manual user-facing e2e | Luna receipts | exact beta HEAD |
| R11 shared OTel | S3 | logs, traces, metrics queries | OTel operator | acceptance time window |
| R12 focused PR | S4 | diff, review, PR state | parent | PR exact head SHA |

Red/green is required for the Hermes persistence behavior change. Hard-cut
deletions use retained-behavior proof rather than recreating tests for removed
features.

## Security Context

Backup encryption keys, Git credentials, Discord tokens, model credentials,
and 1Password values remain outside logs, traces, archives, prompts, commits,
and PR text. Controller HTTPS stays the only Git push path. No agent-visible
mount or capability is broadened.

## Split Or Stop Triggers

- Stop if Hermes persistence requires a forbidden upstream, Gondolin, or new
  service-boundary change.
- Stop code edits for unrelated beta, CI, GitHub, provider, or runner failures;
  record the external blocker and scoped proof.
- Do not weaken or delete retained proof to meet the deadline.
- Do not reopen backup design, restore publication, or migration work.

## Checkpoint Rhythm

Keep the worktree small and commit verified S1, S2, and S4 checkpoints
separately. Never stage unrelated files. A checkpoint commit is not proof; its
tests and evidence are recorded before committing.

phase_result: complete
evidence: this plan and the accepted hard-cut spec
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: the accepted requirements are mapped to four bounded implementation slices and exact proof gates.
