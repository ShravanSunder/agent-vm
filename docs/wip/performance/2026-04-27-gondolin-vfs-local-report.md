# Gondolin VFS Local Performance Report

Date: 2026-04-27

## Source JSON

```text
tmp/gondolin-vfs-4g-2026-04-27.json
tmp/gondolin-worker-git-4g-2026-04-27.json
```

## Harness Files

```text
scripts/perf/gondolin-vfs-benchmark.ts
  Raw rootfs/VFS path matrix benchmark.

scripts/perf/gondolin-worker-git-benchmark.ts
  Worker layout benchmark for rootfs worktree + RealFS gitdir.

packages/agent-vm/src/perf/gondolin-vfs-benchmark-support.ts
  Shared helpers for metadata capture, mount checks, stats, and JSON output.

packages/agent-vm/src/perf/gondolin-vfs-benchmark-support.test.ts
  Unit tests for the shared benchmark helper layer.

docs/reference/gondolin/vfs-rootfs-performance.md
  Canonical reusable reference for interpreting the results.
```

## Commands

```bash
pnpm perf:gondolin-vfs -- \
  --gondolin-repo /Users/shravansunder/Documents/dev/open-source/vm/gondolin \
  --image-path /Users/shravansunder/.agent-vm/cache/gateway-images/openclaw/9e5af0a431ea90f7 \
  --rootfs-modes cow,memory,readonly \
  --file-count 2000 \
  --large-mib 128 \
  --samples 3 \
  --warmup-samples 1 \
  --start-timeout-ms 30000 \
  --child-timeout-ms 900000 \
  --json-out tmp/gondolin-vfs-4g-2026-04-27.json

pnpm perf:worker-git -- \
  --gondolin-repo /Users/shravansunder/Documents/dev/open-source/vm/gondolin \
  --image-path /Users/shravansunder/.agent-vm/cache/gateway-images/openclaw/9e5af0a431ea90f7 \
  --file-count 1000 \
  --large-mib 128 \
  --samples 3 \
  --warmup-samples 1 \
  --start-timeout-ms 30000 \
  --json-out tmp/gondolin-worker-git-4g-2026-04-27.json
```

## Environment

```text
Host:
  platform: darwin
  arch:     arm64
  Node:     v24.7.0

Guest:
  Linux 6.18.20-0-virt aarch64

Gondolin checkout:
  path:   /Users/shravansunder/Documents/dev/open-source/vm/gondolin
  branch: main
  head:   c6efbe3961b129fba763e7ec4d8456e582be2760
  dirty:  yes, untracked local package tarballs only

Image assets:
  /Users/shravansunder/.agent-vm/cache/gateway-images/openclaw/9e5af0a431ea90f7
  rootfs.ext4: 4.0 GiB
```

## Raw Filesystem Workload

```text
small write:
  2000 files
  40 subdirectories
  mkdir -p per file
  printf one line per file

small read:
  cat all 2000 files

large write:
  dd 128 MiB zero file

reporting:
  1 warmup sample, then 3 measured samples
  values below are medians with min/max ranges in the JSON
```

## Raw Filesystem Results

```text
rootfs.mode=cow
  rootfs /opt:
    small write:  739 ms   [560-875]
    small read:   331 ms   [314-486]
    128 MiB write: 25 ms   [24-26]

  guest /tmp tmpfs:
    small write:  899 ms   [544-941]
    small read:   325 ms   [291-345]
    128 MiB write: 18 ms   [18-18]

  Gondolin MemoryProvider:
    small write:  4287 ms  [4148-4954]
    small read:   2242 ms  [2227-2807]
    128 MiB write: 24798 ms [20991-25384]

  Gondolin RealFS:
    small write:  4612 ms  [4377-4897]
    small read:   2630 ms  [2610-2767]
    128 MiB write: 1554 ms [1322-1679]

  RealFS workspace/node_modules:
    small write:  5022 ms  [4999-5376]
    small read:   2711 ms  [2608-2969]
    128 MiB write: 1532 ms [1498-1640]

  ShadowProvider node_modules writeMode tmpfs:
    small write:  4828 ms  [4627-4955]
    small read:   2387 ms  [1865-2526]
    128 MiB write: 24742 ms [21998-25235]
```

