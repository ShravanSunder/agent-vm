# Storage and VFS Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move hot runtime/package-manager work off Gondolin RealFS while preserving host-visible durable state, repairable caches, git metadata, backups, and controller-owned push/auth boundaries.

**Architecture:** OpenClaw gateway images should carry stable hot runtime dependencies in the VM rootfs, while packable state stays on RealFS and repairable caches stay under cacheDir. OpenClaw's RealFS `/home/openclaw/zone-files` mount is a durable zone-files area, not the same storage class as worker execution files. Worker tasks should use VM-local rootfs/COW paths under `/work` for fast source/package/build operations, with a host-backed separate gitdir mounted through RealFS from a non-backup runtimeDir so commits and refs survive for recovery/push without being swallowed by normal zone backups.

**Tech Stack:** TypeScript, pnpm, Vitest, Gondolin VFS providers, OpenClaw bundled plugin runtime deps, bare Git repositories plus explicit `--git-dir` / `--work-tree`, Node 24.

---

## Storage Model Decisions

### OpenClaw Gateway

Runtime code and bundled plugin runtime dependencies are hot read paths. They belong in the VM image/rootfs, not in a RealFS-mounted cache as the normal boot path.

Durable household state belongs in RealFS stateDir and is included in backups.

Repairable heavy artifacts belong in RealFS cacheDir and are not included in backups.

The OpenClaw path `/home/openclaw/zone-files` is durable zone files, not
worker-style hot execution storage. It is RealFS-mounted and included in
OpenClaw zone backups. The config field is `gateway.zoneFilesDir`. Remove
`gateway.workspaceDir` entirely in this cutover; do not support an alias.

### Worker Gateway

Worker hot files should live under `/work` in the VM rootfs/COW layer for speed.
Repos live under `/work/repos/<repoId>`. This includes source files, package
manager installs, `node_modules`, build outputs, and normal editor/search/test
operations.

The git database should live outside the repo files as a separate RealFS-backed gitdir. It must not live under `stateDir`, and it must not live under any directory copied by normal zone backups. Git inside the VM still works through `.git` pointing to the mounted gitdir. The controller still owns push credentials and default-branch operations.

Worker state is packable/backed up. It may contain task event logs, effective
worker config, and generated runtime metadata. It must not contain repos,
repo files, `node_modules`, package-manager caches, build outputs, test outputs,
large temp files, or git object databases.

Use per-task gitdirs for the first implementation. A shared bare repo cache is
a later optimization; it has harder ref-isolation and cleanup semantics and is
not required to fix the current storage-class bug.

Worker gitdirs live under a top-level non-backup `runtimeDir`, for example:

```text
<runtimeDir>/worker-tasks/<zoneId>/<taskId>/gitdirs/<repoId>.git
```

This path is not semantically "cache" when it contains unpushed commits, and it
must not be placed under `cacheDir` because future deployments may put cache on
network storage such as EFS. It is local task runtime/recovery state. The
important property for this plan is that normal `backup create` does not copy
it. Unpushed work must be preserved through an explicit recovery/export path,
not through silent zone backup bloat.

The controller owns the gitdir lifecycle. After a task pushes successfully, the
controller cleans up the gitdir. If the task has unpushed commits, dirty files,
or a failed terminal state, cleanup must stop at an explicit push/export/discard
decision. This is a task lifecycle guardrail, not a backup responsibility.

Every host-side Git invocation against a worker gitdir must use explicit
`--git-dir=<host gitdir>` and must disable hooks with
`-c core.hooksPath=/dev/null`. Never rely on the host repo files `.git` file for
auto-discovery, because the worker `.git` pointer is a VM path.

Worker rootfs repo files are ephemeral execution state. The first implementation
does not promise active-task checkpoint/restore across an externally mutated
gitdir.

Invariant: v1 worker tasks are fresh-boot only. No active-task checkpoint/restore
across rootfs repo files plus RealFS gitdir. Recovery is through gitdir
inspection/export, not VM checkpoint restore.

Bootstrap should be idempotent for a fresh rootfs repo files, and later checkpoint
support must define how rootfs repo files state and external RealFS gitdir state
are reconciled.

---

## File Structure

### Agent VM Source

`packages/openclaw-gateway/src/openclaw-lifecycle.ts`

  Owns OpenClaw VM environment and mount layout. Change the runtime plugin stage root from the RealFS cache path to a rootfs/image path when baked plugin deps are enabled.

`packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`

  Verifies the OpenClaw VM spec points plugin runtime deps at the intended path and keeps state/cache/catalog mounts separated.

`packages/agent-vm/src/cli/build-command.ts`

  Owns image build orchestration. Add a preflight/build step that materializes OpenClaw bundled plugin runtime deps for active default plugins before the gateway image is finalized.

`packages/agent-vm/src/cli/build-command.test.ts`

  Verifies build invokes the OpenClaw plugin dependency staging step for OpenClaw gateway image profiles.

`packages/agent-vm/src/operations/doctor.ts`

  Owns host readiness checks. Add checks that identify missing OpenClaw plugin runtime deps and report the build/doctor command required before startup.

`packages/agent-vm/src/operations/doctor.test.ts`

  Verifies doctor catches missing plugin runtime deps and points at the exact repair command.

`packages/worker-gateway/src/worker-lifecycle.ts`

  Owns worker VM base mounts and process startup. Mount task gitdirs as RealFS while keeping `/work/repos` on rootfs.

`packages/worker-gateway/src/worker-lifecycle.test.ts`

  Verifies `/work/repos` is no longer a RealFS mount and `/gitdirs` is a RealFS mount.

`packages/agent-vm/src/controller/worker-task-runner.ts`

  Owns task preparation. Change repo clone/setup to create a separate gitdir under the non-backup task runtime root and arrange rootfs repo files inside the worker VM.

