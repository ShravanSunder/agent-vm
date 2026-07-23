# Storage Model

[Overview](../README.md) > [Architecture](overview.md) > Storage Model

agent-vm separates source config, VM-local runtime files, durable state,
rebuildable cache, zone files, worker repo files, git metadata, and backup artifacts. Do not
collapse these storage classes to fix a boot or restore symptom; moving data
between them changes backup semantics and often changes performance by crossing
the Gondolin VFS boundary.

For the concrete OpenClaw and Worker gateway path matrix, see
[Storage Matrix](storage-matrix.md).

## Config-Level Path Map

`storageRootDir` is the sole authored standard operational storage path. The
generated root is scoped by the deployment's `projectNamespace` for local,
user-dir, and pod scaffolds. The controller loads that final root and derives
the remaining paths from it and validated zone IDs; it does not append the
namespace again.

```text
path                  scope                 durable?          backup?   contains
──────────────────    ──────────────────    ──────────────    ───────   ─────────────────────────────

cacheDir              global derived        yes               no        rebuildable image/plugin/tool
                                                                           cache

controllerRuntimeDir  global derived        runtime-scoped    no        controller lock, health evidence,
                                                                           observability runtime config

zoneRuntimeDir        per-zone derived      runtime-scoped    no        worker artifacts, zone logs,
                                                                           per-agent gitdirs, control material

stateDir              per-zone derived      yes               yes       gateway identity, auth profiles,
                                                                           effective config, sandboxes

controllerStateDir    global derived        yes               no        host-only controller approval,
                                                                           lifecycle, and cleanup authority

zoneFilesDir          managed Gateway       yes               yes       long-lived shared/agent files;
                      per-zone                                         OpenClaw mounts /zone

backupDir             per-zone output       artifact          no        encrypted backup archives
```

Worker zones do not have an active `zoneFilesDir`. Worker repo files live inside
the VM under `/work/repos/<repoId>`, while worker gitdirs live under the zone's
derived `zoneRuntimeDir`.

### Controller runtime and zone runtime are distinct

```text
subtree                                             lifecycle              wiped by
─────────────────────────────────────────           ─────────────────      ────────────────────────
zoneRuntimeDir/worker-tasks/<task>/                 per-task               postStopGateway runs
  work/, gitdirs/, repo-metadata/                                          fs.rm(taskRuntimeRoot)
                                                                           on every task end

zoneRuntimeDir/logs/                                per-zone               destroy-zone --purge
                                                                           (orchestrator creates,
                                                                           openclaw appends across
                                                                           every gateway restart)

controllerRuntimeDir/vm-ownership/                  controller lifetime    released by the
  controller-ownership.lock
                                                                           controller or offline
                                                                           cleanup process

controllerStateDir/zones/<zone>/                     Gateway lifetime        exact Gateway cleanup
  gateway-runtime.json                               schema v2 evidence      after child cleanup

controllerStateDir/zones/<zone>/                     Tool VM lifetime        exact Tool cleanup
  tool-leases/<recordId>.json                        schema v2 evidence      before parent cleanup
```

The controller holds `controller-ownership.lock` for its complete process
lifetime. Offline cleanup acquires the same lock before probing controller
health or reading destructive evidence. The lock provides deployment-wide
mutual exclusion; it is not destruction evidence. The controller is the sole
lifecycle authority. Schema-v2 runtime records under
`controllerStateDir/zones/<zone>/` are its durable exact-cleanup evidence
after a crash: they bind the canonical deployment and zone to the recorded VM
id, host pid, process-start identity, and Gateway parent identity. The one
system-level `controllerStateDir` is host-controller-only and is never mounted
into a Gateway or Tool VM. Cleanup revalidates its evidence against the current
config and live process/endpoint state before signaling. HTTP health and
telemetry remain diagnostic inputs and cannot authorize VM adoption,
destruction, or TCP-slot reuse.

## Lease Path Vocabulary

Managed Tool VM storage is selected from stable controller-owned agent identity,
not a caller-supplied host or Gateway path. Keep Gateway framework paths,
controller-selected host capabilities, and Tool VM guest paths distinct.