```text
rootfs.mode=memory
  rootfs /opt:
    small write:  735 ms   [696-884]
    small read:   355 ms   [265-475]
    128 MiB write: 26 ms   [25-37]

  guest /tmp tmpfs:
    small write:  702 ms   [690-736]
    small read:   256 ms   [242-377]
    128 MiB write: 19 ms   [18-28]

  Gondolin MemoryProvider:
    small write:  4380 ms  [3293-8217]
    small read:   2819 ms  [1509-3195]
    128 MiB write: 28110 ms [19302-29799]

  Gondolin RealFS:
    small write:  4437 ms  [4220-4836]
    small read:   2475 ms  [2474-2619]
    128 MiB write: 1607 ms [1300-1911]

  RealFS workspace/node_modules:
    small write:  4509 ms  [4389-5255]
    small read:   2560 ms  [2497-2732]
    128 MiB write: 1465 ms [1328-1750]

  ShadowProvider node_modules writeMode tmpfs:
    small write:  4528 ms  [4235-4864]
    small read:   2184 ms  [2071-2205]
    128 MiB write: 22609 ms [22175-23361]
```

```text
rootfs.mode=readonly
  VM startup timed out after 30000 ms while waiting for guest readiness.
```

## Worker Git Workload

```text
layouts:
  full-rootfs
    repo and .git both on rootfs/COW

  full-realfs
    repo and .git both on RealFS

  rootfs-worktree-realfs-gitdir
    worktree on rootfs/COW
    Git metadata on RealFS at /gitdirs/<repo>.git
    git commands use explicit --git-dir and --work-tree

workload:
  write 1000 files
  read 1000 files
  git add + initial commit
  clean status
  modify 100 tracked files
  dirty status
  git diff
  git add modified files
  commit modified files
  write 128 MiB build artifact
```

## Worker Git Results

```text
full-rootfs
  small write:       327 ms
  small read:        149 ms
  128 MiB write:      32 ms
  git add initial:   124 ms
  git status clean:   14 ms
  git status dirty:   14 ms
  git diff:            5 ms
  modify files:       13 ms
  git add modified:   11 ms
  git commit:         11 ms

full-realfs
  small write:      2039 ms
  small read:       1164 ms
  128 MiB write:    1258 ms
  git add initial:  5728 ms
  git status clean:  246 ms
  git status dirty:   99 ms
  git diff:          666 ms
  modify files:      128 ms
  git add modified:  719 ms
  git commit:        992 ms

rootfs-worktree-realfs-gitdir
  small write:       436 ms
  small read:        123 ms
  128 MiB write:      19 ms
  git add initial:  3663 ms
  git status clean:   27 ms
  git status dirty:   27 ms
  git diff:          369 ms
  modify files:       15 ms
  git add modified:  343 ms
  git commit:        752 ms
```

## Interpretation

1. Rootfs/COW is the right default for hot disposable worker files. On the real
   4 GiB agent-vm image, 2000 small writes were roughly 6x faster than RealFS,
   and 128 MiB writes were roughly 60x faster than RealFS.

2. Gondolin `MemoryProvider` and `ShadowProvider(writeMode: "tmpfs")` are not
   substitutes for Linux tmpfs or rootfs-local disk. Their 128 MiB writes were
   around 22-28 seconds because they still cross the Gondolin VFS provider path.

3. Guest `/tmp` tmpfs is fast in this run, but it is memory-pressure storage and
   not checkpointed. Use it for small scratch, not package trees or large build
   artifacts. For large temporary data, prefer a rootfs path such as `/work/tmp`.

4. `rootfs.mode = cow` and `rootfs.mode = memory` were effectively comparable
   for this workload. Choose `cow` because it is checkpointable and predictable,
   not because this benchmark proves it is faster.

5. The worker split design is supported by the Git benchmark. Compared with
   full RealFS, rootfs worktree + RealFS gitdir kept the hot file path close to
   full-rootfs performance while still keeping Git metadata host-visible.

6. The split does not make Git free. `git add`, `git diff`, and `git commit`
   still pay RealFS cost because the object database and index live in the
   RealFS gitdir. That is the intended trade: pay the tax at source-control
   boundaries, not on every edit, package install, search, test, or build file.

## Decisions Supported

```text
OpenClaw gateway:
  Bake stable bundled plugin runtime deps into image/rootfs.
  Keep RealFS cache as repair/download cache.
  Keep RealFS state for auth/config/runtime records only.

Worker gateway:
  Use rootfs/COW worktrees for source, node_modules, builds, tests.
  Use RealFS gitdir for Git objects/refs/index.
  Use explicit GIT_DIR/GIT_WORK_TREE or git --git-dir/--work-tree plumbing.
  Keep controller-owned push/auth on the host side.

Temp-heavy tools:
  Use /work/tmp and TMPDIR for large temp files.
  Keep /tmp for small scratch only.

ShadowProvider:
  Use for policy/isolation, not performance.
```

## Remaining Follow-Up Benchmarks

```text
1. pnpm install into rootfs /work vs RealFS /workspace vs ShadowProvider.
2. npm/pnpm cache on rootfs /work/cache vs RealFS /cache.
3. OpenClaw Discord plugin startup with deps baked into image/rootfs.
4. Same benchmark on the spare Mac.
```
