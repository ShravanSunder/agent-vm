# Agent VM Manual Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agent-vm manual update` so deployments can refresh generated human and agent manuals without burying the entire manual in `AGENTS.md`.

**Architecture:** Agent-vm owns versioned manual templates and a CLI updater that writes generated deployment docs under `docs/manual/`. `AGENTS.md` remains a small agent-facing index that links to the manual; `CLAUDE.md` is a symlink to `AGENTS.md`. OpenClaw channel specifics stay deployment-owned: the default scaffold enables core memory and Gondolin support, but does not configure Discord.

**Tech Stack:** TypeScript, cmd-ts, pnpm, Vitest, OXC, Node 24 filesystem APIs.

---

## Scope

This plan covers only agent-vm framework work:

- Add an `agent-vm manual update` command.
- Add generated manual templates for deployment docs.
- Add a small generated `AGENTS.md` entrypoint and `CLAUDE.md` symlink.
- Update `agent-vm init` to use the same manual renderer.
- Strip Discord from the default OpenClaw scaffold while keeping memory-core enabled.

This plan does not reconfigure `shravan-claw`. That should be a separate deployment worktree after this framework command exists.

This plan does not implement fd-rooted RealFS hardening. That lives in `docs/superpowers/plans/2026-04-30-fd-rooted-realfs-provider.md`.

This plan depends on the operator-facing model from the zone-fix worktree plan:
`docs/superpowers/plans/2026-04-30-multizone-controller-runtime.md`.
Use that plan as the source for final names and examples for
`agentToolProfiles`, `agentSandboxSeeds`, `gateway.authProfilesByAgent`,
`leaseIdleTtl`, and process-wide `tcpPool.size: 12`. Do not freeze generated
manual examples for those fields until zone-fix lands or the implementation
branch confirms the same schema names. Stable manual work may proceed now:
`/work`, Discord-as-deployment, teaching-vs-automation, memory-core defaults,
and the `agent-vm manual update` command.

---

## Review Corrections Before Execution

The implementation must address these reviewed gaps before any code is written:

1. `packages/agent-vm/src/cli/init-command.test.ts` already has an existing assertion that the generated OpenClaw Dockerfile enables Discord. Do not merely add a new negative test with a focused `-t` filter. Update the existing positive assertion in the broad scaffold test so the full file cannot pass with contradictory expectations.
2. `packages/agent-vm/src/cli/init-command.ts` has `envVarsForGatewayType()` returning `DISCORD_BOT_TOKEN` for OpenClaw. Remove that default and add a `.env.local` assertion. Otherwise the scaffold remains Discord-flavored even after Dockerfile and system config cleanup.
3. Memory-core default-on needs startup-oriented verification. Unit tests can prove generated config shape, but the branch is not deploy-ready until a smoke command proves OpenClaw can at least validate/doctor the generated gateway config, or the limitation is explicitly recorded as an environment-gated smoke.
4. Generated manuals must teach `/work` as the Tool VM mount path. Do not leave a `/workspace` mental model anywhere in generated docs, prompt defaults, `AGENTS.md`, or `CLAUDE.md`.
5. Add a migration note for existing Discord-baked deployments. Agent-vm defaults become channel-neutral; deployments such as `shravan-claw` keep Discord by owning their Dockerfile, `openclaw.json`, secrets, allowed hosts, and websocket bypass.
6. Add a real per-agent walkthrough: multi-agent OpenClaw gateway, `scope=agent`, per-agent sandbox/auth replication, and when per-agent tool VM images require multiple zones or future per-agent tool profiles.
7. Add an explicit teaching-vs-automation boundary in `AGENTS.md`: the generated agent index may help explain privileged host/deployment config, but must not silently edit secrets, allowed hosts, Dockerfiles, or OpenClaw channel config unless the human asks for those edits.
8. Expand the Discord recipe with concrete keys and endpoints: `DISCORD_BOT_TOKEN`, `discord.com`, `cdn.discordapp.com`, `gateway.discord.gg:443`, websocket bypass, and runtime auth hints.

---

## File Structure

`packages/agent-vm/src/cli/manual-templates.ts`

Owns generated manual content. It exports pure template builders so tests can assert exact output without running the CLI.

`packages/agent-vm/src/cli/manual-commands.ts`

Owns `updateAgentVmManual()`: writes generated manual files, writes `AGENTS.md`, and creates/replaces the `CLAUDE.md` symlink.

`packages/agent-vm/src/cli/commands/manual-definition.ts`

Owns the `agent-vm manual update` cmd-ts command.

`packages/agent-vm/src/cli/commands/create-app.ts`

Adds the top-level `manual` subcommand.

`packages/agent-vm/src/cli/agent-vm-cli-support.ts`

Adds injectable `updateAgentVmManual` dependency for CLI unit tests.

`packages/agent-vm/src/cli/init-command.ts`

Uses the manual renderer during scaffold, changes default OpenClaw plugin/channel shape, and keeps manual outputs in the scaffold result.

