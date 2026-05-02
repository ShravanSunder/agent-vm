# Relay Core Backports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Relay changes that improve standalone `agent-vm` correctness while leaving Relay-only KVM, Kubernetes, ECR, and deploy workflow concerns out of the personal repo.

**Architecture:** Implement the portable core improvements in order: runtime-aware Git path handling, cancellable Git retry backoff, controller git retry phase correctness, repo resource contract semantics, cache compatibility identity, and small generic coverage/utility backports. Keep each boundary explicit: worker task-state owns replay shape, controller Git helpers own host-side Git invocation, the controller resource pipeline owns repo-local code execution policy, and system cache identity owns image fingerprint salt semantics.

**Tech Stack:** TypeScript, Node 24, pnpm, Vitest, Zod, Oxfmt/Oxlint.

---

## Scope

Port from Relay:

- PR #53: preserve `controller-git-push-retry.phase`.
- PR #67: make worker/controller git commands runtime-aware across VM worktrees and host gitdirs.
- Relay `d3af6a9`: keep Git retry sleeps cancellable through `AbortSignal`.
- Relay `1d60ef4`: preserve precise retry metadata so non-retryable push failures do not advertise retry-after guidance.
- PR #66: missing repo resource contract means no contract; `allowRepoResources: false` skips repo-local contract code; external resources still reach finalizers.
- PR #65: replace generated `gitSha` cache identity defaults with stable cache compatibility fields.
- Relay heartbeat sender test coverage adapted to personal's generic `callerUrl`/`requestTaskId` naming.
- Relay Zig compatibility helper shape adapted without Relay package names.

Do not port:

- KVM worker host image startup scripts.
- `prebuilt-gondolin-cache.tar.zst` archive packaging.
- Kubernetes pod spec, device plugin, ECR, OIDC, or Relay workflow changes.
- Optional `systemCacheIdentifier.json` behavior. Keep the file required in this pass; change only its default semantics.
- Relay's worker-runner file split. Personal still has one worker task runner; split only when a second runner shape forces it.

Validated but deferred:

- `GitPushOperationError`/`GitCommandFailureError` hierarchy cleanup. Useful structural hygiene, but Task 6 is scoped to resource preparation errors and does not require broad Git error refactoring.
- Zod validation in `git-pull-default-tool.ts`, `controllerToolFailureArtifact()` response-shape cleanup, and defensive `response.text()` handling. These are good boundary-hardening follow-ups, but not needed for the core backport set.

Safety note: commit steps below are checkpoints for the eventual implementer. Do not run `git commit` unless the user has explicitly authorized git write operations.

## File Map

- Modify `packages/agent-vm-worker/src/state/task-event-types.ts`
  - Owns task event schema. Add a reusable git push phase schema and require `phase` on retry events.
- Modify `packages/agent-vm-worker/src/state/task-state.ts`
  - Owns replay/reducer state. Replay retry phase from the event instead of hardcoding `push`.
- Modify `packages/agent-vm-worker/src/state/task-state.test.ts`
  - Covers retry replay for `post-push-fetch`.
- Modify `packages/agent-vm-worker/src/coordinator/task-runner.ts`
  - Reuses scoped `safe.directory` environment for wrapup Git context commands.
- Modify `packages/agent-vm-worker/src/coordinator/task-runner.test.ts`
  - Covers wrapup Git context commands using scoped safe Git environment.
- Modify `packages/agent-vm-worker/src/work-phase/controller-tools/controller-tool-support.ts`
  - Exposes `buildSafeGitEnvironment()` and uses it for branch reads.
- Modify `packages/agent-vm-worker/src/work-phase/controller-tools/controller-tools.test.ts`
  - Covers safe Git environment on controller tool worktree reads.
- Modify `packages/agent-vm-worker/src/work-phase/controller-tools/git-pull-default-tool.ts`
  - Uses safe Git environment for HEAD/status/reset commands.
- Create `packages/agent-vm/src/controller/host-git-command.ts`
  - Builds host-side Git arguments with both `--git-dir` and host-visible `--work-tree`.
- Create `packages/agent-vm/src/controller/host-git-command.test.ts`
  - Verifies real Git ignores VM-only `core.worktree` when host args provide a host-visible worktree.
- Modify `packages/agent-vm/src/controller/git-pull-default-operations.ts`
  - Uses `buildHostGitArgs()` for host-side git operations and threads abort signals through retrying Git calls.
- Modify `packages/agent-vm/src/controller/git-pull-default-operations.test.ts`
  - Updates git arg normalization and asserts host worktree.
- Modify `packages/agent-vm/src/controller/git-retry-support.ts`
  - Makes default retry backoff abortable and passes `AbortSignal` to retry attempts.
- Modify `packages/agent-vm/src/controller/git-retry-support.test.ts`
  - Covers signal propagation and aborting while sleeping between retry attempts.
- Modify `packages/agent-vm/src/controller/git-push-operations.ts`
  - Emits `phase: 'push'` for push retry events and keeps retry-after metadata limited to exhausted transient retries.
- Modify `packages/agent-vm/src/controller/git-push-operations.test.ts`
  - Covers retry event phase and no retry-after metadata for non-retryable failures.
- Create `packages/agent-vm/src/controller/heartbeat-sender.test.ts`
  - Covers existing heartbeat sender cadence, terminal responses, bounded warning escalation, and stop/abort behavior.
- Create `packages/agent-vm/src/build/zig-compatibility.ts`
  - Centralizes Gondolin Zig minimum-version compatibility checks.
- Create `packages/agent-vm/src/build/zig-compatibility.test.ts`
  - Covers installed/missing/outdated Zig compatibility outcomes.
- Modify `packages/agent-vm/src/cli/build-command.ts`
  - Uses the shared Zig compatibility helper for build prerequisite checks.
- Modify `packages/agent-vm/src/operations/doctor.ts`
  - Reuses shared Zig compatibility helpers instead of owning version comparison separately.
- Modify `packages/agent-vm/src/resources/repo-resource-contract-loader.ts`
  - Return `null` when `.agent-vm/repo-resources.ts` is absent.
- Modify `packages/agent-vm/src/resources/repo-resource-contract-loader.test.ts`
  - Covers absent contract returning `null`.
- Modify `packages/agent-vm/src/controller/worker-task-runner.ts`
  - Skip repo contract loading when repo resources are disabled; filter absent contracts; pass selected external resources into provider setup.
- Modify `packages/agent-vm/src/controller/worker-task-runner.test.ts`
  - Covers disabled repo-local contracts and mixed bare/contract repos.
- Modify `packages/agent-vm/src/resources/repo-resource-provider-runner.ts`
  - Accept selected external resources for each repo and include them in `finalizeRepoResourceSetup`.
- Modify `packages/agent-vm/src/resources/repo-resource-provider-runner.test.ts`
  - Covers no-op empty repo setup and external resource finalization.
- Modify `packages/agent-vm/src/resources/resource-resolver.test.ts`
  - Covers external resources when repo-local providers are disabled.
- Modify `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`
  - Flatten nested `AggregateError`/cause-chain messages for preparation failures.