```text
name / path                         layer / location                  storage / backing
────────────────────────────────    ───────────────────────────────   ─────────────────────────────

zoneFilesDir                        controller-derived host path       durable RealFS, backed up
                                    OpenClaw and Hermes zones          OpenClaw gateway mounts /zone;
                                                                       Tool VMs receive one agent child

/zone                               OpenClaw gateway VM                RealFS -> zoneFilesDir
	                                durable zone files                 shared, backed up

zoneFilesDir/agents/<agentId>       controller-selected host source    one durable agent workspace
	                                stable agent identity              projected, never caller authority

workspaceDir                        OpenClaw SDK boundary only          Gateway path used to authenticate
	                                plugin input                       the configured agent identity

/workspace                          managed Tool VM guest path         filtered RealFS projection of
	                                durable agent-owned files          zoneFilesDir/agents/<agentId>

zoneRuntimeDir/
gitdirs/agents/<agentId>            controller-selected host root      optional workspace.git only
	                                per-agent Git namespace            never normal backup payload

/gitdirs                            managed Tool VM guest path         selected agent Git databases only

/work                               managed Tool VM guest path         rootfs/COW; repos, builds, caches,
	                                default execution cwd              packages, and temporary work

effectiveGuestCwd                   plugin/controller response         Tool VM guest cwd for commands;
	                                controller-selected                normally /work or a child

/work/repos/<repoId>                Worker VM guest path               rootfs/COW
                                    worker task repo files             disposable after worker VM closes

/gitdirs/<repoId>.git               Worker VM / host runtime           RealFS zoneRuntimeDir
                                    git metadata                       not normal zone backup

/agent-vm/logs                      OpenClaw gateway VM                RealFS ->
                                                                       zoneRuntimeDir/logs
                                    gateway/runtime logs               not normal zone backup

/cache                              OpenClaw gateway VM                RealFS -> cacheDir
                                    rebuildable cache                  not backed up

/state                              gateway / worker VM                RealFS -> stateDir or runtime state
                                    control/state plumbing             depends on gateway type
```

## Storage Classes

