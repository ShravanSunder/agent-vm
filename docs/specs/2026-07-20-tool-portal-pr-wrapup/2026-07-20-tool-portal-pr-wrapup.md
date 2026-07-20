# Tool Portal OpenClaw And Hermes Beta PR Wrap-Up Contract

Status: Draft scope lock for maintainer review

## Purpose

This specification is the single remaining-scope contract for completing the
focused Tool Portal pull request and its beta deployment. A new implementation
agent must be able to begin from this file without reconstructing the earlier
design discussion.

The work has two repositories:

```text
agent-vm implementation
  /Users/shravansunder/Documents/dev/project-dev/agent-vm.tool-portal-beta-pr

beta deployment
  /Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta
```

The result must be a usable common Tool Portal system with real multi-agent
OpenClaw and real multi-profile Hermes behavior, not merely passing unit tests.
It must also finish the backup hard cut, storage projection corrections, beta
configuration, manual acceptance, observability proof, and PR packaging.

## Baseline And Authority

The focused implementation branch baseline at the time this specification was
written is:

```text
base        fb8605ad  origin/master
checkpoint  b8fc5a5a  feat: add common Tool Portal runtime for OpenClaw and Hermes
HEAD        476dc8ac  fix: harden tool portal beta remediation
branch      feat/tool-portal-openclaw-hermes-beta-pr
```

The beta deployment baseline is:

```text
path        /Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta
branch      main
HEAD        869e0ff
state       dirty: OpenClaw changes, Hermes zone scaffolding, local package
            overlays, schemas/manuals, package metadata, and ignored/untracked
            build artifacts are present
```

The implementation agent must re-read live `git status`, current HEADs, and the
named source files before editing. Existing dirty beta changes are not
disposable. They must be audited and preserved unless this specification
explicitly classifies them for removal.

This file supersedes the execution scope in:

- `docs/specs/2026-07-20-agent-vm-backup-scope-hard-cut/plans/2026-07-20-tool-portal-beta-pr-hardcut.md`;
- contaminated parent/child Gateway process language in the older Gateway
  runtime implementation plan;
- any backup, restore, migration, Hermes copy-back, or storage behavior that
  conflicts with this contract.

The following remain supporting design sources when they do not conflict with
this file:

- `docs/specs/2026-07-12-agent-vm-gateway-runtime/agent-vm-gateway-runtime.md`;
- `docs/specs/2026-07-17-agent-vm-storage-layout/2026-07-17-agent-vm-storage-layout.md`;
- `docs/specs/2026-07-20-agent-vm-backup-scope-hard-cut/2026-07-20-agent-vm-backup-scope-hard-cut.md`;
- `docs/architecture/storage-model.md`.

## Product Intent

OpenClaw and Hermes must use one common managed Tool Portal implementation
without moving framework-specific identity or UX into the service.

For each configured agent:

```text
framework-native request
  -> framework integration authenticates native identity
  -> stable Agent VM agentId
  -> private protected UDS request
  -> common Tool Portal service
       capabilities: list / search / describe / call
       sandbox: environment / exec / filesystem / process / stream / terminal
  -> controller-authorized per-agent Tool VM binding
  -> service-owned strict SSH connection
  -> selected Tool VM
```

The service must support both API families:

1. Capability API
   - policy-visible named capabilities;
   - MCP provider, controller host action, or Tool VM runner backends;
   - capability execution may use the selected Tool VM when its configured
     backend requires it.

2. SSH Sandbox API
   - direct full shell/filesystem/process/stream/terminal access to the selected
     Tool VM;
   - not modeled as named Tool Portal capabilities;
   - every operation remains fenced to one agent binding and Tool VM generation.

Managed Gateway mode exposes the protected UDS transport only. Standalone Tool
Portal remains independently runnable and may expose its separately configured
HTTP, MCP, stdio, bearer, and approval surfaces.

## Definition Of Success

The work is complete only when all of the following are true:

1. The focused `agent-vm` branch contains the common Tool Portal service,
   OpenClaw integration, Hermes integration, protected UDS, Sandbox API,
   Capability API, controller HTTPS Git push, lease health/replacement, and
   shared OTel behavior.
2. Hermes `stateDir` is its live `HERMES_HOME` through a direct RW RealFS mount.
   No Hermes profile or SQLite data is copied between rootfs and host storage.
3. Tool VM `/workspace` is selected through a controller-owned
   framework-specific RealFS/ShadowProvider policy.
4. OpenClaw and Hermes each run with two independently admitted agents/profiles
   in beta and cannot cross their workspace, Git, lease, SSH, process, retained
   result, or Tool Portal identity boundaries.
5. Both frameworks complete real user-visible manual acceptance, including
   Discord, native sandbox tools, Tool Portal capabilities, Git commit/push,
   lease replacement, and observability evidence.
6. The simple whole-zone backup behavior is fully validated and the removed
   backup/recovery project is absent from source, tests, docs, runtime, and beta.
7. The beta repository contains reviewed, reproducible, committed configuration
   for both zones and no committed local caches, resolved secrets, or disposable
   package payloads.
