# Gondolin VFS And Rootfs Performance

[Docs](../README.md) > Reference > Gondolin VFS And Rootfs Performance

This page is the working reference for deciding where agent-vm should put hot
runtime dependencies, repo files, caches, state, and temporary files when running
inside Gondolin.

The short rule:

```text
Hot and disposable filesystem work       -> rootfs/COW path, such as /work
Small short-lived scratch                -> guest tmpfs, such as /tmp
Host-visible durable state or outputs    -> RealFS VFS mount
Host-visible Git metadata                -> RealFS gitdir + rootfs repo files
Hidden host junk / denied secrets        -> Shadow/Readonly policy wrapper
Stable boot-time dependencies            -> image/rootfs, built ahead of boot
Repairable download caches               -> RealFS cache, not backed up
```

The most important distinction: guest tmpfs is a Linux guest-kernel filesystem.
Gondolin `MemoryProvider` and `ShadowProvider(writeMode: "tmpfs")` are VFS
providers. They may be memory-backed on the host side, but guest file
operations still cross `sandboxfs` / virtio-serial RPC.

## Three Temporary Filesystems

These are all temporary, but they are not interchangeable.

```text
rootfs.mode = "cow"
  Backing: temporary qcow2 overlay on host disk
  Lifetime: deleted on VM close unless checkpointed
  Best for: large package trees, build outputs, worker repo files
  Bad for: state that must survive without an explicit checkpoint or export

rootfs.mode = "memory"
  Backing: backend-specific throwaway root disk mode
  QEMU: backend-native snapshot mode
  krun: temporary qcow2 overlay on disk, not RAM-backed
  Lifetime: deleted on VM close; not checkpointable in Gondolin
  Best for: stateless throwaway roots when checkpointing is not needed

guest tmpfs
  Backing: guest memory / virtual memory
  Paths: /root, /tmp, /run, /var/log, /var/tmp, /var/cache
  Lifetime: deleted on VM close; not checkpointed
  Best for: small temp files, sockets, pid files, logs
  Bad for: large package trees or unbounded build artifacts
```

Writing to `/scratch/big.bin` or `/work/tmp/big.bin` is different from writing
to `/tmp/big.bin`. If `/scratch` and `/work` are not VFS mounts and not tmpfs
mounts, they live on the rootfs. With `rootfs.mode = "cow"`, that means the
write lands in the disposable qcow2 overlay rather than consuming guest tmpfs
memory.

## Rootfs Knobs

```text
rootfs.mode
  API: VM.create({ rootfs: { mode } })
  Values: "cow", "memory", "readonly"
  Default: "cow", unless the image manifest sets runtimeDefaults.rootfsMode

runtimeDefaults.rootfsMode
  Location: custom image manifest, produced from build config
  Purpose: image-level default when VM.create does not pass rootfs.mode

rootfs.sizeMb
  Location: custom image build config
  Purpose: fixed rootfs image capacity at build time

sandbox.rootDisk* options
Lower-level escape hatch in Gondolin
In normal agent-vm code, prefer rootfs.mode unless explicitly doing root disk
plumbing.
```

Gondolin exposes one native root filesystem per VM in the public SDK model. You
can make that rootfs larger at image build time and choose its write mode at VM
creation time, but there is no documented high-level `disks: []` API for adding
several extra rootfs-like block devices. The normal expansion model is:

```text
one native rootfs
  /work
  /work/tmp
  /work/cache

many VFS mounts
  /workspace  -> host repo/provider
  /cache      -> host cache/provider
  /out        -> host output/provider
```

Use directories inside rootfs for fast disposable disk work. Use VFS mounts
when host persistence, host visibility, or provider policy matters.

Mode behavior from Gondolin docs and source:

```text
readonly
  Implementation: base rootfs path, rootDiskReadOnly = true
  Writes: EROFS
  Checkpoint use: no writable state to checkpoint

memory
  QEMU implementation: base rootfs path with rootDisk snapshot = true
  krun implementation: temporary qcow2 overlay, deleteOnClose = true
  Writes: disposable
  Checkpoint use: not checkpointable in Gondolin

cow
  Implementation: temporary qcow2 overlay backed by the base rootfs
  Writes: disposable unless checkpointed
  Checkpoint use: yes; checkpoint captures root disk overlay state
```

Use careful wording for QEMU `memory` mode. Gondolin documents it as
backend-native snapshot mode, not as a guaranteed RAM filesystem. The practical
decision is still the same: `memory` is throwaway and not checkpointable; `cow`
is throwaway by default and checkpointable.

