# OpenClaw Zone Git Controller Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenClaw zone workspace Git support where agents can commit zone-file changes, while agent-vm performs authenticated push from the host/controller without leaking GitHub credentials into gateway or Tool VMs.

**Architecture:** A configured OpenClaw zone gets one split Git repository whose Git metadata lives under `runtimeDir/zones/<zoneId>/zone-git/zone-files.git` and whose worktree is the zone's `zoneFilesDir`. When zone Git is enabled, Tool VMs mount the zone root at `/zone` and the zone Git runtime directory at `/agent-vm/zone-git`, and leases return the OpenClaw-requested `/zone/...` workdir instead of `/work`; this lets raw `git add` and `git commit` work from agent workspaces while preserving a single zone-root repo. Push is exposed as an OpenClaw plugin tool and a controller/CLI operation; the controller resolves the host GitHub token and pushes with explicit `--git-dir`/`--work-tree`, like worker pushes.

**Tech Stack:** TypeScript, Zod, Hono, cmd-ts, execa, Git CLI, Vitest, OpenClaw plugin API.

---

## Evidence And Constraints

- Current worker design already has the desired security split: agents may commit, but must not raw `git push`; controller handles authenticated push. Reference: `packages/agent-vm-worker/src/prompt/prompt-defaults.ts`.
- Worker split-Git uses a `.git` pointer in the VM worktree and a Git dir under runtime storage. Reference: `packages/agent-vm-worker/src/git/repo-worktree-bootstrap.ts`.
- Current OpenClaw Tool VM leases always mount the selected host work directory at `/work` and serialize `workdir: '/work'`. References: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`, `packages/agent-vm/src/controller/http/controller-http-route-support.ts`.
- A single zone-root repo cannot be discovered from `/work` if `/work` is only `/zone/agents/<agentId>`. To preserve one zone repo and allow raw `git commit`, the Tool VM must see the zone root at `/zone` and run inside `/zone/...`.
- DeepWiki confirmed OpenClaw plugins can register agent-visible tools via `api.registerTool`; use this to expose `zone_git_push` from the existing gondolin plugin without putting credentials in the Tool VM.

---

## File Structure

### New files

- `packages/agent-vm/src/controller/zone-git/zone-git-paths.ts`
  Owns host/guest paths for zone Git runtime storage.

- `packages/agent-vm/src/controller/zone-git/zone-git-operations.ts`
  Owns init/status/push operations using explicit Git args.

- `packages/agent-vm/src/controller/zone-git/zone-git-operations.test.ts`
  Uses temporary local bare remotes to prove init, commit, status, and push.

- `packages/agent-vm/src/cli/commands/zone-git-definition.ts`
  Adds `agent-vm zone-git init|status|push`.

- `packages/agent-vm/src/cli/zone-git-commands.ts`
  CLI implementation wrapper around zone Git operations.

- `packages/agent-vm/src/cli/zone-git-commands.test.ts`
  CLI behavior tests.

- `packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts`
  Registers/implements the OpenClaw `zone_git_push` tool by calling controller HTTP.

- `packages/openclaw-agent-vm-plugin/src/zone-git-tool.test.ts`
  Tests tool registration and controller request shape.

### Modified files

- `packages/agent-vm/src/config/system-config.ts`
  Adds OpenClaw `gateway.zoneGit` config schema.

- `packages/agent-vm/src/config/system-config.test.ts`
  Tests schema parse, defaults, and rejection of zoneGit on worker zones.

- `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
  Adds `Lease.guestWorkdir` serialization and `pushZoneGit` operation type.

- `packages/agent-vm/src/controller/http/controller-http-routes.ts`
  Resolves lease metadata needed for zone Git and calls sandbox seeding against the host work directory.

- `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`
  Adds `POST /zones/:zoneId/zone-git/push` and `GET /zones/:zoneId/zone-git/status`.

- `packages/agent-vm/src/controller/http/controller-request-schemas.ts`
  Adds request schemas for zone Git routes.

- `packages/agent-vm/src/controller/controller-runtime.ts`
  Wires runtimeDir, GitHub token resolver, and zone Git operations into controller service.

- `packages/agent-vm/src/controller/leases/lease-manager.ts`
  Carries `guestWorkdir` and zone Git mount metadata through leases.