- Modify `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
  - Covers actionable nested resource error detail.
- Modify `packages/agent-vm/src/config/system-cache-identifier.ts`
  - Replace generated `gitSha` defaults with `cacheProfile` and `cacheFormat`.
- Modify `packages/agent-vm/src/config/system-cache-identifier.test.ts`
  - Covers new defaults while preserving permissive loader behavior.
- Modify `packages/agent-vm/src/cli/init-command.test.ts`
  - Updates scaffolded identifier expectations.
- Modify `packages/agent-vm/src/cli/vm-host-system-templates.ts`
  - Removes generated `ARG GIT_SHA` rewrite block.
- Modify `packages/agent-vm/src/cli/vm-host-system-templates.test.ts`
  - Asserts generated Dockerfile does not use `GIT_SHA` or rewrite the identifier.
- Modify docs:
  - `docs/reference/configuration/system-cache-identifier.md`
  - `docs/reference/configuration/resource-contracts.md`
  - `docs/reference/configuration/system-json.md`

---

### Task 1: Make Git Operations Runtime-Aware

**Files:**
- Modify: `packages/agent-vm-worker/src/work-phase/controller-tools/controller-tool-support.ts`
- Modify: `packages/agent-vm-worker/src/work-phase/controller-tools/git-pull-default-tool.ts`
- Modify: `packages/agent-vm-worker/src/work-phase/controller-tools/controller-tools.test.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/task-runner.ts`
- Create: `packages/agent-vm-worker/src/coordinator/task-runner.test.ts`
- Create: `packages/agent-vm/src/controller/host-git-command.ts`
- Create: `packages/agent-vm/src/controller/host-git-command.test.ts`
- Modify: `packages/agent-vm/src/controller/git-push-operations.ts`
- Modify: `packages/agent-vm/src/controller/git-push-operations.test.ts`
- Modify: `packages/agent-vm/src/controller/git-pull-default-operations.ts`
- Modify: `packages/agent-vm/src/controller/git-pull-default-operations.test.ts`
- Modify: `packages/agent-vm/src/controller/git-retry-support.ts`
- Modify: `packages/agent-vm/src/controller/git-retry-support.test.ts`

- [ ] **Step 1: Add worker-side safe Git environment helper**

In `packages/agent-vm-worker/src/work-phase/controller-tools/controller-tool-support.ts`, add this helper before `isControllerToolFailure()`:

```ts
export function buildSafeGitEnvironment(cwd: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'safe.directory',
		GIT_CONFIG_VALUE_0: cwd,
	};
}
```

Then update `currentBranch()` so the `execa()` options include:

```ts
env: buildSafeGitEnvironment(cwd),
```

- [ ] **Step 2: Use safe environment in `git-pull-default` worker commands**

In `packages/agent-vm-worker/src/work-phase/controller-tools/git-pull-default-tool.ts`, import the helper:

```ts
import {
	buildSafeGitEnvironment,
	controllerToolFailureArtifact,
	currentBranch,
	isControllerToolFailure,
	postControllerJson,
	selectRepo,
} from './controller-tool-support.js';
```

Add `env: buildSafeGitEnvironment(selected.repo.workPath)` to every worker-side Git `execa()` call in this file:

```ts
const currentHeadResult = await execa('git', ['rev-parse', 'HEAD'], {
	cwd: selected.repo.workPath,
	env: buildSafeGitEnvironment(selected.repo.workPath),
	reject: false,
	timeout: GIT_TOOL_TIMEOUT_MS,
});
```

```ts
const statusResult = await execa('git', ['status', '--porcelain'], {
	cwd: selected.repo.workPath,
	env: buildSafeGitEnvironment(selected.repo.workPath),
	reject: false,
	timeout: GIT_TOOL_TIMEOUT_MS,
});
```

```ts
const resetResult = await execa('git', ['reset', '--hard', 'HEAD'], {
	cwd: selected.repo.workPath,
	env: buildSafeGitEnvironment(selected.repo.workPath),
	reject: false,
	timeout: GIT_TOOL_TIMEOUT_MS,
});
```

- [ ] **Step 3: Add controller-tool safe-directory assertions**

In `packages/agent-vm-worker/src/work-phase/controller-tools/controller-tools.test.ts`, extend the `git-push posts current branch to controller` test with:

```ts
expect(execaMock).toHaveBeenCalledWith(
	'git',
	['branch', '--show-current'],
	expect.objectContaining({
		cwd: '/work/repos/widgets',
		env: expect.objectContaining({
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'safe.directory',
			GIT_CONFIG_VALUE_0: '/work/repos/widgets',
		}),
	}),
);
```

Extend the reset assertion in `git-pull-default resets the worktree after a controller fast-forward` so the options include:

```ts
env: expect.objectContaining({
	GIT_CONFIG_COUNT: '1',
	GIT_CONFIG_KEY_0: 'safe.directory',
	GIT_CONFIG_VALUE_0: '/work/repos/widgets',
}),
```

- [ ] **Step 4: Use safe environment for wrapup Git context**

In `packages/agent-vm-worker/src/coordinator/task-runner.ts`, import:

```ts
import { buildSafeGitEnvironment } from '../work-phase/controller-tools/controller-tool-support.js';
```

Change `gitOutput()` to include:

```ts
env: buildSafeGitEnvironment(cwd),
```

Change `gitRefExists()` to call Git without inline `-c safe.directory=...` and include the same environment:

```ts
const result = await execa('git', ['rev-parse', '--verify', '--quiet', ref], {
	cwd,
	env: buildSafeGitEnvironment(cwd),
	reject: false,
	timeout: 10_000,
});
```

Change `buildWrapupGitContext()` from local-only to exported:

```ts
export async function buildWrapupGitContext(cwd: string, defaultBranch: string): Promise<string> {
```

Call `gitOutput(cwd, ...)` directly in `buildWrapupGitContext()` and remove `gitOutputWithSafeDirectory()`.

- [ ] **Step 5: Add wrapup safe-directory test**

Create `packages/agent-vm-worker/src/coordinator/task-runner.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';

import { buildWrapupGitContext } from './task-runner.js';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

describe('task-runner wrapup git context', () => {
	test('marks the repo worktree safe for every wrapup git command', async () => {
		execaMock.mockImplementation(async (_bin: string, args: readonly string[]) => {
			const joined = args.join(' ');
			if (joined === 'branch --show-current') {
				return { stdout: 'agent/task-1', stderr: '', exitCode: 0 };
			}
			if (joined === 'status --short') {
				return { stdout: ' M README.md', stderr: '', exitCode: 0 };
			}
			if (joined === 'rev-parse --verify --quiet origin/main') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (joined === 'log --oneline origin/main..HEAD') {
				return { stdout: 'abc123 docs: clarify payroll test', stderr: '', exitCode: 0 };
			}
			if (joined === 'diff --stat origin/main...HEAD') {
				return { stdout: ' README.md | 1 +', stderr: '', exitCode: 0 };
			}
			throw new Error(`unexpected git command: ${joined}`);
		});

		await expect(buildWrapupGitContext('/work/repos/widgets', 'main')).resolves.toContain(
			'Current branch: agent/task-1',
		);

		for (const call of execaMock.mock.calls) {
			expect(call[0]).toBe('git');
			expect(call[2]).toEqual(
				expect.objectContaining({
					cwd: '/work/repos/widgets',
					env: expect.objectContaining({
						GIT_CONFIG_COUNT: '1',
						GIT_CONFIG_KEY_0: 'safe.directory',
						GIT_CONFIG_VALUE_0: '/work/repos/widgets',
					}),
				}),
			);
		}
	});
});
```

- [ ] **Step 6: Create host Git argument helper**

Create `packages/agent-vm/src/controller/host-git-command.ts`:

```ts
import { dirname } from 'node:path';

export function buildHostGitArgs(options: {
	readonly args: readonly string[];
	readonly gitDir: string;
}): readonly string[] {
	return [
		'-c',
		'core.hooksPath=/dev/null',
		`--git-dir=${options.gitDir}`,
		// The shared gitdir stores core.worktree=/work/repos/... for the VM.
		// Controller Git runs on the host, where /work does not exist, so pin a
		// host-visible dummy worktree for ref-only operations like fetch/push/log.
		`--work-tree=${dirname(options.gitDir)}`,
		...options.args,
	];
}
```

- [ ] **Step 7: Add real host gitdir/worktree regression coverage**

Create `packages/agent-vm/src/controller/host-git-command.test.ts`:

```ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildHostGitArgs } from './host-git-command.js';

const execFileAsync = promisify(execFile);

let tempDir: string;

async function git(args: readonly string[], cwd?: string): Promise<string> {
	const result = await execFileAsync('git', [...args], cwd ? { cwd } : undefined);
	return result.stdout.trim();
}