`packages/agent-vm/src/controller/worker-task-runner.test.ts`

  Verifies task prep creates gitdir metadata, exposes gitdirs to the VM, and gives the worker enough information to check out repos into rootfs.

`packages/agent-vm/src/config/system-config.ts`

  Adds host-level `runtimeDir` as a resolved path next to `cacheDir` and zone
  path fields. This directory stores active non-backup runtime artifacts such as
  worker gitdirs.

`packages/agent-vm/src/config/system-config.test.ts`

  Verifies `runtimeDir` resolves like the other host-level directories and is
  not conflated with `cacheDir`.

`packages/agent-vm/src/cli/init-command.ts`

  Scaffolds `runtimeDir` for every path profile and keeps the OpenClaw
  zone-files directory visibly separate from worker `/work` paths. The user-dir
  profile should default to `~/.agent-vm/runtime` for runtime artifacts and
  `~/.agent-vm/zone-files/<zone>` for `gateway.zoneFilesDir`.

`packages/agent-vm/src/cli/commands/init-definition.ts`

  Updates `agent-vm init --help` and preset descriptions so users can see the
  macOS defaults: cache, runtime, state, zoneFilesDir, and backup locations.
  Help text must not mention `workspaceDir`.

`packages/agent-vm/src/cli/commands/paths-definition.ts`

  Shows `runtimeDir` and `zoneFilesDir` so `agent-vm paths show` reflects the
  storage model.

`packages/agent-vm/src/cli/init-command.test.ts`

  Verifies init writes and creates the configured `runtimeDir`, writes
  `zoneFilesDir` instead of `workspaceDir`, creates the zone-files path in the
  RealFS path profile, and exposes the expected visible defaults through command
  metadata.

`packages/agent-vm-worker/src/work/repo-bootstrap.ts`

  New worker-side module. On worker startup, creates `/work/repos/<repoId>` rootfs repo files using `/gitdirs/<repoId>.git`.

`packages/agent-vm-worker/src/work/repo-bootstrap.test.ts`

  Unit tests for `.git` pointer creation and checkout command composition.

`packages/agent-vm-worker/src/coordinator/coordinator.ts`

  Calls repo bootstrap before starting plan/work/wrapup phases.

`packages/agent-vm-worker/src/config/worker-config.ts`

  Adds explicit repo gitdir/work-area bootstrap metadata to the worker config schema.

`docs/architecture/storage-model.md`

  Documents the storage model with progressive disclosure: rootfs/image, RealFS state, RealFS cache, RealFS gitdir, tmpfs, VFS provider limits, backups.

`docs/reference/configuration/system-json.md`

  Documents `runtimeDir` as local, non-backup runtime storage. It is a sibling
  of `cacheDir`, not a child of it.

`docs/reference/gondolin/vfs-rootfs-performance.md`

  Documents Gondolin rootfs modes, guest tmpfs, VFS providers, path policy, benchmark usage, current local results, and source references.

`../shravan-claw/docs/wip/vfs-design.md`

  Records empirical benchmark results and marks prior unmeasured assumptions as hypotheses.

`scripts/perf/gondolin-vfs-benchmark.ts`

  Reproducible benchmark harness for running the same rootfs/VFS comparison on other machines and Gondolin checkouts.

`scripts/perf/gondolin-worker-git-benchmark.ts`

  Reproducible benchmark harness for worker git/worker storage layouts. It compares full rootfs, full RealFS, and rootfs repo files plus RealFS gitdir.

`packages/agent-vm/src/perf/gondolin-vfs-benchmark-support.ts`

  Shared benchmark support for Gondolin checkout metadata, sampling stats, mount assertions, and JSON result shape.

---

## Task 1: Document The Target Storage Policy

**Files:**
- Modify: `docs/architecture/storage-model.md`
- Modify: `docs/README.md`
- Create: `docs/reference/gondolin/vfs-rootfs-performance.md`
- Create: `scripts/perf/gondolin-vfs-benchmark.ts`
- Create: `scripts/perf/gondolin-worker-git-benchmark.ts`
- Create: `packages/agent-vm/src/perf/gondolin-vfs-benchmark-support.ts`
- Test: `packages/agent-vm/src/perf/gondolin-vfs-benchmark-support.test.ts`
- Modify: `package.json`
- Modify: `../shravan-claw/docs/wip/vfs-design.md`

- [x] **Step 1: Update the architecture doc**

Update `docs/architecture/storage-model.md` so it states:

```markdown
Rootfs/image is for hot stable dependency trees.
RealFS state is for durable config/auth/runtime records.
RealFS cache is for repairable downloads and package caches.
RealFS gitdir is for host-visible Git metadata.
VM-local rootfs repo files are for worker source/package/build operations.
Kernel tmpfs is for scratch.
Gondolin MemoryProvider and ShadowProvider are isolation tools, not faster
package-tree storage than rootfs.
```

- [x] **Step 2: Link the architecture/reference docs from the docs map**

Modify `docs/README.md` and include the storage model and Gondolin performance
reference in the reading paths/doc tree.

Expected inserted line:

```markdown
- `architecture/storage-model.md` — storage classes, VFS mount policy, backup boundaries, and worker gitdir/work-area model.
- `reference/gondolin/vfs-rootfs-performance.md` — Gondolin rootfs/VFS knobs, benchmark harness, and performance interpretation.
```

- [x] **Step 3: Update the storage model with benchmark facts**

The architecture doc now records this expanded local benchmark:

```text
cow rootfs /opt:
  small writes: ~1196 ms
  small reads:  ~2357 ms
  large write:  ~147 ms

memory rootfs /opt:
  small writes: ~1140 ms
  small reads:  ~1926 ms
  large write:  ~217 ms

guest /tmp tmpfs:
  small reads:  ~275-317 ms
  large write:  ~79-83 ms
  small writes: varied ~4819-7526 ms in shell-loop benchmark

RealFS node_modules path:
  small writes: ~5212-5594 ms
  small reads:  ~2046-2915 ms
  large write:  ~738-1126 ms

ShadowProvider node_modules writeMode tmpfs:
  small writes: ~5286-5763 ms
  small reads:  ~2153-2252 ms
  large write:  ~2160-2326 ms
```

`rootfs.mode = "readonly"` timed out during VM startup at both 30 seconds and
120 seconds with the default benchmark image, so it is not a current default
candidate for the performance work.

- [x] **Step 4: Add a reproducible benchmark harness**

Create `scripts/perf/gondolin-vfs-benchmark.ts` and add:

```json
"perf:gondolin-vfs": "node scripts/perf/gondolin-vfs-benchmark.ts"
```

The script must support:

```text
--gondolin-repo /path/to/gondolin
--rootfs-modes cow,memory,readonly
--file-count 2000
--large-mib 32
--start-timeout-ms 30000
--json-out tmp/gondolin-vfs-benchmark.json
```

It must run each rootfs mode in a child process so a readonly startup failure
does not destroy the whole benchmark run.

- [x] **Step 5: Add the comprehensive Gondolin reference doc**

Create `docs/reference/gondolin/vfs-rootfs-performance.md` covering:

```text
rootfs.mode cow/memory/readonly
guest tmpfs paths
MemoryProvider / RealFSProvider / ReadonlyProvider / ShadowProvider
disk-backed temp via /work or /scratch
TMPDIR/package-cache redirection
checkpoint boundaries
benchmark command examples
current measured results
source references
```

- [x] **Step 6: Update the shravan-claw WIP observation doc**

Modify `../shravan-claw/docs/wip/vfs-design.md` with the same measured benchmark
facts, keeping that file's rule that claims are marked `VERIFIED` or left as
open questions.

- [ ] **Step 7: Verify docs formatting**

Run:

```text
pnpm fmt:check docs/README.md docs/architecture/storage-model.md docs/reference/gondolin/vfs-rootfs-performance.md docs/superpowers/plans/2026-04-27-storage-vfs-performance.md scripts/perf/gondolin-vfs-benchmark.ts package.json
```

Expected: command exits 0.

- [ ] **Step 8: Commit**

```bash
git add docs/README.md docs/architecture/storage-model.md docs/reference/gondolin/vfs-rootfs-performance.md docs/superpowers/plans/2026-04-27-storage-vfs-performance.md scripts/perf/gondolin-vfs-benchmark.ts package.json
git commit -m "docs: document storage and VFS policy

Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 2: Move OpenClaw Plugin Runtime Deps Out Of Boot

**Files:**
- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- Test: `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
- Modify: `packages/agent-vm/src/cli/build-command.ts`
- Test: `packages/agent-vm/src/cli/build-command.test.ts`

- [ ] **Step 1: Write failing lifecycle test for rootfs plugin stage path**

Add this test to `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`:

```ts
it('uses an image-local plugin stage path for OpenClaw runtime deps', () => {
	const vmSpec = openclawLifecycle.buildVmSpec({
		controllerPort: 18800,
		gatewayCacheDir: '/host/cache/gateways/shravan',
		projectNamespace: 'test-project',
		resolvedSecrets: {
			OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
		},
		tcpPool: { hostRange: { start: 19000, end: 19010 } },
		zone: createOpenClawZoneConfig({
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				config: '/catalog/config/gateways/shravan/openclaw.json',
				stateDir: '/host/state/shravan',
				zoneFilesDir: '/host/zone-files/shravan',
			},
		}),
	});

	expect(vmSpec.environment.OPENCLAW_PLUGIN_STAGE_DIR).toBe(
		'/opt/openclaw/plugin-runtime-deps',
	);
	expect(vmSpec.environment.TMPDIR).toBe('/work/tmp');
	expect(vmSpec.environment.npm_config_cache).toBe('/work/cache/npm');
	expect(vmSpec.vfsMounts).not.toHaveProperty('/opt/openclaw/plugin-runtime-deps');
	expect(vmSpec.vfsMounts).toMatchObject({
		'/home/openclaw/.openclaw/cache': {
			hostPath: '/host/cache/gateways/shravan',
			kind: 'realfs',
		},
		'/home/openclaw/.openclaw/state': {
			hostPath: '/host/state/shravan',
			kind: 'realfs',
		},
	});
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.test.ts
```

Expected: FAIL because `OPENCLAW_PLUGIN_STAGE_DIR` still points at `/home/openclaw/.openclaw/cache/plugin-runtime-deps`.

- [ ] **Step 3: Change the runtime plugin stage path**

In `packages/openclaw-gateway/src/openclaw-lifecycle.ts`, define:

```ts
const openClawPluginStageDirVmPath = '/opt/openclaw/plugin-runtime-deps';
const openClawCacheDirVmPath = '/home/openclaw/.openclaw/cache';
```

Keep `/home/openclaw/.openclaw/cache` mounted as RealFS. Do not mount `/opt/openclaw/plugin-runtime-deps`.

Also make the OpenClaw lifecycle create and export rootfs-backed temp/cache
paths so package managers and build tools do not default to guest `/tmp`:

```text
TMPDIR=/work/tmp
TMP=/work/tmp
TEMP=/work/tmp
npm_config_cache=/work/cache/npm
pnpm_config_store_dir=/work/cache/pnpm/store
PIP_CACHE_DIR=/work/cache/pip
UV_CACHE_DIR=/work/cache/uv
```

The bootstrap command must create those directories before starting OpenClaw.

