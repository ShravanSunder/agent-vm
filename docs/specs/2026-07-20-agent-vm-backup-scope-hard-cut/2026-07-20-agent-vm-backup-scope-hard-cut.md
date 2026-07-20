# Agent VM Backup Scope Hard Cut And Beta Completion Contract

Status: Accepted for implementation

## Purpose

This contract removes an unapproved backup, restore, and migration project from the OpenClaw and Hermes Tool Portal beta branch while preserving the valid per-agent workspace Git design and established whole-zone Age backup behavior. It also states the remaining work required before the branch is ready for a focused pull request.

The result is one focused branch that:

- preserves the common Tool Portal service, OpenClaw adapter, Hermes adapter, Tool VM sandbox, Capability API, per-agent workspaces, controller HTTPS Git push, replacement, and shared OTel;
- restores the established live whole-zone backup model without stopping Gateways or retiring Tool VMs;
- removes unfinished restore publication, archive conversion, and legacy Git migration work;
- fixes the remaining Hermes persistence defect;
- completes missing OpenClaw and Hermes acceptance proof;
- contains no backup/recovery feature expansion beyond the explicit minimal adaptation in this contract.

## Product Intent

The beta branch exists to make OpenClaw and Hermes use one common managed Tool Portal system end to end. It is not a vehicle for redesigning backup consistency, archive formats, restore transactions, crash recovery, or legacy migration.

Normal zone backup remains a simple operator facility:

```text
stateDir + zoneFilesDir
          |
          v
one whole-zone tar archive
          |
          v
Age encryption
          |
          v
backupDir/<zone>__<timestamp>.tar.age
```

The backup captures durable zone data. It does not capture runtime Git databases or create an exact point-in-time snapshot of every live writer.

## Decisions

### D1. Whole-zone backup membership

One backup contains:

- the complete selected zone `stateDir`;
- the complete selected zone `zoneFilesDir` for both OpenClaw and Hermes;
- the existing simple manifest containing backup identity metadata such as `zoneId`, timestamp, and creation time.

One backup excludes:

- `runtimeDir` and every `runtimeDir/zones/<zoneId>` subtree;
- actual workspace Git databases;
- `controllerStateDir`;
- `cacheDir`;
- `backupDir` and existing backup artifacts;
- observability storage and other system-global runtime data.

### D2. Gateway and Tool VM availability during backup

Backup creation does not stop, restart, pause, or replace an OpenClaw or Hermes Gateway. It does not enumerate, release, retire, close, or otherwise disturb Tool VM leases.

The accepted tradeoff is the established live-copy consistency level: files can change while `stateDir` and `zoneFilesDir` are copied. Exact point-in-time snapshots, application-aware database snapshots, and writer quiescence are separate future work and are not beta requirements.

### D3. Workspace Git placement

For one configured long-lived agent:

```text
host durable workspace
  <zoneFilesDir>/agents/<agentId>/
    .git                         regular text pointer

host runtime Git database
  <runtimeDir>/zones/<zoneId>/gitdirs/agents/<agentId>/workspace.git/

Tool VM
  /workspace                    selected durable workspace
  /gitdirs                      selected agent Git-directory root
  /workspace/.git               contains: gitdir: /gitdirs/workspace.git
```

The `.git` entry in the durable workspace is a regular text pointer, not a Git database and not a symbolic link. It remains an ordinary member of `zoneFilesDir` and may therefore appear in the whole-zone backup. The referenced Git database remains excluded because it lives under `runtimeDir`.

### D4. Git recovery authority

Age backup protects durable workspace files. It does not guarantee preservation of runtime Git objects, refs, indexes, reflogs, or local-only history.

- Remote workspace Git history is preserved by the configured remote and controller HTTPS push.
- Local-mode runtime Git history is not added to the Age archive by this beta contract.
- Ordinary backup creation does not require a clean worktree, a fully pushed branch, an exact remote HEAD match, or Git metadata in the backup manifest.
- Exact Git reconstruction during restore is deferred to a separately approved recovery design.

### D5. Restore behavior

The branch retains the established simple restore behavior:

