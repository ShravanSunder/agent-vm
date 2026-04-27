# Storage and VFS Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move hot runtime/package-manager work off Gondolin RealFS while preserving host-visible durable state, repairable caches, git metadata, backups, and controller-owned push/auth boundaries.

**Architecture:** OpenClaw gateway images should carry stable hot runtime dependencies in the VM rootfs, while packable state stays on RealFS and repairable caches stay under cacheDir. OpenClaw's current RealFS `/home/openclaw/workspace` is a durable shared-files area, not the same storage class as a worker workspace. Worker tasks should use a VM-local rootfs/COW workspace for fast source/package/build operations, with a host-backed separate gitdir mounted through RealFS from a non-backup task runtime root so commits and refs survive for recovery/push without being swallowed by normal zone backups.

**Tech Stack:** TypeScript, pnpm, Vitest, Gondolin VFS providers, OpenClaw bundled plugin runtime deps, Git `--separate-git-dir`, Node 24.

---

## Storage Model Decisions

### OpenClaw Gateway

Runtime code and bundled plugin runtime dependencies are hot read paths. They belong in the VM image/rootfs, not in a RealFS-mounted cache as the normal boot path.

Durable household state belongs in RealFS stateDir and is included in backups.

Repairable heavy artifacts belong in RealFS cacheDir and are not included in backups.

The OpenClaw path currently named `/home/openclaw/workspace` is durable shared
files, not a worker-style hot workspace. In docs and new code, call this
storage class "OpenClaw shared files" or `sharedFilesDir`. Reserve "workspace"
for VM-local rootfs/COW execution work unless code is referring to the existing
config field that still says `workspaceDir`.

### Worker Gateway

The worker workspace should become VM-local rootfs/COW storage for speed. This includes source files, package manager installs, `node_modules`, build outputs, and normal editor/search/test operations.

The git database should live outside the worktree as a separate RealFS-backed gitdir. It must not live under `stateDir`, and it must not live under any directory copied by normal zone backups. Git inside the VM still works through `.git` pointing to the mounted gitdir. The controller still owns push credentials and default-branch operations.

Worker state is packable/backed up. It may contain task event logs, effective
worker config, and generated runtime metadata. It must not contain repos,
worktrees, `node_modules`, package-manager caches, build outputs, test outputs,
large temp files, or git object databases.

Use per-task gitdirs for the first implementation. A shared bare repo cache is
a later optimization; it has harder ref-isolation and cleanup semantics and is
not required to fix the current storage-class bug.

Worker gitdirs live under a non-backup task runtime root derived from
`cacheDir`, for example:

```text
<cacheDir>/worker-tasks/<zoneId>/<taskId>/gitdirs/<repoId>.git
```

This path is not semantically "cache" when it contains unpushed commits; it is
task runtime/recovery state. The important property for this plan is that
normal `backup create` does not copy it. Unpushed work must be preserved through
an explicit recovery/export path, not through silent zone backup bloat.

The controller owns the gitdir lifecycle. After a task pushes successfully, the
controller cleans up the gitdir. If the task has unpushed commits, dirty files,
or a failed terminal state, cleanup must stop at an explicit push/export/discard
decision. This is a task lifecycle guardrail, not a backup responsibility.

Every host-side Git invocation against a worker gitdir must use explicit
`--git-dir=<host gitdir>` and must disable hooks with
`-c core.hooksPath=/dev/null`. Never rely on the host worktree `.git` file for
auto-discovery, because the worker `.git` pointer is a VM path.

Worker rootfs worktrees are ephemeral execution state. The first implementation
does not promise active-task checkpoint/restore across an externally mutated
gitdir. Bootstrap should be idempotent for a fresh rootfs worktree, and later
checkpoint support must define how rootfs worktree state and external RealFS
gitdir state are reconciled.

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

  Owns worker VM base mounts and process startup. Mount task gitdirs as RealFS while keeping `/workspace` on rootfs.

`packages/worker-gateway/src/worker-lifecycle.test.ts`

  Verifies `/workspace` is no longer a RealFS mount and `/gitdirs` is a RealFS mount.

`packages/agent-vm/src/controller/worker-task-runner.ts`

  Owns task preparation. Change repo clone/setup to create a separate gitdir under the non-backup task runtime root and arrange rootfs worktree checkout inside the worker VM.

`packages/agent-vm/src/controller/worker-task-runner.test.ts`

  Verifies task prep creates gitdir metadata, exposes gitdirs to the VM, and gives the worker enough information to check out repos into rootfs.

`packages/agent-vm-worker/src/workspace/worktree-bootstrap.ts`

  New worker-side module. On worker startup, creates `/workspace/<repoId>` rootfs worktrees using `/gitdirs/<repoId>.git`.