`packages/agent-vm/src/cli/manual-commands.test.ts`

Unit tests for the writer: generated docs, symlink behavior, and user-owned file preservation.

`packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts`

CLI routing tests for `agent-vm manual update`.

`packages/agent-vm/src/cli/init-command.test.ts`

Scaffold tests for generated manuals, Discord-free defaults, and memory-core defaults.

`packages/agent-vm/src/integration-tests/manual-cli.smoke.test.ts`

Black-box smoke test for the built CLI: run `agent-vm manual update`, inspect files, rerun update, and confirm stable outputs.

`docs/reference/configuration/system-json.md`

Documents the framework/deployment split for OpenClaw plugin defaults.

`docs/getting-started/openclaw-guide.md`

Updates channel/plugin guidance so Discord is a deployment recipe, not a framework default.

---

## Generated Manual Contract

The command writes these generated files:

```text
AGENTS.md
CLAUDE.md -> AGENTS.md
docs/manual/README.md
docs/manual/layout.md
docs/manual/scope.md
docs/manual/openclaw.md
docs/manual/agent-worker.md
docs/manual/secrets.md
docs/manual/tool-access.md
docs/manual/channels.md
docs/manual/runtime-paths.md
docs/manual/per-agent-setup.md
docs/manual/migration-discord.md
docs/manual/troubleshooting.md
```

The command must not overwrite these user-owned files if they exist:

```text
docs/manual/local-notes.md
docs/manual/shravan-claw.md
docs/manual/openclaw-discord.local.md
```

The command may always rewrite the generated files above. The generated files must include a marker:

```text
Generated by agent-vm manual. Do not edit by hand.
```

---

### Task 1: Manual Template Builders

**Files:**
- Create: `packages/agent-vm/src/cli/manual-templates.ts`
- Test: `packages/agent-vm/src/cli/manual-templates.test.ts`

Implementation note: the generated manual should mention the zone-fix concepts
as the intended operator model, but schema examples for `agentToolProfiles`,
`agentSandboxSeeds`, `authProfilesByAgent`, and `leaseIdleTtl` must be copied
from the landed zone-fix implementation, not guessed from this plan.

- [ ] **Step 1: Write the failing template tests**

Create `packages/agent-vm/src/cli/manual-templates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
	GENERATED_MANUAL_MARKER,
	buildAgentVmAgentsTemplate,
	buildManualTemplateFiles,
} from './manual-templates.js';

describe('manual templates', () => {
	it('builds an agent-facing AGENTS.md index that points at the manual', () => {
		const content = buildAgentVmAgentsTemplate({
			defaultZoneId: 'shravan',
			systemConfigPath: 'config/system.json',
		});

		expect(content).toContain(GENERATED_MANUAL_MARKER);
		expect(content).toContain('docs/manual/README.md');
		expect(content).toContain('config/system.json');
		expect(content).toContain('shravan');
		expect(content).not.toContain('Discord is enabled by default');
	});

	it('builds progressive manual files for humans and agents', () => {
		const files = buildManualTemplateFiles({
			defaultZoneId: 'shravan',
			systemConfigPath: 'config/system.json',
		});

		expect(files.map((file) => file.relativePath)).toEqual([
			'docs/manual/README.md',
			'docs/manual/layout.md',
			'docs/manual/scope.md',
			'docs/manual/openclaw.md',
			'docs/manual/agent-worker.md',
			'docs/manual/secrets.md',
			'docs/manual/tool-access.md',
			'docs/manual/channels.md',
			'docs/manual/runtime-paths.md',
			'docs/manual/per-agent-setup.md',
			'docs/manual/migration-discord.md',
			'docs/manual/troubleshooting.md',
		]);
		expect(files.every((file) => file.content.includes(GENERATED_MANUAL_MARKER))).toBe(true);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'Discord is configured by the deployment',
		);
	});
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: FAIL because `manual-templates.ts` does not exist.

- [ ] **Step 3: Add the template builder**

Create `packages/agent-vm/src/cli/manual-templates.ts`:

```ts
export const GENERATED_MANUAL_MARKER = 'Generated by agent-vm manual. Do not edit by hand.';

export interface ManualTemplateOptions {
	readonly defaultZoneId: string;
	readonly systemConfigPath: string;
}

export interface ManualTemplateFile {
	readonly content: string;
	readonly relativePath: string;
}

function generatedPage(title: string, body: string): string {
	return `# ${GENERATED_MANUAL_MARKER}

# ${title}

${body.trim()}
`;
}