8. Required unit, integration, host e2e, real VM, OpenClaw, Hermes, beta, and
   quality gates pass against the exact final implementation HEAD.
9. The focused PR is pushed and ready for human review with checks, comments,
   threads, and mergeability reported. It is not merged.

## Spec Boundary And Separability Map

```text
Host controller
  owns:
    configured zones and stable agent identities
    controllerStateDir authority
    Tool VM lease creation/replacement
    controller HTTPS Git push
    managed VM capabilities and exact cleanup
  does not own:
    framework event loops
    framework profile/session identity
    Tool Portal capability semantics
    framework filesystem policy widening

                       control and lease contracts
                                  |
                                  v
Gateway VM ---------------------------------------------------------------
  sibling process: OpenClaw or Hermes framework
    owns native identity, channel/profile/session behavior, native tool UX
    thin integration -> protected UDS client

  sibling process: common Tool Portal service
    owns one ToolPortalService semantic core
    owns Capability and Sandbox APIs
    owns per-agent binding and strict SSH connection state
    owns bounded artifacts/approvals and Tool Portal OTel
    does not parent or supervise OpenClaw/Hermes

                                  |
                           per-agent SSH binding
                                  v
Tool VM ------------------------------------------------------------------
  /workspace   selected filtered durable RealFS agent workspace
  /work        disposable rootfs/COW execution space
  /gitdirs     conditional runtime Git database projection
  /agent-vm    only exact reviewed generated inputs, when implemented

Host storage -------------------------------------------------------------
  stateDir           live durable framework state; backup input
  zoneFilesDir       durable zone/per-agent files; backup input
  runtimeDir         Git DBs, logs, boot inputs; excluded from backup
  cacheDir           rebuildable artifacts; excluded from backup
  controllerStateDir host-only controller authority; never VM-mounted
  backupDir          encrypted backup output; excluded from backup input
  observability      independent shared sink data
```

## Locked Architecture Decisions

### A1. Common service, separate framework integrations

There is one common production Tool Portal service implementation. OpenClaw and
Hermes adapters remain thin and framework-native:

- authenticate the native agent/profile identity;
- map it to the controller-authored stable `agentId`;
- construct the private client context;
- translate framework-native tools and results;
- close client state through framework lifecycle hooks.

Business policy, backend routing, approvals, artifacts, leases, SSH, sandbox
state, and capability execution do not fork into separate OpenClaw and Hermes
implementations.

### A2. Sibling processes, no controller supervisor invention

The framework service and common Tool Portal service run as sibling processes
inside the Gateway VM through existing VM boot/process composition. The Tool
Portal service does not launch, parent, restart, or supervise OpenClaw/Hermes.
No new host controller process, Gateway-runtime parent process, framework-child
supervisor, UID boundary, or Gondolin source change is introduced.

### A3. Per-agent connection ownership

Each configured agent has an independent Tool VM binding and independent SSH
connection. No connection, environment, process, stream, terminal, filesystem
handle, retained result, or operation identifier crosses agent or generation
boundaries.

The common service establishes and maintains the SSH connection from
controller-published material. Framework integrations never receive raw host
paths, lease authority, SSH keys, or alternate-agent connection material.

### A4. Capability API and Sandbox API remain distinct

Capability discovery/call is policy-visible and backend-neutral. Sandbox API is
the direct Tool VM execution surface. A shell command is not fabricated as a
named `sandbox.run_tests` capability. OpenClaw and Hermes native terminal/file/
process tools translate into Sandbox API operations and can perform everything
the authorized SSH user can do inside the selected Tool VM.

### A5. Controller HTTPS is the only Git push transport

The focused PR does not add Gondolin write-enabled SSH Git egress. Agents may
branch, edit, commit, merge permitted branches, and fetch inside their selected
workspace. Remote push is the configured controller HTTPS host action.

The agent-visible surface exposes `workspace_git_push` only through the Tool
Portal controller host action. The controller enforces the existing agent
branch/default-branch rules and uses host-held credentials. No credential enters
the Gateway or Tool VM.

### A6. Shared observability sink

Controller, framework, common Tool Portal service, and relevant Tool VM/lease
operations emit logs, traces, and metrics into the same configured collector
and Victoria sink. Correlation carries zone, framework, agent, Gateway epoch,
Tool VM generation, operation, and trace identity without secrets or raw
credentials.

### A7. Security context remains unchanged

- Framework-native identity is authenticated by the OpenClaw or Hermes
  integration before it becomes a stable Agent VM `agentId`.
- Model-visible, public API, request, provider, profile, and path fields never
  select authority.
- The protected UDS is a private shared-Gateway trust domain, not a separate OS
  identity boundary. Attachment handshakes still fence Gateway epoch,
  projection cohort, client kind, and duplicate or replayed connections.
- The Tool Portal service retains custody of SSH material, provider sessions,
  leases, handles, approvals, artifacts, and retained results. Frameworks and
  agents receive operations and bounded results, not private authority.
- Approval reservations are consumed before dispatching a controller host
  action. No refactor in this PR may move that decision after dispatch.

## Storage Contract