- `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts`
  Returns normalized guest workdir as well as host path.

- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
  Mounts `/zone` and `/agent-vm/zone-git` for zone Git leases; preserves `/work` for all other leases.

- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`
  Tests both existing `/work` leases and zone Git `/zone` leases.

- `packages/agent-vm/src/backup/backup-create-operation.ts`
  Adds zone Git preflight and excludes runtime Git history from age backups.

- `packages/agent-vm/src/backup/backup-create-operation.test.ts`
  Tests backup behavior for clean, dirty, and unpushed zone Git states.

- `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
  Registers the `zone_git_push` tool when the plugin API supports `registerTool`.

- `packages/openclaw-agent-vm-plugin/src/openclaw-sandbox-sdk-contract.ts`
  Extends local SDK typing for `registerTool` without weakening sandbox backend assertions.

- `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
  Carries `controllerUrl` and `zoneId` to the zone Git tool.

- `packages/agent-vm/src/cli/commands/create-app.ts`
  Adds the `zone-git` CLI group.

- `docs/manual/runtime-paths.md`
  Documents zone Git paths and backup boundary.

- `docs/manual/per-agent-setup.md`
  Updates agent Git instructions: commit locally, push via `zone_git_push`.

---

## Implementation Tasks

### Task 1: Add OpenClaw zoneGit config

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.test.ts`

- [ ] **Step 1: Write schema tests**

Add tests proving `zoneGit` is accepted only on OpenClaw gateways:

```ts
it('parses OpenClaw zone Git config', () => {
	const config = loadTestSystemConfig({
		zones: [
			buildOpenClawZone({
				gateway: {
					type: 'openclaw',
					zoneFilesDir: './zone-files/shravan',
					zoneGit: {
						remote: {
							repoUrl: 'shravan/zone-files',
							branch: 'main',
						},
					},
				},
			}),
		],
	});

	expect(config.zones[0]?.gateway).toMatchObject({
		type: 'openclaw',
		zoneGit: {
			remote: {
				repoUrl: 'shravan/zone-files',
				branch: 'main',
			},
		},
	});
});
```

Add a worker-zone rejection assertion by passing `zoneGit` under a worker gateway and expecting Zod strict-object failure.

- [ ] **Step 2: Add schema**

In `system-config.ts`, add:

```ts
const zoneGitRemoteSchema = z
	.object({
		repoUrl: z.string().min(1),
		branch: z.string().min(1).default('main'),
	})
	.strict();

const zoneGitSchema = z
	.object({
		remote: zoneGitRemoteSchema,
	})
	.strict();
```

Extend only `openClawZoneGatewaySchema`:

```ts
const openClawZoneGatewaySchema = zoneGatewayBaseSchema
	.extend({
		type: z.literal('openclaw'),
		zoneFilesDir: z.string().min(1),
		authProfilesByAgent: z.record(agentIdSchema, authProfilesSecretSchema).optional(),
		zoneGit: zoneGitSchema.optional(),
	})
	.strict();
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts
```

Expected: config tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/config/system-config.ts packages/agent-vm/src/config/system-config.test.ts
git commit -m "feat: add OpenClaw zone Git config" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Implement zone Git paths and host operations

**Files:**
- Create: `packages/agent-vm/src/controller/zone-git/zone-git-paths.ts`
- Create: `packages/agent-vm/src/controller/zone-git/zone-git-operations.ts`
- Create: `packages/agent-vm/src/controller/zone-git/zone-git-operations.test.ts`
- Modify: `packages/agent-vm/src/controller/git-auth-support.ts`

- [ ] **Step 1: Extract reusable GitHub push URL helper**

`git-push-operations.ts` currently keeps repo URL parsing private. Move the reusable pieces into `git-auth-support.ts`:

```ts
export class GitHubRepositoryValidationError extends Error {}

export function parseGithubRepositoryFromUrl(repoUrl: string): string {
	const cleaned = repoUrl.replace(/\.git$/u, '');
	const urlPattern = /(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)$/u;
	const match = urlPattern.exec(cleaned);

	if (match?.[1]) return match[1];
	if (/^[^\s/]+\/[^\s/]+$/u.test(cleaned)) return cleaned;

	throw new GitHubRepositoryValidationError(`Invalid GitHub repository: ${repoUrl}`);
}

export function buildGithubTokenUrl(repoUrl: string, githubToken: string): string {
	return `https://x-access-token:${githubToken}@github.com/${parseGithubRepositoryFromUrl(repoUrl)}.git`;
}
```

Update `git-push-operations.ts` to import these helpers and preserve existing error behavior by catching or rethrowing as needed.

- [ ] **Step 2: Add path helpers**

Create `zone-git-paths.ts`:

```ts
import path from 'node:path';

import type { SystemConfig } from '../../config/system-config.js';

export const OPENCLAW_ZONE_GIT_GUEST_ROOT = '/agent-vm/zone-git';
export const OPENCLAW_ZONE_GIT_GUEST_DIR = `${OPENCLAW_ZONE_GIT_GUEST_ROOT}/zone-files.git`;
export const OPENCLAW_ZONE_FILES_GUEST_ROOT = '/zone';

export interface ZoneGitPaths {
	readonly hostZoneGitRoot: string;
	readonly hostGitDir: string;
	readonly guestZoneGitRoot: typeof OPENCLAW_ZONE_GIT_GUEST_ROOT;
	readonly guestGitDir: typeof OPENCLAW_ZONE_GIT_GUEST_DIR;
}

export function resolveZoneGitPaths(options: {
	readonly runtimeDir: string;
	readonly zoneId: string;
}): ZoneGitPaths {
	const hostZoneGitRoot = path.join(options.runtimeDir, 'zones', options.zoneId, 'zone-git');
	return {
		hostZoneGitRoot,
		hostGitDir: path.join(hostZoneGitRoot, 'zone-files.git'),
		guestZoneGitRoot: OPENCLAW_ZONE_GIT_GUEST_ROOT,
		guestGitDir: OPENCLAW_ZONE_GIT_GUEST_DIR,
	};
}

export function isOpenClawZoneGitConfigured(
	zone: SystemConfig['zones'][number],
): zone is SystemConfig['zones'][number] & {
	readonly gateway: Extract<SystemConfig['zones'][number]['gateway'], { readonly type: 'openclaw' }> & {
		readonly zoneGit: NonNullable<
			Extract<SystemConfig['zones'][number]['gateway'], { readonly type: 'openclaw' }>['zoneGit']
		>;
	};
} {
	return zone.gateway.type === 'openclaw' && zone.gateway.zoneGit !== undefined;
}
```

- [ ] **Step 3: Write operation tests**

Use temporary directories and a local bare remote:

```ts
it('initializes split zone Git metadata under runtimeDir and leaves .git pointing at the guest path', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'agent-vm-zone-git-'));
	const runtimeDir = path.join(root, 'runtime');
	const zoneFilesDir = path.join(root, 'zone-files', 'sunfam');
	const remoteDir = path.join(root, 'remote.git');
	await mkdir(zoneFilesDir, { recursive: true });
	await writeFile(path.join(zoneFilesDir, 'AGENTS.md'), 'commit and use zone_git_push\n');
	await execa('git', ['init', '--bare', remoteDir]);

	await ensureZoneGitRepository({
		branch: 'main',
		githubToken: 'unused-for-file-remote',
		remoteUrl: remoteDir,
		runtimeDir,
		zoneFilesDir,
		zoneId: 'sunfam',
	});

	await expect(readFile(path.join(zoneFilesDir, '.git'), 'utf8')).resolves.toBe(
		'gitdir: /agent-vm/zone-git/zone-files.git\n',
	);
	await expect(stat(path.join(runtimeDir, 'zones', 'sunfam', 'zone-git', 'zone-files.git'))).resolves.toBeTruthy();
});
```

Add tests for:

- existing initialized repo is reused without deleting commits
- `getZoneGitStatus()` reports `dirty`, `ahead`, and `unpushed`
- `pushZoneGit()` pushes committed local HEAD to the configured branch
- token-scrubbed errors never print `githubToken`

- [ ] **Step 4: Implement operations**

Create these public functions:

```ts
export interface ZoneGitOperationConfig {
	readonly branch: string;
	readonly githubToken: string;
	readonly remoteUrl: string;
	readonly runtimeDir: string;
	readonly zoneFilesDir: string;
	readonly zoneId: string;
}