```text
decrypt archive
  -> extract temporary archive
  -> copy state/ into stateDir
  -> copy zone-files/ into zoneFilesDir
  -> remove temporary plaintext
```

This beta contract does not add fresh staging roots, atomic live-root publication, rollback transactions, restart recovery, per-agent Git reconstruction, legacy archive conversion, or destructive migration.

## Spec Boundary And Separability Map

```text
Backup subsystem
  owns:
    whole-zone stateDir + zoneFilesDir archive
    Age encryption/decryption
    create/list/simple restore
  does not own:
    Gateway lifecycle
    Tool VM leases
    workspace Git synchronization
    runtime Git reconstruction
    controller authority records

Per-agent workspace Git subsystem
  owns:
    runtimeDir Git database
    workspace .git pointer
    Tool VM /workspace + /gitdirs projection
    controller HTTPS push
  does not own:
    Age backup archive consistency
    backup-time Gateway lifecycle

Gateway and Tool VM lifecycle
  owns:
    Gateway start/stop/restart
    Tool VM lease, SSH, health, and replacement
  exposes no backup-specific writer-stop or lease-retirement contract

Tool Portal beta
  owns:
    private UDS transport
    Sandbox API
    Capability API
    per-agent binding and SSH
    OTel signals
  has no dependency on backup, restore, or migration
```

## Preserve Inventory

The following behavior and implementation remain in scope.

### Per-agent storage and Git

- `zones[].agents[].workspaceGit` local/remote configuration.
- `<zoneFilesDir>/agents/<agentId>` durable workspace ownership.
- `<runtimeDir>/zones/<zoneId>/gitdirs/agents/<agentId>/workspace.git` Git database placement.
- `/workspace` and `/gitdirs` Tool VM mounts.
- `/workspace/.git` pointer generation with `/gitdirs/workspace.git` as the guest target.
- Workspace Git initialization when configured.
- Controller HTTPS `workspace_git_push` authorization and execution.
- Agent-branch and default-branch constraints already required by the accepted Tool Portal design.
- Single-resource `WorkspaceGitOperationLocks.runExclusive` serialization used by controller Git operations.

Primary source owners:

- `packages/agent-vm/src/gateway/managed-agent-root-storage.ts`
- `packages/agent-vm/src/controller/workspace-git/workspace-git-paths.ts`
- `packages/agent-vm/src/controller/workspace-git/workspace-git-operations.ts`, excluding backup-only readiness behavior named below
- `packages/agent-vm/src/controller/workspace-git/workspace-git-operation-locks.ts`, excluding backup-only multi-resource locking named below
- `packages/agent-vm/src/tool-vm/managed-agent-tool-vm-mounts.ts`
- `packages/agent-vm/src/controller/leases/managed-framework-tool-vm-lease-create-options.ts`
- `packages/gateway-runtime/src/backends/controller-host-action-gateway-control-adapter.ts`

### Established backup surface

- `agent-vm backup create`.
- `agent-vm backup list`.
- `agent-vm backup restore` with established simple copy semantics.
- Existing Age encryption and secret resolution.
- Existing backup filename and list behavior.
- Existing manifest identity fields.
- Existing separation between backup inputs and `runtimeDir`/`cacheDir`.

Primary source owners retained in their minimal form:

- `packages/agent-vm/src/backup/backup-archive-layout.ts`
- `packages/agent-vm/src/backup/backup-encryption.ts`
- `packages/agent-vm/src/backup/backup-manager.ts`
- `packages/agent-vm/src/backup/backup-create-operation.ts`
- `packages/agent-vm/src/backup/backup-restore-operation.ts`
- `packages/agent-vm/src/cli/backup-commands.ts`

### Tool Portal beta implementation

- Common Tool Portal production service and private UDS transport.
- Separate Sandbox and Capability APIs.
- Unrestricted selected-agent Tool VM SSH-backed sandbox operations.
- OpenClaw and Hermes thin adapters.
- Two configured identities/profiles per framework.
- Tool VM lease health, replacement, and per-agent isolation.
- Shared-sink logs, traces, and metrics.

## Hard-Cut Inventory

Hard cut means the resulting focused branch contains neither the behavior nor dead contracts/tests/documentation that describe the behavior.

