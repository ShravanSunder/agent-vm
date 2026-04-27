# Storage Matrix

[Overview](../README.md) > [Architecture](overview.md) > Storage Matrix

This matrix is the concrete path policy for OpenClaw gateway VMs and Worker
gateway VMs. It applies the broader storage classes from
[Storage Model](storage-model.md) to the actual paths each gateway should use.

The core rule is that storage location defines both performance and backup
semantics. Do not move files between these classes without explicitly reviewing
the backup and VFS consequences.

## OpenClaw Gateway VM

OpenClaw is a long-lived household service. Its durable state should be backed
up. Its stable boot-time dependencies should be baked into the image/rootfs. Its
repair caches should stay outside backup.

```text
path or data                           backing                backup
──────────────────────────────         ─────────────────      ─────────

config/gateways/<zone>/
openclaw.json, prompts                 git/catalog repo       git only
                                       desired config         not backup

vm-images/gateways/openclaw/
Dockerfile, build config               git/catalog repo       git only
                                       image recipe           not backup

/opt/openclaw/plugin-runtime-deps       image/rootfs baked     no
Discord + stable plugin deps            hot boot deps          rebuild image

/home/openclaw/.openclaw/state          RealFS stateDir        yes
auth profiles, effective config,        durable identity
runtime records, metadata

/home/openclaw/.openclaw/cache          RealFS cacheDir        no
repair/download caches                  rebuildable

/home/openclaw/shared-files             RealFS sharedFilesDir  yes
current VM path: /home/openclaw/         long-lived household
workspace                               user/agent files

/work/tmp                               rootfs/COW             no
large temp, TMPDIR target               disposable disk

/work/cache                             rootfs/COW or cache    no
runtime package cache                   disposable or repairable

/tmp, /run, /var/log                    guest tmpfs            no
sockets, pid files, tiny scratch        memory-pressure only

gateway-runtime.json                    stateDir               yes
host runtime record                     durable enough
```

## Worker Gateway VM

Worker VMs are per-task execution environments. The hot worktree should be
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

/workspace/<repoId>                     rootfs/COW             no
source edits, node_modules,             hot task worktree
builds, tests, package installs

/gitdirs/<repoId>.git                   RealFS taskRuntimeDir  explicit
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
worktrees
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

The backup command also copies the zone's current host `workspaceDir`
wholesale. Worker gitdirs must not be placed there either unless backup gains a
worker-specific exclusion policy. For the target design, gitdirs live in a
non-backup task runtime root and are preserved through explicit recovery/export
flows.

## Target Worker Layout

```text
stateDir/
  tasks/<taskId>/
    state/
      effective-worker.json
      tasks/<taskId>.jsonl
    agent-vm/
      agents.md
      runtime-instructions.md
      resources/

taskRuntimeDir/   # derived from cacheDir or a future explicit config field
  worker-tasks/<zoneId>/<taskId>/
    gitdirs/<repoId>.git
    recovery/

inside worker VM rootfs/COW:
  /workspace/<repoId>
  /work/tmp
  /work/cache
```

The controller keeps control over Git push/fetch credentials through the RealFS
gitdir. The worker keeps hot filesystem work on rootfs/COW. Normal backup
captures control-plane state, not task git object databases or accidental full
task clones.

## Backup Policy

```text
active task with unpushed commits       preserve/recover explicitly
completed task with pushed branch       disposable
failed task                             retain for debugging until cleanup
normal zone backup                      durable state, not task repos
```

Worker `.git` storage is controller-visible recovery state. It should not be
treated as ordinary durable zone state forever without an explicit recovery or
retention policy.

## Worker Gitdir Lifecycle

```text
worker task starts
  -> controller creates RealFS gitdir
  -> worker rootfs worktree points .git at /gitdirs/<repoId>.git
  -> agent edits rootfs files and commits into the gitdir
  -> controller pushes using host credentials
  -> controller cleans up the gitdir after push/task close
```

Worker gitdirs are not normal backup payload. They are a controller-managed
task runtime boundary: visible to the host for push/fetch/recovery, but cleaned
up when the task lifecycle is complete.

Before cleanup, the controller must make unresolved Git state explicit:

```text
clean and pushed        -> delete gitdir
unpushed commits        -> push, export recovery artifact, or discard
dirty worktree          -> commit/push, export patch/artifact, or discard
failed task             -> retain until operator recovery decision
```