Because OpenClaw gateways are long-lived, set an explicit OpenClaw image
`rootfs.sizeMb` and document one cleanup strategy before shipping: either a
periodic `/work` cleanup command or an operational weekly gateway restart. The
goal is a clear ENOSPC failure mode instead of unbounded host overlay growth.

- [ ] **Step 4: Run the lifecycle test**

Run:

```bash
pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add build-command test for pre-staging**

Add a test in `packages/agent-vm/src/cli/build-command.test.ts` that creates an
OpenClaw gateway image target and asserts the generated Docker build context or
build step includes a deterministic plugin-deps bake contract:

```bash
OPENCLAW_PLUGIN_STAGE_DIR=/opt/openclaw/plugin-runtime-deps openclaw doctor --fix --non-interactive
```

The assertion should also cover the marker file written after a successful
stage:

```text
/opt/openclaw/plugin-runtime-deps/.openclaw-runtime-deps.json
```

That marker should include the OpenClaw version, the plugin manifest/fingerprint,
and the install command that populated the tree.

- [ ] **Step 6: Run the failing build-command test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/build-command.test.ts
```

Expected: FAIL because the build pipeline does not yet stage OpenClaw bundled plugin deps.

- [ ] **Step 7: Implement the OpenClaw image pre-stage command**

In `packages/agent-vm/src/cli/build-command.ts`, add a build-time command for OpenClaw gateway images:

```ts
const openClawPluginRuntimeDepsStageCommand =
	'OPENCLAW_PLUGIN_STAGE_DIR=/opt/openclaw/plugin-runtime-deps openclaw doctor --fix --non-interactive';
```

Insert that command after OpenClaw is installed in the image and before the
image is finalized. The command must run without runtime secrets, without auth
profiles, and without the runtime stateDir. Network access is allowed only as
part of the image build dependency install path.

This command path was checked against DeepWiki for `openclaw/openclaw`: bundled
plugin runtime dependency repair flows through `openclaw doctor --fix
--non-interactive`, and `OPENCLAW_PLUGIN_STAGE_DIR` controls the standalone
install root. Keep a local/source verification step in the implementation PR so
the exact OpenClaw version used by the catalog is still grounded in code.

Cutover criterion:

```text
plugin manifest/fingerprint is known at image build
Docker/build step stages deps into /opt/openclaw/plugin-runtime-deps
marker file exists in the built image
OPENCLAW_PLUGIN_STAGE_DIR points to populated /opt path at boot
/home/openclaw/.openclaw/cache is repair/download cache only
boot fails loudly if the marker is missing or stale
```

- [ ] **Step 8: Run targeted tests**

Run:

```bash
pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.test.ts packages/agent-vm/src/cli/build-command.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/openclaw-gateway/src/openclaw-lifecycle.ts packages/openclaw-gateway/src/openclaw-lifecycle.test.ts packages/agent-vm/src/cli/build-command.ts packages/agent-vm/src/cli/build-command.test.ts
git commit -m "fix: bake OpenClaw plugin deps into gateway image

Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 3: Add Worker Rootfs Repo files With RealFS Gitdir

**Files:**
- Modify: `packages/agent-vm/src/controller/worker-task-runner.ts`
- Test: `packages/agent-vm/src/controller/worker-task-runner.test.ts`
- Modify: `packages/agent-vm/src/backup/backup-create-operation.ts`
- Test: `packages/agent-vm/src/backup/backup-create-operation.test.ts`
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Test: `packages/agent-vm/src/config/system-config.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/commands/init-definition.ts`
- Modify: `packages/agent-vm/src/cli/commands/paths-definition.ts`
- Test: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `packages/agent-vm-worker/src/config/worker-config.ts`
- Test: `packages/agent-vm-worker/src/config/worker-config.test.ts`
- Create: `packages/agent-vm-worker/src/work/repo-bootstrap.ts`
- Create: `packages/agent-vm-worker/src/work/repo-bootstrap.test.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/coordinator.ts`
- Modify: `packages/worker-gateway/src/worker-lifecycle.ts`
- Test: `packages/worker-gateway/src/worker-lifecycle.test.ts`
- Modify: `docs/reference/configuration/system-json.md`

- [ ] **Step 1: Add host `runtimeDir` to system config and init**

In `packages/agent-vm/src/config/system-config.ts`, add `runtimeDir` beside
`cacheDir` and resolve it through the existing path resolver:

```ts
runtimeDir: z.string().min(1).default('./runtime'),
```

The resolved system config must expose `runtimeDir` as an absolute path. This is
where active worker runtime artifacts live; it is never normal backup scope and
it is not repairable cache.

In `packages/agent-vm/src/config/system-config.ts`, remove
`gateway.workspaceDir` from `zoneGatewaySchema` and add
`gateway.zoneFilesDir`:

```ts
zoneFilesDir: z.string().min(1),
```

This is a hard cutover. Do not support both names, do not add an alias, and do
not silently map `workspaceDir` to `zoneFilesDir`.

In `packages/agent-vm/src/cli/init-command.ts`, add `runtimeDir` and rename the
path profile helper from `gatewayWorkspaceDir` to `gatewayZoneFilesDir`:

```ts
local:
  runtimeDir: '../runtime'
  gatewayZoneFilesDir: '../zone-files/<zone>'

container:
  runtimeDir: '/var/agent-vm/runtime'
  gatewayZoneFilesDir: '/var/agent-vm/zone-files/<zone>'

user-dir:
  runtimeDir: '~/.agent-vm/runtime'
  gatewayZoneFilesDir: '~/.agent-vm/zone-files/<zone>'