### HC1. Backup-aware Gateway lifecycle

Remove:

- `ManagedGatewayZoneRuntime.runWithManagedWritersStopped`;
- its `zone-runtime-types.ts` contract;
- its stop-operation-restart implementation in `managed-gateway-zone-runtime.ts`;
- tests whose only purpose is backup-time writer stopping or restart;
- backup consumers of this lifecycle method.

No replacement backup lifecycle abstraction is introduced.

### HC2. Backup-specific Tool VM lease fencing

Remove:

- `runWithExactZoneToolVmLeasesRetiredForBackup`;
- `BackupToolVmLeaseInventoryEntry`;
- `RunWithExactZoneToolVmLeasesRetiredForBackupOptions`;
- `ExactZoneToolVmLeaseBackupFenceDependencies`;
- controller wiring that lists and force-releases exact-zone Tool VM leases before backup;
- backup lease-fencing unit tests and fixtures.

Normal Tool VM health, retirement, close, successor admission, and replacement remain untouched.

### HC3. Managed backup orchestration and controller API expansion

Delete the backup-only controller modules:

- `packages/agent-vm/src/controller/backup/managed-zone-backup-coordinator.ts`
- `packages/agent-vm/src/controller/backup/managed-zone-backup-coordinator.unit.test.ts`
- `packages/agent-vm/src/controller/backup/offline-managed-zone-backup.ts`
- `packages/agent-vm/src/controller/backup/offline-managed-zone-backup.unit.test.ts`

Remove:

- `ControllerRuntime.createZoneBackup`;
- controller HTTP operation `POST /zones/:zoneId/backups`;
- `ControllerClient.createZoneBackup`;
- controller route support types, fake operations, and tests used only by this route;
- CLI dependency injection for `createOfflineManagedZoneBackup`;
- offline controller-ownership acquisition, recorded-VM reconciliation, and active-controller fallback introduced only for backup creation.

The CLI returns to direct established backup-manager invocation. It does not become a controller lifecycle operation.

### HC4. Backup generation fencing and Git-aware archive manifest

Delete:

- `packages/agent-vm/src/backup/backup-generation-contract.ts`
- `packages/agent-vm/src/backup/backup-generation-contract.unit.test.ts`

Remove:

- `BackupGenerationFence` and generation checkpoints;
- `backupGenerationId` requirements introduced by this feature;
- per-agent manifest entries;
- workspace Git mode, repository identity, branch, and exact OID from the backup manifest;
- exact configured-agent archive cohort validation;
- post-publication generation-fence rollback behavior introduced only for this redesign.

### HC5. Backup-time workspace Git readiness

Remove from `workspace-git-operations.ts`:

- `WorkspaceGitRemoteReadiness`;
- `inspectWorkspaceGitRemoteReadiness`;
- backup-only clean worktree checks;
- backup-only local/remote exact HEAD comparison.

Remove from `workspace-git-operation-locks.ts`:

- `runExclusiveMany` when it has no non-backup consumer;
- its backup-only tests.

Restore `normalizeWorkspaceGitRepositoryIdentity` to package-internal visibility if no retained external consumer requires it. Keep the function itself because system configuration validation uses it.

Controller push logic, push-result classification, expected-head compare-and-swap, remote authentication, and default-branch refusal remain.

### HC6. Archive-contract and restore-boundary redesign

Delete files added only for the unapproved archive/restore redesign:

- `packages/agent-vm/src/backup/backup-archive-contract.ts`
- `packages/agent-vm/src/backup/backup-archive-contract.unit.test.ts`
- `packages/agent-vm/src/backup/backup-tar-operations.ts`
- `packages/agent-vm/src/backup/backup-tar-link-policy.host.e2e.test.ts`
- `packages/agent-vm/src/backup/backup-restore-boundary.host.e2e.test.ts`
- `packages/agent-vm/src/backup/managed-agent-root-backup.host.e2e.test.ts`

Restore the established create/restore implementation and tests rather than retaining a second archive format or an unused generalized archive inventory subsystem.

This hard cut accepts the established restore trust and consistency behavior for this beta branch. A future archive-hardening goal may reintroduce bounded safety improvements without coupling them to Gateway lifecycle or Git reconstruction.