export interface ZoneGitStatus {
	readonly configured: true;
	readonly initialized: boolean;
	readonly branch: string;
	readonly dirty: boolean;
	readonly aheadOfRemote: number;
	readonly behindRemote: number;
	readonly localHead: string | null;
	readonly remoteHead: string | null;
}

export async function ensureZoneGitRepository(options: ZoneGitOperationConfig): Promise<void>;
export async function getZoneGitStatus(options: ZoneGitOperationConfig): Promise<ZoneGitStatus>;
export async function pushZoneGit(options: ZoneGitOperationConfig): Promise<ZoneGitPushResult>;
```

Implementation rules:

- Use `git init --separate-git-dir=<hostGitDir> <zoneFilesDir>` on first init.
- Rewrite `<zoneFilesDir>/.git` to `gitdir: /agent-vm/zone-git/zone-files.git\n` after init.
- Set Git config for VM-side raw commits:

```bash
git --git-dir=<hostGitDir> config core.worktree /zone
git --git-dir=<hostGitDir> config commit.gpgsign false
git --git-dir=<hostGitDir> config core.hooksPath /dev/null
```

- Host/controller commands must always pass explicit `--git-dir=<hostGitDir>` and `--work-tree=<zoneFilesDir>`.
- Fetch/push with `buildGithubTokenUrl()` for GitHub remotes; allow absolute local paths in tests.
- Do not auto-commit. Agents own `git add` and `git commit`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/zone-git/zone-git-operations.test.ts packages/agent-vm/src/controller/git-push-operations.test.ts
```

Expected: new zone Git tests pass and existing worker push tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/zone-git packages/agent-vm/src/controller/git-auth-support.ts packages/agent-vm/src/controller/git-push-operations.ts
git commit -m "feat: add host-side zone Git operations" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Mount zone root and zone gitdir for zone Git Tool VM leases

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts`
- Modify: `packages/agent-vm/src/controller/leases/lease-manager.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`

- [ ] **Step 1: Write route and lifecycle tests**

Add a controller route test:

```ts
it('returns the requested /zone child workdir for zone Git leases', async () => {
	const createLease = vi.fn(async (options) => buildLease({ ...options, guestWorkdir: '/zone/agents/shravan' }));
	const app = createControllerApp({
		leaseManager: buildLeaseManager({ createLease }),
		toolVmProfiles: { standard: { cpus: 1, memory: '1g', imageProfile: 'default' } },
		zoneIds: new Set(['sunfam']),
		zoneDefaultToolVmProfiles: { sunfam: 'standard' },
		resolveLeaseWorkMountDir: async () => ({
			hostWorkMountDir: '/host/zone-files/sunfam/agents/shravan',
			guestWorkdir: '/zone/agents/shravan',
			zoneGit: {
				hostZoneFilesDir: '/host/zone-files/sunfam',
				hostZoneGitRoot: '/host/runtime/zones/sunfam/zone-git',
			},
		}),
	});

	const response = await app.request('/lease', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			agentWorkspaceDir: '/zone/agents/shravan',
			profileId: 'standard',
			scopeKey: 'agent:shravan',
			workMountDir: '/zone/agents/shravan',
			zoneId: 'sunfam',
		}),
	});

	await expect(response.json()).resolves.toMatchObject({ workdir: '/zone/agents/shravan' });
});
```

Add a Tool VM lifecycle test asserting zone Git leases mount:

```ts
expect(capturedCreateVmOptions?.vfsMounts).toMatchObject({
	'/zone': { hostPath: '/host/zone-files/sunfam', kind: 'realfs' },
	'/agent-vm/zone-git': { hostPath: '/host/runtime/zones/sunfam/zone-git', kind: 'realfs' },
});
expect(capturedCreateVmOptions?.vfsMounts['/work']).toBeUndefined();
```

Keep the existing non-zoneGit test expecting only `/work`.

- [ ] **Step 2: Return lease mount resolution metadata**

Change the lease resolver return shape from `Promise<string>` to:

```ts
export interface ResolvedLeaseWorkMount {
	readonly hostWorkMountDir: string;
	readonly guestWorkdir: string;
	readonly zoneGit?: {
		readonly hostZoneFilesDir: string;
		readonly hostZoneGitRoot: string;
	};
}
```

When the zone is OpenClaw with `gateway.zoneGit` and the work mount is under `/zone`, return:

```ts
{
	hostWorkMountDir,
	guestWorkdir: normalizedWorkMountDir,
	zoneGit: {
		hostZoneFilesDir: options.zone.gateway.zoneFilesDir,
		hostZoneGitRoot: resolveZoneGitPaths({ runtimeDir, zoneId }).hostZoneGitRoot,
	},
}
```

Keep current behavior for non-zoneGit leases:

```ts
{
	hostWorkMountDir,
	guestWorkdir: '/work',
}
```

- [ ] **Step 3: Carry guestWorkdir through leases**

Add to `Lease` and `LeaseManager.createLease()` options:

```ts
readonly guestWorkdir: string;
readonly zoneGitMount?: {
	readonly hostZoneFilesDir: string;
	readonly hostZoneGitRoot: string;
};
```

Update `serializeLeaseForResponse()` to return:

```ts
readonly workdir: string;
```

and serialize `lease.guestWorkdir`.

- [ ] **Step 4: Mount zone Git roots in Tool VM lifecycle**

In `createToolVm()`, add options:

```ts
readonly zoneGitMount?: {
	readonly hostZoneFilesDir: string;
	readonly hostZoneGitRoot: string;
};
```

If `zoneGitMount` is present:

- validate `hostWorkMountDir` is inside `hostZoneFilesDir`
- pin `hostZoneFilesDir` and `hostZoneGitRoot`
- mount `/zone` and `/agent-vm/zone-git`
- do not mount `/work`
- close both pinned roots if VM creation fails

If absent, preserve existing `/work` behavior exactly.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts
```