### S1. Storage responsibility table

| Storage | Owner | Guest projection | Durable | Normal backup |
| --- | --- | --- | --- | --- |
| `stateDir` | framework/zone | OpenClaw state, Hermes `HERMES_HOME`, Worker `/state` | yes | yes |
| `zoneFilesDir` | zone and agents | OpenClaw `/zone`; selected Tool VM `/workspace` | yes | yes for OpenClaw/Hermes |
| `runtimeDir` | controller/runtime | logs, boot inputs, conditional `/gitdirs` | runtime-specific | no |
| `cacheDir` | build/runtime tooling | framework cache only | rebuildable | no |
| `controllerStateDir` | host controller | never mounted | yes | no |
| `backupDir` | backup CLI | no dedicated mount | yes | never an input |
| observability `dataDir` | OTel/Victoria stack | network sink, not VFS | retention-based | no |
| rootfs `/work` | individual VM | direct rootfs/COW | VM lifetime | no |

### S2. Hermes state is direct RealFS

Required projection:

```text
host <stateDir>
  -- RW RealFS --> /home/hermes/.hermes
                    HERMES_HOME
```

Remove all of the following:

- `/run/agent-vm/hermes-durable-home` as a second persistence root;
- `AGENT_VM_HERMES_DURABLE_HOME`;
- boot-time tree restoration into rootfs;
- shutdown tree copy-back;
- SQLite snapshot/copy helpers;
- copy-back completion receipt;
- controller Hermes graceful-stop persistence stage;
- tests and docs that exist only for those mechanisms.

Hermes profile directory preparation remains host-side direct preparation under
`stateDir`. If direct RealFS produces a reproducible SQLite disk-I/O failure,
implementation stops and reports the exact operation, path, mount, logs, and
minimal reproduction. A new persistence mechanism is not authorized.

### S3. Tool VM workspace selection uses RealFS plus framework policy

The controller selects exactly:

```text
<zoneFilesDir>/agents/<agentId>
```

The managed-VM boundary opens and pins the directory capability. The Gondolin
adapter constructs the filtered provider from that exact RealFS root. Plugins
cannot supply a host path or widen the policy.

The existing provider machinery remains:

- positive-path projection;
- `ShadowProvider` deny paths;
- `ShadowProvider` tmpfs paths;
- nested read-only inputs;
- symlink-bypass protection;
- owned-directory identity revalidation and one-shot capability transfer.

The current universal `whole-root-writable` production selector is invalid.

OpenClaw template:

- selected agent workspace is the base visible root;
- configured `.git` pointer is readable but not writable through ordinary
  workspace mutation when `workspaceGit` is enabled;
- host secrets, framework private state, controller records, sibling agents,
  caches, and runtime Git databases are absent;
- explicit reviewed generated inputs are read-only.

Hermes template:

- positively selects only the canonical
  `<zoneFilesDir>/agents/<agentId>` source root. Version 1 does not add a second
  child-path configuration schema: arbitrary agent-authored project paths
  inside that already isolated root remain visible;
- native Hermes memories, skills, soul/profile files, credentials, sessions,
  configuration, logs, caches, databases, and complete `HERMES_HOME` are absent;
- the selected source capability comes from the configured Agent VM workspace
  projection, never from copying or inspecting the Hermes Gateway home;
- configured `.git` pointer is read-only when `workspaceGit` is enabled.

Policy proof must validate actual positive and negative paths. A policy object
with empty placeholder lists is not proof.

The positive Hermes boundary is the selected source capability, not a guessed
list of filenames inside a Git worktree. Native Hermes categories are excluded
by never sourcing them from `HERMES_HOME`; do not shadow a broad Hermes home and
do not add a new workspace-policy config surface in this PR.

### S4. `/work`, `/workspace`, `/gitdirs`, and `/agent-vm`

`/work` is rootfs/COW and is always disposable. It is the default hot execution
space for managed Tool VMs.

`/workspace` is the selected durable agent workspace in managed Tool VMs.
Worker keeps current repositories under `/work/repos` and additionally creates
an empty reserved rootfs/COW `/workspace`; Worker does not mount or advertise it
as durable storage.

`/gitdirs` is present only when the selected agent declares `workspaceGit`.
When absent, no host Git root is materialized, opened, or mounted. When present:

```text
/workspace/.git                 text pointer
/gitdirs/workspace.git          selected runtime Git database
```

Agents are not instructed to work in `/gitdirs`; normal Git commands operate
from `/workspace`.

The current optional `/agent-vm/managed-skills` helper with no production
caller is removed. An `/agent-vm` Tool VM surface exists only if the final
implementation names an exact controller-generated file inventory, host source,
lifetime, and read-only mount. Do not retain a test-only pseudo-surface. This
requirement explicitly supersedes older generic statements that every managed
Tool VM must mount `/agent-vm`; no mount is safer than an unowned placeholder.

### S5. Dead storage surfaces are removed

Remove the uncalled self-revision storage subsystem:

- `managed-agent-self-coherence.ts`;
- `managed-agent-self-revision-manifest-file.ts`;
- their exports, tests, and `.agent-vm-self-revision.json` spec promises.