`packages/agent-vm-worker/src/workspace/worktree-bootstrap.test.ts`

  Unit tests for `.git` pointer creation and checkout command composition.

`packages/agent-vm-worker/src/coordinator/coordinator.ts`

  Calls worktree bootstrap before starting plan/work/wrapup phases.

`packages/agent-vm-worker/src/config/worker-config.ts`

  Adds explicit repo gitdir/worktree bootstrap metadata to the worker config schema.

`docs/architecture/storage-model.md`

  Documents the storage model with progressive disclosure: rootfs/image, RealFS state, RealFS cache, RealFS gitdir, tmpfs, VFS provider limits, backups.

`docs/reference/gondolin/vfs-rootfs-performance.md`

  Documents Gondolin rootfs modes, guest tmpfs, VFS providers, path policy, benchmark usage, current local results, and source references.

`../shravan-claw/docs/wip/vfs-design.md`

  Records empirical benchmark results and marks prior unmeasured assumptions as hypotheses.

`scripts/perf/gondolin-vfs-benchmark.ts`

  Reproducible benchmark harness for running the same rootfs/VFS comparison on other machines and Gondolin checkouts.

`scripts/perf/gondolin-worker-git-benchmark.ts`

  Reproducible benchmark harness for worker git/worktree layouts. It compares full rootfs, full RealFS, and rootfs worktree plus RealFS gitdir.

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
VM-local rootfs worktrees are for worker source/package/build operations.
Kernel tmpfs is for scratch.
Gondolin MemoryProvider and ShadowProvider are isolation tools, not faster
package-tree storage than rootfs.
```

- [x] **Step 2: Link the architecture/reference docs from the docs map**

Modify `docs/README.md` and include the storage model and Gondolin performance
reference in the reading paths/doc tree.

Expected inserted line:

```markdown
- `architecture/storage-model.md` — storage classes, VFS mount policy, backup boundaries, and worker gitdir/worktree model.
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
				workspaceDir: '/host/workspaces/shravan',
			},
		}),
	});

	expect(vmSpec.environment.OPENCLAW_PLUGIN_STAGE_DIR).toBe(
		'/opt/openclaw/plugin-runtime-deps',
	);
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

- [ ] **Step 4: Run the lifecycle test**

Run:

```bash
pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add build-command test for pre-staging**

Add a test in `packages/agent-vm/src/cli/build-command.test.ts` that creates an OpenClaw gateway image target and asserts the generated Docker build context or build step includes:

```bash
OPENCLAW_PLUGIN_STAGE_DIR=/opt/openclaw/plugin-runtime-deps openclaw doctor --fix --non-interactive
```

The assertion should match the exact command string emitted by the implementation.

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

Insert that command after OpenClaw is installed in the image and before the image is finalized. The command must run without secrets and must not use the runtime stateDir.

This command path was checked against DeepWiki for `openclaw/openclaw`: bundled
plugin runtime dependency repair flows through `openclaw doctor --fix
--non-interactive`, and `OPENCLAW_PLUGIN_STAGE_DIR` controls the standalone
install root. Keep a local/source verification step in the implementation PR so
the exact OpenClaw version used by the catalog is still grounded in code.

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

## Task 3: Add Worker Rootfs Worktree With RealFS Gitdir

**Files:**
- Modify: `packages/agent-vm/src/controller/worker-task-runner.ts`
- Test: `packages/agent-vm/src/controller/worker-task-runner.test.ts`
- Modify: `packages/agent-vm-worker/src/config/worker-config.ts`
- Test: `packages/agent-vm-worker/src/config/worker-config.test.ts`
- Create: `packages/agent-vm-worker/src/workspace/worktree-bootstrap.ts`
- Create: `packages/agent-vm-worker/src/workspace/worktree-bootstrap.test.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/coordinator.ts`

- [ ] **Step 1: Extend worker config schema with repo checkout metadata**

In `packages/agent-vm-worker/src/config/worker-config.ts`, add:

```ts
const repoCheckoutSchema = z.object({
	repoId: z.string().min(1),
	repoUrl: z.string().min(1),
	baseBranch: z.string().min(1),
	worktreePath: z.string().min(1),
	gitDirPath: z.string().min(1),
});
```

Add to `workerConfigSchema`:

```ts
repoCheckouts: z.array(repoCheckoutSchema).default([]),
```

- [ ] **Step 2: Add config schema test**

In `packages/agent-vm-worker/src/config/worker-config.test.ts`, add:

```ts
it('parses repo checkout metadata', () => {
	const config = workerConfigSchema.parse({
		repoCheckouts: [
			{
				repoId: 'agent-vm',
				repoUrl: 'https://github.com/ShravanSunder/agent-vm.git',
				baseBranch: 'main',
				worktreePath: '/workspace/agent-vm',
				gitDirPath: '/gitdirs/agent-vm.git',
			},
		],
	});

	expect(config.repoCheckouts).toEqual([
		{
			repoId: 'agent-vm',
			repoUrl: 'https://github.com/ShravanSunder/agent-vm.git',
			baseBranch: 'main',
			worktreePath: '/workspace/agent-vm',
			gitDirPath: '/gitdirs/agent-vm.git',
		},
	]);
});
```

- [ ] **Step 3: Run config test to verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/config/worker-config.test.ts
```