describe('buildHostGitArgs', () => {
	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-host-git-'));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { force: true, recursive: true });
	});

	it('pins a host-visible worktree when a shared gitdir stores a VM-only core.worktree', async () => {
		const sourceRepoPath = path.join(tempDir, 'source');
		const hostRuntimePath = path.join(tempDir, 'runtime');
		const gitDirPath = path.join(hostRuntimePath, 'gitdirs', 'widgets.git');
		await fs.mkdir(sourceRepoPath, { recursive: true });
		await fs.mkdir(path.dirname(gitDirPath), { recursive: true });

		await git(['init', '--initial-branch=main'], sourceRepoPath);
		await git(['config', 'user.email', 'agent-vm@example.com'], sourceRepoPath);
		await git(['config', 'user.name', 'Agent VM'], sourceRepoPath);
		await fs.writeFile(path.join(sourceRepoPath, 'README.md'), 'hello\n', 'utf8');
		await git(['add', 'README.md'], sourceRepoPath);
		await git(['commit', '-m', 'initial commit'], sourceRepoPath);
		const expectedHead = await git(['rev-parse', 'HEAD'], sourceRepoPath);

		await git(['clone', '--bare', sourceRepoPath, gitDirPath]);
		await git(['--git-dir', gitDirPath, 'config', 'core.bare', 'false']);
		await git(['--git-dir', gitDirPath, 'config', 'core.worktree', '/work/repos/widgets']);

		await expect(
			execFileAsync('git', ['--git-dir', gitDirPath, 'rev-parse', 'HEAD']),
		).rejects.toMatchObject({
			stderr: expect.stringContaining('/work/repos/widgets'),
		});

		const actualHead = await git(
			buildHostGitArgs({ gitDir: gitDirPath, args: ['rev-parse', 'HEAD'] }),
		);

		expect(actualHead).toBe(expectedHead);
	});
});
```

- [ ] **Step 8: Use host Git args in controller operations**

In both `packages/agent-vm/src/controller/git-push-operations.ts` and `packages/agent-vm/src/controller/git-pull-default-operations.ts`, import:

```ts
import { buildHostGitArgs } from './host-git-command.js';
```

Replace git argument construction with:

```ts
const args = buildHostGitArgs({ args: options.args, gitDir: options.gitDir });
```

and pass `args` to `execa('git', args, ...)`.

- [ ] **Step 9: Update controller Git test arg helpers**

In `packages/agent-vm/src/controller/git-push-operations.test.ts` and `packages/agent-vm/src/controller/git-pull-default-operations.test.ts`, update the helper that strips controller git boilerplate to skip both `--git-dir` and `--work-tree`:

```ts
function extractGitArgs(args: readonly string[]): readonly string[] {
	let index = 0;
	while (args[index] === '-c') {
		index += 2;
	}
	while (index < args.length) {
		const arg = args[index];
		if (arg === '--git-dir' || arg === '--work-tree') {
			index += 2;
			continue;
		}
		if (arg?.startsWith('--git-dir=') || arg?.startsWith('--work-tree=')) {
			index += 1;
			continue;
		}
		break;
	}
	return args.slice(index);
}
```

Also add one assertion in each file that a host-visible worktree is passed:

```ts
expect(args).toContain('--work-tree=/tmp/task-1/gitdirs');
```

- [ ] **Step 10: Make retry backoff sleeps cancellable**

In `packages/agent-vm/src/controller/git-retry-support.ts`, add an abort-aware default sleep helper before `runGitCommandWithTransientRetries()`:

```ts
async function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timeout = setTimeout(resolve, delayMs);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timeout);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}
```

Change `runGitCommandWithTransientRetries()` to accept and pass `AbortSignal`:

```ts
export async function runGitCommandWithTransientRetries(options: {
	readonly run: (signal?: AbortSignal) => Promise<GitCommandResult>;
	readonly onRetry?: (props: {
		readonly attempt: number;
		readonly delayMs: number;
		readonly result: GitCommandResult;
	}) => Promise<void>;
	readonly signal?: AbortSignal;
	readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}): Promise<GitCommandRetryResult> {
	const sleep = options.sleep ?? defaultSleep;
```

Inside the retry loop, call:

```ts
const result = await options.run(options.signal);
```

and replace:

```ts
await sleep(retryDelayMs);
```

with:

```ts
await (options.signal ? sleep(retryDelayMs, options.signal) : sleep(retryDelayMs));
```

In `packages/agent-vm/src/controller/git-push-operations.ts`, remove the local `sleep()` helper. Change `git()` to accept:

```ts
readonly signal?: AbortSignal;
```

and pass the signal to `execa()`:

```ts
...(options.signal ? { cancelSignal: options.signal } : {}),
```

For each `runGitCommandWithTransientRetries()` call in this file:

```ts
run: async (signal) =>
	await git({
		args,
		gitDir,
		reject: false,
		...(signal ? { signal } : {}),
	}),
...(options.signal ? { signal: options.signal } : {}),
...(options.retrySleep ? { sleep: options.retrySleep } : {}),
```

Use the same pattern in `packages/agent-vm/src/controller/git-pull-default-operations.ts`: remove the local `sleep()` helper, add `signal?: AbortSignal` to the local `git()` options, pass it as `cancelSignal` to `execa()`, and pass `options.signal` into every retry helper call. Keep injected test sleeps, but do not provide a local default sleep.

- [ ] **Step 11: Add cancellable retry coverage**

In `packages/agent-vm/src/controller/git-retry-support.test.ts`, import `vi`:

```ts
import { describe, expect, test, vi } from 'vitest';
```

and import the retry runner:

```ts
import {
	isRetryableGitFailure,
	runGitCommandWithTransientRetries,
} from './git-retry-support.js';
```

Add:

```ts
	test('passes abort signals to git attempts and retry sleeps', async () => {
		const abortController = new AbortController();
		const run = vi.fn(async () => ({
			stdout: '',
			stderr: 'RPC failed; HTTP 503',
			exitCode: 128,
		}));
		const sleep = vi.fn(async (_delayMs: number, signal?: AbortSignal) => {
			expect(signal).toBe(abortController.signal);
			abortController.abort(new Error('cancelled'));
		});

		await expect(
			runGitCommandWithTransientRetries({
				run,
				sleep,
				signal: abortController.signal,
			}),
		).rejects.toThrow('cancelled');

		expect(run).toHaveBeenCalledWith(abortController.signal);
		expect(sleep).toHaveBeenCalledWith(2_000, abortController.signal);
	});

	test('aborts the default retry sleep without waiting for the full backoff', async () => {
		const abortController = new AbortController();
		const run = vi.fn(async () => ({
			stdout: '',
			stderr: 'RPC failed; HTTP 503',
			exitCode: 128,
		}));

		const promise = runGitCommandWithTransientRetries({
			run,
			signal: abortController.signal,
		});
		await Promise.resolve();
		abortController.abort(new Error('cancelled'));

		await expect(promise).rejects.toThrow('cancelled');
	});
```

- [ ] **Step 12: Run targeted runtime-aware git tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/coordinator/task-runner.test.ts packages/agent-vm-worker/src/work-phase/controller-tools/controller-tools.test.ts packages/agent-vm/src/controller/host-git-command.test.ts packages/agent-vm/src/controller/git-retry-support.test.ts packages/agent-vm/src/controller/git-push-operations.test.ts packages/agent-vm/src/controller/git-pull-default-operations.test.ts
```

Expected: PASS.

---

### Task 2: Preserve Git Push Retry Phase

**Files:**
- Modify: `packages/agent-vm-worker/src/state/task-event-types.ts`
- Modify: `packages/agent-vm-worker/src/state/task-state.ts`
- Modify: `packages/agent-vm-worker/src/state/task-state.test.ts`
- Modify: `packages/agent-vm/src/controller/git-push-operations.ts`
- Modify: `packages/agent-vm/src/controller/git-push-operations.test.ts`

- [ ] **Step 1: Write the worker state regression test**

Add this test next to `stores controller git push status for agent-visible retry guidance` in `packages/agent-vm-worker/src/state/task-state.test.ts`.

```ts
	it('preserves controller git push retry phase during replay', () => {
		const state = createInitialState('task-1', TEST_CONFIG);

		const retrying = applyEvent(state, {
			event: 'controller-git-push-retry',
			repoUrl: 'https://github.com/acme/widgets.git',
			branch: 'agent/task-1',
			attempts: 2,
			message: 'RPC failed after push while fetching branch',
			phase: 'post-push-fetch',
			retryDelaySeconds: 4,
		});

		expect(retrying.controllerOperations.gitPushes).toEqual([
			{
				repoUrl: 'https://github.com/acme/widgets.git',
				branch: 'agent/task-1',
				status: 'retrying',
				attempts: 2,
				message: 'RPC failed after push while fetching branch',
				phase: 'post-push-fetch',
				retryDelaySeconds: 4,
				retryAfterSeconds: null,
				localHead: null,
				remoteBranchHead: null,
			},
		]);
	});
```

- [ ] **Step 2: Run the targeted worker test and verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/state/task-state.test.ts
```

Expected: FAIL because `controller-git-push-retry` does not accept `phase`, or because replay still writes `phase: 'push'`.

- [ ] **Step 3: Add the event schema field**

In `packages/agent-vm-worker/src/state/task-event-types.ts`, define the phase schema once near `controllerGitPushBaseSchema`:

```ts
const controllerGitPushPhaseSchema = z.enum(['pre-push-fetch', 'push', 'post-push-fetch']);
```

Change the retry event schema from:

```ts
controllerGitPushBaseSchema.extend({
	event: z.literal('controller-git-push-retry'),
	attempts: z.number().int().positive(),
	message: z.string(),
	retryDelaySeconds: z.number().positive(),
}),
```

to:

```ts
controllerGitPushBaseSchema.extend({
	event: z.literal('controller-git-push-retry'),
	attempts: z.number().int().positive(),
	message: z.string(),
	phase: controllerGitPushPhaseSchema,
	retryDelaySeconds: z.number().positive(),
}),
```

Change the failed event schema inline phase enum to:

```ts
phase: controllerGitPushPhaseSchema.optional(),
```

- [ ] **Step 4: Replay event phase**

In `packages/agent-vm-worker/src/state/task-state.ts`, change:

```ts
phase: 'push',
```

inside the `controller-git-push-retry` branch to:

```ts
phase: event.phase,
```

- [ ] **Step 5: Emit push retry phase from the controller**

In `packages/agent-vm/src/controller/git-push-operations.ts`, update the retry event inside `pushBranch()`:

```ts
event: {
	event: 'controller-git-push-retry',
	repoUrl: options.repoUrl,
	branch: sanitizedBranchName,
	attempts: attempt,
	message: detail,
	phase: 'push',
	retryDelaySeconds: delayMs / 1000,
},
```

- [ ] **Step 6: Add controller event coverage**

In `packages/agent-vm/src/controller/git-push-operations.test.ts`, update the existing transient push retry assertion so it expects:

```ts
expect(recordedEvents).toContainEqual(
	expect.objectContaining({
		event: 'controller-git-push-retry',
		branch: 'agent/task-1',
		phase: 'push',
	}),
);
```

- [ ] **Step 7: Preserve precise retry-after metadata**

In `packages/agent-vm/src/controller/git-push-operations.ts`, keep `retryAfterSeconds` limited to exhausted transient retries:

```ts
const retryAfterSeconds =
	error instanceof GitPushFailedAfterRetriesError && error.attempts > 1
		? GIT_PUSH_RETRY_AFTER_SECONDS
		: undefined;
```

and keep event construction conditional:

```ts
...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
```

In `packages/agent-vm/src/controller/git-push-operations.test.ts`, update the non-retryable push failure test (`Nothing new to push`) so it asserts the final event does not advertise retry guidance:

```ts
expect(recordedEvents.at(-1)).not.toHaveProperty('retryAfterSeconds');
```

- [ ] **Step 8: Run targeted tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/state/task-state.test.ts packages/agent-vm/src/controller/git-push-operations.test.ts
```

Expected: PASS.

- [ ] **Step 9: Checkpoint**

Run:

```bash
git diff -- packages/agent-vm-worker/src/state/task-event-types.ts packages/agent-vm-worker/src/state/task-state.ts packages/agent-vm-worker/src/state/task-state.test.ts packages/agent-vm/src/controller/git-push-operations.ts packages/agent-vm/src/controller/git-push-operations.test.ts
```

Expected: diff only contains retry phase schema/emitter/replay/test changes.

---

### Task 3: Treat Missing Repo Resource Contracts As No Contract

**Files:**
- Modify: `packages/agent-vm/src/resources/repo-resource-contract-loader.ts`
- Modify: `packages/agent-vm/src/resources/repo-resource-contract-loader.test.ts`
- Modify: `packages/agent-vm/src/controller/worker-task-runner.ts`
- Modify: `packages/agent-vm/src/controller/worker-task-runner.test.ts`
- Modify: `docs/reference/configuration/resource-contracts.md`

- [ ] **Step 1: Write the loader regression test**

Replace the missing-file test in `packages/agent-vm/src/resources/repo-resource-contract-loader.test.ts` with:

```ts
	it('returns null when repo-resources.ts is missing', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-resource-missing-'));
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

		try {
			const description = await loadRepoResourceDescriptionContract({
				repoDir,
				repoId: 'repo-a',
				repoUrl: 'https://github.com/example/repo-a.git',
			});

			expect(description).toBeNull();
			expect(stderrSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'[repo-resource-contract-loader] repo-a: no .agent-vm/repo-resources.ts; skipping repo resource setup.',
				),
			);
		} finally {
			stderrSpy.mockRestore();
		}
	});
```

- [ ] **Step 2: Run the loader test and verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/resources/repo-resource-contract-loader.test.ts
```

Expected: FAIL because the loader returns the fake empty contract.

- [ ] **Step 3: Change the loader return type and missing-file behavior**

In `packages/agent-vm/src/resources/repo-resource-contract-loader.ts`, add:

```ts
export type LoadedRepoResourceDescription = ResolvedRepoResourcesDescription | null;
```

Change the function signature:

```ts
}): Promise<LoadedRepoResourceDescription> {
```

Change the missing-file branch to:

```ts
	if (!(await fileExists(contractPath))) {
		writeRepoContractLoaderLog(
			`${options.repoId}: no ${REPO_RESOURCES_PATH}; skipping repo resource setup.`,
		);
		return null;
	}
```

- [ ] **Step 4: Filter absent contracts in the task runner**

In `packages/agent-vm/src/controller/worker-task-runner.ts`, change the repo description collection to filter null descriptions:

```ts
const repoResourceDescriptions = (
	await Promise.all(
		clonedRepos.map(async (repo) => {
			const description = await loadRepoResourceDescriptionContract({
				repoDir: repo.hostMetadataPath,
				repoId: repo.repoId,
				repoUrl: repo.repoUrl,
			});
			if (!description) {
				return null;
			}
			return {
				repoId: repo.repoId,
				repoUrl: repo.repoUrl,
				description,
			};
		}),
	)
).filter((repo): repo is NonNullable<typeof repo> => repo !== null);
```

Remove `hasContract` from this local data shape and remove the `if (!repoDescription.hasContract) return null;` branch in the `startRepoResourceProviders()` `repos` mapping.

- [ ] **Step 5: Add a mixed bare/contract task-runner test**

In `packages/agent-vm/src/controller/worker-task-runner.test.ts`, add or update a test that mocks one bare repo and one repo with `.agent-vm/repo-resources.ts`. Assert only the contracted repo reaches `startRepoResourceProviders`.

Use this assertion shape:

```ts
expect(startRepoResourceProvidersMock).toHaveBeenCalledWith(
	expect.objectContaining({
		repos: [
			expect.objectContaining({
				repoId: 'contract-repo',
				setupCommand: '.agent-vm/run-setup.sh',
			}),
		],
	}),
);
```

Also assert:

```ts
expect(startRepoResourceProvidersMock.mock.calls[0]?.[0].repos).toHaveLength(1);
```

- [ ] **Step 6: Run targeted resource/task tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/resources/repo-resource-contract-loader.test.ts packages/agent-vm/src/controller/worker-task-runner.test.ts
```

Expected: PASS.

- [ ] **Step 7: Update resource contract docs**

In `docs/reference/configuration/resource-contracts.md`, replace text that says every requested repo runs setup with:

```md
When a requested repo does not contain `.agent-vm/repo-resources.ts`, it does
not participate in repo resource setup. The controller does not run
`.agent-vm/run-setup.sh` and does not call `finalizeRepoResourceSetup()` for
that repo.
```

- [ ] **Step 8: Checkpoint**

Run:

```bash
git diff -- packages/agent-vm/src/resources/repo-resource-contract-loader.ts packages/agent-vm/src/resources/repo-resource-contract-loader.test.ts packages/agent-vm/src/controller/worker-task-runner.ts packages/agent-vm/src/controller/worker-task-runner.test.ts docs/reference/configuration/resource-contracts.md
```

Expected: absent contracts are represented as `null`, not fake empty contracts.

---

### Task 4: Gate Repo-Local Contract Code With `allowRepoResources`

**Files:**
- Modify: `packages/agent-vm/src/controller/worker-task-runner.ts`
- Modify: `packages/agent-vm/src/controller/worker-task-runner.test.ts`
- Modify: `packages/agent-vm/src/resources/resource-resolver.test.ts`
- Modify: `docs/reference/configuration/resource-contracts.md`
- Modify: `docs/reference/configuration/system-json.md`

- [ ] **Step 1: Add resolver coverage for external-only disabled repo resources**

In `packages/agent-vm/src/resources/resource-resolver.test.ts`, add:

```ts
	it('allows external resources when repo-local providers are disabled', () => {
		const resolved = resolveTaskResources({
			allowRepoResources: false,
			externalResources: {
				pg: {
					name: 'pg',
					binding: { host: 'pg.local', port: 5432 },
					target: { host: 'postgres.internal', port: 5432 },
					env: { DATABASE_URL: 'postgres://postgres.internal:5432/app' },
				},
			},
			repos: [
				{
					repoId: 'repo-a',
					repoUrl: 'https://github.com/example/repo-a.git',
					description: {
						setupCommand: '.agent-vm/run-setup.sh',
						requires: {
							pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
						},
						provides: {},
					},
				},
			],
		});

		expect(resolved.selectedRepoProviders).toEqual([]);
		expect(resolved.externalResources.pg?.target.host).toBe('postgres.internal');
	});
```

- [ ] **Step 2: Add task-runner test for disabled repo resources**

In `packages/agent-vm/src/controller/worker-task-runner.test.ts`, add a test where `zoneConfig.resources.allowRepoResources` is `false` and a cloned repo contains `.agent-vm/repo-resources.ts`.

Assert:

```ts
expect(loadRepoResourceDescriptionContractMock).not.toHaveBeenCalled();
expect(startRepoResourceProvidersMock).not.toHaveBeenCalled();
```

Also assert the task still compiles the external resource overlay when the request includes:

```ts
resources: {
	externalResources: {
		pg: {
			name: 'pg',
			binding: { host: 'pg.local', port: 5432 },
			target: { host: 'postgres.internal', port: 5432 },
			env: { DATABASE_URL: 'postgres://postgres.internal:5432/app' },
		},
	},
},
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/resources/resource-resolver.test.ts packages/agent-vm/src/controller/worker-task-runner.test.ts
```

Expected: resolver may pass already; task runner should fail because it still loads contracts.

- [ ] **Step 4: Gate loading before touching repo-local code**

In `packages/agent-vm/src/controller/worker-task-runner.ts`, parse resources first and add:

```ts
const resources = workerTaskResourcesSchema.parse(parsedTaskInput.resources);
const allowRepoResources = zoneConfig.resources?.allowRepoResources ?? true;
const repoResourceDescriptions =
	allowRepoResources === false
		? []
		: (
				await Promise.all(
					clonedRepos.map(async (repo) => {
						const description = await loadRepoResourceDescriptionContract({
							repoDir: repo.hostMetadataPath,
							repoId: repo.repoId,
							repoUrl: repo.repoUrl,
						});
						if (!description) {
							return null;
						}
						return {
							repoId: repo.repoId,
							repoUrl: repo.repoUrl,
							description,
						};
					}),
				)
			).filter((repo): repo is NonNullable<typeof repo> => repo !== null);
```

Pass `allowRepoResources` into `resolveTaskResources`.

- [ ] **Step 5: Skip provider runner when there are no repo contracts**

Still in `worker-task-runner.ts`, change:

```ts
const providerRun = await startRepoResourceProviders({
```

to:

```ts
const providerRun =
	repoResourceDescriptions.length === 0
		? { finalizations: [], startedProviders: [] }
		: await startRepoResourceProviders({
```

and close the expression after the existing `providers` array.

- [ ] **Step 6: Update docs**

In `docs/reference/configuration/resource-contracts.md`, add:

```md
When `allowRepoResources` is `false`, the controller skips the full repo-local
resource contract pipeline. It does not load `.agent-vm/repo-resources.ts`, run
`.agent-vm/run-setup.sh`, or call `finalizeRepoResourceSetup()`. Task-supplied
`externalResources` are still applied.
```

In `docs/reference/configuration/system-json.md`, replace wording that says the policy gates only provider selection with the same behavior.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/resources/resource-resolver.test.ts packages/agent-vm/src/controller/worker-task-runner.test.ts
```

Expected: PASS.

---

### Task 5: Pass External Resources To Repo Finalizers

**Files:**
- Modify: `packages/agent-vm/src/resources/repo-resource-provider-runner.ts`
- Modify: `packages/agent-vm/src/resources/repo-resource-provider-runner.test.ts`
- Modify: `packages/agent-vm/src/controller/worker-task-runner.ts`
- Modify: `packages/agent-vm/src/controller/worker-task-runner.test.ts`
- Modify: `packages/agent-vm/src/config/resource-contracts/repo-resource-contract-types.ts`

- [ ] **Step 1: Add provider-runner no-op test**

In `packages/agent-vm/src/resources/repo-resource-provider-runner.test.ts`, add:

```ts
	it('does not run subprocesses when no repos have resource contracts', async () => {
		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');

		const result = await startRepoResourceProviders({
			taskId: 'task-123',
			repos: [],
			providers: [],
		});

		expect(result).toEqual({
			finalizations: [],
			startedProviders: [],
		});
		expect(execaMock).not.toHaveBeenCalled();
	});
```

- [ ] **Step 2: Add external resource finalization test**

Add this test to `packages/agent-vm/src/resources/repo-resource-provider-runner.test.ts`:

```ts
	it('passes selected external resources to repo finalization', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-provider-external-'));
		const outputDir = path.join(repoDir, 'output');
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command.endsWith('/.agent-vm/run-setup.sh')) {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (command === 'node') {
				const source = args[3] ?? '';
				expect(source).toContain('"pg"');
				expect(source).toContain('"postgres.internal"');
				return {
					stdout: JSON.stringify({
						resources: {
							pg: {
								binding: { host: 'pg.local', port: 5432 },
								target: { host: 'postgres.internal', port: 5432 },
								env: { DATABASE_URL: 'postgres://postgres.internal:5432/app' },
							},
						},
						generated: [],
					}),
					stderr: '',
					exitCode: 0,
				};
			}
			throw new Error(`unexpected command: ${command}`);
		});

		const { startRepoResourceProviders } = await import('./repo-resource-provider-runner.js');
		const result = await startRepoResourceProviders({
			taskId: 'task-123',
			repos: [
				{
					...buildRepoResourceSetup({ repoDir, outputDir }),
					selectedExternalResources: {
						pg: {
							binding: { host: 'pg.local', port: 5432 },
							target: { host: 'postgres.internal', port: 5432 },
						},
					},
				},
			],
			providers: [],
		});

		expect(result.finalizations[0]?.final.resources.pg?.env.DATABASE_URL).toBe(
			'postgres://postgres.internal:5432/app',
		);
	});