Do not replace it with another coherence protocol in this PR.

## Backup Hard-Cut Contract

### B1. Required simple behavior

Backup create remains a direct CLI/backup-manager operation:

```text
stateDir + managed zoneFilesDir
  -> fixed-layout tar
  -> Age encryption
  -> backupDir/<zone>__<timestamp>.tar.age
```

OpenClaw and Hermes include `stateDir` and `zoneFilesDir`. Worker retains its
established `stateDir` behavior. Archive membership excludes:

- `runtimeDir`, including all actual Git databases;
- `cacheDir`;
- `controllerStateDir`;
- `backupDir` and existing backup artifacts;
- observability storage;
- configuration/catalog roots outside the selected zone data.

The `.git` text pointer inside a durable workspace is an ordinary workspace file
and may be included. The runtime Git database is excluded.

Restore remains the established simple additive operation:

```text
decrypt -> temporary extract -> copy state -> copy zone files -> cleanup
```

This PR does not make restore authoritative, atomic, transactional, migratory,
or responsible for runtime Git reconstruction.

### B2. Backup never controls live runtimes

Backup does not:

- stop, pause, restart, or replace a Gateway;
- stop OpenClaw or Hermes;
- enumerate, retire, release, close, or fence Tool VM leases;
- wait for writers to quiesce;
- require a clean worktree or fully pushed branch;
- require exact Git OIDs in the manifest;
- coordinate controller ownership or runtime generations.

The accepted consistency model is a live file copy. Application-consistent
snapshots are future work requiring a separate approved design.

### B3. Forbidden backup/recovery mechanisms

The final branch must have no production, contract, test-only, documentation,
or beta references that keep the removed project alive:

- managed backup coordinator;
- offline managed backup orchestration;
- backup-specific controller HTTP route/client operation;
- backup generation fencing;
- backup-time multi-workspace Git readiness or locking;
- Tool VM lease fencing for backup;
- Gateway writer-stop lifecycle method;
- restore staging/publication transaction;
- restore operation authority records;
- rollback/restart restore recovery;
- archive generation conversion;
- legacy whole-zone Git migration;
- Git reconstruction during restore.

The untracked restore-publication files in the separate
`agent-vm.mcp-portal-better-interface` checkout are explicitly excluded and must
not be imported.

### B4. Remaining backup corrections

The implementation must close these bounded gaps:

1. Extend existing loaded-config path isolation so `cacheDir` and explicit
   `backupDir` cannot overlap `stateDir` or `zoneFilesDir` in ways that put
   excluded data into the archive. Preserve the supported default
   `<stateDir>/backups` layout through the existing nested-backup exclusion;
   reject unsafe same-path, ancestor, and other descendant layouts instead of
   inventing generalized archive filtering.
2. Remove the generated-manual sentence claiming remote workspace backup
   requires a clean, fully pushed repository.
3. Correct canonical docs that describe `zoneFilesDir` as OpenClaw-only.
4. Correct or explicitly mark superseded every tracked historical artifact
   that still presents removed behavior as current work, including:
   - `docs/superpowers/plans/2026-05-06-openclaw-zone-git-controller-push.md`
     clean/pushed backup admission;
   - `docs/superpowers/plans/2026-06-10-repo-improvements/12-backup-pipeline-hardening.md`
     live-zone guards and staged-swap restore;
   - the storage-layout spec statement that restore publication is an existing
     retained system.
5. Add explicit Hermes create/restore/archive-membership proof, rather than
   relying on an OpenClaw-shaped fixture and a shared conditional.

Do not respond to these gaps with generalized archive filtering, a coordinator,
or a new restore design.

## Original Tool Portal Goal: Required Final State

The implementation agent must re-anchor each row against current source and
tests. `Present` means preserve and prove; it does not mean the row may be
skipped.

| Surface | Required final state | Current checkpoint disposition |
| --- | --- | --- |
| Portable TS/Python contracts | strict parity for Capability and Sandbox operations | present; re-prove |
| `ToolPortalService` | one common semantic core and immutable configured catalog | present; re-prove |
| Protected UDS | private managed transport with authenticated attachment and bounded framing | present; re-prove |
| Sandbox environment/exec/fs/process/stream/terminal | full authorized Tool VM behavior over service-owned SSH | present; real Hermes/OpenClaw proof incomplete |
| Capability list/search/describe/call | common routing with complete agent context | present; real dual-framework proof incomplete |
| MCP provider backend | configured provider discovery/call and live validation | present; beta proof required |
| Controller host actions | typed registered operations, including HTTPS workspace push | present; beta proof required |
| Approvals and artifacts | shared authority, bounded storage/readback, correct agent/epoch fencing | present; re-prove affected lanes |
| OpenClaw integration | native agent identity, native tool translation, private client lifecycle | present; multi-agent beta proof required |
| Hermes integration | native profile identity, stock BaseEnvironment tools, private client lifecycle | present; persistence correction and multi-profile beta proof required |
| Lease and SSH health | positive readiness, heartbeat/renew, stale binding replacement | present; real dual-framework proof required |
| OTel | framework and Tool Portal logs/traces/metrics to one sink | configured; correlated beta proof required |
| Standalone Tool Portal | independent configured external transports/auth | present; regression proof required |
| CLI | thin Tool Portal CLI and bounded artifact access | present; packed exact-HEAD host proof required |