Expected: FAIL before schema implementation, PASS after schema implementation.

- [ ] **Step 4: Create worktree bootstrap module**

Create `packages/agent-vm-worker/src/workspace/worktree-bootstrap.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

export interface RepoCheckout {
	readonly repoId: string;
	readonly repoUrl: string;
	readonly baseBranch: string;
	readonly worktreePath: string;
	readonly gitDirPath: string;
}

export async function bootstrapRepoWorktrees(
	repoCheckouts: readonly RepoCheckout[],
): Promise<void> {
	for (const repoCheckout of repoCheckouts) {
		await bootstrapRepoWorktree(repoCheckout);
	}
}

async function bootstrapRepoWorktree(repoCheckout: RepoCheckout): Promise<void> {
	await mkdir(repoCheckout.worktreePath, { recursive: true });
	await writeFile(
		path.join(repoCheckout.worktreePath, '.git'),
		`gitdir: ${repoCheckout.gitDirPath}\n`,
		{ encoding: 'utf8', mode: 0o644 },
	);
	await execa(
		'git',
		[
			'-c',
			'core.hooksPath=/dev/null',
			`--git-dir=${repoCheckout.gitDirPath}`,
			`--work-tree=${repoCheckout.worktreePath}`,
			'checkout',
			'-f',
			repoCheckout.baseBranch,
		],
		{ reject: true, timeout: 60_000 },
	);
}
```

- [ ] **Step 5: Add worktree bootstrap tests**

Create `packages/agent-vm-worker/src/workspace/worktree-bootstrap.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapRepoWorktrees } from './worktree-bootstrap.js';

vi.mock('execa', () => ({
	execa: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

describe('bootstrapRepoWorktrees', () => {
	it('writes a VM-valid .git pointer and checks out the base branch', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'worker-worktree-'));
		const worktreePath = path.join(root, 'workspace', 'agent-vm');
		const gitDirPath = '/gitdirs/agent-vm.git';

		await bootstrapRepoWorktrees([
			{
				repoId: 'agent-vm',
				repoUrl: 'https://github.com/ShravanSunder/agent-vm.git',
				baseBranch: 'main',
				worktreePath,
				gitDirPath,
			},
		]);

		await expect(readFile(path.join(worktreePath, '.git'), 'utf8')).resolves.toBe(
			'gitdir: /gitdirs/agent-vm.git\n',
		);
		expect(execa).toHaveBeenCalledWith(
			'git',
			[
				'-c',
				'core.hooksPath=/dev/null',
				'--git-dir=/gitdirs/agent-vm.git',
				`--work-tree=${worktreePath}`,
				'checkout',
				'-f',
				'main',
			],
			{ reject: true, timeout: 60_000 },
		);
	});
});
```