```

The init command must write `runtimeDir` and `gateway.zoneFilesDir` to
`system.json` and create both directories during scaffold, using the same
absolute-at-scaffold rule as the other user-dir paths. Update
`docs/reference/configuration/system-json.md` with the same definition.

Do not default `runtimeDir` under `cacheDir`; cache may be network-backed in
worker deployments, while runtime gitdirs should prefer local disk.

Update `packages/agent-vm/src/cli/commands/init-definition.ts` so
`agent-vm init --help` exposes the visible defaults:

```text
macos-local:
  cacheDir: ~/.agent-vm/cache
  runtimeDir: ~/.agent-vm/runtime
  stateDir: ~/.agent-vm/state/<zone>
  zoneFilesDir: ~/.agent-vm/zone-files/<zone>
  backupDir: ~/.agent-vm-backups/<zone>
```

Update `packages/agent-vm/src/cli/commands/paths-definition.ts` so
`agent-vm paths show` prints `runtimeDir` and labels zone files clearly:

```text
cacheDir
runtimeDir
zone[shravan].stateDir
zone[shravan].zoneFilesDir
zone[shravan].backupDir
```

- [ ] **Step 2: Add system config and init tests for `runtimeDir`**

In `packages/agent-vm/src/config/system-config.test.ts`, verify `runtimeDir`
resolves to an absolute path.

In `packages/agent-vm/src/cli/init-command.test.ts`, verify the macOS user-dir
preset writes and creates `runtimeDir` under the scaffold home, and that it still
creates the zoneFilesDir directory under the configured profile.

Add a negative assertion that generated `system.json` does not contain
`workspaceDir`.

Add CLI-definition coverage for the visible defaults. The test can inspect the
command description or invoke `--help`, but it must prove that the help text
contains these terms:

```text
runtimeDir
zone files
zoneFilesDir
~/.agent-vm/runtime
~/.agent-vm/zone-files/<zone>
~/.agent-vm-backups/<zone>
```

Add `paths show` coverage proving the output includes `runtimeDir` and labels
`zoneFilesDir`; add a negative assertion that the output does not include
`workspaceDir`.

- [ ] **Step 3: Add backup path assertions for worker runtime dirs**

In `packages/agent-vm/src/backup/backup-create-operation.ts`, add a structural
guard before staging backup contents:

```ts
assertNotDescendant(systemConfig.runtimeDir, zone.gateway.stateDir);
assertNotDescendant(systemConfig.runtimeDir, zone.gateway.zoneFilesDir);
```

Thread the resolved `runtimeDir` from `runBackupCommand` through
`ZoneBackupManager.createBackup()` into `createEncryptedBackup()`. The exact
helper can compare resolved real/absolute paths, but the invariant is
non-negotiable: normal backup must fail loudly if worker runtime gitdirs could
be descendants of `stateDir` or the backup-copied OpenClaw `zoneFilesDir`.

Add tests in `packages/agent-vm/src/backup/backup-create-operation.test.ts`
covering:

```text
runtimeDir under stateDir      -> backup fails before tar staging
runtimeDir under zoneFilesDir  -> backup fails before tar staging
runtimeDir sibling path        -> backup proceeds
```

- [ ] **Step 4: Extend worker config schema with repo work metadata**

In `packages/agent-vm-worker/src/config/worker-config.ts`, add:

```ts
const repoWorkDirectorySchema = z.object({
	repoId: z.string().min(1),
	repoUrl: z.string().min(1),
	baseBranch: z.string().min(1),
	taskBranch: z.string().min(1),
	repoWorkPath: z.string().min(1),
	gitDirPath: z.string().min(1),
});
```

Add to `workerConfigSchema`:

```ts
repoWorkDirectories: z.array(repoWorkDirectorySchema).default([]),
```

- [ ] **Step 5: Add config schema test**

In `packages/agent-vm-worker/src/config/worker-config.test.ts`, add:

```ts
it('parses repo work metadata', () => {
	const config = workerConfigSchema.parse({
		repoWorkDirectories: [
			{
				repoId: 'agent-vm',
				repoUrl: 'https://github.com/ShravanSunder/agent-vm.git',
				baseBranch: 'main',
				taskBranch: 'agent/task-001',
				repoWorkPath: '/work/repos/agent-vm',
				gitDirPath: '/gitdirs/agent-vm.git',
			},
		],
	});

	expect(config.repoWorkDirectories).toEqual([
		{
			repoId: 'agent-vm',
			repoUrl: 'https://github.com/ShravanSunder/agent-vm.git',
			baseBranch: 'main',
			taskBranch: 'agent/task-001',
			repoWorkPath: '/work/repos/agent-vm',
			gitDirPath: '/gitdirs/agent-vm.git',
		},
	]);
});
```

- [ ] **Step 6: Run config test to verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/config/worker-config.test.ts
```

Expected: FAIL before schema implementation, PASS after schema implementation.

- [ ] **Step 7: Create repo bootstrap module**

Create `packages/agent-vm-worker/src/work/repo-bootstrap.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

export interface RepoWorkDirectory {
	readonly repoId: string;
	readonly repoUrl: string;
	readonly baseBranch: string;
	readonly taskBranch: string;
	readonly repoWorkPath: string;
	readonly gitDirPath: string;
}

export async function bootstrapRepoWorkDirs(
	repoWorkDirectories: readonly RepoWorkDirectory[],
): Promise<void> {
	for (const repoWorkDirectory of repoWorkDirectories) {
		await bootstrapRepoWorkDir(repoWorkDirectory);
	}
}

async function bootstrapRepoWorkDir(repoWorkDirectory: RepoWorkDirectory): Promise<void> {
	await mkdir(repoWorkDirectory.repoWorkPath, { recursive: true });
	await writeFile(
		path.join(repoWorkDirectory.repoWorkPath, '.git'),
		`gitdir: ${repoWorkDirectory.gitDirPath}\n`,
		{ encoding: 'utf8', mode: 0o644 },
	);
	await execa(
		'git',
		[
			'-c',
			'core.hooksPath=/dev/null',
			`--git-dir=${repoWorkDirectory.gitDirPath}`,
			`--work-tree=${repoWorkDirectory.repoWorkPath}`,
			'checkout',
			'-B',
			repoWorkDirectory.taskBranch,
			repoWorkDirectory.baseBranch,
		],
		{ reject: true, timeout: 60_000 },
	);
}
```