Expected: existing lease behavior remains green; zone Git lease tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/leases packages/agent-vm/src/controller/http packages/agent-vm/src/tool-vm
git commit -m "feat: mount zone Git worktrees for OpenClaw tools" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Wire controller zone Git status and push routes

**Files:**
- Modify: `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-request-schemas.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`

- [ ] **Step 1: Add request/response tests**

Add tests for:

- `GET /zones/:zoneId/zone-git/status`
- `POST /zones/:zoneId/zone-git/push`
- unsupported operation returns 405
- validation errors scrub GitHub token output

Use route-level operation mocks:

```ts
const pushZoneGit = vi.fn(async () => ({
	branch: 'main',
	success: true,
	localHead: 'abc123',
	remoteHead: 'abc123',
	pushed: [{ sha: 'abc123', subject: 'docs: update memory' }],
}));
```

- [ ] **Step 2: Add route schemas**

In `controller-request-schemas.ts`:

```ts
export const controllerZoneGitPushRequestSchema = z
	.object({
		expectedHead: z.string().min(1).optional(),
	})
	.strict()
	.default({});
```

- [ ] **Step 3: Add controller operations**

Extend `ControllerRouteOperations`:

```ts
readonly getZoneGitStatus?: (zoneId: string) => Promise<unknown>;
readonly pushZoneGit?: (
	zoneId: string,
	input: { readonly expectedHead?: string | undefined },
) => Promise<unknown>;
```

Add routes:

```ts
app.get('/zones/:zoneId/zone-git/status', async (context) => { ... });
app.post('/zones/:zoneId/zone-git/push', async (context) => { ... });
```

- [ ] **Step 4: Wire runtime operations**

In `controller-runtime.ts`, resolve:

- selected zone
- `zone.gateway.zoneGit.remote.repoUrl`
- `zone.gateway.zoneGit.remote.branch`
- `systemConfig.runtimeDir`
- `zone.gateway.zoneFilesDir`
- host GitHub token through the existing host secret resolver path

Then call `getZoneGitStatus()` / `pushZoneGit()`.

If `host.githubToken` is missing and zoneGit is configured, throw a configuration error that says:

```text
zoneGit for zone '<zoneId>' requires host.githubToken so the controller can push without exposing credentials to VMs.
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/http/controller-http-routes.test.ts packages/agent-vm/src/controller/controller-runtime.test.ts
```

