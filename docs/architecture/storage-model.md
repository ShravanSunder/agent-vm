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

These fields live at different config levels and have different lifecycle
semantics. Keeping those boundaries explicit prevents `runtimeDir`,
`zoneFilesDir`, and `cacheDir` from drifting into each other's jobs.

```text
field             scope                 durable?          backup?   contains
──────────────    ──────────────────    ──────────────    ───────   ─────────────────────────────

cacheDir          system                yes               no        rebuildable image/plugin/tool
                                                                       cache

runtimeDir        system                mixed: worker     no        active worker artifacts,
                                        per-task                       zone runtime logs,
                                        ephemeral;                     gitdirs, repo metadata,
                                        OpenClaw zone-                 recovery exports
                                        persistent (see
                                        below)

stateDir          per-zone              yes               yes       identity, auth profiles,
                                                                       effective config,
                                                                       runtime records

zoneFilesDir      OpenClaw per-zone     yes               yes       long-lived user/agent files
                                                                       mounted at
                                                                       /zone

backupDir         per-zone output       artifact          no        encrypted backup archives
```

Worker zones do not have `zoneFilesDir` in the target schema. Worker repo files
live inside the VM under `/work/repos/<repoId>`, while worker gitdirs live under
`runtimeDir`.

### runtimeDir is two lifecycles, not one

`runtimeDir`'s "task-lifetime" durability covers only the worker subtree.
The OpenClaw zone subtree has different lifecycle rules.

```text
subtree                                             lifecycle              wiped by
─────────────────────────────────────────           ─────────────────      ────────────────────────
runtimeDir/worker-tasks/<zone>/<task>/              per-task               postStopGateway runs
  work/, gitdirs/, repo-metadata/                                          fs.rm(taskRuntimeRoot)
                                                                           on every task end

runtimeDir/zones/<zone>/logs/                       per-zone               destroy-zone --purge
                                                                           (orchestrator creates,
                                                                           openclaw appends across
                                                                           every gateway restart)

runtimeDir/zones/<zone>/zone-git/                   per-zone, preserved    NOT wiped by
                                                    by destroy-zone's       destroy-zone --purge
                                                    selective deletion      (see two reasons
                                                    (see note below)        below)
```

Note that `zone-git/` is preserved **implicitly**, not by explicit policy.
`destroy-zone --purge` enumerates specific subtrees to delete (`worker-tasks/`,
`zones/<zone>/logs/`, and `zoneFilesDir`). It does NOT use a broad
`fs.rm(runtimeDir/zones/<zone>/)` that would also remove `zone-git/`. Any
future change to `destroy-zone.ts` that broadens the rm scope must
explicitly exclude `zone-git/` — the two reasons below are why.

1. **Data loss prevention.** `zone-git/zone-files.git` is the authoritative
   git store for committed work in this zone. Backups capture
   `zoneFilesDir` (the worktree) but not the git history under
   `runtimeDir/zones/<zone>/zone-git/`. Any commits that have not been
   pushed to a remote live only in `zone-git/`; wiping it loses that
   history irrecoverably.
2. **Pointer integrity.** `zoneFilesDir/.git` is a `gitdir:` pointer file
   (not a directory) referencing `/agent-vm/zone-git/zone-files.git`
   inside the gateway VM, which is realfs-mounted to
   `runtimeDir/zones/<zone>/zone-git/zone-files.git`. Backed-up
   `zoneFilesDir` carries this pointer with it; wiping the target leaves
   any future restore with a dangling `.git` reference.

## Lease Path Vocabulary

Tool VM lease paths cross three naming layers: OpenClaw SDK input, gateway VM
paths, and controller-trusted host paths. Keep these names distinct.

Runtime path translation is implemented as a shared pure translator in
`@agent-vm/gateway-interface`. The shared code owns path mechanics: absolute
path normalization, parent-traversal rejection, longest-root matching, relative
path calculation, guest-to-host and host-to-guest mapping, storage backing
classification, and structured retry guidance.