```

- [ ] **Step 3: Run provider tests and verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/resources/repo-resource-provider-runner.test.ts
```

Expected: FAIL because `RepoResourceSetupInput` does not accept selected external resources.

- [ ] **Step 4: Extend setup input types**

In `packages/agent-vm/src/resources/repo-resource-provider-runner.ts`, import `ResourceBinding` if not already present and update `RepoResourceSetupInput`:

```ts
readonly selectedExternalResources: Record<
	string,
	{ readonly binding: ResourceBinding; readonly target: ResourceBinding }
>;
```

Add the same property to `RepoResourceProviderGroup`.

- [ ] **Step 5: Preserve selected external resources while grouping**

In `groupReposByComposeProject()`, include `selectedExternalResources` in the grouped value and mismatch check:

```ts
function stableJson(value: unknown): string {
	return JSON.stringify(value);
}
```

Use:

```ts
stableJson(existingGroup.selectedExternalResources) !== stableJson(repo.selectedExternalResources)
```

inside the inconsistent paths check, and store:

```ts
selectedExternalResources: repo.selectedExternalResources,
```

- [ ] **Step 6: Merge external and repo-selected resources before finalize**

In `startOneProviderGroup()`, rename the current `selectedResources` from compose providers:

```ts
const selectedRepoResources = Object.fromEntries(
```

