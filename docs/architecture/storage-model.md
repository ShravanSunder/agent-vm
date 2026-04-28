# Storage Model

[Overview](../README.md) > [Architecture](overview.md) > Storage Model

agent-vm separates source config, VM-local runtime files, durable state,
rebuildable cache, zone files, worker repo files, git metadata, and backup artifacts. Do not
collapse these storage classes to fix a boot or restore symptom; moving data
between them changes backup semantics and often changes performance by crossing
the Gondolin VFS boundary.

For the concrete OpenClaw and Worker gateway path matrix, see
[Storage Matrix](storage-matrix.md).

## Storage Classes

```text
source/config
  Owner: catalog repo
  Example: config/system.json, config/gateways/<zone>/openclaw.json, vm-images/
  Backup: git, not agent-vm backups
  Rule: human-authored desired state

rootfs / image
  Owner: image build
  VM: /
  Backup: no; rebuilt from image recipes
  Rule: hot runtime dependencies and package trees needed during normal boot

durable state
  Owner: controller runtime
  Host: <stateDir>
  VM: /home/openclaw/.openclaw/state or /state
  Backup: yes
  Rule: difficult or annoying to recreate; identity, auth profiles, runtime records

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
  VM: /home/openclaw/zone-files
  Backup: yes for OpenClaw-style long-lived zone backups
  Rule: RealFS-mounted durable household/user files, not hot package-manager work

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
  vm-images/gateways/openclaw/

host stateDir
  ~/.agent-vm/state/<zone>/
    effective-openclaw.json
    agents/main/agent/auth-profiles.json
    gateway-runtime.json
    logs/

host cacheDir
  ~/.agent-vm/cache/
    gateway-images/<imageProfile>/
    tool-vm-images/<imageProfile>/
    gateways/<zone>/
      plugin-runtime-deps/

host runtimeDir
  ~/.agent-vm/runtime/
    worker-tasks/<zone>/<task>/
      gitdirs/<repo>.git

host zoneFilesDir
  ~/.agent-vm/zone-files/<zone>/

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

`stateDir` is for effective config, auth profiles, runtime metadata, and logs.
Putting dependency trees in state makes encrypted backups large, slow, and hard
to reason about.

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

Zone backups archive:

```text
state/
zone files/     # config field: gateway.zoneFilesDir
manifest.json
```

Zone backups do not archive `cacheDir` or `runtimeDir`. If a cache is missing
after restore, doctor/repair flows should rebuild it rather than restoring stale
dependency trees from encrypted backup. If worker runtime state contains
unpushed commits, recovery must happen through an explicit push/export/retain
decision before cleanup, not through normal zone backup.

## Design Rule

If data is required for correctness and cannot be recreated from config,
secrets, or upstream packages, it belongs in state. If it only avoids slow
repair or rebuild work, it belongs in cache. If it is a stable hot dependency
tree required during every boot, it belongs in the image/rootfs.