No row authorizes a new process topology or a second implementation per
framework.

## Implementation Closure Inventory

### C1. Required removals

- Hermes durable-home copy-in/copy-back and controller receipt stage.
- Universal permissive workspace policy result.
- Unconditional managed-agent Git root and `/gitdirs` projection.
- Dead managed-skills option and test-only mount surface.
- Dead self-revision manifest/coherence subsystem.
- Stale clean-and-pushed backup manual language.
- Wrong OpenClaw-only `zoneFilesDir` documentation.
- Any remaining tracked forbidden backup/recovery surface from B3.

### C2. Required corrections

- Direct Hermes `stateDir -> /home/hermes/.hermes` RW RealFS.
- Exact OpenClaw and Hermes RealFS/ShadowProvider policy templates.
- Conditional workspace Git root, pointer, capability, and mount behavior.
- Worker rootfs/COW `/workspace` creation without a mount.
- Backup/cache/durable-root path-disjointness validation.
- Hermes backup create and restore coverage.
- Maintainer docs, generated manual templates, schemas, and tests aligned with
  the final behavior.
- Packed Gateway Runtime host proof uses an ephemeral listener port rather than
  fixed `127.0.0.1:18790`; another local process owning that port must not make
  the host e2e lane fail.

### C3. Required functional completion/proof

- OpenClaw two-agent native routing and isolation.
- Hermes two-profile native routing and isolation.
- Complete native Sandbox tool translation for both frameworks.
- Capability API discovery and calls for both frameworks.
- Controller HTTPS workspace Git push for all four configured identities.
- Default-branch refusal and agent-branch success remain distinguishable.
- Tool VM replacement preserves `/workspace`, rotates `/work`, changes exact
  Tool VM/SSH identity, and leaves leases healthy.
- Parallel Tool Portal/Sandbox operations remain same-agent isolated.
- Shared OTel evidence exists for framework plus Tool Portal operations.
- Standalone Tool Portal and Worker behavior remain non-regressed.

## Automated Proof Contract

### P1. Unit proof

Required unit evidence includes:

- strict portable contract and TS/Python parity;
- OpenClaw/Hermes policy selector outputs;
- positive/negative ShadowProvider path behavior;
- read-only `.git` input behavior;
- conditional `/gitdirs` materialization and mounting;
- Worker `/workspace` bootstrap contract;
- Hermes direct state mount contract and absence of copy variables/helpers;
- Tool Portal context identity and backend routing;
- Sandbox operation and process/stream/terminal state machines;
- lease health/replacement state;
- backup membership and config disjointness;
- observability configuration and Tool Portal telemetry.

The complete repository unit gate must pass with no skipped/todo tests:

```text
pnpm test:unit
```

### P2. Integration proof

Required integration evidence includes:

- real UDS server/client framing and multi-client isolation;
- common managed Tool Portal composition with real backend ports;
- strict Tool VM SSH client behavior;
- controller control/lease RPC and active-use tracking;
- Gateway runtime production service composition;
- OpenClaw plugin/native tool integration;
- Hermes Python adapter/profile/environment behavior;
- workspace Git controller HTTPS operations;
- simple backup CLI and controller non-involvement;
- standalone Tool Portal transports and auth.

Required gates:

```text
pnpm test:integration
uv run pytest python
```

Python formatting and typing are required:

```text
pnpm python:fmt:check
pnpm python:typecheck
```

### P3. Host e2e proof

Host e2e must prove external program and packaging boundaries:

- real Age create/list/simple restore archive membership;
- OpenClaw and Hermes zoneFiles inclusion;
- runtime Git/controller/cache/backup/observability exclusion;
- packed Tool Portal CLI and artifact readback;
- packed Gateway Runtime executable boot on an ephemeral listener port;
- Python wheel contents and Hermes entrypoint;
- workspace Git commit/push/refusal result classification;
- generated manuals and built CLI behavior.

Required gate:

```text
pnpm test:e2e:host
```

### P4. Real VM and framework proof

Real VM proof must be serial where image/cache/process resources conflict.
Inventory-only or skipped tests do not count.

Required gates against one exact built HEAD:

```text
pnpm build
mise exec -- pnpm test:e2e:vm
mise exec -- pnpm test:e2e:worker
mise exec -- pnpm test:e2e:openclaw
mise exec -- pnpm test:e2e:hermes
mise exec -- pnpm test:e2e:control-lease-reliability
```

Real framework proof must include:

- OpenClaw Gateway boot, protected UDS, Tool Portal, selected Tool VM, native
  shell/file/process behavior, capability call, replacement, and health;
- Hermes Gateway boot, both profiles, direct RealFS state writes, protected UDS,
  Tool Portal, selected Tool VM, stock terminal/file/code/process behavior,
  capability call, replacement, restart persistence, and health;