Runtime packages inject their own mapping facts. The OpenClaw plugin injects
the Tool VM mapping where `/workspace` is the RealFS workspace mount and
`/work` is Tool VM rootfs/COW scratch. The controller injects the OpenClaw
gateway lease mapping where `/zone` maps to `zoneFilesDir` and
`/home/openclaw/.openclaw/state/sandboxes` maps to `stateDir/sandboxes`.

```text
name / path                         layer / location                  storage / backing
────────────────────────────────    ───────────────────────────────   ─────────────────────────────

zoneFilesDir                        system.json host config            durable RealFS, backed up
                                    OpenClaw zones only                mounted in gateway at /zone

/zone                               OpenClaw gateway VM                RealFS -> zoneFilesDir
                                    durable zone files                 shared, backed up

workMountDir                        POST /lease request                gateway VM path, untrusted input
                                    chosen by OpenClaw/plugin          must be child of /zone or sandboxes

/home/openclaw/.openclaw/state/
sandboxes/<child>                   OpenClaw gateway VM                RealFS -> stateDir/sandboxes/<child>
                                    agent sandbox namespace            durable state, backed up

hostWorkMountDir                    controller internal                trusted resolved host path
                                    after validation/realpath          passed to lease manager / RealFS

	/workspace                          Tool VM guest path                 RealFS -> hostWorkMountDir
	                                    lease-local execution dir          survives if backing host dir does

	effectiveGuestCwd                   plugin/controller response         Tool VM guest cwd for commands
	                                    derived from runtime translation    may be /workspace, /workspace/sub, or /work

	/work                               Tool VM guest path                 rootfs/COW
	                                    disposable scratch                 deleted with the Tool VM

agentWorkspaceDir                   OpenClaw/tool process cwd concept  guest-side agent working dir
                                    controller lease field             not a host storage root

workspaceDir                        OpenClaw SDK boundary only          external SDK name
                                    plugin input                       translated immediately to workMountDir

/work/repos/<repoId>                Worker VM guest path               rootfs/COW
                                    worker task repo files             disposable after worker VM closes

/gitdirs/<repoId>.git               Worker VM / host runtime           RealFS runtimeDir
                                    git metadata                       not normal zone backup

/agent-vm/logs                      OpenClaw gateway VM                RealFS ->
                                                                       runtimeDir/zones/<zone>/logs
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

durable state
  Owner: controller runtime
  Host: <stateDir>
  VM: /home/openclaw/.openclaw/state or /state
  Backup: yes
  Rule: difficult or annoying to recreate; identity, auth profiles, runtime records

  Note: `gateway-runtime.json` is a durable recovery record under `stateDir`.
  It is not part of `runtimeDir`; the shared word "runtime" does not imply the
  same lifecycle.

  Note: `tool-leases/<recordId>.json` is a durable recovery record for an
  OpenClaw Tool VM. `recordId` is a controller-generated UUID. The record keeps
  `agentId`, `leaseId`, `vmId`, `qemuPid`, deployment fences, TCP slot, and
  session/process evidence. It never persists OpenClaw scope keys.

  On controller startup, Phase A scans this directory and applies the following
  recovery discipline:

  - **Five-fence deployment check** — `configPath`, `controllerPort`,
    `projectNamespace`, `zoneId`, `sessionLabel` must all match the running
    deployment. Any mismatch in `in-process-recovery` mode warns and skips the
    record without signaling or mutating it; in `offline-cleanup` mode the
    cleanup throws.

  - **Host ownership proof** — recovery uses host-side `lsof` to check TCP
    listener ownership, then verifies the recorded pid and process identity
    before signaling QEMU/krun. PID reuse during the read-record → signal
    window is detected and refused.

  - **Hard-cut schema handling** — records whose JSON fails Zod parse are
    warned and skipped by startup recovery without mutation. There is no
    compatibility or rename path for this development format.

  Lifecycle invariants enforced by the lease manager:
  - `createLease` writes the record after `storeLease`. On write failure
    the lease is unstored and the VM is closed before throwing.
  - `evictLease` and `releaseLease` delete the record **only** when
    `vm.close()` succeeds. On close failure the record is preserved AND the
    tcp slot is moved into a per-process quarantine set (not reusable until
    next controller restart) so the orphan QEMU's host port cannot collide
    with a fresh lease on the same slot.

rebuildable cache
  Owner: controller/runtime tooling
  Host: <cacheDir>
  VM: gateway-specific cache mounts
  Backup: no
  Rule: can be deleted and repaired; may persist across reboot for speed

runtime artifacts
  Owner: controller runtime
  Host: <runtimeDir>
  VM: /gitdirs for worker task git metadata, future runtime-only mounts
  Backup: no normal zone backup; explicit recovery/export only
  Rule: active task runtime state that is not rebuildable cache and not
        durable state; local disk preferred because cacheDir may be networked

zone files
  Owner: long-lived gateway/user workflow
  Host: <zoneFilesDir>
  VM: /zone
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
  Owner: controller + worker runtime
  Host: <runtimeDir>/worker-tasks/<zone>/<task>/gitdirs/<repo>.git
  VM: /gitdirs/<repo>.git
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
  ~/.agent-vm/state/<zone>/
    effective-openclaw.json
    agents/main/agent/auth-profiles.json
    agents/<agentId>/agent/auth-profiles.json
    sandboxes/<agentId>/work/
    gateway-runtime.json
    tool-leases/<recordId>.json

host cacheDir
  ~/.agent-vm/cache/
    gateway-images/<imageProfile>/
      prepared-image.json
    tool-vm-images/<imageProfile>/
      prepared-image.json
    gateways/<zone>/
      plugin-runtime-deps/

host runtimeDir
  ~/.agent-vm/runtime/
    zones/<zone>/
      logs/
    worker-tasks/<zone>/<task>/
      gitdirs/<repo>.git

host zoneFilesDir
  ~/.agent-vm/zone-files/<zone>/
    agents/default/

host backupDir
  ~/.agent-vm-backups/<projectNamespace>/<zone>/
```

