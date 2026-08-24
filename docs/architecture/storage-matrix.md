# Storage Matrix

[Overview](../README.md) > [Architecture](overview.md) > Storage Matrix

This matrix is the concrete path policy for Hermes Gateway VMs and Worker
gateway VMs. It applies the broader storage classes from
[Storage Model](storage-model.md) to the actual paths each gateway should use.

The core rule is that storage location defines both performance and backup
semantics. Do not move files between these classes without explicitly reviewing
the backup and VFS consequences.

## Hermes Gateway VM

Hermes is a long-lived managed service. Its framework home and profile state
are durable. Stable boot-time dependencies belong in the managed image recipe;
repair caches and runtime logs stay outside backup.

```text
path or data                           backing                backup
──────────────────────────────         ─────────────────      ─────────

config/gateways/<zone>/
hermes config, prompts                 git/catalog repo       git only
                                       desired config         not backup

Hermes managed image recipe             @agent-vm/hermes-      no
and immutable upstream pin               gateway package        release-owned

/home/hermes/.hermes                     Shadow -> stateDir      yes
root config, profiles, framework         durable framework home
state; profile .env paths are tmpfs

/home/hermes/.cache                      RealFS cacheDir        no
repair/download caches                  rebuildable

zoneFilesDir/agents/<agentId>           host durable RealFS    yes
selected agent workspace                projected to Tool VM
                                       at /work

/agent-vm/logs                          RealFS zoneRuntimeDir  no
gateway-boot-latest.log,                zone-lifetime, wiped by
Hermes and Gateway Runtime logs         destroy-zone --purge

/work/tmp                               rootfs/COW             no
large temp, TMPDIR target               disposable disk

/work/cache                             rootfs/COW or cache    no
runtime package cache                   disposable or repairable

/tmp, /run, /var/log                    guest tmpfs            no
sockets, pid files, tiny scratch        memory-pressure only

gateway-runtime.json                    controllerStateDir     no
host runtime record                     controller-only

tool-leases/<recordId>.json             controllerStateDir     no
Tool VM recovery record                 controller-only
recordId UUID; keeps agentId,
leaseId, vmId, qemuPid; never
stores framework scope keys
```

Hermes Gateways are long-lived, so rootfs/COW scratch can accumulate across
requests. Size `runtimeRootfsSize` explicitly and use an operational restart
window where necessary. Tool VMs and Worker tasks are shorter-lived and shed
their rootfs state at lease/task teardown. Hermes does not mount a broad
`zoneFilesDir` root; the controller projects only the selected agent workspace
into its Tool VM at `/work`.

## Worker Gateway VM

Worker VMs are per-task execution environments. The hot repo files should be
rootfs/COW so source edits, package managers, builds, tests, and search avoid
the Gondolin VFS path. Git metadata should be RealFS so the controller can
inspect refs and push/fetch with host credentials.

```text
path or data                           backing                backup
──────────────────────────────         ─────────────────      ─────────

stateDir/tasks/<taskId>/state           RealFS stateDir        yes
event log, effective-worker.json        control-plane state

stateDir/tasks/<taskId>/agent-vm        RealFS stateDir        yes-ish
runtime instructions, resource          small generated task
metadata, agents.md                     metadata

/work/repos/<repoId>                     rootfs/COW             no
source edits, node_modules,             hot task repo files
builds, tests, package installs

/gitdirs/<repoId>.git                   RealFS zoneRuntimeDir  explicit
Git objects, refs, index                recovery/export only

/work/tmp                               rootfs/COW             no
large temp, TMPDIR target               disposable disk

/work/cache                             rootfs/COW             no
npm/pnpm/uv/pip per-task cache          disposable

/cache                                  RealFS cacheDir        no
optional cross-task repair cache        rebuildable

/tmp, /run, /var/log                    guest tmpfs            no
tiny scratch only                       memory-pressure

worker task recovery artifact           explicit export dir    explicit
patches/log bundle if needed            not automatic backup
```

## Worker StateDir Exclusion Rule

Never put these under worker `stateDir`:

```text
repos
repo files
node_modules
package-manager caches
build artifacts
test outputs
large temp files
full clones
```

The backup command currently copies `stateDir` wholesale. Anything under worker
`stateDir` silently becomes encrypted backup payload when a worker zone is
backed up.

The backup command also copies managed Hermes `zoneFilesDir` roots. Worker gitdirs must
not be placed there either unless backup gains a worker-specific exclusion
policy. Gitdirs live in `zoneRuntimeDir`, a non-backup task runtime root, and
are deleted during task teardown.

## Target Worker Layout

```text
<storageRootDir>/<zoneId>/state/
  tasks/<taskId>/
    state/
      effective-worker.json
      tasks/<taskId>.jsonl
    agent-vm/
      agents.md
      runtime-instructions.md
      resources/

<storageRootDir>/<zoneId>/runtime/
  worker-tasks/<taskId>/
    gitdirs/<repoId>.git
    recovery/

inside worker VM rootfs/COW:
  /work/repos/<repoId>
  /work/tmp
  /work/cache
```

The controller keeps control over Git push/fetch credentials through the RealFS
gitdir. The worker keeps hot filesystem work on rootfs/COW. Normal backup
captures control-plane state, not task git object databases or accidental full
task clones.

## Backup Policy

```text
active task with unpushed commits       agent must push before teardown
completed task with pushed branch       disposable
failed/closed/timeout task              disposable after VM close
normal zone backup                      durable state, not task repos
```

Worker `.git` storage is controller-visible runtime state while the task is
alive. It is not normal durable zone state, and v1 does not retain it after task
teardown.

## Worker Gitdir Lifecycle

```text
worker task starts
  -> controller creates RealFS gitdir
  -> worker rootfs repo files point .git at /gitdirs/<repoId>.git
  -> agent edits rootfs files and commits into the gitdir
  -> controller pushes using host credentials
  -> controller cleans up the gitdir after push/task close
```

Worker gitdirs are not normal backup payload. They are a controller-managed
task runtime boundary: visible to the host for push/fetch while the task is
alive, then cleaned up when the task lifecycle is complete.

Before terminal completion, the agent must make unresolved Git state explicit:

```text
clean and pushed        -> task can complete
unpushed commits        -> agent calls git-push, or reports the failure
dirty repo files        -> worker must commit before terminal completed state
failed task             -> runtime artifacts are deleted during teardown
```

After the worker VM closes, rootfs/COW `/work/repos` files are gone. The
controller cannot inspect RealFS gitdirs, refs, commits, or dirty uncommitted
rootfs files for that task unless a future pre-close snapshot/export path is
added.

## Tool VM

Tool VMs are lease-local execution sandboxes. The controller selects one stable
agent identity and grants only that agent's filtered durable workspace and
optional workspace Git database. Callers never supply a host mount path.
`/work` is fast rootfs/COW execution space and is discarded when the Tool VM
closes or is replaced.

For the canonical name/location/storage vocabulary, see
[Lease Path Vocabulary](storage-model.md#lease-path-vocabulary).

```text
path or data                           backing                backup
──────────────────────────────         ─────────────────      ─────────

/workspace                             filtered RealFS         yes
selected durable agent workspace      zoneFilesDir child

/work                                  rootfs/COW              no
repos, builds, packages, temp work     deleted with Tool VM

/gitdirs/workspace.git                 selected RealFS         no
optional workspace Git database       controller runtime

/agent-vm                              reviewed read-only      generated
runtime instructions and metadata     narrow inputs only

/tmp, /run, /var/log                   guest tmpfs            no
tiny scratch only                      memory-pressure
```