Then add:

```ts
const selectedResources = {
	...options.group.selectedExternalResources,
	...selectedRepoResources,
};
```

Pass that `selectedResources` into `finalizeRepoResourceSetupInSubprocess()`.

- [ ] **Step 7: Build selected external resources in the task runner**

In `packages/agent-vm/src/controller/worker-task-runner.ts`, when mapping `repoResourceDescriptions` into `startRepoResourceProviders({ repos })`, compute:

```ts
const selectedExternalResources = Object.fromEntries(
	Object.entries(repoDescription.description.requires).flatMap(([resourceName, requirement]) => {
		const externalResource = resolvedResources.externalResources[resourceName];
		if (!externalResource) {
			return [];
		}
		return [
			[
				resourceName,
				{
					binding: requirement.binding,
					target: externalResource.target,
				},
			] as const,
		];
	}),
);
```

Include it in each repo setup object:

```ts
selectedExternalResources,
```

- [ ] **Step 8: Add task-runner boundary coverage**

In `packages/agent-vm/src/controller/worker-task-runner.test.ts`, add a test where a repo contract requires `pg` and the task request supplies `resources.externalResources.pg`.

Assert the task runner passes the selected external resource into provider setup:

```ts
expect(startRepoResourceProvidersMock).toHaveBeenCalledWith(
	expect.objectContaining({
		repos: [
			expect.objectContaining({
				repoId: 'repo-a',
				selectedExternalResources: {
					pg: {
						binding: { host: 'pg.local', port: 5432 },
						target: { host: 'postgres.internal', port: 5432 },
					},
				},
			}),
		],
	}),
);
```