- no Hermes SQLite disk-I/O warning or copy-back activity;
- every Gateway destruction/cleanup stage reports complete; a non-empty
  cleanup-debt result fails the evidence lane instead of producing a green test;
- no skipped, todo, or zero-test evidence lane.

### P5. Full quality gate

Before final checkpoint and PR preparation:

```text
pnpm check
git diff --check
```

GitHub Actions availability is external. A GitHub outage does not authorize
changing CI or weakening local proof. Report unavailable PR/release proof
separately.

## Manual Beta Acceptance Contract

### M1. Beta deployment facts

The deployment must retain two zones:

```text
OpenClaw zone  beta
  auth owner   main
  agents       clawfest, beta
  port         18891

Hermes zone    hermes-beta
  profiles     clawfest, beta
  port         18892
```

OpenClaw `main` is the internal shared LLM-auth owner, not a Discord-facing
acceptance agent. Its existing auth store remains in place. The two native
OpenClaw agent identities exercised below are `clawfest` and `beta`.

Both use the same Tool VM image profile and distinct per-agent workspace Git
branches. They use the same two bot accounts, one per user-facing identity, and
therefore run one framework zone at a time so the same Discord credential is
never polled by both frameworks concurrently.

The two zones keep separate complete Tool Portal agent-assignment files because
OpenClaw also admits the internal `main` auth owner. Their capability policy is
otherwise identical. Hermes keeps each Discord token only in the corresponding
profile-local `.env` under direct `stateDir` RealFS with mode `0600`; beta
preparation resolves those files through 1Password without adding controller
materialization, copying, or synchronization behavior.

The preferred beta model is OpenRouter `openai/gpt-5.6-luna` with medium
thinking. Allowed configured fallbacks are
`moonshotai/kimi-k2-thinking` and `deepseek/deepseek-v4-flash`, also medium.
OpenClaw retains the Pi agent runtime. Do not replace the framework runtime or
enable unrelated Codex runtime entries merely to change the model.

### M2. Beta preparation and provenance

The final implementation HEAD must be synced into beta from the focused
worktree:

```text
pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta
```

The implementation agent must verify:

- beta package and workspace overrides point to tarballs produced from the
  exact final focused HEAD, not the old `c2065cda` sync worktree;
- `scripts/sync-local-tarballs-to-deployment.ts` resolves the Tool VM overlay
  under the deployment exactly once. The current duplicated
  `path.join(deploymentDirectory, deploymentDirectory, ...)` construction is a
  bounded sync-script defect to correct and cover before the final resync;
- OpenClaw, Hermes, and Tool VM overlays consume that same package set;
- generated schemas/manuals match the installed exact-HEAD CLI;
- ignored tarballs/wheels, package caches, `.pnpm-store`, logs, runtime state,
  and resolved secrets are not committed;
- authored beta config, Hermes image recipe, deterministic overlays/manifests,
  schema/manual outputs required by the deployment, package metadata, and
  lockfile are reviewed and committed.

Static preparation must pass before boot:

```text
mise exec -- pnpm build
pnpm validate
pnpm exec agent-vm validate --config config/system.jsonc --mcp-live
pnpm doctor
```

Use the existing saved 1Password test service-account path through the repo CLI
and Keychain. Never print or commit the service token, secret references,
Discord token, model key, GitHub token, or resolved secret values.

### M3. Multi-agent OpenClaw manual journey

Run the `beta` zone and manually exercise both `clawfest` and `beta` agents through
native OpenClaw identity routing. Each agent must independently:

1. report its authenticated Agent VM `agentId` without receiving host paths or
   another agent's identity material;
2. create, read, update, and stat its own `/workspace` marker using native
   file/shell tools;
3. create disposable `/work` data;
4. start, inspect, stream/log, wait for, and stop a bounded background process;
5. use Tool Portal list, search, describe, and one real MCP provider call;
6. create a Git commit on its configured agent branch;
7. invoke controller HTTPS `workspace_git_push` with the exact expected HEAD;
8. demonstrate default-branch refusal is distinct from transport/auth failure;
9. run multiple sequential and parallel Sandbox/Capability operations;
10. prove it cannot observe or operate on the other agent's workspace, process,
    stream, retained result, lease, or SSH identity.

At least one real Discord turn per OpenClaw agent must reach the intended native
agent binding and complete a real Tool VM/Tool Portal operation. An HTTP-only or
mock-client result does not replace Discord proof.

### M4. Multi-profile Hermes manual journey

Stop OpenClaw before starting `hermes-beta`. Run stock Hermes with profiles
`clawfest` and `beta`. Each profile must independently:

1. arrive with the authenticated native `profileName` and mapped stable
   Agent VM `agentId`;
2. use stock Hermes terminal, file, code execution, and process tools through
   the common Sandbox API and selected Tool VM;
3. create, read, update, and stat its own `/workspace` marker;
4. create disposable `/work` data and a bounded background process;
5. use Tool Portal list, search, describe, and one real MCP provider call;
6. create and controller-push a Git commit on its configured agent branch;
7. run multiple sequential and parallel Sandbox/Capability operations;
8. prove it cannot observe or operate on the other profile's workspace,
   process, stream, retained result, lease, or SSH identity.