- [ ] **Step 8: Add repo bootstrap tests**

Create `packages/agent-vm-worker/src/work/repo-bootstrap.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapRepoWorkDirs } from './repo-bootstrap.js';

vi.mock('execa', () => ({
	execa: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

describe('bootstrapRepoWorkDirs', () => {
	it('writes a VM-valid .git pointer and checks out the base branch', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'worker-repo-'));
		const repoWorkPath = path.join(root, 'work', 'repos', 'agent-vm');
		const gitDirPath = '/gitdirs/agent-vm.git';

		await bootstrapRepoWorkDirs([
			{
				repoId: 'agent-vm',
				repoUrl: 'https://github.com/ShravanSunder/agent-vm.git',
				baseBranch: 'main',
				taskBranch: 'agent/task-001',
				repoWorkPath,
				gitDirPath,
			},
		]);

		await expect(readFile(path.join(repoWorkPath, '.git'), 'utf8')).resolves.toBe(
			'gitdir: /gitdirs/agent-vm.git\n',
		);
		expect(execa).toHaveBeenCalledWith(
			'git',
			[
				'-c',
				'core.hooksPath=/dev/null',
				'--git-dir=/gitdirs/agent-vm.git',
				`--work-tree=${repoWorkPath}`,
				'checkout',
				'-B',
				'agent/task-001',
				'main',
			],
			{ reject: true, timeout: 60_000 },
		);
	});
});
```

- [ ] **Step 9: Run repo bootstrap tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/work/repo-bootstrap.test.ts
```

Expected: PASS after implementation.

- [ ] **Step 10: Make controller create host-backed gitdirs**

In `packages/agent-vm/src/controller/worker-task-runner.ts`, change repo
preparation from cloning into a host repo directory to creating gitdirs under the
non-backup `runtimeDir`.

Add or thread a task runtime root from `prepareWorkerTask`, derived from
`systemConfig.runtimeDir`:

```ts
const taskStateRoot = path.join(zone.gateway.stateDir, 'tasks', taskId);
const taskRuntimeRoot = path.join(systemConfig.runtimeDir, 'worker-tasks', zone.id, taskId);
const gitdirsRoot = path.join(taskRuntimeRoot, 'gitdirs');
const repoMetadataRoot = path.join(taskRuntimeRoot, 'repo-metadata');
```

`taskStateRoot` is packable/backed up. `taskRuntimeRoot` is not copied by normal
zone backups. Do not create `gitdirs` under `taskStateRoot` or
`zone.gateway.zoneFilesDir`.

Clone as a bare gitdir. Do not create a temporary full host checkout just to
delete it again:

```ts
const repoGitDir = path.join(gitdirsRoot, `${repo.repoId}.git`);
const cloneArgs = [
	...authArgs,
	'clone',
	'--bare',
	'--branch',
	repo.baseBranch,
	repo.repoUrl,
	repoGitDir,
];
```

The worker VM creates the real `/work/repos/<repoId>` repo files on rootfs/COW
during bootstrap.

Configure the gitdir for explicit work-tree use and keep host-side hook
execution disabled:

```ts
await execa(
	'git',
	[
		'-c',
		'core.hooksPath=/dev/null',
		`--git-dir=${repoGitDir}`,
		'config',
		'core.bare',
		'false',
	],
	{ reject: true, timeout: 10_000 },
);
```

Because there is no host checkout anymore, read repo-local agent-vm metadata
from the bare gitdir instead of from a checkout. Materialize only `.agent-vm/`
into the task runtime metadata directory:

```ts
const repoMetadataDir = path.join(repoMetadataRoot, repo.repoId);
await execa(
	'git',
	[
		'-c',
		'core.hooksPath=/dev/null',
		`--git-dir=${repoGitDir}`,
		'archive',
		repo.baseBranch,
		'.agent-vm',
	],
	{ reject: true, stdout: 'pipe' },
);
```

Pipe the archive into `tar -x -C ${repoMetadataDir}` or use an equivalent
structured extraction helper. Missing `.agent-vm/` should be treated like an
empty repo config. Repo config and repo resource contracts are read from
`repoMetadataDir`, never from a full host checkout.

Do not write VM `.git` pointers on the host. The worker-side bootstrap writes
the VM `.git` file in the rootfs repo files.

For any host-side Git config/ref operation, use the host gitdir explicitly and
disable hooks:

```ts
await execa(
	'git',
	[
		'-c',
		'core.hooksPath=/dev/null',
		`--git-dir=${repoGitDir}`,
		'config',
		key,
		value,
	],
	{ reject: true, timeout: 10_000 },
);
```

Update `ActiveWorkerTaskRepo` and all controller-side push/fetch/default-branch
operations so host Git commands use the host gitdir path directly. Do not rely
on `.git` auto-discovery from a host repo files.

Also update task cleanup so gitdir removal happens only after the controller has
checked for dirty files and unpushed commits. The cleanup path must report a
clear recovery decision when work is not safely pushed:

```ts
type TaskCleanupDecision =
	| { readonly kind: 'delete'; readonly reason: 'clean-and-pushed' }
	| {
			readonly kind: 'retain';
			readonly reason: 'failed-task' | 'dirty-repo-files' | 'unpushed-commits';
	  }
	| { readonly kind: 'export'; readonly artifactPath: string };