The contract description used by the test should include:

```ts
{
	setupCommand: '.agent-vm/run-setup.sh',
	requires: {
		pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
	},
	provides: {},
}
```

The task input should include:

```ts
resources: {
	externalResources: {
		pg: {
			name: 'pg',
			binding: { host: 'pg.local', port: 5432 },
			target: { host: 'postgres.internal', port: 5432 },
			env: { DATABASE_URL: 'postgres://postgres.internal:5432/app' },
		},
	},
},
```

- [ ] **Step 9: Update the test helper**

In `repo-resource-provider-runner.test.ts`, update `buildRepoResourceSetup()` return type and return value with:

```ts
readonly selectedExternalResources: Record<
	string,
	{
		readonly binding: { readonly host: string; readonly port: number };
		readonly target: { readonly host: string; readonly port: number };
	}
>;
```

and:

```ts
selectedExternalResources: {},
```

- [ ] **Step 10: Run targeted tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/resources/repo-resource-provider-runner.test.ts packages/agent-vm/src/controller/worker-task-runner.test.ts
```

Expected: PASS.

---

### Task 6: Flatten Resource Preparation Error Details

**Files:**
- Modify: `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`

- [ ] **Step 1: Add HTTP route regression test**

In `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`, add a test for worker task preparation failure with nested `AggregateError`.

Use this error shape in the mocked worker task runner:

```ts
const preparationError = new AggregateError(
	[
		new Error('setup failed for repo-a', {
			cause: new AggregateError([new Error('docker compose up failed')], 'provider cleanup failed'),
		}),
	],
	'Failed to start repo resource providers.',
);
```

Assert the response body includes all actionable messages:

```ts
expect(response.status).toBe(500);
expect(await response.json()).toEqual(
	expect.objectContaining({
		error: expect.stringContaining('Failed to start repo resource providers.'),
		details: expect.arrayContaining([
			'setup failed for repo-a',
			'provider cleanup failed',
			'docker compose up failed',
		]),
	}),
);
```

- [ ] **Step 2: Run the HTTP route test and verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: FAIL because nested details are not exposed.

- [ ] **Step 3: Add error detail collector**

In `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`, add:

```ts
function collectErrorMessages(error: unknown, seen = new Set<unknown>()): readonly string[] {
	if (seen.has(error)) {
		return [];
	}
	seen.add(error);
	if (!(error instanceof Error)) {
		return [String(error)];
	}
	const messages = [error.message];
	if (error instanceof AggregateError) {
		for (const nestedError of error.errors) {
			messages.push(...collectErrorMessages(nestedError, seen));
		}
	}
	if (error.cause !== undefined) {
		messages.push(...collectErrorMessages(error.cause, seen));
	}
	return [...new Set(messages.filter((message) => message.length > 0))];
}
```

- [ ] **Step 4: Include details in preparation failure responses**

Where worker task preparation failures are converted into HTTP JSON, include:

```ts
details: collectErrorMessages(error).slice(1),
```

Keep the top-level `error` string unchanged for API compatibility.

- [ ] **Step 5: Run targeted HTTP tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: PASS.

---

### Task 7: Replace Git-SHA Cache Identity Defaults

**Files:**
- Modify: `packages/agent-vm/src/config/system-cache-identifier.ts`
- Modify: `packages/agent-vm/src/config/system-cache-identifier.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `packages/agent-vm/src/cli/vm-host-system-templates.ts`
- Modify: `packages/agent-vm/src/cli/vm-host-system-templates.test.ts`
- Modify: `docs/reference/configuration/system-cache-identifier.md`
- Modify: `docs/reference/configuration/README.md`

- [ ] **Step 1: Update system cache identifier tests first**

In `packages/agent-vm/src/config/system-cache-identifier.test.ts`, change the default bare-metal expected value to:

```ts
expect(identifier).toEqual({
	$comment:
		'Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change cacheProfile or cacheFormat when the outer cache contract changes.',
	schemaVersion: 1,
	os: 'linux',
	hostSystemType: 'bare-metal',
	cacheProfile: 'default',
	cacheFormat: 'gondolin-cache-v1',
});
```

Change the container expected value to:

```ts
expect(identifier).toEqual({
	$comment:
		'Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change cacheProfile or cacheFormat when the outer cache contract changes.',
	schemaVersion: 1,
	os: 'darwin',
	hostSystemType: 'container',
	cacheProfile: 'default',
	cacheFormat: 'gondolin-cache-v1',
});
```

Keep `returns parsed JSON contents without validating the object shape` with a legacy `gitSha` value to prove old hand-written files still parse as arbitrary JSON.

- [ ] **Step 2: Run cache identifier tests and verify failure**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-cache-identifier.test.ts
```

Expected: FAIL because defaults still include `gitSha`.

- [ ] **Step 3: Change the default identifier type**

In `packages/agent-vm/src/config/system-cache-identifier.ts`, update dependencies:

```ts
export interface SystemCacheIdentifierPlatformDependencies {
	readonly cacheFormat?: string;
	readonly cacheProfile?: string;
	readonly hostSystemType?: HostSystemType;
	readonly platform?: () => string;
}
```

Update `DefaultSystemCacheIdentifier`:

```ts
export interface DefaultSystemCacheIdentifier {
	readonly $comment: string;
	readonly schemaVersion: 1;
	readonly os: SystemCacheOs;
	readonly hostSystemType: HostSystemType;
	readonly cacheProfile: string;
	readonly cacheFormat: string;
}
```

Change the comment:

```ts
const systemCacheIdentifierComment =
	'Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change cacheProfile or cacheFormat when the outer cache contract changes.';
```

Change the default object:

```ts
return {
	$comment: systemCacheIdentifierComment,
	schemaVersion: 1,
	os: captureSystemOsName(platform),
	hostSystemType: dependencies.hostSystemType ?? 'bare-metal',
	cacheProfile: dependencies.cacheProfile ?? 'default',
	cacheFormat: dependencies.cacheFormat ?? 'gondolin-cache-v1',
};
```

- [ ] **Step 4: Update scaffold tests**

In `packages/agent-vm/src/cli/init-command.test.ts`, replace scaffold expectations that mention `gitSha` with:

```ts
expect(JSON.parse(raw)).toMatchObject({
	$comment:
		'Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change cacheProfile or cacheFormat when the outer cache contract changes.',
	schemaVersion: 1,
	os: expect.any(String),
	hostSystemType: 'bare-metal',
	cacheProfile: 'default',
	cacheFormat: 'gondolin-cache-v1',
});
```

For container scaffolds:

```ts
expect(JSON.parse(raw)).toMatchObject({
	schemaVersion: 1,
	os: expect.any(String),
	hostSystemType: 'container',
	cacheProfile: 'default',
	cacheFormat: 'gondolin-cache-v1',
});
expect(JSON.parse(raw)).not.toHaveProperty('gitSha');
```

- [ ] **Step 5: Remove generated Dockerfile `GIT_SHA` rewrite**

In `packages/agent-vm/src/cli/vm-host-system-templates.ts`, delete this block:

```Dockerfile
ARG GIT_SHA
RUN test -n "${GIT_SHA}" \
    || (echo "GIT_SHA build-arg required" >&2; exit 1) \
    && printf '{\n  "$comment": "System cache identifier. Contents hash into every Gondolin image fingerprint. gitSha=local is the intentional sentinel for bare-metal dev. Container-host builds usually replace gitSha with a build provenance string such as a commit SHA.",\n  "schemaVersion": 1,\n  "os": "linux",\n  "hostSystemType": "container",\n  "gitSha": "%s"\n}\n' "${GIT_SHA}" \
    > /etc/agent-vm/systemCacheIdentifier.json