export function buildAgentVmAgentsTemplate(options: ManualTemplateOptions): string {
	return generatedPage(
		'Agent Instructions',
		`
This deployment uses agent-vm. Start with docs/manual/README.md, then drill into the specific manual page for the task.

Primary config:
- System config: ${options.systemConfigPath}
- Default zone: ${options.defaultZoneId}

Use docs/manual/layout.md before moving files or changing generated folders.
Use docs/manual/scope.md before changing OpenClaw sandbox scope or tool VM lease behavior.
Use docs/manual/tool-access.md before answering whether a tool binary, auth profile, or tool VM image should be agent-specific.
Use docs/manual/channels.md before helping a human configure Discord, Slack, Telegram, or another OpenClaw channel.
Use docs/manual/runtime-paths.md before answering where files appear inside Tool VMs.
Use docs/manual/per-agent-setup.md before changing multi-agent layouts, scope=agent behavior, or per-agent tool/auth isolation.

Do not assume Discord is enabled by the framework. Channels and channel secrets are deployment-owned.
Do not silently edit privileged host/deployment config. Explain the proposed Dockerfile, secret, allowedHosts, websocketBypass, or OpenClaw config change and wait for the human to ask you to apply it.
`,
		);
}

export function buildManualTemplateFiles(options: ManualTemplateOptions): readonly ManualTemplateFile[] {
	return [
		{
			relativePath: 'docs/manual/README.md',
			content: generatedPage(
				'agent-vm Deployment Manual',
				`
This manual is generated from the installed agent-vm package. It is the deployment-local guide for humans and coding agents.

Read in this order:
1. layout.md explains generated folders and ownership.
2. scope.md explains session, agent, and shared scope.
3. openclaw.md explains OpenClaw gateway configuration.
4. tool-access.md explains binary, auth, OpenClaw tool, and zone/image isolation.
5. channels.md explains how deployments add Discord or other channels.
6. runtime-paths.md explains /work and other in-VM paths.
7. per-agent-setup.md explains multi-agent scope and tool access choices.
8. migration-discord.md explains how existing Discord deployments keep working.
9. secrets.md explains runtime auth and HTTP mediation.

Local deployment notes belong in docs/manual/local-notes.md or another non-generated file.
`,
			),
		},
		{
			relativePath: 'docs/manual/layout.md',
			content: generatedPage(
				'Generated Layout',
				`
config/system.json is the controller config.
config/gateways/<zone>/openclaw.json is OpenClaw-owned gateway config.
vm-images/ contains deployment-owned Dockerfiles and Gondolin build configs.
stateDir stores durable gateway state.
zoneFilesDir stores durable user/workspace files for OpenClaw zones.
cacheDir stores rebuildable artifacts.
runtimeDir stores controller runtime artifacts that are not backup state.

OpenClaw Tool VMs mount the validated lease workspace at /work.
Do not describe Tool VM workspaces as /workspace. /workspace is stale for the agent-vm Tool VM path.
`,
			),
		},
		{
			relativePath: 'docs/manual/scope.md',
			content: generatedPage(
				'Scope And Tool VM Reuse',
				`
OpenClaw sandbox scope decides which workspace a tool VM sees.

session scope isolates per conversation.
agent scope reuses a stable workspace for one agent identity.
shared scope intentionally shares one workspace across participants.

Tool VM lease identity follows scopeKey. TCP slots are capacity; they are not identity.

Example:
- shravan agent uses scope=agent and scopeKey=agent-shravan.
- alevtina agent uses scope=agent and scopeKey=agent-alevtina.
- Each agent gets its own scoped sandbox mounted at /work in its Tool VM.
- If both agents share one OpenClaw zone, they still share the zone's toolProfile image.
- Use per-agent auth in the scoped sandbox for cheap isolation.
- Use separate zones or a future per-agent toolProfile field when binary-level tool isolation matters.
`,
			),
		},
		{
			relativePath: 'docs/manual/openclaw.md',
			content: generatedPage(
				'OpenClaw Gateway',
				`
Agent-vm provides VM lifecycle, storage mounts, TCP/HTTP mediation, image build, and tool VM leases.
OpenClaw owns plugin lifecycle, agents.list, channels, and gateway behavior.

The default scaffold enables Gondolin and memory-core support. It does not enable Discord.
`,
			),
		},
		{
			relativePath: 'docs/manual/agent-worker.md',
			content: generatedPage(
				'Agent Worker Gateway',
				`
Worker gateways run task VMs with explicit phases: plan, work, review, and wrapup.
Repo resources live under .agent-vm inside target repos and are refreshed with agent-vm resources update.
`,
			),
		},
		{
			relativePath: 'docs/manual/secrets.md',
			content: generatedPage(
				'Secrets And Runtime Auth',
				`
Secrets are declared in config/system.json.
Use http-mediation for service tokens that should be swapped into outbound requests by the controller.
Use env only when the gateway process itself must read the raw value.
Do not bake secrets into Dockerfiles or images.
`,
			),
		},
		{
			relativePath: 'docs/manual/tool-access.md',
			content: generatedPage(
				'Tool Access And Isolation',
				`
Today every agent in one OpenClaw zone uses the zone's configured toolProfile. That means every agent lease in the zone gets the same tool VM image.

There are three isolation layers:

1. Auth-based isolation.
   The binary may exist for every agent, but only an agent's scoped sandbox contains credentials. This works today and is cheap, but the binary is still callable.

2. OpenClaw tool allowlists.
   Per-agent tool policy can stop an agent from invoking certain named tools. This is useful, but it is not binary-level isolation if a broad shell tool can still run arbitrary commands.

3. Per-zone or per-agent tool VM images.
   This is binary-level isolation. Put agents that need different installed tools into zones or future per-agent tool profiles that point at different tool VM image profiles.

Use one OpenClaw zone when agents should share gateway resources and the same tool image is acceptable.
Use multiple zones when tool binary isolation, gateway lifecycle isolation, or per-agent image profiles matter more than memory cost.

The multizone controller runtime design lives in docs/superpowers/plans/2026-04-30-multizone-controller-runtime.md in the zone-fix worktree. This manual page explains the operator model after that work lands; it does not implement multizone dispatch by itself.
`,
			),
		},
		{
			relativePath: 'docs/manual/channels.md',
			content: generatedPage(
				'OpenClaw Channels',
				`
Discord is configured by the deployment, not by agent-vm defaults.

To add a channel:
1. Install or bake the plugin in the deployment Dockerfile if needed.
2. Add the plugin to plugins.allow in openclaw.json.
3. Add plugin or channels config in openclaw.json.
4. Add required secrets in config/system.json.
5. Add allowedHosts and websocketBypass entries for the channel endpoints.
6. Rebuild the gateway image and run agent-vm doctor.

Discord recipe:
- Add DISCORD_BOT_TOKEN as a zone secret.
- Add discord.com and cdn.discordapp.com to allowedHosts.
- Add gateway.discord.gg:443 to websocketBypass.
- Enable channels.discord or the Discord plugin entry in deployment-owned openclaw.json.
- Bake any required Discord plugin/runtime dependencies in the deployment Dockerfile.
- Add runtimeAuthHints only if the agent should know that a Discord service token exists.
`,
			),
		},
		{
			relativePath: 'docs/manual/runtime-paths.md',
			content: generatedPage(
				'Runtime Paths',
				`
OpenClaw Tool VMs run commands in /work.
/work is the validated, scope-selected workspaceDir from the OpenClaw lease request.
/agent-vm contains generated agent-vm runtime instructions.
/state is controller/gateway plumbing, not the primary place for agent docs.

Do not use /workspace in new docs, prompts, or examples for Tool VMs.
`,
			),
		},
		{
			relativePath: 'docs/manual/per-agent-setup.md',
			content: generatedPage(
				'Per-Agent Setup',
				`
A single OpenClaw gateway can host multiple agents. Use scope=agent when each agent should have a stable workspace and reusable Tool VM lease identity.

Per-agent auth isolation works today by placing credentials in the agent's scoped sandbox. The same tool binary can exist for every agent, but only the intended agent's /work contains usable credentials.

OpenClaw tool allowlists are a policy layer. They do not remove binaries from the Tool VM image if a broad shell tool can still run them.

Binary-level isolation requires different Tool VM images. Today that means separate zones with different toolProfiles, or future per-agent toolProfile support.
`,
			),
		},
		{
			relativePath: 'docs/manual/migration-discord.md',
			content: generatedPage(
				'Discord Migration',
				`
Agent-vm defaults are channel-neutral. Existing Discord deployments keep Discord by owning the deployment layer:

1. Keep Discord plugin/runtime installation in the deployment Dockerfile.
2. Keep Discord enabled in config/gateways/<zone>/openclaw.json.
3. Keep DISCORD_BOT_TOKEN in config/system.json zone secrets.
4. Keep discord.com and cdn.discordapp.com in allowedHosts.
5. Keep gateway.discord.gg:443 in websocketBypass.

Do not reintroduce Discord into agent-vm init defaults. Use this page as the deployment recipe.
`,
			),
		},
		{
			relativePath: 'docs/manual/troubleshooting.md',
			content: generatedPage(
				'Troubleshooting',
				`
Run agent-vm validate after config edits.
Run agent-vm doctor before starting or after changing images, secrets, or channel plugins.
Run agent-vm manual update after upgrading agent-vm to refresh this manual.
`,
			),
		},
	];
}
```

- [ ] **Step 4: Run the template tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts
git commit -m "feat: add deployment manual templates" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Manual Writer

**Files:**
- Create: `packages/agent-vm/src/cli/manual-commands.ts`
- Test: `packages/agent-vm/src/cli/manual-commands.test.ts`

- [ ] **Step 1: Write the failing writer tests**

Create `packages/agent-vm/src/cli/manual-commands.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { updateAgentVmManual } from './manual-commands.js';