## VFS Knobs

VFS paths use Gondolin's guest `sandboxfs` mount plus host-side providers. File
operations cross the VM boundary:

```text
guest process
  -> Linux VFS / FUSE sandboxfs
  -> virtio-serial RPC
  -> host FsRpcService
  -> provider
```

That makes VFS excellent for persistence and policy, but a poor default for hot
package-manager trees when a rootfs path is available.

```text
MemoryProvider
  Backing: host Node.js memory provider
  Lifetime: VM/process lifetime
  Checkpoint: not included
  Use for: isolated scratch VFS mounts

RealFSProvider(hostPath)
  Backing: host filesystem path
  Lifetime: persistent on host
  Checkpoint: not included
  Use for: state, cache, config, outputs, host-visible gitdirs

ReadonlyProvider(backend)
  Backing: wrapped provider
  Policy: denies writes
  Use for: config or resources the VM may read but not mutate

ShadowProvider(backend, { writeMode: "deny" })
  Backing: wrapped provider
  Policy: hides selected paths and denies writes
  Use for: blocking secrets or host-only files

ShadowProvider(backend, { writeMode: "tmpfs" })
  Backing: wrapped provider plus MemoryProvider upper layer by default
  Policy: reads from shadowed paths do not fall through to backend; writes go
          to the upper layer
  Use for: hiding host node_modules while allowing small guest-created files
  Do not use as the main performance plan for large node_modules trees
```

`ShadowProvider(writeMode: "tmpfs")` is not Linux `/tmp` and is not a fast
kernel tmpfs. In Gondolin source, the upper layer defaults to `new
MemoryProvider()`, so it is still a VFS provider path. Use it for isolation and
policy, not as a performance substitute for rootfs-local package trees.

VFS can mount at ordinary absolute guest paths. A VFS mount at `/tmp` can shadow
the default `/tmp` tmpfs, but that is usually a heavier solution than setting
`TMPDIR=/work/tmp` for tools that need disk-backed temporary space.

## Path Policy

```text
/opt/openclaw/plugin-runtime-deps
  Backing: image/rootfs
  Purpose: stable OpenClaw bundled plugin deps used during normal boot

/home/openclaw/.openclaw/state
  Backing: RealFS stateDir
  Purpose: effective config, auth profiles, runtime metadata, logs
  Backup: yes

/home/openclaw/.openclaw/cache
  Backing: RealFS cacheDir
  Purpose: repair/download cache
  Backup: no

/home/openclaw/zone-files
  Backing: RealFS zoneFilesDir config field for
           long-lived OpenClaw household files
  Backup: yes

/work/repos/<repo>
  Backing: rootfs/COW for worker tasks
  Purpose: hot source edits, node_modules, builds, tests

/gitdirs/<repo>.git
  Backing: RealFS runtimeDir outside normal zone backup
  Purpose: host-visible Git objects, refs, and index; explicit recovery/export
           only
  Backup: no normal backup

/work or /scratch
  Backing: rootfs/COW unless explicitly mounted
  Purpose: large temporary disk-backed files

/tmp
  Backing: guest tmpfs unless overridden
  Purpose: small temporary files only
```

For temp-heavy package managers and build tools, prefer:

```bash
mkdir -p /work/tmp /work/cache/npm /work/cache/pip /work/cache/uv
export TMPDIR=/work/tmp
export TMP=/work/tmp
export TEMP=/work/tmp
export npm_config_cache=/work/cache/npm
export PIP_CACHE_DIR=/work/cache/pip
export UV_CACHE_DIR=/work/cache/uv
```

This keeps large temp/cache churn on the rootfs COW overlay instead of guest
tmpfs, while still being disposable at VM close.

## Local Benchmark Harness

Harness files:

```text
scripts/perf/gondolin-vfs-benchmark.ts
  Measures rootfs modes, guest tmpfs, MemoryProvider, RealFS, and
  ShadowProvider path behavior.

scripts/perf/gondolin-worker-git-benchmark.ts
  Measures full-rootfs, full-RealFS, and rootfs-work area + RealFS-gitdir worker
  layouts.

packages/agent-vm/src/perf/gondolin-vfs-benchmark-support.ts
  Shared benchmark helpers for Gondolin checkout metadata, statistics,
  mount-class assertions, and JSON result shape.

packages/agent-vm/src/perf/gondolin-vfs-benchmark-support.test.ts
  Unit coverage for the benchmark support helpers.
```