```

Leave `COPY config/ /etc/agent-vm/` in place.

- [ ] **Step 6: Add Dockerfile template assertions**

In `packages/agent-vm/src/cli/vm-host-system-templates.test.ts`, assert:

```ts
expect(dockerfile).not.toContain('ARG GIT_SHA');
expect(dockerfile).not.toContain('gitSha');
expect(dockerfile).not.toContain('/etc/agent-vm/systemCacheIdentifier.json');
```

- [ ] **Step 7: Update docs**

In `docs/reference/configuration/system-cache-identifier.md`, replace the default shape with:

```json
{
  "$comment": "Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change cacheProfile or cacheFormat when the outer cache contract changes.",
  "schemaVersion": 1,
  "os": "darwin",
  "hostSystemType": "bare-metal",
  "cacheProfile": "default",
  "cacheFormat": "gondolin-cache-v1"
}
```

Add:

```md
`cacheProfile` names the broad cache compatibility profile. `cacheFormat`
names the expected cache layout/contract. Change either value when the outer
cache contract changes in a way that should invalidate shared Gondolin image
fingerprints.
```

Remove claims that container builds rewrite the file with `GIT_SHA`.

- [ ] **Step 8: Search for stale cache identity wording**

Run:

```bash
rg -n "gitSha|GIT_SHA|Container-host builds usually replace|runtime.*overwrite.*systemCacheIdentifier|Pod runtimes overwrite" \
  packages/agent-vm/src/config/system-cache-identifier.ts \
  packages/agent-vm/src/config/system-cache-identifier.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts \
  packages/agent-vm/src/cli/vm-host-system-templates.ts \
  packages/agent-vm/src/cli/vm-host-system-templates.test.ts \
  docs/reference/configuration/system-cache-identifier.md \
  docs/reference/configuration/README.md
```

Expected: no matches except the legacy arbitrary-JSON loader assertion in
`system-cache-identifier.test.ts`, if that assertion still uses a `gitSha`
fixture.

- [ ] **Step 9: Run targeted cache/scaffold tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-cache-identifier.test.ts packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/cli/vm-host-system-templates.test.ts
```

Expected: PASS.

---

### Task 8: Add Heartbeat Sender Regression Coverage

**Files:**
- Create: `packages/agent-vm/src/controller/heartbeat-sender.test.ts`

- [ ] **Step 1: Add the heartbeat sender test harness**

Create `packages/agent-vm/src/controller/heartbeat-sender.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startHeartbeatSender } from './heartbeat-sender.js';

interface ScheduledInterval {
	readonly handle: symbol;
	readonly callback: () => void | Promise<void>;
	readonly delayMs: number;
}

function createFakeInterval(): {
	readonly setIntervalImpl: (cb: () => void | Promise<void>, ms: number) => NodeJS.Timeout;
	readonly clearIntervalImpl: (handle: NodeJS.Timeout) => void;
	readonly fire: () => Promise<void>;
	readonly active: () => readonly ScheduledInterval[];
} {
	const scheduled: ScheduledInterval[] = [];
	return {
		setIntervalImpl: (callback, delayMs): NodeJS.Timeout => {
			const handle = Symbol('interval');
			scheduled.push({ handle, callback, delayMs });
			return handle as unknown as NodeJS.Timeout;
		},
		clearIntervalImpl: (handle): void => {
			const index = scheduled.findIndex((item) => item.handle === (handle as unknown as symbol));
			if (index >= 0) {
				scheduled.splice(index, 1);
			}
		},
		fire: async (): Promise<void> => {
			const snapshot = scheduled.slice();
			await Promise.all(snapshot.map(async (item) => await item.callback()));
		},
		active: (): readonly ScheduledInterval[] => scheduled.slice(),
	};
}

describe('startHeartbeatSender', () => {
	let fakeTimer: ReturnType<typeof createFakeInterval>;
	let fetchMock: ReturnType<typeof vi.fn>;
	const warnings: string[] = [];

	beforeEach(() => {
		fakeTimer = createFakeInterval();
		fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		warnings.length = 0;
	});
```

- [ ] **Step 2: Cover immediate send, cadence, and URL shape**

Append:

```ts
	it('fires immediately on start', async () => {
		const handle = startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock as unknown as typeof fetch,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [calledUrl] = fetchMock.mock.calls[0] ?? [];
		expect(calledUrl).toBe('http://caller:3000/tasks/task-1/heartbeat');

		handle.stop();
	});

	it('uses the configured cadence', () => {
		const handle = startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			cadenceMs: 2_500,
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		expect(fakeTimer.active()).toHaveLength(1);
		expect(fakeTimer.active()[0]?.delayMs).toBe(2_500);

		handle.stop();
	});

	it('uses the exact request task id in the request path', async () => {
		const handle = startHeartbeatSender('request-task-42', {
			callerUrl: 'http://caller:3000/',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		await Promise.resolve();
		await Promise.resolve();

		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('http://caller:3000/tasks/request-task-42/heartbeat');

		handle.stop();
	});
```

- [ ] **Step 3: Cover failure handling and terminal responses**

Append:

```ts
	it('logs warnings for non-2xx responses and escalates only on the first and third failures', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 502 }));

		startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock as unknown as typeof fetch,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();
		await fakeTimer.fire();
		await fakeTimer.fire();

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain('HTTP 502');
		expect(warnings[1]).toContain('3 consecutive times');
	});

	it('stops heartbeating when the caller returns a terminal status', async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 410 }));

		startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock as unknown as typeof fetch,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		await fakeTimer.fire();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(warnings[0]).toContain('stopping heartbeat permanently');
		expect(fakeTimer.active()).toHaveLength(0);
	});
```

- [ ] **Step 4: Cover stop cleanup**

Append and close the `describe()` block:

```ts
	it('aborts an in-flight heartbeat fetch when stopped', async () => {
		let signal: AbortSignal | undefined;
		const hangingFetch: typeof fetch = (_url, init) => {
			signal = init?.signal as AbortSignal | undefined;
			return new Promise<Response>(() => {});
		};

		const handle = startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: hangingFetch,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		handle.stop();

		expect(signal?.aborted).toBe(true);
		expect(fakeTimer.active()).toHaveLength(0);
	});

	it('stop cancels the interval and is idempotent', () => {
		const handle = startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		handle.stop();
		handle.stop();

		expect(fakeTimer.active()).toHaveLength(0);
	});
});
```

- [ ] **Step 5: Run heartbeat test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/heartbeat-sender.test.ts
```

Expected: PASS.

---

### Task 9: Share Zig Compatibility Logic

**Files:**
- Create: `packages/agent-vm/src/build/zig-compatibility.ts`
- Create: `packages/agent-vm/src/build/zig-compatibility.test.ts`
- Modify: `packages/agent-vm/src/cli/build-command.ts`
- Modify: `packages/agent-vm/src/operations/doctor.ts`

- [ ] **Step 1: Create the shared Zig compatibility helper**

Create `packages/agent-vm/src/build/zig-compatibility.ts`:

```ts
import { resolveGondolinMinimumZigVersion } from '@agent-vm/gondolin-adapter';
import { execa } from 'execa';

export interface ZigCompatibilityResult {
	readonly compatible: boolean;
	readonly hint: string;
	readonly requiredVersion: string;
	readonly installedVersion?: string;
}

export async function resolveGondolinCompatibleZigVersion(
	resolveRequiredVersion: () => Promise<string> = resolveGondolinMinimumZigVersion,
): Promise<string> {
	return await resolveRequiredVersion();
}