Expected: controller route and runtime tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/http packages/agent-vm/src/controller/controller-runtime.ts
git commit -m "feat: expose controller zone Git operations" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: Expose zone_git_push as an OpenClaw agent tool

**Files:**
- Create: `packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/zone-git-tool.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/openclaw-sandbox-sdk-contract.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
- Modify: `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.test.ts`

- [ ] **Step 1: Write tool tests**

Test that registration calls `api.registerTool` when present:

```ts
it('registers zone_git_push when OpenClaw exposes registerTool', async () => {
	const registerTool = vi.fn();

	registerZoneGitTool({
		api: { registerTool },
		controllerUrl: 'http://127.0.0.1:18800',
		fetchImpl: async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
		zoneId: 'sunfam',
	});

	expect(registerTool).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'zone_git_push',
			description: expect.stringContaining('Push committed zone workspace changes'),
		}),
	);
});
```

Test execution calls:

```text
POST http://127.0.0.1:18800/zones/sunfam/zone-git/push
```

with JSON body `{}` or `{ "expectedHead": "..." }`.

- [ ] **Step 2: Extend SDK contract**

Add optional typing:

```ts
export interface OpenClawToolRegistrationApi {
	readonly registerTool?: (tool: {
		readonly name: string;
		readonly description: string;
		readonly inputSchema: Record<string, unknown>;
		readonly execute: (input: unknown) => Promise<unknown>;
	}) => void;
}
```

Do not require `registerTool` in `assertSdkShape()` because older/sandbox-only SDK contexts may not expose it.

- [ ] **Step 3: Implement tool**

Create `zone-git-tool.ts`:

```ts
export function registerZoneGitTool(options: {
	readonly api: OpenClawToolRegistrationApi;
	readonly controllerUrl: string;
	readonly fetchImpl?: typeof fetch;
	readonly zoneId: string;
}): void {
	if (!options.api.registerTool) return;

	options.api.registerTool({
		name: 'zone_git_push',
		description:
			'Push committed OpenClaw zone workspace changes through the agent-vm controller. Use after git commit; do not run raw git push.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				expectedHead: { type: 'string' },
			},
		},
		execute: async (input) => {
			const expectedHead =
				typeof input === 'object' &&
				input !== null &&
				typeof Reflect.get(input, 'expectedHead') === 'string'
					? Reflect.get(input, 'expectedHead')
					: undefined;
			const response = await (options.fetchImpl ?? fetch)(
				`${options.controllerUrl.replace(/\/$/u, '')}/zones/${options.zoneId}/zone-git/push`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(expectedHead ? { expectedHead } : {}),
				},
			);
			const payload = await response.json();
			if (!response.ok) {
				throw new Error(`zone_git_push failed: ${JSON.stringify(payload).slice(0, 500)}`);
			}
			return payload;
		},
	});
}
```

- [ ] **Step 4: Register from plugin entry**

In `openclaw-plugin-registration.ts`, after resolving `pluginConfig`, call:

```ts
registerZoneGitTool({
	api,
	controllerUrl: pluginConfig.controllerUrl,
	zoneId: pluginConfig.zoneId,
});
```

Keep sandbox backend registration unchanged.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/zone-git-tool.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.test.ts
```

Expected: plugin tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-agent-vm-plugin/src
git commit -m "feat: add OpenClaw zone git push tool" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 6: Add agent-vm zone-git CLI

**Files:**
- Create: `packages/agent-vm/src/cli/commands/zone-git-definition.ts`
- Create: `packages/agent-vm/src/cli/zone-git-commands.ts`
- Create: `packages/agent-vm/src/cli/zone-git-commands.test.ts`
- Modify: `packages/agent-vm/src/cli/commands/create-app.ts`
- Modify: `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts`

- [ ] **Step 1: Write CLI tests**

Test:

- `agent-vm zone-git status --zone sunfam`
- `agent-vm zone-git init --zone sunfam`
- `agent-vm zone-git push --zone sunfam`
- `--json` output
- worker zones and unconfigured OpenClaw zones get clear errors

- [ ] **Step 2: Add command implementation**

Create subcommands:

```ts
agent-vm zone-git init --zone <zone>
agent-vm zone-git status --zone <zone> [--json]
agent-vm zone-git push --zone <zone> [--json]
```

Use `loadSystemConfigFromOption()` and `requireZone()`. For human output:

```text
zone git sunfam
  branch       main
  initialized  yes
  dirty        no
  ahead        1
  behind       0
```

- [ ] **Step 3: Register CLI group**

In `create-app.ts`:

```ts
import { createZoneGitSubcommands } from './zone-git-definition.js';
```

and:

```ts
'zone-git': createZoneGitSubcommands(io, dependencies),
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/zone-git-commands.test.ts packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts
```

Expected: CLI tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/cli
git commit -m "feat: add zone git CLI commands" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 7: Add backup and doctor guardrails

**Files:**
- Modify: `packages/agent-vm/src/backup/backup-create-operation.ts`
- Modify: `packages/agent-vm/src/backup/backup-create-operation.test.ts`
- Modify: `packages/agent-vm/src/operations/doctor.ts`
- Modify: `packages/agent-vm/src/operations/doctor.test.ts`

- [ ] **Step 1: Write guardrail tests**

Backup tests:

- clean zone Git allows backup
- dirty worktree fails with a message instructing `git status`, `git add`, `git commit`
- local commits ahead of remote fail with a message instructing `zone_git_push` or `agent-vm zone-git push`
- runtimeDir Git metadata is not copied into the backup archive

Doctor tests:

- zoneGit configured without `host.githubToken` is an error
- zoneGit configured and repo not initialized is a warning with `agent-vm zone-git init --zone <zone>`
- zoneGit dirty/ahead status is reported

- [ ] **Step 2: Implement backup preflight**

Before staging zone files, if `zone.gateway.zoneGit` exists:

```ts
const status = await getZoneGitStatus(...);
if (status.dirty) {
	throw new Error(
		`Zone '${zone.id}' has uncommitted zone Git changes. Commit them before backup.`,
	);
}
if (status.aheadOfRemote > 0) {
	throw new Error(
		`Zone '${zone.id}' has ${status.aheadOfRemote} unpushed zone Git commit(s). Run agent-vm zone-git push --zone ${zone.id} before backup.`,
	);
}
```

Do not copy `runtimeDir` into backups.

- [ ] **Step 3: Implement doctor checks**

Add checks to `doctor.ts`:

```text
zone-git-github-token-<zoneId>
zone-git-initialized-<zoneId>
zone-git-clean-<zoneId>
zone-git-pushed-<zoneId>
```

Keep failures actionable and include paths:

```text
runtimeDir/zones/<zoneId>/zone-git/zone-files.git
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/backup/backup-create-operation.test.ts packages/agent-vm/src/operations/doctor.test.ts
```

Expected: backup and doctor tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/backup packages/agent-vm/src/operations
git commit -m "feat: guard zone git backups and doctor checks" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 8: Update OpenClaw agent instructions and docs

**Files:**
- Modify: `docs/manual/runtime-paths.md`
- Modify: `docs/manual/per-agent-setup.md`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`

- [ ] **Step 1: Update manual docs**

Document:

```text
Host:
  zone files     <zoneFilesDir>
  git metadata   <runtimeDir>/zones/<zoneId>/zone-git/zone-files.git

Gateway VM:
  zone files     /zone

Tool VM with zoneGit:
  zone files     /zone
  git metadata   /agent-vm/zone-git/zone-files.git
  workdir        /zone/<agent workspace path>

Backup:
  includes       current zone files
  excludes       runtimeDir Git metadata
  requires       clean and pushed zone Git before backup
```

- [ ] **Step 2: Update scaffolded AGENTS text**

Where OpenClaw per-agent files are scaffolded, change Git instructions to:

```text
## Git

- You may inspect, stage, and commit your own changes with git status, git add, and git commit.
- Do not run raw git push. The VM does not have GitHub credentials.
- After committing, use the zone_git_push tool to ask agent-vm's controller to push the zone branch.
- If zone_git_push reports divergence or rejection, stop and report the exact message.
```

- [ ] **Step 3: Add init tests**

Assert new scaffolded OpenClaw `AGENTS.md` includes:

```text
Do not run raw git push.
zone_git_push
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts
```

Expected: init scaffold tests pass.

- [ ] **Step 5: Commit**

```bash
git add docs/manual/runtime-paths.md docs/manual/per-agent-setup.md packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts
git commit -m "docs: document OpenClaw zone Git workflow" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 9: End-to-end validation