async function createTestDirectory(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-manual-'));
}

async function readText(targetDir: string, relativePath: string): Promise<string> {
	return await fs.readFile(path.join(targetDir, relativePath), 'utf8');
}

describe('updateAgentVmManual', () => {
	it('writes generated manual files plus AGENTS.md and CLAUDE.md symlink', async () => {
		const targetDir = await createTestDirectory();

		const result = await updateAgentVmManual({
			defaultZoneId: 'shravan',
			systemConfigPath: 'config/system.json',
			targetDir,
			updateAgentIndex: true,
		});

		expect(result.updated).toContain('docs/manual/README.md');
		expect(result.updated).toContain('AGENTS.md');
		expect(await readText(targetDir, 'docs/manual/README.md')).toContain(
			'Generated by agent-vm manual',
		);
		expect(await readText(targetDir, 'AGENTS.md')).toContain('docs/manual/README.md');
		expect(await fs.readlink(path.join(targetDir, 'CLAUDE.md'))).toBe('AGENTS.md');
	});

	it('preserves user-owned local manual notes when updating generated files', async () => {
		const targetDir = await createTestDirectory();
		await fs.mkdir(path.join(targetDir, 'docs', 'manual'), { recursive: true });
		await fs.writeFile(
			path.join(targetDir, 'docs', 'manual', 'local-notes.md'),
			'deployment-owned notes\n',
			'utf8',
		);

		await updateAgentVmManual({
			defaultZoneId: 'shravan',
			systemConfigPath: 'config/system.json',
			targetDir,
			updateAgentIndex: true,
		});

		expect(await readText(targetDir, 'docs/manual/local-notes.md')).toBe(
			'deployment-owned notes\n',
		);
	});

	it('does not update AGENTS.md unless updateAgentIndex is true', async () => {
		const targetDir = await createTestDirectory();
		await fs.writeFile(path.join(targetDir, 'AGENTS.md'), 'custom agent index\n', 'utf8');

		const result = await updateAgentVmManual({
			defaultZoneId: 'shravan',
			systemConfigPath: 'config/system.json',
			targetDir,
			updateAgentIndex: false,
		});

		expect(result.updated).not.toContain('AGENTS.md');
		expect(await readText(targetDir, 'AGENTS.md')).toBe('custom agent index\n');
	});
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-commands.test.ts
```

Expected: FAIL because `manual-commands.ts` does not exist.

- [ ] **Step 3: Add the writer**

Create `packages/agent-vm/src/cli/manual-commands.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	buildAgentVmAgentsTemplate,
	buildManualTemplateFiles,
	type ManualTemplateOptions,
} from './manual-templates.js';

export interface UpdateAgentVmManualOptions extends ManualTemplateOptions {
	readonly targetDir: string;
	readonly updateAgentIndex: boolean;
}

export interface UpdateAgentVmManualResult {
	readonly updated: readonly string[];
}

async function writeGeneratedFile(targetDir: string, relativePath: string, content: string): Promise<void> {
	const absolutePath = path.join(targetDir, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content, 'utf8');
}

async function replaceRelativeSymlink(linkPath: string, target: string): Promise<void> {
	await fs.rm(linkPath, { force: true });
	await fs.symlink(target, linkPath);
}

export async function updateAgentVmManual(
	options: UpdateAgentVmManualOptions,
): Promise<UpdateAgentVmManualResult> {
	const updated: string[] = [];
	for (const file of buildManualTemplateFiles(options)) {
		await writeGeneratedFile(options.targetDir, file.relativePath, file.content);
		updated.push(file.relativePath);
	}

	if (options.updateAgentIndex) {
		await writeGeneratedFile(options.targetDir, 'AGENTS.md', buildAgentVmAgentsTemplate(options));
		await replaceRelativeSymlink(path.join(options.targetDir, 'CLAUDE.md'), 'AGENTS.md');
		updated.push('AGENTS.md', 'CLAUDE.md');
	}

	return { updated };
}
```

- [ ] **Step 4: Run the writer tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-commands.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/cli/manual-commands.ts packages/agent-vm/src/cli/manual-commands.test.ts
git commit -m "feat: add manual update writer" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: CLI Command

**Files:**
- Create: `packages/agent-vm/src/cli/commands/manual-definition.ts`
- Modify: `packages/agent-vm/src/cli/commands/create-app.ts`
- Modify: `packages/agent-vm/src/cli/agent-vm-cli-support.ts`
- Test: `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts`

- [ ] **Step 1: Write the failing CLI routing test**

Add this test to `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts` inside `describe('runAgentVmCli', ...)`:

```ts
it('routes manual update to the deployment manual updater', async () => {
	const outputs: string[] = [];
	const updateAgentVmManual = vi.fn(async () => ({
		updated: ['docs/manual/README.md', 'AGENTS.md', 'CLAUDE.md'],
	}));

	await runAgentVmCli(
		['manual', 'update', '--agents'],
		{
			stderr: { write: () => true },
			stdout: {
				write: (chunk: string | Uint8Array) => {
					outputs.push(String(chunk));
					return true;
				},
			},
		},
		{
			...defaultCliDependencies,
			getCurrentWorkingDirectory: () => '/tmp/agent-vm-manual',
			updateAgentVmManual,
		},
	);

	expect(updateAgentVmManual).toHaveBeenCalledWith({
		defaultZoneId: 'default',
		systemConfigPath: 'config/system.json',
		targetDir: '/tmp/agent-vm-manual',
		updateAgentIndex: true,
	});
	expect(outputs.join('')).toContain('Updated generated agent-vm manual files');
	expect(outputs.join('')).toContain('docs/manual/README.md');
});
```

- [ ] **Step 2: Run the failing CLI test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts -t "routes manual update"
```

Expected: FAIL because the `manual` command is not registered.

- [ ] **Step 3: Add CLI dependency wiring**

Modify `packages/agent-vm/src/cli/agent-vm-cli-support.ts`:

```ts
import {
	updateAgentVmManual,
	type UpdateAgentVmManualResult,
} from './manual-commands.js';
```

Add to `CliDependencies`:

```ts
readonly updateAgentVmManual?: (options: {
	readonly defaultZoneId: string;
	readonly systemConfigPath: string;
	readonly targetDir: string;
	readonly updateAgentIndex: boolean;
}) => Promise<UpdateAgentVmManualResult>;
```

Add to `defaultCliDependencies`:

```ts
updateAgentVmManual,
```

- [ ] **Step 4: Add the command definition**

Create `packages/agent-vm/src/cli/commands/manual-definition.ts`:

```ts
// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, flag, option, optional, string, subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { updateAgentVmManual } from '../manual-commands.js';

function writeUpdateSummary(io: CliIo, updated: readonly string[]): void {
	io.stdout.write('Updated generated agent-vm manual files\n');
	for (const relativePath of updated) {
		io.stdout.write(`  updated ${relativePath}\n`);
	}
}

export function createManualSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'manual',
		description: 'Update generated deployment manual files',
		cmds: {
			update: command({
				name: 'update',
				description: 'Refresh generated docs/manual files in the current deployment',
				args: {
					agents: flag({
						long: 'agents',
						description: 'Also refresh AGENTS.md and CLAUDE.md',
					}),
					defaultZoneId: option({
						long: 'default-zone',
						defaultValue: () => 'default',
						description: 'Default zone name to mention in generated manual text',
						type: string,
					}),
					systemConfigPath: option({
						long: 'config',
						defaultValue: () => 'config/system.json',
						description: 'System config path to mention in generated manual text',
						type: string,
					}),
					targetDir: option({
						long: 'target-dir',
						description: 'Deployment directory to update',
						type: optional(string),
					}),
				},
				handler: async ({ agents, defaultZoneId, systemConfigPath, targetDir }) => {
					const resolvedTargetDir =
						targetDir ?? dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
					const result = await (dependencies.updateAgentVmManual ?? updateAgentVmManual)({
						defaultZoneId,
						systemConfigPath,
						targetDir: resolvedTargetDir,
						updateAgentIndex: agents,
					});
					writeUpdateSummary(io, result.updated);
				},
			}),
		},
	});
}
```

- [ ] **Step 5: Register the command**

Modify `packages/agent-vm/src/cli/commands/create-app.ts`:

```ts
import { createManualSubcommands } from './manual-definition.js';
```

Add to `cmds`:

```ts
manual: createManualSubcommands(io, dependencies),
```

- [ ] **Step 6: Run the CLI routing test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts -t "routes manual update"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/cli/agent-vm-cli-support.ts packages/agent-vm/src/cli/commands/create-app.ts packages/agent-vm/src/cli/commands/manual-definition.ts packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts
git commit -m "feat: add manual update cli" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Init Scaffold Defaults And Manual Output

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`

- [ ] **Step 1: Write failing scaffold tests**

Update `packages/agent-vm/src/cli/init-command.test.ts`:

First update the existing OpenClaw scaffold test that currently asserts the generated Dockerfile contains:

```ts
expect(gatewayDockerfile).toContain('"channels": { "discord": { "enabled": true } }');
```

Replace that assertion in-place with the Discord-free expectations below. Do not leave both assertions in the file. Run the full `init-command.test.ts` file, not only a focused filter, before committing this task.

```ts
it('scaffolds generated deployment manual files and CLAUDE.md symlink', async () => {
	const targetDir = await createTestDirectory();

	const result = await scaffoldAgentVmProject(
		{
			targetDir,
			zoneId: 'test-openclaw',
			gatewayType: 'openclaw',
			architecture: 'aarch64',
			secretsProvider: '1password',
			writeLocalEnvironmentFile: true,
		},
		noGeneratedAgeIdentityDependencies,
	);

	expect(result.created).toEqual(
		expect.arrayContaining(['AGENTS.md', 'CLAUDE.md', 'docs/manual/README.md']),
	);
	expect(await fs.readFile(path.join(targetDir, 'AGENTS.md'), 'utf8')).toContain(
		'docs/manual/README.md',
	);
	expect(await fs.readlink(path.join(targetDir, 'CLAUDE.md'))).toBe('AGENTS.md');
});

it('keeps the default OpenClaw scaffold Discord-free and memory-core enabled', async () => {
	const targetDir = await createTestDirectory();

	await scaffoldAgentVmProject(
		{
			targetDir,
			zoneId: 'test-openclaw',
			gatewayType: 'openclaw',
			architecture: 'aarch64',
			secretsProvider: '1password',
			writeLocalEnvironmentFile: true,
		},
		noGeneratedAgeIdentityDependencies,
	);

	const rawOpenClawConfig = JSON.parse(
		await fs.readFile(
			path.join(targetDir, 'config', 'gateways', 'test-openclaw', 'openclaw.json'),
			'utf8',
		),
	);
	const rawSystemConfig = JSON.parse(
		await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
	);
	const gatewayDockerfile = await fs.readFile(
		path.join(targetDir, 'vm-images', 'gateways', 'openclaw', 'Dockerfile'),
		'utf8',
	);

	expect(rawOpenClawConfig.channels).toEqual({});
	expect(rawOpenClawConfig.plugins.entries['memory-core']).toEqual({ enabled: true });
	expect(rawOpenClawConfig.plugins.entries.discord).toBeUndefined();
	expect(rawSystemConfig.zones[0].secrets.DISCORD_BOT_TOKEN).toBeUndefined();
	expect(rawSystemConfig.zones[0].allowedHosts).not.toContain('discord.com');
	expect(rawSystemConfig.zones[0].websocketBypass).not.toContain('gateway.discord.gg:443');
	expect(gatewayDockerfile).not.toContain('"channels": { "discord": { "enabled": true } }');

	const localEnvironmentFile = await fs.readFile(path.join(targetDir, '.env.local'), 'utf8');
	expect(localEnvironmentFile).not.toContain('DISCORD_BOT_TOKEN');
});
```

- [ ] **Step 2: Run the failing scaffold tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts -t "manual files|Discord-free"
```

Expected: FAIL because init does not write manuals and the Dockerfile still stages Discord.

- [ ] **Step 3: Update OpenClaw defaults**

Modify `packages/agent-vm/src/cli/init-command.ts`:

1. Remove `DISCORD_BOT_TOKEN` from `defaultSecretsForGatewayType()` for OpenClaw.
2. Remove `DISCORD_BOT_TOKEN` from `envVarsForGatewayType()` for OpenClaw so `.env.local` is channel-neutral.
3. Remove `discord.com` and `cdn.discordapp.com` from `defaultAllowedHostsForGatewayType()` for OpenClaw.
4. Remove Discord hosts from `defaultWebsocketBypassForGatewayType()` for OpenClaw. Keep non-Discord defaults only if they are framework-level; otherwise return `[]`.
5. Replace the Dockerfile plugin-stage config with a memory-core/gondolin neutral config:

```Dockerfile
    printf '%s\n' \
      '{' \
      '  "gateway": { "mode": "local" },' \
      '  "plugins": {' \
      '    "allow": ["gondolin", "memory-core"],' \
      '    "entries": {' \
      '      "gondolin": { "enabled": true },' \
      '      "memory-core": { "enabled": true }' \
      '    }' \
      '  }' \
      '}' > /tmp/openclaw-plugin-stage-config.json && \
```

6. Add memory-core to `defaultOpenClawConfig()`:

```ts
plugins: {
	load: {
		paths: [defaultOpenClawExtensionsPath],
	},
	allow: ['gondolin', 'memory-core'],
	entries: {
		gondolin: {
			enabled: true,
			config: {
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId,
			},
		},
		'memory-core': {
			enabled: true,
		},
	},
},
channels: {},
```

- [ ] **Step 4: Reuse the manual updater from init**

Modify `packages/agent-vm/src/cli/init-command.ts` imports:

```ts
import { updateAgentVmManual } from './manual-commands.js';
```

Before the final runtime directory creation block, call:

```ts
const manualResult = await updateAgentVmManual({
	defaultZoneId: options.zoneId,
	systemConfigPath: 'config/system.json',
	targetDir: options.targetDir,
	updateAgentIndex: true,
});
created.push(...manualResult.updated);
```

If duplicate entries appear because a file was already created earlier, remove the earlier manual-specific writes rather than filtering at the end. Keep the result honest.

- [ ] **Step 5: Run the scaffold tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run startup-oriented OpenClaw config verification**

Run a generated-config smoke against the scaffold. If the repo has a local `agent-vm validate` or doctor command for generated config, use that command; otherwise run the strongest available OpenClaw config validation command in the generated gateway directory and record the limitation in the PR:

```bash
tmp_dir="$(mktemp -d)"
node packages/agent-vm/dist/cli/agent-vm-entrypoint.js init test-openclaw --type openclaw --secrets environment --arch aarch64 --target-dir "$tmp_dir"
node packages/agent-vm/dist/cli/agent-vm-entrypoint.js validate --config "$tmp_dir/config/system.json"
node packages/agent-vm/dist/cli/agent-vm-entrypoint.js doctor --config "$tmp_dir/config/system.json"
```

Expected: PASS, or an explicitly documented environment-gated skip if the local machine cannot start/doctor OpenClaw. Do not claim the memory-core default is deployment-safe from unit tests alone.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts
git commit -m "feat: scaffold deployment manuals and neutral openclaw defaults" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: CLI Smoke Test And Docs

**Files:**
- Create: `packages/agent-vm/src/integration-tests/manual-cli.smoke.test.ts`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/getting-started/openclaw-guide.md`

- [ ] **Step 1: Write the black-box smoke test**

Create `packages/agent-vm/src/integration-tests/manual-cli.smoke.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const agentVmCliPath = path.join(
	repoRoot,
	'packages',
	'agent-vm',
	'dist',
	'cli',
	'agent-vm-entrypoint.js',
);

async function readText(targetDir: string, relativePath: string): Promise<string> {
	return await fs.readFile(path.join(targetDir, relativePath), 'utf8');
}

describe('smoke: agent-vm manual CLI', () => {
	it('updates generated manual files from the built CLI', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-manual-cli-'));

		await execa(
			'node',
			[
				agentVmCliPath,
				'manual',
				'update',
				'--agents',
				'--default-zone',
				'shravan',
				'--target-dir',
				targetDir,
			],
			{ reject: true, timeout: 30_000 },
		);

		expect(await readText(targetDir, 'docs/manual/README.md')).toContain(
			'Generated by agent-vm manual',
		);
		expect(await readText(targetDir, 'AGENTS.md')).toContain('shravan');
		expect(await fs.readlink(path.join(targetDir, 'CLAUDE.md'))).toBe('AGENTS.md');
	});
});
```

- [ ] **Step 2: Update docs**

In `docs/reference/configuration/system-json.md`, add a short OpenClaw default section:

```md
### OpenClaw channel defaults