```

- [ ] **Step 11: Pass repo work metadata to worker config**

When building `effectiveConfig`, include:

```ts
repoWorkDirectories: clonedRepos.map((repo) => ({
	repoId: repo.repoId,
	repoUrl: repo.repoUrl,
	baseBranch: repo.baseBranch,
	taskBranch: `agent/${taskId}`,
	repoWorkPath: `/work/repos/${repo.repoId}`,
	gitDirPath: `/gitdirs/${repo.repoId}.git`,
})),
```

- [ ] **Step 12: Mount gitdirs into the worker VM**

Return a VFS override from task preparation:

```ts
vfsMounts: {
	'/agent-vm': {
		hostPath: agentVmDir,
		kind: 'realfs-readonly',
	},
	'/gitdirs': {
		hostPath: gitdirsRoot,
		kind: 'realfs',
	},
},
```

- [ ] **Step 13: Stop mounting `/work/repos` as RealFS in worker lifecycle**

In `packages/worker-gateway/src/worker-lifecycle.ts`, remove the worker repo RealFS mount and keep `/state`.

Expected VFS base mounts:

```ts
vfsMounts: {
	'/state': {
		hostPath: zone.gateway.stateDir,
		kind: 'realfs',
	},
},
```

Task-specific override mounts will add `/gitdirs` and `/agent-vm`.

- [ ] **Step 14: Wire rootfs temp/cache environment for workers**

In `packages/worker-gateway/src/worker-lifecycle.ts`, create the rootfs-backed
large temp/cache paths and set environment variables before the worker process
starts:

```bash
mkdir -p /work/tmp /work/cache/npm /work/cache/pnpm/store /work/cache/pip /work/cache/uv
cat >/etc/profile.d/agent-vm-workdir.sh <<'EOF'
export TMPDIR=/work/tmp
export TMP=/work/tmp
export TEMP=/work/tmp
export npm_config_cache=/work/cache/npm
export pnpm_config_store_dir=/work/cache/pnpm/store
export PIP_CACHE_DIR=/work/cache/pip
export UV_CACHE_DIR=/work/cache/uv
EOF
```

Also set these values in the worker process environment so subprocesses launched
by `agent-vm-worker` inherit them even when they do not run an interactive shell.

- [ ] **Step 15: Call repo bootstrap from coordinator startup**

In `packages/agent-vm-worker/src/coordinator/coordinator.ts`, import and call:

```ts
import { bootstrapRepoWorkDirs } from '../work/repo-bootstrap.js';
```

Before task phases begin:

```ts
await bootstrapRepoWorkDirs(config.repoWorkDirectories);
```

- [ ] **Step 16: Run targeted tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/backup/backup-create-operation.test.ts packages/agent-vm-worker/src/config/worker-config.test.ts packages/agent-vm-worker/src/work/repo-bootstrap.test.ts packages/worker-gateway/src/worker-lifecycle.test.ts packages/agent-vm/src/controller/worker-task-runner.test.ts
```

Expected: PASS.

- [ ] **Step 17: Commit**

```bash
git add packages/agent-vm/src/config/system-config.ts packages/agent-vm/src/config/system-config.test.ts packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/backup/backup-create-operation.ts packages/agent-vm/src/backup/backup-create-operation.test.ts packages/agent-vm-worker/src/config/worker-config.ts packages/agent-vm-worker/src/config/worker-config.test.ts packages/agent-vm-worker/src/work/repo-bootstrap.ts packages/agent-vm-worker/src/work/repo-bootstrap.test.ts packages/agent-vm-worker/src/coordinator/coordinator.ts packages/worker-gateway/src/worker-lifecycle.ts packages/worker-gateway/src/worker-lifecycle.test.ts packages/agent-vm/src/controller/worker-task-runner.ts packages/agent-vm/src/controller/worker-task-runner.test.ts docs/reference/configuration/system-json.md
git commit -m "feat: use rootfs worker work dir with RealFS gitdirs

Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 4: Add Doctor Checks For Storage Layout Drift

**Files:**
- Modify: `packages/agent-vm/src/operations/doctor.ts`
- Test: `packages/agent-vm/src/operations/doctor.test.ts`

- [ ] **Step 1: Add failing doctor test for OpenClaw plugin deps**

Add a test asserting doctor reports an actionable error when the OpenClaw image profile does not contain baked plugin deps:

```ts
it('reports missing baked OpenClaw plugin runtime deps with a rebuild hint', async () => {
	const report = await runDoctor(createSystemConfigWithOpenClawZone(), {
		fileExists: (filePath) => !filePath.includes('/opt/openclaw/plugin-runtime-deps'),
	});

	expect(report.findings).toContainEqual(
		expect.objectContaining({
			severity: 'error',
			title: 'OpenClaw plugin runtime deps are not baked into the gateway image',
			hint: 'Run pnpm build to rebuild the gateway image before starting the controller.',
		}),
	);
});
```

- [ ] **Step 2: Implement the doctor finding**

In `packages/agent-vm/src/operations/doctor.ts`, add a check that verifies the current OpenClaw gateway image has the expected plugin runtime stage marker:

```ts
const openClawPluginRuntimeDepsMarkerPath =
	'/opt/openclaw/plugin-runtime-deps/.openclaw-runtime-deps.json';