```text
source/config
  Owner: catalog repo
  Example: config/system.jsonc, config/gateways/<zone>/openclaw.json,
           vm-images/**/build-config.jsonc, vm-images/**/overlay.jsonc
  Backup: git, not agent-vm backups
  Rule: human-authored desired state

rootfs / image
  Owner: agent-vm managed base image + deployment overlay
  VM: /
  Backup: no; rebuilt from image recipes
  Rule: hot runtime dependencies and package trees needed during normal boot

Gateway durable state
  Owner: gateway runtime
  Host: <storageRootDir>/<zoneId>/state (`stateDir`)
  VM: /home/openclaw/.openclaw/state or /state
  Backup: yes
  Rule: preserve existing Gateway-visible identity, auth, effective config,
        sandbox, and framework state paths exactly

controller durable authority
  Owner: host controller
  Host: <storageRootDir>/controller-state/zones/<zone>/
  VM: never mounted into a Gateway or Tool VM
  Backup: excluded from normal zone backup
  Rule: one system/controller-owned root for approval, lifecycle, and cleanup
        records; it must remain disjoint from every VM mount source

  The per-zone root contains:
  - `approvals/` for controller-owned approval records;
  - `gateway-runtime.json` for the managed Gateway cleanup record;
  - `tool-leases/<recordId>.json` for Tool VM cleanup records; and
  - `worker-tasks/<taskId>/gateway-runtime.json` for Worker task cleanup
    records.

  The managed Gateway record captures canonical config path, controller port,
  project namespace, zone, full Gateway epoch identity, VM id, host pid,
  process command/start identity, session label, and ingress port when
  available. Each Tool record additionally binds its controller-generated
  record id, `agentId`, `leaseId`, parent Gateway identity, TCP slot, and exact
  managed VM process evidence. It never persists framework scope keys.

  Controller restart adopts no VM. Startup and scoped offline cleanup process
  all Tool VM records for a zone before its Gateway record, prove the recorded
  processes and relevant endpoints absent, and only then permit a fresh tree.
  Records are deleted only after exact cleanup or already-absent process and
  endpoint state is proven.

  Recovery applies the following fail-closed discipline:

  - **Deployment and parent fences** — `configPath`, `controllerPort`,
    `projectNamespace`, `zoneId`, and `sessionLabel` must match the running
    deployment. Schema validation also requires each Tool record's parent
    Gateway zone to match and the Gateway record's epoch VM id to match its
    recorded VM id. Any mismatch in `in-process-recovery` mode warns and leaves
    the record untouched; `offline-cleanup` throws.

  - **Exact host-process proof** — cleanup re-reads the recorded pid's command
    and process-start identity immediately before TERM/KILL. PID reuse or an
    unexpected command is refused. Host-side `lsof` verifies the relevant
    ingress or Tool SSH endpoint; an occupied Tool slot is not reusable because
    stock Gondolin's Tool SSH listener belongs to the controller process, not
    the QEMU runner.

  - **Hard-cut schema handling** — old, malformed, or otherwise non-v2 JSON has
    no compatibility/adoption path. In-process recovery warns and preserves it;
    offline cleanup fails.

  Lifecycle invariants enforced by the lease manager:
  - `createLease` starts the stock Gondolin VM, captures exact process identity,
    and writes its v2 record before enabling SSH and publishing the lease as
    current.
  - Live-handle teardown first closes Tool SSH, terminates the exact recorded
    runner, observes Gondolin's runner detached, and then calls stock
    `VM.close()` for remaining wrapper resources.
  - `evictLease` and `releaseLease` delete the record and release the TCP slot
    only after the exact runner and listener are absent. Unknown or unproven
    identity preserves the record, quarantines the slot, and refuses a
    replacement.

rebuildable cache
  Owner: controller/runtime tooling
  Host: <storageRootDir>/cache (`cacheDir`)
  VM: gateway-specific cache mounts
  Backup: no
  Rule: can be deleted and repaired; may persist across reboot for speed

controller runtime artifacts
	Owner: controller deployment runtime
	Host: <storageRootDir>/controller-runtime (`controllerRuntimeDir`)
	VM: never mounted as a broad root
  Backup: no
  Rule: controller lock, health evidence, and generated observability files

zone runtime artifacts
	Owner: runtime subsystems acting for one zone
	Host: <storageRootDir>/<zoneId>/runtime (`zoneRuntimeDir`)
	VM: optional /gitdirs/workspace.git for a managed agent; /gitdirs for
	    Worker task Git metadata
  Backup: no normal zone backup; explicit recovery/export only
  Rule: active task runtime state that is not rebuildable cache and not
        durable state

zone files
	Owner: long-lived gateway/user workflow
	Host: <storageRootDir>/<zoneId>/zone-files (`zoneFilesDir`)
	VM: /zone in the OpenClaw Gateway; selected agent content at /workspace in Tool VMs
  Backup: yes for OpenClaw-style long-lived zone backups
  Rule: RealFS-mounted durable household/user files, not hot package-manager work

OpenClaw gateway /work
  Owner: gateway runtime
  Host: none for the target hot path
  VM: /work/tmp, /work/cache
  Backup: no
  Rule: rootfs/COW temp and cache only; do not mount zoneFilesDir at /work

worker repo files
  Owner: per-task VM execution
  Host: none for the target worker hot path
  VM: /work/repos/<repoId>
  Backup: no
  Rule: rootfs/COW repo files for source edits, package installs, builds, tests

gitdir
  Owner: controller + selected agent or worker runtime
  Host: <zoneRuntimeDir>/gitdirs/agents/<agentId>/workspace.git or
        <zoneRuntimeDir>/worker-tasks/<task>/gitdirs/<repo>.git
  VM: optional managed-agent /gitdirs/workspace.git or Worker /gitdirs/<repo>.git
  Backup: explicit recovery/export only, not normal zone backup
  Rule: host-visible Git objects/refs/index used with VM-local repo files;
        never place under stateDir or normal backup-copied zone files

backup output
  Owner: backup commands
  Host: <backupDir>
  Backup: no; this is the backup artifact
  Rule: encrypted archives only
```

## OpenClaw Gateway Paths

```text
catalog repo
  config/gateways/<zone>/openclaw.json
  vm-images/gateways/openclaw/build-config.jsonc
  vm-images/gateways/openclaw/overlay.jsonc

host stateDir
  ~/.agent-vm/<projectNamespace>/<zone>/state/
    effective-openclaw.json
    agents/main/agent/auth-profiles.json
    agents/<agentId>/agent/auth-profiles.json
    sandboxes/<agentId>/work/

host controllerStateDir
	~/.agent-vm/<projectNamespace>/controller-state/
	  zones/<zone>/
      approvals/
      gateway-runtime.json
      tool-leases/<recordId>.json
      worker-tasks/<taskId>/gateway-runtime.json

host cacheDir
  ~/.agent-vm/<projectNamespace>/cache/
    gateway-images/<imageProfile>/
      prepared-image.json
    tool-vm-images/<imageProfile>/
      prepared-image.json
    gateways/<zone>/
      plugin-runtime-deps/

host controllerRuntimeDir
  ~/.agent-vm/<projectNamespace>/controller-runtime/
    vm-ownership/
    controller-health/
    observability/<projectNamespace>/

host zoneRuntimeDir
  ~/.agent-vm/<projectNamespace>/<zone>/runtime/
    logs/
    gitdirs/agents/<agentId>/
      workspace.git
    worker-tasks/<task>/
      gitdirs/<repo>.git

host zoneFilesDir
  ~/.agent-vm/<projectNamespace>/<zone>/zone-files/
    agents/default/

host backupDir
  ~/.agent-vm-backups/<zone>/
```