### HC7. Authoritative restore staging and Git reconstruction

Delete:

- `packages/agent-vm/src/backup/backup-restore-git-staging.ts`
- `packages/agent-vm/src/backup/backup-restore-staging-contract.ts`
- `packages/agent-vm/src/backup/backup-restore-staging.ts`
- `packages/agent-vm/src/backup/backup-restore-staging.unit.test.ts`
- `packages/agent-vm/src/backup/backup-restore-staging.host.e2e.test.ts`
- `packages/agent-vm/src/backup/backup-restore-validation.ts`

Remove all imports, exports, fixtures, and documentation that imply the beta branch can stage, validate, publish, or reconstruct an authoritative per-agent restore.

No replacement staging or publication system is added.

### HC8. Legacy archive conversion

Delete:

- `packages/agent-vm/src/backup/legacy-backup-conversion.ts`
- `packages/agent-vm/src/backup/legacy-backup-conversion.unit.test.ts`
- `packages/agent-vm/src/backup/legacy-backup-conversion.host.e2e.test.ts`

Remove V1-to-V2 archive-conversion terminology and dependencies. The focused branch does not introduce a V2 agent/Git-aware archive format requiring conversion.

### HC9. Legacy whole-zone Git migration

Delete:

- `packages/agent-vm/src/backup/legacy-whole-zone-git-migration.ts`
- `packages/agent-vm/src/backup/legacy-whole-zone-git-migration.host.e2e.test.ts`

Remove code that:

- validates an old whole-zone Git repository;
- requires it to be clean and fully pushed;
- stages new per-agent Git databases;
- moves the old Git database into a migration archive;
- publishes new per-agent `.git` pointers;
- attempts destructive migration rollback.

Existing deployments requiring this conversion need a separate migration contract and proof cycle.

### HC10. Backup-only documentation and test claims

Remove or correct documentation, manuals, plans, fixtures, and test names that claim or require:

- coherent exact-generation backups;
- Gateway shutdown for backup;
- Tool VM lease retirement for backup;
- Git clean/pushed admission for backup;
- per-agent Git identity in backup manifests;
- staged authoritative restore;
- exact Git reconstruction from an Age archive;
- V1-to-V2 conversion;
- legacy whole-zone Git migration.

Do not remove tests for valid per-agent workspace placement, Git pointer generation, Tool VM mounts, controller HTTPS push, default-branch refusal, or lease replacement.

### HC11. File-level action inventory

Delete completely because the files have no retained beta responsibility:

```text
packages/agent-vm/src/backup/backup-archive-contract.ts
packages/agent-vm/src/backup/backup-archive-contract.unit.test.ts
packages/agent-vm/src/backup/backup-generation-contract.ts
packages/agent-vm/src/backup/backup-generation-contract.unit.test.ts
packages/agent-vm/src/backup/backup-restore-boundary.host.e2e.test.ts
packages/agent-vm/src/backup/backup-restore-git-staging.ts
packages/agent-vm/src/backup/backup-restore-staging-contract.ts
packages/agent-vm/src/backup/backup-restore-staging.ts
packages/agent-vm/src/backup/backup-restore-staging.unit.test.ts
packages/agent-vm/src/backup/backup-restore-staging.host.e2e.test.ts
packages/agent-vm/src/backup/backup-restore-validation.ts
packages/agent-vm/src/backup/backup-tar-link-policy.host.e2e.test.ts
packages/agent-vm/src/backup/backup-tar-operations.ts
packages/agent-vm/src/backup/legacy-backup-conversion.ts
packages/agent-vm/src/backup/legacy-backup-conversion.unit.test.ts
packages/agent-vm/src/backup/legacy-backup-conversion.host.e2e.test.ts
packages/agent-vm/src/backup/legacy-whole-zone-git-migration.ts
packages/agent-vm/src/backup/legacy-whole-zone-git-migration.host.e2e.test.ts
packages/agent-vm/src/backup/managed-agent-root-backup.host.e2e.test.ts
packages/agent-vm/src/controller/backup/managed-zone-backup-coordinator.ts
packages/agent-vm/src/controller/backup/managed-zone-backup-coordinator.unit.test.ts
packages/agent-vm/src/controller/backup/offline-managed-zone-backup.ts
packages/agent-vm/src/controller/backup/offline-managed-zone-backup.unit.test.ts
```