Run the benchmark from the agent-vm repo:

```bash
pnpm perf:gondolin-vfs -- \
  --gondolin-repo /path/to/gondolin \
  --image-path /path/to/built/gondolin/assets \
  --samples 3 \
  --warmup-samples 1 \
  --json-out tmp/gondolin-vfs-benchmark.json
```

Useful variants:

```bash
# Fast smoke test.
pnpm perf:gondolin-vfs -- \
  --gondolin-repo /path/to/gondolin \
  --rootfs-modes cow \
  --file-count 50 \
  --large-mib 1 \
  --samples 2 \
  --warmup-samples 0

# Compare only writable rootfs modes.
pnpm perf:gondolin-vfs -- \
  --gondolin-repo /path/to/gondolin \
  --rootfs-modes cow,memory \
  --json-out tmp/gondolin-vfs-writable.json

# Increase VM startup allowance for slower machines.
pnpm perf:gondolin-vfs -- \
  --gondolin-repo /path/to/gondolin \
  --start-timeout-ms 120000 \
  --json-out tmp/gondolin-vfs-slow-host.json

# Require the Gondolin checkout to be clean before timing.
pnpm perf:gondolin-vfs -- \
  --gondolin-repo /path/to/gondolin \
  --require-clean-gondolin \
  --json-out tmp/gondolin-vfs-clean.json

# Measure the worker-specific rootfs work area + RealFS gitdir design.
pnpm perf:worker-git -- \
  --gondolin-repo /path/to/gondolin \
  --image-path /path/to/built/gondolin/assets \
  --json-out tmp/gondolin-worker-git.json
```

The script also reads `GONDOLIN_REPO`:

```bash
GONDOLIN_REPO=/path/to/gondolin pnpm perf:gondolin-vfs
```

The benchmark records:

```text
host OS / arch / Node version
Gondolin repo path, branch, HEAD, dirty status
asset image path when provided
guest uname
guest df/mount output
rootfs mode
small file write median/min/max
small file read median/min/max
large file write median/min/max
per-sample raw timings
per-mode failures, including readonly startup failures
```

The current workload is intentionally simple and reproducible:

```text
2000 small file writes:
  shell loop, 40 subdirectories, mkdir -p per file, printf per file

2000 small file reads:
  shell loop, cat each file

32 MiB large write:
  dd if=/dev/zero bs=1MiB count=32
```

Do not overfit a single run. The script defaults to multiple samples, but the
workload is still a deliberately small synthetic probe. Use it to compare
storage classes on the same machine. The most important relative question is:

```text
Does this workload cross Gondolin VFS, or is it using rootfs/tmpfs?
```

## Current Local Results

The canonical local result lives in the JSON report under `tmp/` and the dated
runbook under `docs/wip/performance/`. Keep detailed timing tables there rather
than duplicating them through architecture docs.

Initial local data on 2026-04-27 supported these directional conclusions:

```text
rootfs/COW beat Gondolin VFS providers for shell-loop small writes
rootfs/COW beat RealFS by roughly 60x for 128 MiB writes on the 4 GiB image
Gondolin MemoryProvider and ShadowProvider still behaved like VFS paths
guest tmpfs was fast in the latest run but remains memory-pressure storage
cow vs memory rootfs speed was within noise; cow wins as default because checkpointable
rootfs work area + RealFS gitdir beat full RealFS for worker file workloads
```

Scope limits:

```text
The raw VFS benchmark is not a package-manager benchmark yet.
It does not exercise hardlinks, symlinks, atomic renames, parallel I/O, or stat-heavy installs.
The worker Git benchmark does exercise Git object/index operations, but pnpm install remains unmeasured.
```

`rootfs.mode = "readonly"` did not reach readiness within 30 seconds in the
current run and timed out after 120 seconds in a previous run. This has not been
root-caused yet. Treat readonly as a separate hardening/debug target, not a
performance default.

## Sources

Gondolin local docs/source used for this page:

```text
docs/sdk-storage.md
docs/workloads.md
docs/snapshots.md
docs/vfs.md
docs/custom-images.md
guest/image/init
host/src/vm/core.ts
host/src/vfs/shadow.ts
host/src/sandbox/server.ts
```

External Linux reference:

```text
https://www.kernel.org/doc/html/latest/filesystems/tmpfs.html
```