- [ ] **Step 6: Run worktree bootstrap tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/workspace/worktree-bootstrap.test.ts
```

Expected: PASS after implementation.

- [ ] **Step 7: Make controller create host-backed gitdirs**

In `packages/agent-vm/src/controller/worker-task-runner.ts`, change repo preparation from cloning into the host workspace to creating gitdirs under a non-backup task runtime root.

Add or thread a task runtime root from `prepareWorkerTask`, derived from
`systemConfig.cacheDir`:

```ts
const taskStateRoot = path.join(zone.gateway.stateDir, 'tasks', taskId);
const taskRuntimeRoot = path.join(systemConfig.cacheDir, 'worker-tasks', zone.id, taskId);
const gitdirsRoot = path.join(taskRuntimeRoot, 'gitdirs');
```

`taskStateRoot` is packable/backed up. `taskRuntimeRoot` is not copied by normal
zone backups. Do not create `gitdirs` under `taskStateRoot` or
`zone.gateway.workspaceDir`.

Clone into a temporary host worktree only long enough to create/populate the
separate gitdir:

```ts
const repoGitDir = path.join(gitdirsRoot, `${repo.repoId}.git`);
const hostBootstrapWorktreePath = path.join(taskRuntimeRoot, 'bootstrap-worktrees', repo.repoId);
const cloneArgs = [
	...authArgs,
	'clone',
	'--branch',
	repo.baseBranch,
	'--separate-git-dir',
	repoGitDir,
	repo.repoUrl,
	hostBootstrapWorktreePath,
];
```

After clone, remove the temporary bootstrap worktree. The durable part is the
gitdir. The worker VM creates the real `/workspace/<repoId>` worktree on
rootfs/COW during bootstrap.

Do not write VM `.git` pointers on the host bootstrap worktree as a source of
truth. The worker-side bootstrap writes the VM `.git` file.

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
on `.git` auto-discovery from a host worktree.

Also update task cleanup so gitdir removal happens only after the controller has
checked for dirty files and unpushed commits. The cleanup path must report a
clear recovery decision when work is not safely pushed:

```text
push
export recovery artifact
discard
```

- [ ] **Step 8: Pass checkout metadata to worker config**

When building `effectiveConfig`, include:

```ts
repoCheckouts: clonedRepos.map((repo) => ({
	repoId: repo.repoId,
	repoUrl: repo.repoUrl,
	baseBranch: repo.baseBranch,
	worktreePath: repo.workspacePath,
	gitDirPath: `/gitdirs/${repo.repoId}.git`,
})),
```

- [ ] **Step 9: Mount gitdirs into the worker VM**

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

- [ ] **Step 10: Stop mounting `/workspace` as RealFS in worker lifecycle**

In `packages/worker-gateway/src/worker-lifecycle.ts`, remove the `/workspace` RealFS mount and keep `/state`.

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

- [ ] **Step 11: Call worktree bootstrap from coordinator startup**

In `packages/agent-vm-worker/src/coordinator/coordinator.ts`, import and call:

```ts
import { bootstrapRepoWorktrees } from '../workspace/worktree-bootstrap.js';
```

Before task phases begin:

```ts
await bootstrapRepoWorktrees(config.repoCheckouts);
```

- [ ] **Step 12: Run targeted tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/config/worker-config.test.ts packages/agent-vm-worker/src/workspace/worktree-bootstrap.test.ts packages/worker-gateway/src/worker-lifecycle.test.ts packages/agent-vm/src/controller/worker-task-runner.test.ts
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/agent-vm-worker/src/config/worker-config.ts packages/agent-vm-worker/src/config/worker-config.test.ts packages/agent-vm-worker/src/workspace/worktree-bootstrap.ts packages/agent-vm-worker/src/workspace/worktree-bootstrap.test.ts packages/agent-vm-worker/src/coordinator/coordinator.ts packages/worker-gateway/src/worker-lifecycle.ts packages/worker-gateway/src/worker-lifecycle.test.ts packages/agent-vm/src/controller/worker-task-runner.ts packages/agent-vm/src/controller/worker-task-runner.test.ts
git commit -m "feat: use rootfs worker worktrees with RealFS gitdirs

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

Add a test asserting worker zones do not mount `/workspace` as RealFS:

```ts
it('reports worker workspace RealFS mounts as a performance risk', async () => {
	const report = await runDoctor(createSystemConfigWithWorkerZoneUsingRealFsWorkspace());

	expect(report.findings).toContainEqual(
		expect.objectContaining({
			severity: 'warning',
			title: 'Worker workspace is mounted through RealFS',
			hint: 'Use VM-local worktrees with RealFS gitdirs for package-manager-heavy tasks.',
		}),
	);
});
```

- [ ] **Step 4: Implement worker storage policy finding**

In `packages/agent-vm/src/operations/doctor.ts`, inspect the effective worker
gateway VM spec and task override policy. Warn if `/workspace` appears in
`vfsMounts`, or if any worker task gitdir path is configured under `stateDir` or
under the zone's normal backup-copied shared files directory.

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
workspace RealFS, and ShadowProvider cases. Worker Git output includes:

```text
full-rootfs
full-realfs
rootfs-worktree-realfs-gitdir
```

Before treating the numbers as acceptance evidence, make sure both perf scripts
call the mount assertion helper for their RealFS and gitdir mounts. The worker
Git benchmark should either use a fresh VM per layout or explicitly record the
caveat that a single VM's rootfs/COW overlay accumulates churn across layouts.

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
- Worker rootfs workspace plus RealFS gitdir is covered by Task 3.
- Empirical VFS/rootfs benchmarking is covered by Task 1 and Task 5.
- Doctor/build guardrails are covered by Task 4.
- Documentation is covered by Task 1 and Task 5.

Placeholder scan:

- No `TBD`, `TODO`, `implement later`, or empty test instructions remain.

Type consistency:

- `RepoCheckout` fields match the planned `repoCheckouts` schema.
- `worktreePath` and `gitDirPath` are used consistently in controller metadata and worker bootstrap.
- OpenClaw plugin stage path is consistently `/opt/openclaw/plugin-runtime-deps`.