function parseZigVersion(version: string): readonly [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isZigVersionAtLeast(installedVersion: string, requiredVersion: string): boolean {
	const installed = parseZigVersion(installedVersion);
	const required = parseZigVersion(requiredVersion);
	if (!installed || !required) {
		return false;
	}

	const [installedMajor, installedMinor, installedPatch] = installed;
	const [requiredMajor, requiredMinor, requiredPatch] = required;
	if (installedMajor !== requiredMajor) {
		return installedMajor > requiredMajor;
	}
	if (installedMinor !== requiredMinor) {
		return installedMinor > requiredMinor;
	}
	return installedPatch >= requiredPatch;
}

export function buildZigInstallHint(requiredZigVersion: string | undefined): string {
	return requiredZigVersion
		? `Install Zig >= ${requiredZigVersion}. On macOS: brew install zig.`
		: 'Install Zig required by Gondolin. On macOS: brew install zig.';
}

export function buildZigUpgradeHint(requiredZigVersion: string): string {
	return `Requires Zig >= ${requiredZigVersion}. On macOS: brew install zig.`;
}

export async function resolveHostZigVersion(): Promise<string | undefined> {
	try {
		const result = await execa('zig', ['version']);
		return result.stdout.trim();
	} catch {
		return undefined;
	}
}

export function checkGondolinZigCompatibility(options: {
	readonly installedVersion?: string;
	readonly requiredVersion: string;
}): ZigCompatibilityResult {
	const compatible = options.installedVersion
		? isZigVersionAtLeast(options.installedVersion, options.requiredVersion)
		: false;
	return {
		compatible,
		hint: options.installedVersion
			? `found ${options.installedVersion}, required >= ${options.requiredVersion}`
			: buildZigInstallHint(options.requiredVersion),
		requiredVersion: options.requiredVersion,
		...(options.installedVersion ? { installedVersion: options.installedVersion } : {}),
	};
}

export function assertGondolinZigCompatibility(options: {
	readonly installedVersion?: string;
	readonly requiredVersion: string;
}): void {
	if (checkGondolinZigCompatibility(options).compatible) {
		return;
	}
	if (options.installedVersion) {
		throw new Error(
			`${buildZigUpgradeHint(options.requiredVersion)} Current version: ${options.installedVersion}.`,
		);
	}
	throw new Error(buildZigInstallHint(options.requiredVersion));
}
```

- [ ] **Step 2: Add helper tests**

Create `packages/agent-vm/src/build/zig-compatibility.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import {
	assertGondolinZigCompatibility,
	checkGondolinZigCompatibility,
	isZigVersionAtLeast,
} from './zig-compatibility.js';

describe('zig-compatibility', () => {
	test('compares semantic Zig versions as minimum versions', () => {
		expect(isZigVersionAtLeast('0.15.2', '0.15.1')).toBe(true);
		expect(isZigVersionAtLeast('0.16.0', '0.15.9')).toBe(true);
		expect(isZigVersionAtLeast('0.14.9', '0.15.0')).toBe(false);
		expect(isZigVersionAtLeast('not-a-version', '0.15.0')).toBe(false);
	});

	test('reports missing and outdated Zig installations', () => {
		expect(
			checkGondolinZigCompatibility({
				requiredVersion: '0.15.2',
			}),
		).toMatchObject({
			compatible: false,
			hint: 'Install Zig >= 0.15.2. On macOS: brew install zig.',
		});

		expect(() =>
			assertGondolinZigCompatibility({
				installedVersion: '0.14.0',
				requiredVersion: '0.15.2',
			}),
		).toThrow('Requires Zig >= 0.15.2');
	});
});
```

- [ ] **Step 3: Use the helper from build command**

In `packages/agent-vm/src/cli/build-command.ts`, replace the `execa` import and local Zig helpers with:

```ts
import {
	assertGondolinZigCompatibility,
	resolveHostZigVersion,
} from '../build/zig-compatibility.js';
```

Remove `buildZigInstallHint`, `buildZigUpgradeHint`, and `isVersionAtLeast` from the `../operations/doctor.js` import in this file.

Change `assertZigBuildPrerequisite()` to:

```ts
async function assertZigBuildPrerequisite(
	resolveRequiredZigVersion: () => Promise<string>,
	resolveZigVersion: () => Promise<string | undefined>,
): Promise<void> {
	const requiredZigVersion = await resolveRequiredZigVersion();
	const zigVersion = await resolveZigVersion();
	assertGondolinZigCompatibility({
		requiredVersion: requiredZigVersion,
		...(zigVersion ? { installedVersion: zigVersion } : {}),
	});
}
```

- [ ] **Step 4: Reuse helper exports from doctor checks**

In `packages/agent-vm/src/operations/doctor.ts`, import:

```ts
import {
	buildZigInstallHint,
	buildZigUpgradeHint,
	isZigVersionAtLeast,
} from '../build/zig-compatibility.js';
```

Delete the local `parseVersionParts()`, `isVersionAtLeast()`, `buildZigInstallHint()`, and `buildZigUpgradeHint()` definitions. Change the Zig version check to call:

```ts
const ok = isZigVersionAtLeast(zigVersion, requiredZigVersion);
```

- [ ] **Step 5: Run targeted Zig tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/build/zig-compatibility.test.ts packages/agent-vm/src/cli/build-command.test.ts packages/agent-vm/src/cli/controller-operation-commands.test.ts
```

Expected: PASS.

---

### Task 10: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run formatter check**

Run:

```bash
pnpm fmt:check
```

Expected: exit code 0.

- [ ] **Step 2: Run lint**

Run:

```bash
pnpm lint
```

Expected: exit code 0.

- [ ] **Step 3: Run type-aware lint**

Run:

```bash
pnpm lint:types
```

Expected: exit code 0.

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: exit code 0.

- [ ] **Step 5: Run unit tests**

Run:

```bash
pnpm test:unit
```

Expected: exit code 0.

- [ ] **Step 6: Run integration tests**

Run:

```bash
pnpm test:integration
```

Expected: exit code 0.

- [ ] **Step 7: Run smoke tests**

Run:

```bash
pnpm test:smoke
```

Expected: exit code 0.

- [ ] **Step 8: Run full quality gate**

Run:

```bash
pnpm check
```

Expected: exit code 0.

- [ ] **Step 9: Final stale-text search**

Run:

```bash
rg -n "otherwise start a new task|treating repo resources as empty" \
  packages/agent-vm/src packages/agent-vm-worker/src docs/reference

rg -n "ARG GIT_SHA|gitSha.*local|Pod runtimes overwrite|Container-host builds usually replace" \
  packages/agent-vm/src/config/system-cache-identifier.ts \
  packages/agent-vm/src/config/system-cache-identifier.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts \
  packages/agent-vm/src/cli/vm-host-system-templates.ts \
  packages/agent-vm/src/cli/vm-host-system-templates.test.ts \
  docs/reference/configuration/system-cache-identifier.md \
  docs/reference/configuration/README.md
```

Expected: no matches except intentionally preserved legacy-loader tests, if any.

---

## Self-Review Checklist

- Spec coverage:
  - Runtime-aware Git path handling from Relay PR #67 is covered by Task 1.
  - Cancellable Git retry sleeps from Relay `d3af6a9` are covered by Task 1.
  - Git retry phase from Relay PR #53 is covered by Task 2.
  - Precise retry-after metadata from Relay `1d60ef4` is preserved by Task 2.
  - Repo resource semantics from Relay PR #66 are covered by Tasks 3-6.
  - Cache identity cleanup from Relay PR #65 is covered by Task 7.
  - Heartbeat sender coverage is covered by Task 8 using personal's generic `callerUrl`/`requestTaskId` naming.
  - Shared Zig compatibility logic is covered by Task 9 and deliberately adapts Relay's helper to personal's `@agent-vm/*` package names.
  - KVM/ECR/k8s/prebuilt archive exclusions are explicitly out of scope.
- Placeholder scan:
  - No `TBD`, `TODO`, or unspecified edge-case tasks.
  - Each code-changing task has a concrete test and concrete implementation shape.
- Type consistency:
  - `controllerGitPushPhaseSchema` is reused by retry and failed events.
  - `runGitCommandWithTransientRetries()` accepts `run(signal)`, `signal`, and `sleep(delayMs, signal)`.
  - `LoadedRepoResourceDescription` is `ResolvedRepoResourcesDescription | null`.
  - `selectedExternalResources` uses `Record<string, { binding: ResourceBinding; target: ResourceBinding }>` consistently.
  - Cache identity defaults use `cacheProfile` and `cacheFormat`; loader remains permissive.