At least one real Discord turn per Hermes profile must reach the intended
profile binding and complete a real Tool VM/Tool Portal operation. The current
profile-prefixed webhook acceptance route may remain as an additional operator
fixture, but it does not replace Discord proof.

After both profiles have written native Hermes state, perform a normal stop and
restart. Prove both profile states remain directly present in `stateDir`, are
readable after restart, and produced no copy receipt or SQLite disk-I/O warning.

### M5. Tool VM replacement journey

For one agent in each framework:

1. write a durable marker under `/workspace`;
2. write a disposable sentinel under `/work`;
3. capture current lease, Tool VM process identity, SSH generation, and health;
4. trigger the existing supported stale/unhealthy Tool VM replacement path;
5. prove the old binding is unrouted and exact old VM close begins while the
   successor boots;
6. prove the successor becomes routable only with current authority;
7. verify `/workspace` marker persists;
8. verify `/work` sentinel is absent;
9. verify Tool VM/SSH generation changes and lease/SSH health returns positive;
10. verify stale operation identifiers cannot access the successor.

Do not turn replacement proof into repository reconstruction, VM snapshot
restore, or a new lease protocol.

### M6. Backup manual journey

With the selected framework still running and without stopping its Gateway or
Tool VMs:

1. create a zone backup;
2. verify framework `stateDir`, both agents' `zoneFilesDir` workspaces, and
   `.git` pointer files are present;
3. verify runtime Git databases, controller records, cache, observability data,
   and previous backup artifacts are absent;
4. verify active Gateway and Tool VM identities did not change because of the
   backup;
5. list the backup through the established CLI;
6. exercise simple restore only in an isolated disposable destination/fixture,
   not over the live beta zone;
7. verify no coordinator, lifecycle stop, lease fence, restore publication, or
   migration record appears in logs or controller state.

Run this journey for both OpenClaw and Hermes backup configuration.

### M7. Shared OTel evidence

For each framework acceptance window, query the configured shared sink and
record:

- framework logs;
- Tool Portal service logs;
- controller/lease health logs;
- traces covering framework integration -> protected UDS -> Tool Portal ->
  capability or Sandbox backend -> Tool VM/controller;
- Tool Portal, framework, controller, lease, and operation metrics;
- correlation by zone, framework, agent, Gateway epoch, Tool VM generation,
  operation, and trace identity;
- absence of secret values and raw credentials.

At least one successful and one intentionally denied/isolation operation must
be traceable. “Collector is healthy” without correlated operation evidence is
not sufficient.

### M8. Luna test driver receipt

Use GPT-5.6 Luna at medium effort as the beta test driver. The driver may send
the manual prompts, inspect returned structured receipts, and summarize logs,
traces, and metrics. It does not decide acceptance. The implementation agent
must independently verify source state, process identities, Git heads, files,
health, and observability evidence.

Each framework receipt records:

```text
implementation HEAD
beta HEAD and dirty-state hash before/after
framework/image/package provenance
zone and agent/profile
Gateway epoch and process identity
Tool VM generation and SSH identity
workspace marker and Git branch/head
capability calls and Sandbox operations
replacement before/after identities
Discord message/turn evidence
OTel trace/log/metric query evidence
errors, retries, skips, and external blockers
```

## Beta Repository Commit Contract

The beta deployment changes are a separate reviewed checkpoint from the
`agent-vm` implementation commit.

The beta checkpoint must include, when validated and required:

- `config/system.jsonc` zone, agent, Tool Portal, OTel, egress, and image
  configuration;
- OpenClaw config with Pi runtime and approved models;
- Hermes multi-profile and Discord configuration;
- managed Tool Portal and shared MCP provider config;
- Hermes/OpenClaw/Tool VM authored image recipes and deterministic overlay
  metadata;
- generated schemas and deployment manuals from the exact installed CLI;
- package metadata, workspace overrides, and lockfile required to reproduce the
  exact local package installation;
- removal of obsolete standalone MCP Portal/OpenClaw plugin configuration when
  superseded by managed Tool Portal.

The beta checkpoint must exclude:

- `.pnpm-store`;
- ignored tarballs and disposable package archives;
- generated wheels unless the deployment intentionally tracks them and a clean
  checkout cannot regenerate them through the supported sync command;
- VM images, runtime/cache/state/controller-state/backup/observability data;
- logs and manual acceptance receipts containing user/channel IDs or secrets;
- resolved credentials or raw 1Password references in commit/PR prose.

Before committing, inspect the beta diff file by file. Preserve unrelated
maintainer changes. The final beta commit message must identify it as the
OpenClaw/Hermes Tool Portal beta configuration/proof checkpoint.

## Checkpoint Commit Contract

Commit verified work as bounded checkpoints; do not accumulate a large dirty
implementation tree.

Expected implementation checkpoints are:

1. storage/backup hard cuts and direct Hermes RealFS;
2. framework workspace policy and conditional Git projection;
3. Tool Portal/OpenClaw/Hermes remaining functional corrections;
4. automated proof and documentation closure;
5. final review remediation and PR wrap-up.