```

If the marker is missing, report:

```ts
{
	severity: 'error',
	title: 'OpenClaw plugin runtime deps are not baked into the gateway image',
	hint: 'Run pnpm build to rebuild the gateway image before starting the controller.',
}
```

- [ ] **Step 3: Add worker storage policy doctor test**

Add a test asserting worker zones do not mount `/work/repos` as RealFS:

```ts
it('reports worker work area RealFS mounts as a performance risk', async () => {
	const report = await runDoctor(createSystemConfigWithWorkerZoneUsingRealFsWorkspace());

	expect(report.findings).toContainEqual(
		expect.objectContaining({
			severity: 'warning',
			title: 'Worker work area is mounted through RealFS',
			hint: 'Use VM-local repo files with RealFS gitdirs for package-manager-heavy tasks.',
		}),
	);
});
```

- [ ] **Step 4: Implement worker storage policy finding**

In `packages/agent-vm/src/operations/doctor.ts`, inspect the effective worker
gateway VM spec and task override policy. Warn if `/work/repos` appears in
`vfsMounts`, or if any worker task gitdir path is configured under `stateDir` or
under the zone's normal backup-copied zone files directory.

- [ ] **Step 5: Run targeted doctor tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/operations/doctor.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/operations/doctor.ts packages/agent-vm/src/operations/doctor.test.ts
git commit -m "feat: diagnose storage layout drift

Co-authored-by: Codex <noreply@openai.com>"
```

---

## Task 5: Validate With Local Benchmarks And Real Boot

**Files:**
- Modify: `docs/wip/vfs-design.md`
- Modify: `docs/wip/startup-issues.md`

- [ ] **Step 1: Re-run the local Gondolin VFS benchmark**

Run:

```bash
pnpm perf:gondolin-vfs -- \
  --gondolin-repo /path/to/gondolin \
  --image-path /path/to/built/gondolin/assets \
  --rootfs-modes cow,memory,readonly \
  --samples 3 \
  --warmup-samples 1 \
  --json-out tmp/gondolin-vfs-validation.json

pnpm perf:worker-git -- \
  --gondolin-repo /path/to/gondolin \
  --image-path /path/to/built/gondolin/assets \
  --samples 3 \
  --warmup-samples 1 \
  --json-out tmp/gondolin-worker-git-validation.json
```

Expected: VFS output includes rootfs, guest tmpfs, MemoryProvider, RealFS,
repo RealFS, and ShadowProvider cases. Worker Git output includes:

```text
full-rootfs
full-realfs
rootfs-work-realfs-gitdir
fresh-bootstrap-realfs-gitdir-to-rootfs-work
```

Before treating the numbers as acceptance evidence, make sure both perf scripts
call the mount assertion helper for their RealFS and gitdir mounts. The worker
Git benchmark should either use a fresh VM per layout or explicitly record the
caveat that a single VM's rootfs/COW overlay accumulates churn across layouts.
The fresh-bootstrap case must time the first checkout from a populated RealFS
gitdir into a rootfs/COW repo files, because that is the setup cost paid once per
task and the earlier synthetic git benchmark did not measure it.

- [ ] **Step 2: Build agent-vm**

Run:

```bash
pnpm build
```

Expected: exits 0.

- [ ] **Step 3: Run full checks**

Run:

```bash
pnpm check
pnpm test:unit
pnpm test:integration
```

Expected: all exit 0.

- [ ] **Step 4: Build shravan-claw images from the local agent-vm branch**

From `/Users/shravansunder/Documents/dev/project-dev/shravan-claw`, run the catalog build using the local built agent-vm CLI:

```bash
node /Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/dist/cli/agent-vm-entrypoint.js build --config config/system.json
```

Expected: OpenClaw gateway image builds and logs the OpenClaw plugin runtime deps staging step during build, not during controller start.

- [ ] **Step 5: Enable Discord explicitly in shravan-claw test config**

For the local test only, configure `config/gateways/shravan/openclaw.json` with a real Discord block using the existing secret reference pattern. Do not commit household secrets.

Expected config shape:

```json
{
	"channels": {
		"discord": {
			"enabled": true,
			"token": { "source": "env", "provider": "agent-vm", "id": "DISCORD_BOT_TOKEN" },
			"groupPolicy": "allowlist",
			"contextVisibility": "allowlist"
		}
	}
}
```

- [ ] **Step 6: Boot OpenClaw with Discord**

Run:

```bash
node /Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/dist/cli/agent-vm-entrypoint.js controller start --config config/system.json --zone shravan
```

Expected:

```text
Waiting for readiness done
Controller API on :18800 done
```

OpenClaw log should not contain:

```text
staging bundled runtime deps before gateway startup
```

- [ ] **Step 7: Capture boot timings**

Run:

```bash
node /Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/dist/cli/agent-vm-entrypoint.js controller logs --config config/system.json --zone shravan
```

Expected log contains:

```text
[gateway] ready
```

Record the time from config load to ready in `docs/wip/startup-issues.md`.

- [ ] **Step 8: Stop controller and verify cleanup**

Run:

```bash
node /Users/shravansunder/Documents/dev/project-dev/agent-vm/packages/agent-vm/dist/cli/agent-vm-entrypoint.js controller stop --config config/system.json
pgrep -af 'qemu-system|agent-vm-entrypoint|openclaw|gondolin' || true
```

Expected: stop returns `{ "ok": true }` and no stale processes remain.

- [ ] **Step 9: Commit docs updates**

```bash
git add docs/wip/vfs-design.md docs/wip/startup-issues.md
git commit -m "docs: record storage performance validation

Co-authored-by: Codex <noreply@openai.com>"
```

---

## Self-Review

Spec coverage:

- OpenClaw Discord/plugin startup is covered by Task 2 and Task 5.
- Worker rootfs `/work/repos` plus RealFS gitdir is covered by Task 3.
- Empirical VFS/rootfs benchmarking is covered by Task 1 and Task 5.
- Doctor/build guardrails are covered by Task 4.
- Documentation is covered by Task 1 and Task 5.

Placeholder scan:

- No `TBD`, `TODO`, `implement later`, or empty test instructions remain.

Type consistency:

- `RepoWorkDirectory` fields match the planned `repoWorkDirectories` schema.
- `repoWorkPath` and `gitDirPath` are used consistently in controller metadata and worker bootstrap.
- OpenClaw plugin stage path is consistently `/opt/openclaw/plugin-runtime-deps`.