Target state: OpenClaw bundled plugin runtime dependencies are hot boot-time
import paths. The normal path should be image/rootfs-local, produced during
image build, so startup does not install or import Discord-sized dependency
trees through a Gondolin VFS mount.

`cacheDir/gateways/<zone>/plugin-runtime-deps` is still useful as a repair or
download cache. It must not be the primary runtime import path for stable
bundled plugin dependencies, and it must not be moved into `stateDir`.

`stateDir` is for effective config, auth profiles, sandboxes, and other durable
Gateway-visible state. Controller lifecycle and approval authority belongs only
under `controllerStateDir/zones/<zone>/`.
Putting dependency trees in state makes encrypted backups large, slow, and hard
to reason about.

Gateway logs are runtime evidence, not backup state and not rebuildable cache.
OpenClaw gateway logs belong under `zoneRuntimeDir/logs` and are
mounted into the gateway VM at `/agent-vm/logs`.

Every configured long-lived agent has one canonical durable workspace at
`zoneFilesDir/agents/<agentId>`. The Gateway framework may see that directory at
its native path, but the controller independently projects only the selected
agent workspace into a managed Tool VM at `/workspace`. `/work` remains
rootfs/COW and `/gitdirs` exposes only the optional selected agent workspace Git
database. Remote workspace push is controller-owned over HTTPS through
`workspace_git_push`; Tool VM Git SSH remains read-only.

## Worker Repo Files And Git

Worker task repo files should use VM-local rootfs/COW storage for source files,
package manager installs, `node_modules`, build outputs, search, and tests.

Git metadata should be stored separately in a RealFS-backed gitdir. The VM
repo files can use a `.git` file or explicit `GIT_DIR` / `GIT_WORK_TREE` plumbing
that points at `/gitdirs/<repo>.git`, while the controller retains push
credentials and default-branch operations.

This split gives the agent fast local filesystem behavior for hot work while
keeping commits, refs, and the index visible to the host.

## Gondolin VFS Performance Notes

Local benchmarking on this machine supports this policy direction, with an
important scope limit: the raw VFS benchmark is a synthetic shell-loop file
workload, and pnpm install behavior is still unmeasured.

```text
rootfs/COW
  Use for hot disposable work: worker repo files, package trees, build outputs.
  Local data on the real 4 GiB agent-vm image showed 128 MiB rootfs writes in
  roughly 20-30 ms, compared with roughly 1.5 s through RealFS.

RealFS
  Use for host-visible state, OpenClaw zone files, cache, outputs, and Git
  metadata.
  Pay this cost at source-control and persistence boundaries, not for every
  source edit, package-manager file, search, or test artifact.

ShadowProvider(writeMode = "tmpfs")
  Use for policy/isolation. It is still a Gondolin VFS provider path, not Linux
  guest tmpfs and not the main performance answer for node_modules.

guest /tmp tmpfs
  Use for small scratch only. It is memory-pressure storage and not checkpointed.
```

Interpretation: Gondolin `MemoryProvider` and `ShadowProvider` are memory-backed
at the provider layer, but from the guest they still cross the VFS/FUSE/RPC
path. They are isolation tools, not a substitute for rootfs when the workload is
a hot package tree. Linux `/tmp` tmpfs is a different class and is best for
scratch, not durable runtime state.

The worker Git benchmark directly supports the rootfs work area + RealFS gitdir
split. With 1000 files and a 128 MiB build artifact, full RealFS kept every
repo-file operation on the slow path, while the split preserved rootfs-speed file
writes and paid the RealFS cost only for Git object/index operations.

`rootfs.mode = "readonly"` did not boot the default local benchmark VM within
30 seconds or 120 seconds during this investigation. That failure has not been
root-caused yet. Treat readonly rootfs as a separate hardening target, not the
default for OpenClaw or worker performance work.

For the full rootfs/VFS knob matrix, reproducible benchmark command, and
environment-portable interpretation guide, see
[Gondolin VFS And Rootfs Performance](../reference/gondolin/vfs-rootfs-performance.md).

## Design Rule

If Gateway-visible data is required for framework correctness and cannot be
recreated from config, secrets, or upstream packages, it belongs in
`stateDir`. Host-only approval, lifecycle, and cleanup authority belongs in
`controllerStateDir`. If data only avoids slow repair or rebuild work, it
belongs in cache. If it is a stable hot dependency tree required during every
boot, it belongs in the image/rootfs.