Restore to established responsibility and apply only the minimal Hermes/generalized-zone adaptation:

```text
packages/agent-vm/src/backup/backup-manager.ts
packages/agent-vm/src/backup/backup-create-operation.ts
packages/agent-vm/src/backup/backup-restore-operation.ts
packages/agent-vm/src/cli/backup-commands.ts
```

Retain and update their established proof rather than keeping redesign-specific proof:

```text
packages/agent-vm/src/backup/backup-manager.host.e2e.test.ts
packages/agent-vm/src/backup/backup-create-operation.host.e2e.test.ts
packages/agent-vm/src/backup/backup-encryption.host.e2e.test.ts
packages/agent-vm/src/cli/backup-commands.unit.test.ts
```

Surgically remove backup-only additions while preserving unrelated Tool Portal, controller, Git, and lifecycle behavior:

```text
packages/agent-vm/src/cli/agent-vm-cli-support.ts
packages/agent-vm/src/cli/agent-vm-entrypoint.unit.test.ts
packages/agent-vm/src/cli/controller-operation-commands.unit.test.ts
packages/agent-vm/src/cli/openclaw-auth-command.unit.test.ts
packages/agent-vm/src/cli/ssh-commands.unit.test.ts
packages/agent-vm/src/config/system-config.ts
packages/agent-vm/src/controller/controller-runtime.ts
packages/agent-vm/src/controller/http/controller-client.ts
packages/agent-vm/src/controller/http/controller-client.unit.test.ts
packages/agent-vm/src/controller/http/controller-http-route-support.ts
packages/agent-vm/src/controller/http/controller-http-routes.ts
packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts
packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts
packages/agent-vm/src/controller/workspace-git/workspace-git-operation-locks.ts
packages/agent-vm/src/controller/workspace-git/workspace-git-operation-locks.unit.test.ts
packages/agent-vm/src/controller/workspace-git/workspace-git-operations.ts
packages/agent-vm/src/controller/workspace-git/workspace-git-operations.host.e2e.test.ts
packages/agent-vm/src/controller/zone-runtimes/managed-gateway-zone-runtime.ts
packages/agent-vm/src/controller/zone-runtimes/managed-gateway-zone-runtime.unit.test.ts
packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.unit.test.ts
packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts
```

Do not wholesale-revert any shared file in the surgical list. Each also contains retained work from the common controller, Hermes generalization, per-agent Git, Tool Portal, or later beta fixes.

The following established files remain as-is unless a compile-time consumer cleanup requires a mechanical import adjustment:

```text
packages/agent-vm/src/backup/backup-archive-layout.ts
packages/agent-vm/src/backup/backup-encryption.ts
packages/agent-vm/src/gateway/managed-agent-root-storage.ts
packages/agent-vm/src/controller/workspace-git/workspace-git-paths.ts
packages/agent-vm/src/tool-vm/managed-agent-tool-vm-mounts.ts
packages/agent-vm/src/controller/leases/managed-framework-tool-vm-lease-create-options.ts
packages/agent-vm/src/controller/control-session/gateway-control-controller-host-action-authorization.ts
packages/gateway-runtime/src/backends/controller-host-action-gateway-control-adapter.ts
```

## Minimal Fix Inventory

### F1. Generalize established whole-zone backup to Hermes

Both managed Gateway types have `zoneFilesDir`. `agent-vm backup create` and simple restore therefore pass `zoneFilesDir` for:

- OpenClaw;
- Hermes.

Worker backup behavior remains unchanged.

This is a type-narrowed managed-Gateway branch, not an OpenClaw-only conditional and not a new backup coordinator.

### F2. Preserve complete durable folder coverage

The backup proof must show that one archive contains representative files from:

- `stateDir`, including framework-owned nested paths;
- `zoneFilesDir/agents/<firstAgentId>`;
- `zoneFilesDir/agents/<secondAgentId>`;
- ordinary `.git` pointer files when workspace Git is configured.