`agent-vm init --type openclaw` scaffolds framework primitives: Gondolin, memory-core, VM lifecycle, tool VM lease plumbing, and runtime auth wiring. It does not enable Discord or any other channel-specific surface by default.

Channel plugins are deployment-owned. Add channel plugins in the deployment Dockerfile and `config/gateways/<zone>/openclaw.json`, then declare the matching secrets, `allowedHosts`, and `websocketBypass` entries in `config/system.json`.
```

In `docs/getting-started/openclaw-guide.md`, replace any wording that says Discord is included by default with:

```md
Discord is a deployment recipe, not an agent-vm framework default. To enable Discord, configure it in your deployment Dockerfile and OpenClaw config, then add `DISCORD_BOT_TOKEN`, Discord hosts, and the Discord gateway websocket bypass to `system.json`.
```

- [ ] **Step 3: Run targeted tests**

Run:

```bash
pnpm build
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts packages/agent-vm/src/cli/manual-commands.test.ts packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts packages/agent-vm/src/cli/init-command.test.ts
pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/manual-cli.smoke.test.ts
```

Expected: all commands PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/integration-tests/manual-cli.smoke.test.ts docs/reference/configuration/system-json.md docs/getting-started/openclaw-guide.md
git commit -m "docs: document manual update and neutral openclaw defaults" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

## Final Verification

- [ ] Run formatting and type checks:

```bash
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
```

Expected: all PASS.

- [ ] Run unit tests:

```bash
pnpm test:unit
```

Expected: all PASS.

- [ ] Run smoke tests:

```bash
pnpm test:smoke
```

Expected: all PASS or document any environment-gated live smoke exclusions already used by the repo.

- [ ] Run manual black-box scaffold check:

```bash
tmp_dir="$(mktemp -d)"
node packages/agent-vm/dist/cli/agent-vm-entrypoint.js init test-openclaw --type openclaw --secrets environment --arch aarch64 --target-dir "$tmp_dir"
test -f "$tmp_dir/docs/manual/README.md"
test -L "$tmp_dir/CLAUDE.md"
grep -q "docs/manual/README.md" "$tmp_dir/AGENTS.md"
grep -q '"memory-core"' "$tmp_dir/config/gateways/test-openclaw/openclaw.json"
! grep -R "discord" "$tmp_dir/config/gateways/test-openclaw/openclaw.json"
```

Expected: exit code 0.

---

## Self-Review

Spec coverage:

- `agent-vm manual update` exists: Task 3.
- Generated deployment manual exists: Tasks 1 and 2.
- `AGENTS.md` is an agent-facing index and `CLAUDE.md` is a symlink: Tasks 1, 2, and 4.
- Discord is not a framework default: Task 4 and Task 5.
- memory-core is enabled by default: Task 4.
- Tool access/isolation model is documented: Task 1.
- Tests follow pyramid: unit tests for templates/writer/CLI/init, smoke test for built CLI.

Placeholder scan:

- No task contains TBD, TODO, "similar to", or vague unimplemented placeholders.

Type consistency:

- `ManualTemplateOptions`, `ManualTemplateFile`, `UpdateAgentVmManualOptions`, and `UpdateAgentVmManualResult` are introduced before use and match later task signatures.
