# FD-Rooted RealFS Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden pinned RealFS mounts with Linux fd-rooted root-swap protection and operation-wide containment checks, while retaining explicit weaker fallback behavior for macOS development.

**Architecture:** Keep lease path translation and allow-root validation in `agent-vm`, but move the final mount trust boundary into `@agent-vm/gondolin-adapter`. The adapter pins the workspace directory with `O_NOFOLLOW | O_DIRECTORY`, uses `/proc/self/fd/<rootFd>` on Linux so the workspace root cannot be swapped after validation, and applies containment checks consistently to every read and mutation operation. On platforms where Node cannot traverse a directory fd by path, the adapter must choose an explicit guarded fallback, not silently claim true fd-rooting.

**Tech Stack:** TypeScript, Node 24 `fs`, Gondolin `VirtualProvider`, Vitest, Linux `/proc/self/fd`, current `@earendil-works/gondolin` provider surface.

---

## Why This Is Separate

Manual/update work changes docs and scaffolding. This work changes the filesystem security boundary for caller-provided tool VM workspaces.

Current state on master:

- `packages/agent-vm/src/controller/leases/lease-workspace-paths.ts` validates guest paths, translates them to allowed host roots, and rejects traversal/symlink escapes.
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts` revalidates before VM creation, pins the workspace root, and passes `pinnedHostRoot` into `createManagedVm`.
- `packages/gondolin-adapter/src/pinned-realfs.ts` opens the root with `O_NOFOLLOW | O_DIRECTORY`, but `createPinnedRealFsProvider()` still wraps a normal `RealFSProvider(root.realPath)`. That means provider operations still reopen by path after checking the root identity.

That is better than plain `realpath`, but it is not a complete child-path escape defense. `/proc/self/fd/<rootFd>` prevents the root directory from being swapped, but the kernel still follows child symlinks. The provider must therefore combine fd-rooted root resolution with consistent realpath containment checks for every operation that touches a path.

---

## Platform Decision

Linux:

Use `/proc/self/fd/<fd>/<relative-path>` for provider operations. This is the target production hardening path.

macOS:

Node does not expose `openat(2)`, and `/dev/fd/<dirfd>/child` does not behave like Linux `/proc/self/fd/<dirfd>/child` on the local development host. The adapter must not pretend macOS has true fd-rooting. It should use an explicit fallback named `guarded-path` for local development, with tests and docs that call out the weaker boundary.

No native addon is introduced in this plan. A native `openat` binding can be a future hardening plan if macOS needs equivalent fd-relative traversal or if we want to eliminate the remaining realpath-then-operation child symlink TOCTOU window.

---

## Review Corrections Before Execution

The previous version of this plan overclaimed what fd-rooting solves. Execute this corrected threat model:

1. Allowed-root validation in `lease-workspace-paths.ts` already closes the original caller-controlled `/etc` mount request. This plan is defense-in-depth for mount-boundary root swap and child path containment, not a replacement for route validation.
2. `/proc/self/fd/<rootFd>` solves root directory swap. It does not by itself stop child symlink escapes such as `/work/link -> /etc`.
3. Every operation must go through the same containment helper: read, open, stat, write, unlink, mkdir, rmdir, rename, readdir, and existence checks where the provider exposes them. Do not protect only read paths.
4. `rename` must validate both source and destination. A safe source with an escaping destination is still a write escape.
5. If the plan mentions `O_NOFOLLOW`, the implementation must actually use numeric flags where Node supports them, or the claim must be removed. Do not leave a helper that throws instead of enforcing `O_NOFOLLOW`.
6. Child symlink checks are still realpath-then-operation and therefore reduce, but do not fully eliminate, TOCTOU without native `openat`/path-walking support. State that limitation in code comments and docs.
7. Hardlinks are a separate policy. Realpath containment will not distinguish a hardlink whose inode is also reachable outside the workspace. The implementation should not claim to solve hardlink escape; document it as constrained by host permissions and outside this plan unless a later policy forbids hardlinks.
8. Before implementation, inspect OpenClaw sandbox seeding for legitimate symlinks. Relative symlinks that remain inside the workspace must continue to work; absolute symlinks that escape must fail.
9. Linux is the only platform with the intended fd-rooted guarantee in this plan. macOS fallback is for local development and must be named weaker in tests/docs.

---

## File Structure

`packages/gondolin-adapter/src/fd-rooted-realfs-provider.ts`

Owns the new provider. Implements the Gondolin `VirtualProvider` surface by translating guest paths to Linux fd-rooted host paths.

`packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts`

Unit tests for path normalization, traversal rejection, symlink escape handling, root swap handling, and platform fallback selection.

`packages/gondolin-adapter/src/pinned-realfs.ts`

Keeps root pinning and root cleanup. Delegates provider creation to the new provider factory.

`packages/gondolin-adapter/src/pinned-realfs.test.ts`

Updates tests so pinned provider creation proves Linux fd-rooted behavior when supported and guarded fallback behavior when unsupported.

`packages/gondolin-adapter/src/vm-adapter.ts`

Keeps `pinnedHostRoot` VFS spec support, but removes direct `RealFSProvider(root.realPath)` fallback from pinned mounts.

`packages/gondolin-adapter/src/vm-adapter.test.ts`

Asserts pinned root lifecycle is still correct and that pinned mounts do not call `createRealFsProvider(hostPath)`.

`packages/gondolin-adapter/src/index.ts`

Exports the new provider helpers for tests and downstream diagnostics.

`packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`

Adds a comment that the adapter is the final mount boundary and the lifecycle layer only validates/pins the lease root.

`packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`

Keeps leak-prevention tests and adds a validation-failure cleanup assertion if not already present.

`docs/specs/fd-rooted-realfs-provider.md`

Explains the threat model, Linux behavior, macOS fallback, and future native `openat` option.

---

## Provider Semantics

The new provider must:

- Accept only paths that normalize under `/`.
- Reject `..` traversal after normalization.
- Resolve the root through the pinned fd, not through the original host path, on Linux.
- Apply `O_NOFOLLOW` when opening symlink-sensitive child paths where Node exposes numeric flags; if the provider accepts string flags, translate them to numeric flags before adding `O_NOFOLLOW` or do not claim `O_NOFOLLOW` protection for that method.
- Resolve the final realpath and assert it stays inside the pinned root before every operation that follows symlinks.
- Ensure all write and mutation methods use the same fd-rooted translation and containment checks as read methods.
- Validate both source and destination paths for `rename`.
- Never call `new RealFSProvider(root.realPath)` for a pinned mount on Linux.
- Close the root fd exactly once through existing lifecycle cleanup.
- Preserve relative symlinks that resolve inside the workspace.
- Reject absolute or relative symlinks that resolve outside the workspace.

The provider may use Node's synchronous fs APIs internally because Gondolin's provider surface has both sync and async methods. Async methods can wrap sync operations with `Promise.resolve()` for the first implementation; correctness beats async elegance here.

Do not claim this eliminates every TOCTOU class. Without a native `openat`/path-walking implementation, there remains a window between realpath containment and the subsequent filesystem operation for child paths. This plan intentionally narrows the boundary and makes the limitation explicit.

---

### Task 1: Provider Platform Probe And Path Translator

**Files:**
- Create: `packages/gondolin-adapter/src/fd-rooted-realfs-provider.ts`
- Test: `packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts`

- [ ] **Step 1: Write failing tests for platform probe and path translation**

Create `packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	buildFdRootedPath,
	detectFdRootedPathSupport,
	normalizeVirtualRealFsPath,
} from './fd-rooted-realfs-provider.js';
import { closePinnedRealFsRoot, pinRealFsRoot } from './pinned-realfs.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