The same proof must show that representative files from `runtimeDir`, actual `workspace.git` databases, `controllerStateDir`, `cacheDir`, and `backupDir` do not enter the archive.

### F3. Preserve live availability

Backup creation must not invoke Gateway stop/restart APIs or Tool VM release/close APIs. Existing Gateway and Tool VM identities remain live across a backup operation.

### F4. Restore established manifest and command behavior

Create/list/restore remain compatible with the established simple backup artifacts and operator command shape. This hard cut does not create a new archive-version migration requirement.

### F5. Hermes durable SQLite persistence

Stock Hermes currently completes Tool Portal journeys but logs repeated `state.db` disk I/O failures while saving routing, creating sessions, and appending messages. The beta cannot be called ready while successful user turns are missing from durable Hermes state.

Required behavior:

- each configured Hermes profile writes routing, session, and message state without SQLite disk I/O warnings;
- one profile cannot read or overwrite another profile's state;
- state survives a normal Hermes Gateway restart;
- the solution retains one stock Hermes process, the existing managed Gateway lifecycle, and the accepted Tool Portal service boundary;
- no Gondolin source change or Hermes upstream source modification is introduced;
- framework state remains under the zone's durable `stateDir` ownership contract, even if the runtime projection needs a narrower SQLite-compatible implementation.

The exact storage mechanism is unresolved by this hard-cut spec and must be established from current Hermes and Gondolin behavior before implementation. It must remain a narrow framework-state fix, not a backup or restore redesign.

## Beta Completion Inventory

### Already proven at `cc895c5`

- Exact beta package and image inputs.
- Static beta deployment validation.
- Common Sandbox and Capability APIs.
- OpenClaw two-agent isolation.
- Hermes two-profile Tool Portal routing and distinct Tool VM bindings.
- Sequential, parallel, and mixed calls.
- Controller HTTPS Git push from both frameworks.
- OpenClaw and Hermes Tool VM replacement with durable `/workspace` and disposable `/work` behavior.
- Shared-sink controller, Tool Portal, backend, Sandbox, and health telemetry.
- Exact-HEAD focused tests and repository quality gate.

These proofs must be rerun or revalidated where the hard cut changes the final branch HEAD, but their underlying runtime implementation is preserved.

### Remaining implementation defect

- Fix Hermes `state.db` persistence and prove durable profile-scoped messages across restart.

### Remaining external acceptance proof

Produce real Discord-delivered turns for:

- OpenClaw first identity;
- OpenClaw second identity;
- Hermes first profile;
- Hermes second profile.

Webhook or direct API proof does not substitute for Discord ingress.

Produce explicit GPT-5.6 Luna acceptance receipts at the final exact HEAD. Luna exercises both Gateways through their real configured user-facing path and checks:

- multiple Sandbox calls;
- parallel Sandbox calls;
- Capability list/search/describe/call;
- file writes and reads;
- process and stream behavior;
- per-agent negative isolation;
- controller HTTPS Git push;
- Tool VM replacement;
- absence of lease, SSH, or framework-state health regressions.

### Remaining packaging work

The final pull-request branch must be constructed from `origin/master` without the hard-cut feature cluster. The proven `beta-tool-portal-finalize-c2065` branch remains unchanged as a recovery/reference branch until the clean branch passes proof.

The focused branch must contain no excluded backup, restore, migration, publication, or legacy-conversion source after the hard cut. It must also retain every in-scope Tool Portal and storage commit required by the accepted beta behavior.

### Remaining final proof

The final exact HEAD requires evidence for:

- unit logic changed by the hard cut and Hermes persistence fix;
- controller/config/filesystem integration boundaries;
- host backup create/list/simple restore behavior;
- real VM Tool Portal and Tool VM mount behavior;
- real OpenClaw Gateway behavior;
- real Hermes Gateway behavior, including persistence across restart;
- beta OpenClaw and Hermes acceptance;
- shared OTel logs, traces, metrics, and health;
- repository formatting, linting, typechecking, taxonomy, and broad quality gate;
- pull-request scope, checks, comments, threads, and mergeability when GitHub service/API access is available.