A checkpoint is committed only after its directly affected unit/integration
proof and `git diff --check` pass. Commits do not include unrelated user-owned
files. Do not amend, rebase, merge, or rewrite history without explicit user
authorization.

## Final PR Readiness Contract

Before preparing the pull request:

1. Re-read this specification and mark every requirement with exact evidence.
2. Compare the final branch with `origin/master` and classify every changed
   file as required by this contract.
3. Search source, tests, docs, manifests, and beta for every forbidden backup,
   restore, migration, Hermes copy-back, supervisor, and SSH Git-push surface.
4. Verify all generated artifacts come from the exact final source HEAD.
5. Run the full automated proof contract and manual beta acceptance.
6. Run at most one final implementation review/remediation cycle. Do not reopen
   spec or plan review.
7. Rerun all affected proof after remediation.
8. Commit and push final implementation and beta checkpoints.
9. Prepare/update the focused PR, report checks, review comments, unresolved
   threads, mergeability, exact HEAD, and any GitHub outage.
10. Do not merge.

## Explicit Non-Goals

This PR does not add or redesign:

- backup quiescing, snapshots, generations, publication, restore transactions,
  recovery, archive migration, or Git reconstruction;
- a controller-owned Gateway runtime process or framework supervisor;
- Gondolin source or semantics;
- upstream OpenClaw or Hermes;
- write-enabled Git SSH egress;
- alternate Git push transports;
- encrypted standalone Tool Portal config;
- standalone config anti-agent-write protection;
- Agent Worker storage redesign beyond reserved `/workspace` creation;
- production deployment, npm release, merge, or exhaustive theoretical fault
  permutations;
- cleanup of inherited unrelated storage issues unless they block a required
  proof gate.

## Stop And Reconverge Conditions

Stop implementation and return with evidence before changing architecture if:

- direct Hermes `stateDir` RealFS produces a reproducible SQLite failure;
- stock Hermes cannot provide authenticated profile identity for the required
  native/Discord path;
- satisfying the framework workspace policy requires a Gondolin source change;
- Tool Portal Sandbox behavior cannot be expressed through the existing strict
  SSH/backend contracts;
- beta requires replacing Pi/OpenClaw/Hermes runtimes rather than changing the
  approved model configuration;
- a required test failure lies outside this specification and would require CI,
  runner, provider, or unrelated product changes;
- continuing risks destroying user-owned beta changes or live state.

Routine implementation details, test fixture updates, existing-boundary type
changes, and direct corrections named by this specification do not require a
new design round.

## Requirements And Proof Matrix

| ID | Requirement | Required proof |
| --- | --- | --- |
| R1 | One common Tool Portal semantic service | unit identity + production composition + dual-framework runtime |
| R2 | Protected managed UDS only | protocol/integration + VM path/permission inspection |
| R3 | Capability and Sandbox APIs remain distinct | contract ceiling + framework native-tool journeys |
| R4 | Per-agent binding/SSH/process isolation | adversarial unit/integration + multi-agent beta |
| R5 | Direct Hermes RealFS state | contract test + real writes/restart + no-copy source search |
| R6 | Framework ShadowProvider/RealFS policies | policy unit + adapter attacks + real Tool VM visibility |
| R7 | `/work`, `/workspace`, conditional `/gitdirs` | unit/integration + real VM filesystem inspection |
| R8 | Controller HTTPS Git push only | host e2e + four-agent beta push/refusal journeys |
| R9 | Simple backup and full hard cut | source inventory + host e2e + running-framework manual backup |
| R10 | OpenClaw auth owner `main`; agents `clawfest` and `beta` | shared-auth-owner validation + real native/Discord multi-agent acceptance |
| R11 | Hermes `clawfest` and `beta` | real native/Discord multi-profile acceptance |
| R12 | Lease health and replacement | real before/after process, SSH, workspace, and `/work` evidence |
| R13 | Shared OTel sink | correlated logs/traces/metrics for both frameworks and Tool Portal |
| R14 | Standalone and Worker non-regression | integration + real Worker lane |
| R15 | Reproducible committed beta | clean diff audit + exact-HEAD sync/build/validate + beta commit |
| R16 | Focused PR ready, not merged | full check/e2e, one review remediation, PR state report |

## Handoff Receipt Required From The Implementing Agent

The final handoff must contain:

- final implementation and beta commit SHAs;
- exact changed-file inventory by requirement;
- removed-surface search evidence;
- automated commands with exit codes and test pass/fail/skip counts;
- OpenClaw and Hermes manual acceptance receipts for both identities;
- lease/replacement before/after identities;
- backup archive membership/exclusion evidence for both frameworks;
- OTel query evidence for logs, traces, and metrics;
- beta package/image provenance;
- PR URL, exact head, checks, comments, threads, and mergeability;
- every unrun or blocked proof with the precise external reason;
- confirmation that the PR was not merged.

The work is not complete if Hermes or OpenClaw is represented only by mocks,
one configured identity, inventory-only tests, or prose claiming beta success.