**Files:**
- No new files unless failures reveal missing permanent tests.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/controller/zone-git/zone-git-operations.test.ts \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/backup/backup-create-operation.test.ts \
  packages/agent-vm/src/operations/doctor.test.ts \
  packages/openclaw-agent-vm-plugin/src/zone-git-tool.test.ts \
  packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run full checks**

Run:

```bash
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test
pnpm fmt:check
git diff --check
```

Expected: every command exits 0. If `fmt:check` fails on pre-existing files, verify the changed files are formatted and record the exact pre-existing paths.

- [ ] **Step 3: Manual smoke with a local bare remote**

Create a temporary deployment config or test fixture with:

```jsonc
"zoneGit": {
  "remote": {
    "repoUrl": "/tmp/zone-files-remote.git",
    "branch": "main"
  }
}
```

Then run:

```bash
agent-vm zone-git init --zone sunfam
agent-vm zone-git status --zone sunfam
```

Boot OpenClaw, run in an agent Tool VM:

```bash
pwd
git status --short
echo "smoke $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> AGENTS.md
git add AGENTS.md
git commit -m "docs: smoke zone git"
```

Invoke the OpenClaw `zone_git_push` tool.

Verify on host:

```bash
git --git-dir /tmp/zone-files-remote.git log --oneline --max-count=1
```

Expected: the smoke commit exists in the bare remote.

- [ ] **Step 4: Final commit if validation fixes were needed**

```bash
git status --short
git add <changed files>
git commit -m "test: verify OpenClaw zone Git workflow" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Skip this commit if no validation fixes were needed.

---

## Non-Goals

- Do not put GitHub tokens, SSH keys, or 1Password material into gateway or Tool VM environments.
- Do not copy `runtimeDir` Git metadata into normal age backups.
- Do not make OpenClaw auto-commit changes. Agents commit intentionally.
- Do not support non-GitHub authenticated remotes in v1. Local filesystem remotes are test-only; production auth uses `host.githubToken`.
- Do not preserve `/work` semantics for zoneGit-enabled OpenClaw leases. ZoneGit leases intentionally return `/zone/...` workdirs so Git can discover the zone-root repo.

---

## Risks And Mitigations

- **Risk:** Mounting the zone root in Tool VMs broadens visibility from one agent workspace to the whole zone.
  **Mitigation:** This is required for one zone-root repo and stays inside the same zone boundary. Document it clearly. If per-agent isolation becomes the priority, use per-agent repos instead of a single zone repo.

- **Risk:** Multiple agents can commit concurrently against one zone Git index.
  **Mitigation:** Git's `index.lock` prevents simultaneous index writes. `zone_git_push` should report lock or divergence failures clearly. Later work can add a controller-mediated `zone_git_commit` if raw concurrent commits prove too brittle.

- **Risk:** Host `git status` inside `zoneFilesDir` may not work because `.git` points at the VM guest path.
  **Mitigation:** agent-vm host operations always use explicit `--git-dir` and `--work-tree`. Human host workflow should use `agent-vm zone-git status|push`.

- **Risk:** OpenClaw plugin tool API shape drifts.
  **Mitigation:** `registerTool` is optional in local typing. If missing, sandbox backend still registers and doctor should warn that `zone_git_push` is unavailable.

---

## Definition Of Done

- Agents in zoneGit-enabled OpenClaw Tool VMs can run `git status`, `git add`, and `git commit` from their `/zone/...` workspace.
- Agents can invoke `zone_git_push` and the controller pushes committed changes without exposing GitHub credentials to any VM.
- `agent-vm zone-git status|init|push` works from the host.
- `backup create` does not include runtime Git metadata and refuses dirty or unpushed zone Git states.
- Doctor catches missing GitHub token, missing zone Git init, dirty worktree, and unpushed commits.
- Full lint, typecheck, test, format check, and `git diff --check` pass.