Skipped tests or inventory-only discovery do not satisfy the corresponding live proof.

## Requirements

R1. One Age backup archives the complete selected zone `stateDir` and `zoneFilesDir` for OpenClaw and Hermes.

R2. Normal Age backup excludes `runtimeDir`, actual Git databases, `controllerStateDir`, `cacheDir`, `backupDir`, and observability data.

R3. Workspace `.git` pointer files remain valid durable worktree members; actual Git databases remain under `runtimeDir`.

R4. Backup creation does not stop or restart a Gateway and does not release, retire, close, or replace a Tool VM lease.

R5. Backup creation does not inspect or require workspace Git clean state, pushed state, remote HEAD equality, repository identity, or branch identity.

R6. The focused branch does not contain authoritative restore staging, restore publication, Git reconstruction, archive conversion, legacy Git migration, or backup-specific lifecycle coordination.

R7. Existing per-agent workspace Git initialization, pointer generation, Tool VM mounts, controller HTTPS push, and default-branch protection remain behaviorally intact.

R8. Existing Tool VM health and replacement behavior remains independent of backup.

R9. Stock Hermes persists routing, sessions, and messages for every configured profile without SQLite disk I/O errors and across normal Gateway restart.

R10. OpenClaw and Hermes both pass final exact-HEAD Discord and Luna acceptance with multiple and parallel tool operations.

R11. OpenClaw, Hermes, Tool Portal, controller, and Tool VM operations emit correlated logs, traces, and metrics into the same configured sink.

R12. The final PR branch contains only the agreed Tool Portal beta, minimal backup adaptation, and Hermes persistence fix; no excluded recovery project remains.

## Security Context

- Backup encryption keys and controller Git credentials remain controller/operator secrets and never enter Gateway or Tool VM logs, traces, archives, prompts, or PR artifacts.
- `controllerStateDir` remains host-only and is never mounted into or archived as Gateway state.
- A Tool VM sees only the selected agent's workspace and Git-directory root.
- Removing backup-time writer fences intentionally accepts live-copy consistency; it does not broaden agent access or credential authority.
- Controller HTTPS remains the only configured Git push transport in this beta goal.

## Non-Goals

- Atomic or point-in-time live backup.
- SQLite-aware backup snapshots.
- Backup-driven Gateway restart.
- Backup-driven Tool VM retirement.
- Runtime Git database backup.
- Local-only Git history disaster recovery.
- Exact Git reconstruction from Age archives.
- New archive formats or version converters.
- Authoritative restore staging, publication, rollback, or crash recovery.
- Legacy whole-zone Git migration.
- Gondolin source changes.
- OpenClaw or Hermes upstream source changes.
- A new launcher, supervisor, helper process, UID boundary, or service graph.
- SSH Git push.
- npm/PyPI publication, production deployment, or merge.
- Another spec, plan, or implementation review cycle beyond the already-authorized single remediation cycle.

## Tradeoffs

The hard cut gains a focused, reviewable beta branch; keeps Gateway and Tool VM availability during backup; and restores the established storage mental model. It gives up exact point-in-time backup consistency and automatic reconstruction of excluded runtime Git history.

Those are explicit accepted limitations. They may be revisited only under a separately approved backup/recovery goal with evidence that the established behavior is insufficient.

## Proof Expectations

The implementation plan must map every requirement to at least one proof modality. At minimum:

- archive content inspection proves inclusion and exclusion boundaries;
- lifecycle observation proves Gateway and Tool VM identities remain live during backup;
- Git path and mount proof confirms pointer/database separation;
- controller push proof confirms retained Git behavior;
- Hermes database and restart state proves durable profile-scoped persistence;
- Discord receipts prove real ingress;
- Luna receipts prove user-facing multi-tool and parallel behavior;
- OTel queries prove correlated logs, traces, metrics, and health;
- final diff/source inventory proves excluded recovery code is absent.

## Open Decision

The narrow SQLite-compatible storage mechanism for Hermes `state.db` remains to be selected from live Hermes and Gondolin evidence. The requirement and boundary are fixed; implementation must stop and reconverge if satisfying it requires Gondolin changes, Hermes upstream changes, backup redesign, or a new service boundary.