function createTemporaryDirectory(): string {
	const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-fd-realfs-'));
	createdDirectories.push(directoryPath);
	return directoryPath;
}

describe('fd-rooted RealFS path support', () => {
	it('normalizes virtual paths without allowing traversal above root', () => {
		expect(normalizeVirtualRealFsPath('/')).toBe('.');
		expect(normalizeVirtualRealFsPath('/work/file.txt')).toBe('work/file.txt');
		expect(normalizeVirtualRealFsPath('work/file.txt')).toBe('work/file.txt');
		expect(() => normalizeVirtualRealFsPath('/work/../file.txt')).toThrow(
			/Path traversal is not allowed/u,
		);
		expect(() => normalizeVirtualRealFsPath('../file.txt')).toThrow(
			/Path traversal is not allowed/u,
		);
	});

	it('builds Linux fd-rooted paths through /proc/self/fd', () => {
		expect(buildFdRootedPath({ fd: 12, relativePath: 'work/file.txt' })).toBe(
			'/proc/self/fd/12/work/file.txt',
		);
		expect(buildFdRootedPath({ fd: 12, relativePath: '.' })).toBe('/proc/self/fd/12');
	});

	it('detects whether this platform can traverse child paths through a directory fd', () => {
		const rootDirectory = path.join(createTemporaryDirectory(), 'root');
		fs.mkdirSync(rootDirectory);
		fs.writeFileSync(path.join(rootDirectory, 'probe.txt'), 'ok', 'utf8');
		const root = pinRealFsRoot(rootDirectory);

		try {
			const support = detectFdRootedPathSupport(root);
			expect(support.kind === 'supported' || support.kind === 'unsupported').toBe(true);
			if (process.platform === 'linux') {
				expect(support.kind).toBe('supported');
			}
		} finally {
			closePinnedRealFsRoot(root);
		}
	});
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts
```

Expected: FAIL because `fd-rooted-realfs-provider.ts` does not exist.

- [ ] **Step 3: Add the platform probe and translator**

Create `packages/gondolin-adapter/src/fd-rooted-realfs-provider.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

import type { VirtualProvider } from '@earendil-works/gondolin';

import type { PinnedRealFsRoot } from './pinned-realfs.js';

export type FdRootedPathSupport =
	| { readonly kind: 'supported'; readonly rootFdPath: string }
	| { readonly kind: 'unsupported'; readonly reason: string };

export function normalizeVirtualRealFsPath(virtualPath: string): string {
	const normalizedPath = path.posix.normalize(virtualPath.startsWith('/') ? virtualPath : `/${virtualPath}`);
	const segments = normalizedPath.split('/').filter((segment) => segment.length > 0);
	if (segments.includes('..') || virtualPath.split(/[\\/]+/u).includes('..')) {
		throw new Error(`Path traversal is not allowed in RealFS virtual path: ${virtualPath}`);
	}
	return segments.length === 0 ? '.' : segments.join('/');
}

export function buildFdRootedPath(options: { readonly fd: number; readonly relativePath: string }): string {
	return options.relativePath === '.'
		? `/proc/self/fd/${String(options.fd)}`
		: `/proc/self/fd/${String(options.fd)}/${options.relativePath}`;
}

export function detectFdRootedPathSupport(root: PinnedRealFsRoot): FdRootedPathSupport {
	const rootFdPath = buildFdRootedPath({ fd: root.fd, relativePath: '.' });
	try {
		const stats = fs.statSync(rootFdPath);
		if (!stats.isDirectory()) {
			return { kind: 'unsupported', reason: `${rootFdPath} is not a directory` };
		}
		return { kind: 'supported', rootFdPath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: 'unsupported', reason: message };
	}
}

export interface CreateFdRootedRealFsProviderOptions {
	readonly root: PinnedRealFsRoot;
}
```

- [ ] **Step 4: Run the test**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gondolin-adapter/src/fd-rooted-realfs-provider.ts packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts
git commit -m "feat: add fd-rooted realfs path support probe" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Linux FD-Rooted VirtualProvider

**Files:**
- Modify: `packages/gondolin-adapter/src/fd-rooted-realfs-provider.ts`
- Modify: `packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts`

- [ ] **Step 1: Add provider behavior tests**

Append to `packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts`:

```ts
import { createFdRootedRealFsProvider } from './fd-rooted-realfs-provider.js';

describe('createFdRootedRealFsProvider', () => {
	it('reads and writes through the pinned root when fd-rooted paths are supported', async () => {
		const rootDirectory = path.join(createTemporaryDirectory(), 'root');
		fs.mkdirSync(rootDirectory);
		fs.writeFileSync(path.join(rootDirectory, 'input.txt'), 'hello', 'utf8');
		const root = pinRealFsRoot(rootDirectory);

		try {
			if (detectFdRootedPathSupport(root).kind === 'unsupported') {
				return;
			}
			const provider = createFdRootedRealFsProvider({ root });

			expect(provider.readFileSync?.('/input.txt', 'utf8')).toBe('hello');
			provider.writeFileSync?.('/output.txt', 'world', { encoding: 'utf8' });

			expect(fs.readFileSync(path.join(rootDirectory, 'output.txt'), 'utf8')).toBe('world');
			await expect(provider.readFile('/input.txt', 'utf8')).resolves.toBe('hello');
		} finally {
			closePinnedRealFsRoot(root);
		}
	});

	it('rejects symlink child escapes when fd-rooted paths are supported', () => {
		const temporaryDirectory = createTemporaryDirectory();
		const rootDirectory = path.join(temporaryDirectory, 'root');
		const outsideDirectory = path.join(temporaryDirectory, 'outside');
		fs.mkdirSync(rootDirectory);
		fs.mkdirSync(outsideDirectory);
		fs.writeFileSync(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
		fs.symlinkSync(outsideDirectory, path.join(rootDirectory, 'link'));
		const root = pinRealFsRoot(rootDirectory);

		try {
			if (detectFdRootedPathSupport(root).kind === 'unsupported') {
				return;
			}
			const provider = createFdRootedRealFsProvider({ root });

			expect(() => provider.readFileSync?.('/link/secret.txt', 'utf8')).toThrow(
				/escapes pinned RealFS root/u,
			);
		} finally {
			closePinnedRealFsRoot(root);
		}
	});

	it('rejects write, unlink, mkdir, and rename operations through escaping symlinks', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const rootDirectory = path.join(temporaryDirectory, 'root');
		const outsideDirectory = path.join(temporaryDirectory, 'outside');
		fs.mkdirSync(rootDirectory);
		fs.mkdirSync(outsideDirectory);
		fs.writeFileSync(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
		fs.symlinkSync(outsideDirectory, path.join(rootDirectory, 'link'));
		const root = pinRealFsRoot(rootDirectory);

		try {
			if (detectFdRootedPathSupport(root).kind === 'unsupported') {
				return;
			}
			const provider = createFdRootedRealFsProvider({ root });

			expect(() => provider.writeFileSync?.('/link/secret.txt', 'changed', { encoding: 'utf8' })).toThrow(
				/escapes pinned RealFS root/u,
			);
			expect(() => provider.unlinkSync?.('/link/secret.txt')).toThrow(/escapes pinned RealFS root/u);
			expect(() => provider.mkdirSync?.('/link/new-dir')).toThrow(/escapes pinned RealFS root/u);
			expect(() => provider.renameSync?.('/input.txt', '/link/moved.txt')).toThrow(
				/escapes pinned RealFS root/u,
			);
			await expect(provider.writeFile('/link/secret.txt', 'changed', { encoding: 'utf8' })).rejects.toThrow(
				/escapes pinned RealFS root/u,
			);
		} finally {
			closePinnedRealFsRoot(root);
		}
	});

	it('allows relative symlinks that stay inside the pinned workspace', () => {
		const rootDirectory = path.join(createTemporaryDirectory(), 'root');
		fs.mkdirSync(rootDirectory);
		fs.mkdirSync(path.join(rootDirectory, 'safe'));
		fs.writeFileSync(path.join(rootDirectory, 'safe', 'file.txt'), 'inside', 'utf8');
		fs.symlinkSync('safe', path.join(rootDirectory, 'safe-link'));
		const root = pinRealFsRoot(rootDirectory);

		try {
			if (detectFdRootedPathSupport(root).kind === 'unsupported') {
				return;
			}
			const provider = createFdRootedRealFsProvider({ root });

			expect(provider.readFileSync?.('/safe-link/file.txt', 'utf8')).toBe('inside');
		} finally {
			closePinnedRealFsRoot(root);
		}
	});

	it('rejects provider creation when fd-rooted paths are unsupported', () => {
		const rootDirectory = path.join(createTemporaryDirectory(), 'root');
		fs.mkdirSync(rootDirectory);
		const root = pinRealFsRoot(rootDirectory);

		try {
			if (detectFdRootedPathSupport(root).kind === 'supported') {
				return;
			}
			expect(() => createFdRootedRealFsProvider({ root })).toThrow(/fd-rooted RealFS is not supported/u);
		} finally {
			closePinnedRealFsRoot(root);
		}
	});
});
```

- [ ] **Step 2: Run the failing provider tests**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts -t "createFdRootedRealFsProvider"
```

Expected: FAIL because `createFdRootedRealFsProvider()` has not been exported yet.

- [ ] **Step 3: Implement the provider**

Add `createFdRootedRealFsProvider()` to `packages/gondolin-adapter/src/fd-rooted-realfs-provider.ts`:

```ts
import type { Dirent, Stats } from 'node:fs';

function fdPathForVirtualPath(root: PinnedRealFsRoot, virtualPath: string): string {
	const relativePath = normalizeVirtualRealFsPath(virtualPath);
	return buildFdRootedPath({ fd: root.fd, relativePath });
}

function assertResolvedPathStaysInsideRoot(root: PinnedRealFsRoot, resolvedPath: string): void {
	const relativePath = path.relative(root.realPath, resolvedPath);
	if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
		throw new Error(
			`RealFS path '${resolvedPath}' escapes pinned RealFS root '${root.realPath}'.`,
		);
	}
}

function containedExistingPath(root: PinnedRealFsRoot, virtualPath: string): string {
	const hostPath = fdPathForVirtualPath(root, virtualPath);
	const resolvedPath = fs.realpathSync(hostPath);
	assertResolvedPathStaysInsideRoot(root, resolvedPath);
	return hostPath;
}

function containedParentPath(root: PinnedRealFsRoot, virtualPath: string): string {
	const hostPath = fdPathForVirtualPath(root, virtualPath);
	const parentPath = path.dirname(hostPath);
	const resolvedParentPath = fs.realpathSync(parentPath);
	assertResolvedPathStaysInsideRoot(root, resolvedParentPath);
	return hostPath;
}

function containedDestinationPath(root: PinnedRealFsRoot, virtualPath: string): string {
	const hostPath = fdPathForVirtualPath(root, virtualPath);
	if (fs.existsSync(hostPath)) {
		return containedExistingPath(root, virtualPath);
	}
	return containedParentPath(root, virtualPath);
}

export function createFdRootedRealFsProvider(
	options: CreateFdRootedRealFsProviderOptions,
): VirtualProvider {
	const support = detectFdRootedPathSupport(options.root);
	if (support.kind === 'unsupported') {
		throw new Error(`fd-rooted RealFS is not supported on this platform: ${support.reason}`);
	}

	const provider = {
		readonly: false,
			supportsSymlinks: true,
			supportsWatch: false,
			openSync(virtualPath: string, flags: string, mode?: number) {
				const hostPath = containedDestinationPath(options.root, virtualPath);
				return fs.openSync(hostPath, flags, mode);
			},
			async open(virtualPath: string, flags: string, mode?: number) {
				const hostPath = containedDestinationPath(options.root, virtualPath);
				return await fs.promises.open(hostPath, flags, mode);
			},
			statSync(virtualPath: string, statOptions?: object): Stats {
				const hostPath = containedExistingPath(options.root, virtualPath);
				return fs.statSync(hostPath, statOptions);
			},
			async stat(virtualPath: string, statOptions?: object): Promise<Stats> {
				const hostPath = containedExistingPath(options.root, virtualPath);
				return await fs.promises.stat(hostPath, statOptions);
			},
		lstatSync(virtualPath: string, statOptions?: object): Stats {
			return fs.lstatSync(fdPathForVirtualPath(options.root, virtualPath), statOptions);
		},
		async lstat(virtualPath: string, statOptions?: object): Promise<Stats> {
			return await fs.promises.lstat(fdPathForVirtualPath(options.root, virtualPath), statOptions);
		},
			readdirSync(virtualPath: string, readdirOptions?: object): Array<string | Dirent> {
				return fs.readdirSync(containedExistingPath(options.root, virtualPath), readdirOptions);
			},
			async readdir(virtualPath: string, readdirOptions?: object): Promise<Array<string | Dirent>> {
				return await fs.promises.readdir(containedExistingPath(options.root, virtualPath), readdirOptions);
			},
			mkdirSync(virtualPath: string, mkdirOptions?: object): void | string {
				return fs.mkdirSync(containedParentPath(options.root, virtualPath), mkdirOptions);
			},
			async mkdir(virtualPath: string, mkdirOptions?: object): Promise<void | string> {
				return await fs.promises.mkdir(containedParentPath(options.root, virtualPath), mkdirOptions);
			},
			rmdirSync(virtualPath: string): void {
				fs.rmdirSync(containedExistingPath(options.root, virtualPath));
			},
			async rmdir(virtualPath: string): Promise<void> {
				await fs.promises.rmdir(containedExistingPath(options.root, virtualPath));
			},
			unlinkSync(virtualPath: string): void {
				fs.unlinkSync(containedExistingPath(options.root, virtualPath));
			},
			async unlink(virtualPath: string): Promise<void> {
				await fs.promises.unlink(containedExistingPath(options.root, virtualPath));
			},
			renameSync(oldVirtualPath: string, newVirtualPath: string): void {
				fs.renameSync(
					containedExistingPath(options.root, oldVirtualPath),
					containedDestinationPath(options.root, newVirtualPath),
				);
			},
			async rename(oldVirtualPath: string, newVirtualPath: string): Promise<void> {
				await fs.promises.rename(
					containedExistingPath(options.root, oldVirtualPath),
					containedDestinationPath(options.root, newVirtualPath),
				);
			},
			readFileSync(virtualPath: string, readOptions?: { encoding?: BufferEncoding } | BufferEncoding): Buffer | string {
				const hostPath = containedExistingPath(options.root, virtualPath);
				return fs.readFileSync(hostPath, readOptions);
			},
			async readFile(virtualPath: string, readOptions?: { encoding?: BufferEncoding } | BufferEncoding): Promise<Buffer | string> {
				const hostPath = containedExistingPath(options.root, virtualPath);
				return await fs.promises.readFile(hostPath, readOptions);
			},
			writeFileSync(
				virtualPath: string,
				data: Buffer | string,
				writeOptions?: { encoding?: BufferEncoding; mode?: number },
			): void {
				fs.writeFileSync(containedDestinationPath(options.root, virtualPath), data, writeOptions);
			},
			async writeFile(
				virtualPath: string,
				data: Buffer | string,
				writeOptions?: { encoding?: BufferEncoding; mode?: number },
			): Promise<void> {
				await fs.promises.writeFile(containedDestinationPath(options.root, virtualPath), data, writeOptions);
			},
			existsSync(virtualPath: string): boolean {
				try {
					return fs.existsSync(containedExistingPath(options.root, virtualPath));
				} catch {
					return false;
				}
			},
			async exists(virtualPath: string): Promise<boolean> {
				try {
					return fs.existsSync(containedExistingPath(options.root, virtualPath));
				} catch {
					return false;
				}
			},
		} satisfies VirtualProvider;

	return provider;
}
```

If TypeScript rejects `fs.promises.FileHandle` as a `VirtualFileHandle`, wrap the returned file handle behind an adapter object that implements the `VirtualFileHandle` methods from Gondolin's `VirtualProvider` type.

If the provider surface requires string flags and cannot safely add `O_NOFOLLOW`, remove the `O_NOFOLLOW` claim from this task and the spec. If numeric flags are available at the call boundary, translate string flags to numeric flags and OR in `fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC` for methods that open existing symlink-sensitive child paths.

- [ ] **Step 4: Run provider tests**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts
```

Expected: PASS on Linux; on macOS, supported-only tests skip their assertions by returning early and the unsupported test passes.

- [ ] **Step 5: Run adapter typecheck early**

Run:

```bash
pnpm --filter @agent-vm/gondolin-adapter typecheck
```

Expected: PASS. If it fails because Node fs return overloads do not line up with Gondolin's `VirtualProvider`, add narrow wrapper functions with explicit `VirtualProvider` method signatures. Do not use `any`.

- [ ] **Step 6: Commit**

```bash
git add packages/gondolin-adapter/src/fd-rooted-realfs-provider.ts packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts
git commit -m "feat: add fd-rooted realfs provider" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Wire Pinned Mounts To FD-Rooted Provider

**Files:**
- Modify: `packages/gondolin-adapter/src/pinned-realfs.ts`
- Modify: `packages/gondolin-adapter/src/pinned-realfs.test.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`
- Modify: `packages/gondolin-adapter/src/index.ts`

- [ ] **Step 1: Write failing adapter tests**

In `packages/gondolin-adapter/src/vm-adapter.test.ts`, update the pinned mount test:

```ts
expect(dependencies.createRealFsProvider).not.toHaveBeenCalledWith(pinnedRoot.realPath);
expect(createPinnedRealFsProvider).toHaveBeenCalledWith(pinnedRoot);
```

In `packages/gondolin-adapter/src/pinned-realfs.test.ts`, add:

```ts
it('does not construct a path-based RealFSProvider for pinned roots when fd-rooted support exists', () => {
	const workspaceDirectory = path.join(createTemporaryDirectory(), 'workspace');
	fs.mkdirSync(workspaceDirectory);
	const root = pinRealFsRoot(workspaceDirectory);
	const createRealFsProvider = vi.fn(() => createProvider());

	try {
		if (process.platform !== 'linux') {
			return;
		}
		createPinnedRealFsProvider({ createRealFsProvider, root });
		expect(createRealFsProvider).not.toHaveBeenCalled();
	} finally {
		closePinnedRealFsRoot(root);
	}
});

it('wraps pinned readonly mounts without dropping fd-rooted provider semantics', () => {
	const workspaceDirectory = path.join(createTemporaryDirectory(), 'workspace');
	fs.mkdirSync(workspaceDirectory);
	const root = pinRealFsRoot(workspaceDirectory);
	const createRealFsProvider = vi.fn(() => createProvider());
	const createReadonlyProvider = vi.fn((provider: unknown) => ({ provider, readonly: true }));

	try {
		if (process.platform !== 'linux') {
			return;
		}
		const provider = createPinnedReadonlyRealFsProvider({
			createRealFsProvider,
			createReadonlyProvider,
			root,
		});

		expect(createRealFsProvider).not.toHaveBeenCalled();
		expect(createReadonlyProvider).toHaveBeenCalledOnce();
		expect(provider).toEqual(expect.objectContaining({ readonly: true }));
	} finally {
		closePinnedRealFsRoot(root);
	}
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/pinned-realfs.test.ts packages/gondolin-adapter/src/vm-adapter.test.ts
```

Expected: FAIL on Linux if pinned provider still delegates to `RealFSProvider(root.realPath)`.

- [ ] **Step 3: Wire provider creation**

Modify `packages/gondolin-adapter/src/pinned-realfs.ts`:

```ts
import {
	createFdRootedRealFsProvider,
	detectFdRootedPathSupport,
} from './fd-rooted-realfs-provider.js';
```

Replace `createPinnedRealFsProvider()` with:

```ts
export function createPinnedRealFsProvider(
	options: CreatePinnedRealFsProviderOptions,
): VirtualProvider {
	assertPinnedRealFsRoot(options.root);
	const support = detectFdRootedPathSupport(options.root);
	if (support.kind === 'supported') {
		return createFdRootedRealFsProvider({ root: options.root });
	}

	const provider = options.createRealFsProvider(options.root.realPath);
	return new Proxy(provider, {
		get(target: VirtualProvider, property: string | symbol, receiver: unknown): unknown {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== 'function') {
				return value;
			}

			return (...methodArguments: readonly unknown[]): unknown => {
				assertPinnedRealFsRoot(options.root);
				return Reflect.apply(value as ProviderMethod, target, methodArguments);
			};
		},
	});
}
```

This keeps local macOS development working with the existing guarded-path fallback, while Linux gets fd-rooted behavior.

Modify `packages/gondolin-adapter/src/index.ts`:

```ts
export * from './fd-rooted-realfs-provider.js';
```

- [ ] **Step 4: Run adapter tests**

Run:

```bash
pnpm vitest run packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts packages/gondolin-adapter/src/pinned-realfs.test.ts packages/gondolin-adapter/src/vm-adapter.test.ts
pnpm --filter @agent-vm/gondolin-adapter typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gondolin-adapter/src/fd-rooted-realfs-provider.ts packages/gondolin-adapter/src/pinned-realfs.ts packages/gondolin-adapter/src/pinned-realfs.test.ts packages/gondolin-adapter/src/vm-adapter.ts packages/gondolin-adapter/src/vm-adapter.test.ts packages/gondolin-adapter/src/index.ts
git commit -m "feat: use fd-rooted realfs for pinned mounts" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Tool VM Boundary Tests And Cleanup

**Files:**
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`

- [ ] **Step 1: Add cleanup regression test**

In `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`, add:

```ts
it('does not build images, create VMs, or pin roots when mount-boundary validation fails', async () => {
	const systemConfig = createToolVmSystemConfig();
	const standardProfile = systemConfig.toolProfiles.standard;
	if (!standardProfile) {
		throw new Error('Expected standard tool profile');
	}
	const buildGondolinImage = vi.fn(async () => ({
		built: true,
		fingerprint: 'tool-fingerprint',
		imagePath: '/cache/tool-fingerprint',
	}));
	const pinRealFsRoot = vi.fn();
	const createManagedVm = vi.fn();

	await expect(
		createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				workspaceDir: '/etc',
				zoneId: 'shravan',
			},
			{
				buildGondolinImage,
				createManagedVm,
				pinRealFsRoot,
			},
		),
	).rejects.toThrow(/outside allowed OpenClaw tool workspace roots/u);

	expect(buildGondolinImage).not.toHaveBeenCalled();
	expect(pinRealFsRoot).not.toHaveBeenCalled();
	expect(createManagedVm).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add the boundary comment**

In `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`, keep the existing pre-image validation and replace the mount-boundary comment with:

```ts
// The /lease route already validates caller-provided workspaceDir values, but
// internal callers can invoke createToolVm directly. This is the in-process
// mount boundary: revalidate, pin the root fd, and let gondolin-adapter choose
// the strongest platform-supported provider for pinnedHostRoot.
```

- [ ] **Step 3: Run tool VM tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
git commit -m "test: cover tool vm mount validation cleanup" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Security Spec

**Files:**
- Create: `docs/specs/fd-rooted-realfs-provider.md`

- [ ] **Step 1: Write the spec**

Create `docs/specs/fd-rooted-realfs-provider.md`:

```md
# FD-Rooted RealFS Provider

## Problem

OpenClaw tool VM leases contain a caller-provided workspace path. Agent-vm validates that path against allowed roots and pins the final directory with `O_NOFOLLOW | O_DIRECTORY`, but a normal path-based RealFS provider still reopens the root path for guest file operations.

That leaves two boundaries:

1. Root-swap boundary: the validated workspace root can be swapped after validation unless provider operations resolve through the pinned fd.
2. Child-path boundary: child symlinks can still point outside the workspace unless every provider operation checks resolved containment.

Fd-rooting solves the first boundary. Consistent containment checks reduce the second boundary but do not fully eliminate child symlink TOCTOU without native `openat`/path-walking support.

## Boundary

The controller owns lease validation and root pinning. The gondolin-adapter owns the final VFS provider boundary.

For Linux controllers, pinned RealFS mounts use `/proc/self/fd/<rootFd>` so child paths are resolved from the pinned directory fd rather than the original host path. Every operation that follows symlinks must realpath the operation target or parent and assert it remains under the pinned root before touching the filesystem.

For macOS local development, Node does not expose `openat(2)`, and `/dev/fd/<dirfd>/child` does not provide Linux-style directory-fd traversal. The adapter uses a guarded path fallback and names that weaker boundary explicitly in tests and diagnostics.

## Non-goals

This change does not add a native Node addon.
This change does not change lease API shape.
This change does not make arbitrary host paths acceptable; allowed-root validation remains required.
This change does not claim to solve hardlink policy. Hardlink behavior is constrained by host permissions and can be tightened in a later policy if needed.

## Required tests

- Root path symlink is rejected by `pinRealFsRoot()`.
- Guest `..` traversal is rejected before host path construction.
- Child symlink escape is rejected for read, open, stat, write, unlink, mkdir, rmdir, rename, readdir, and exists operations.
- Relative symlinks that resolve inside the workspace still work.
- Root swap after pinning does not redirect Linux fd-rooted operations.
- Readonly pinned mounts wrap the fd-rooted provider instead of falling back to path-based RealFS.
- Pinned fd closes when VM creation fails.
- Pinned fd closes when managed VM closes.
- macOS fallback is explicit and tested as weaker than Linux fd-rooting.
```

- [ ] **Step 2: Commit**

```bash
git add docs/specs/fd-rooted-realfs-provider.md
git commit -m "docs: specify fd-rooted realfs boundary" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Final Verification

- [ ] Run adapter targeted tests:

```bash
pnpm vitest run packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts packages/gondolin-adapter/src/pinned-realfs.test.ts packages/gondolin-adapter/src/vm-adapter.test.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
```

Expected: PASS.

- [ ] Run adapter typecheck:

```bash
pnpm --filter @agent-vm/gondolin-adapter typecheck
```

Expected: PASS.

- [ ] Run full quality gate:

```bash
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test:unit
```

Expected: all PASS.

- [ ] On a Linux controller host, run the provider test without platform skips:

```bash
pnpm vitest run packages/gondolin-adapter/src/fd-rooted-realfs-provider.test.ts
```

Expected: the fd-rooted read/write and symlink escape tests execute and PASS.

---

## Self-Review

Spec coverage:

- True Linux fd-rooted behavior: Tasks 1-3.
- macOS boundary explained instead of hidden: Platform Decision and Task 5.
- Gondolin adapter ownership: Tasks 2-3.
- Tool VM lifecycle cleanup: Task 4.
- Tests for security boundary: Tasks 1-4.

Placeholder scan:

- The Task 1 temporary throwing implementation is an intentional red-green TDD step and is replaced in Task 2.
- No final task contains TBD, TODO, or unspecified "add tests" language.

Type consistency:

- `PinnedRealFsRoot`, `VirtualProvider`, `FdRootedPathSupport`, and `CreateFdRootedRealFsProviderOptions` are defined before use.
- The plan avoids `any`; where Gondolin type overloads may need adapters, the plan directs explicit wrapper functions rather than casts.