Target state: OpenClaw bundled plugin runtime dependencies are hot boot-time
import paths. The normal path should be image/rootfs-local, produced during
image build, so startup does not install or import Discord-sized dependency
trees through a Gondolin VFS mount.

`cacheDir/gateways/<zone>/plugin-runtime-deps` is still useful as a repair or
download cache. It must not be the primary runtime import path for stable
bundled plugin dependencies, and it must not be moved into `stateDir`.

`stateDir` is for effective config, auth profiles, and durable runtime metadata.
Putting dependency trees in state makes encrypted backups large, slow, and hard
to reason about.

Gateway logs are runtime evidence, not backup state and not rebuildable cache.
OpenClaw gateway logs belong under `runtimeDir/zones/<zone>/logs` and are
mounted into the gateway VM at `/agent-vm/logs`.

OpenClaw agent sandbox work directories live under `stateDir` and can be mounted
into Tool VMs as `/workspace`. Per-agent sandbox seeds are written only into
these sandbox-backed workspace directories, and only when the target file does
not already exist. Shared `/zone` work mounts are not seeded this way.

Tool VM lease requests name `workMountDir` as a gateway path under a concrete
child of `/zone` or `/home/openclaw/.openclaw/state/sandboxes`; the roots
themselves are validation boundaries and rejected as mount targets. The
controller resolves that gateway path to a trusted host `hostWorkMountDir`. For
non-zone-git leases the Tool VM sees the resolved directory at `/workspace`;
`/work` remains VM-local rootfs/COW scratch.

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

## Backup Contract

OpenClaw zone backups archive:

```text
state/
zone files/     # config field: gateway.zoneFilesDir
manifest.json
```

Worker zone backups archive `stateDir` only. Worker zones do not have
`zoneFilesDir` in the target schema.

Zone backups do not archive `cacheDir` or `runtimeDir`. If a cache is missing
after restore, doctor/repair flows should rebuild it rather than restoring stale
dependency trees from encrypted backup. Worker runtime state is deleted at task
teardown in v1, so recovery must happen before teardown through committed work
and controller-side `git-push`, not through normal zone backup.

## Design Rule

If data is required for correctness and cannot be recreated from config,
secrets, or upstream packages, it belongs in state. If it only avoids slow
repair or rebuild work, it belongs in cache. If it is a stable hot dependency
tree required during every boot, it belongs in the image/rootfs.
