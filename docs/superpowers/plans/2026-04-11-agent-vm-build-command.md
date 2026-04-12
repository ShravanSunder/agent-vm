# `agent-vm build` CLI Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shell script `scripts/build-images.sh` with a proper TypeScript CLI command `agent-vm build` that programmatically builds Docker OCI images and Gondolin VM assets from config.

**Architecture:** The `build` command reads `system.json` to discover image configs and zone cache paths. For each image type (gateway, tool), it optionally builds a Docker image from a configured Dockerfile path, then runs Gondolin `buildImage()` to produce VM assets (rootfs, kernel, initramfs) with postBuild.copy support. Everything is type-safe, config-driven, and follows the existing CLI dependency injection pattern.

**Tech Stack:** TypeScript (ES modules, Node 24), Gondolin SDK, Zod 4, execa (for Docker), Vitest

**Implementation repo:** `/Users/shravansunder/Documents/dev/project-dev/agent-vm/` (branch: `live-validation-2`)

---

## Why This Replaces the Shell Script

The current `scripts/build-images.sh` has real problems:

1. **String interpolation into inline JS** — bash variables (`${CONFIG_PATH}`) injected into `node -e` JS source. Paths with quotes or special chars break silently.
2. **No type safety** — the inline JS parses system.json with no schema validation. Field name typos or missing fields produce cryptic runtime errors.
3. **Module resolution fails** — can't import `@earendil-works/gondolin` from `node -e` because it's a linked workspace dep. We worked around this with a fragile absolute path to `gondolin-core/dist/build-pipeline.js`.
4. **Poor error context** — when `buildAssets` fails partway through, the user sees a raw Node.js stack trace from `[eval]:line:col` with no file name.
5. **Inconsistent with the CLI** — every other operation is `agent-vm <command>`. Building images is the odd one out.

The TypeScript command uses the same `loadSystemConfig()` + Zod parsing the controller uses, the same `buildImage()` from gondolin-core, and the same dependency injection pattern as every other CLI command.

## Config Changes

`system.json` gains an optional `dockerfile` field per image target. If present, `agent-vm build` builds the Docker image before running Gondolin. If absent, the OCI image must already exist.

Current:

```json
"images": {
  "gateway": {
    "buildConfig": "./images/gateway/build-config.json"
  }
}
```

After:

```json
"images": {
  "gateway": {
    "buildConfig": "./images/gateway/build-config.json",
    "dockerfile": "./images/gateway/Dockerfile"
  }
}
```

The `oci.image` in `build-config.json` remains the tag the Docker build targets. `pullPolicy: "never"` means Gondolin doesn't try to pull — it uses the locally built image.

Default OCI base is `node:24-slim`. Users can change it in their Dockerfile. The Dockerfile is the customization point for the rootfs — users choose their base OS, packages, and tools.

---

## File Structure

### New Files

| File                                                         | Responsibility                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `packages/agent-vm/src/cli/build-command.ts`                 | `agent-vm build` — orchestrates Docker + Gondolin builds per zone                                 |
| `packages/agent-vm/src/cli/build-command.test.ts`            | Tests for build command                                                                           |
| `packages/agent-vm/src/build/docker-image-builder.ts`        | Runs `docker build` from a Dockerfile path, tags with the OCI image name                          |
| `packages/agent-vm/src/build/docker-image-builder.test.ts`   | Tests for Docker builder                                                                          |
| `packages/agent-vm/src/build/gondolin-image-builder.ts`      | Reads build-config.json, calls gondolin-core `buildImage()` with correct configDir and cache path |
| `packages/agent-vm/src/build/gondolin-image-builder.test.ts` | Tests for Gondolin builder                                                                        |

### Modified Files

| File                                                | Change                                     |
| --------------------------------------------------- | ------------------------------------------ |
| `packages/agent-vm/src/controller/system-config.ts` | Add optional `dockerfile` to image schemas |
| `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`  | Add `build` subcommand                     |
| `system.json`                                       | Add `dockerfile` fields                    |
| `scripts/build-images.sh`                           | Delete                                     |

### Deleted Files

| File                      | Why                          |
| ------------------------- | ---------------------------- |
| `scripts/build-images.sh` | Replaced by `agent-vm build` |

---

## Phase A: Docker Image Builder

### Task 1: Create docker-image-builder with test

**Files:**

- Create: `packages/agent-vm/src/build/docker-image-builder.ts`
- Create: `packages/agent-vm/src/build/docker-image-builder.test.ts`

The Docker builder takes a Dockerfile path and a target image tag, runs `docker build`, and reports success/failure. It uses `execa` (already a dependency) for subprocess execution.

- [ ] **Step 1: Write failing test**

```typescript
// packages/agent-vm/src/build/docker-image-builder.test.ts
import { describe, expect, it, vi } from 'vitest';

import { buildDockerImage, type DockerImageBuilderDependencies } from './docker-image-builder.js';

describe('buildDockerImage', () => {
	it('runs docker build with correct arguments', async () => {
		const execCommands: { command: string; args: readonly string[] }[] = [];
		const dependencies: DockerImageBuilderDependencies = {
			executeCommand: async (command, args) => {
				execCommands.push({ command, args });
			},
		};

		await buildDockerImage(
			{
				dockerfilePath: '/project/images/gateway/Dockerfile',
				imageTag: 'agent-vm-gateway:latest',
			},
			dependencies,
		);

		expect(execCommands).toHaveLength(1);
		expect(execCommands[0]?.command).toBe('docker');
		expect(execCommands[0]?.args).toEqual([
			'build',
			'-f',
			'/project/images/gateway/Dockerfile',
			'-t',
			'agent-vm-gateway:latest',
			'/project/images/gateway',
		]);
	});

	it('throws with context when docker build fails', async () => {
		const dependencies: DockerImageBuilderDependencies = {
			executeCommand: async () => {
				throw new Error('exit code 1');
			},
		};

		await expect(
			buildDockerImage(
				{
					dockerfilePath: '/project/images/gateway/Dockerfile',
					imageTag: 'agent-vm-gateway:latest',
				},
				dependencies,
			),
		).rejects.toThrow('Docker build failed for agent-vm-gateway:latest');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/build/docker-image-builder`
Expected: FAIL (module doesn't exist)

- [ ] **Step 3: Implement docker-image-builder.ts**

```typescript
// packages/agent-vm/src/build/docker-image-builder.ts
import path from 'node:path';

import { execa } from 'execa';

export interface DockerImageBuilderDependencies {
	readonly executeCommand?: (command: string, args: readonly string[]) => Promise<void>;
}

interface BuildDockerImageOptions {
	readonly dockerfilePath: string;
	readonly imageTag: string;
}

async function executeDockerCommand(command: string, args: readonly string[]): Promise<void> {
	await execa(command, args, { stdio: 'inherit' });
}

export async function buildDockerImage(
	options: BuildDockerImageOptions,
	dependencies: DockerImageBuilderDependencies = {},
): Promise<void> {
	const executeCommand = dependencies.executeCommand ?? executeDockerCommand;
	const resolvedDockerfilePath = path.resolve(options.dockerfilePath);
	const contextDir = path.dirname(resolvedDockerfilePath);

	try {
		await executeCommand('docker', [
			'build',
			'-f',
			resolvedDockerfilePath,
			'-t',
			options.imageTag,
			contextDir,
		]);
	} catch (error) {
		throw new Error(
			`Docker build failed for ${options.imageTag}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/build/docker-image-builder`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/build/
git commit -m "feat: add docker-image-builder — typed wrapper for docker build"
```

---

## Phase B: Gondolin Image Builder (Extracted)

### Task 2: Create gondolin-image-builder with test

**Files:**

- Create: `packages/agent-vm/src/build/gondolin-image-builder.ts`
- Create: `packages/agent-vm/src/build/gondolin-image-builder.test.ts`

This extracts the Gondolin build logic that currently lives inline in the shell script. It reads a build-config.json, resolves configDir for relative paths, and calls `buildImage()` from gondolin-core.

- [ ] **Step 1: Write failing test**

```typescript
// packages/agent-vm/src/build/gondolin-image-builder.test.ts
import { describe, expect, it, vi } from 'vitest';

import {
	buildGondolinImage,
	type GondolinImageBuilderDependencies,
} from './gondolin-image-builder.js';

describe('buildGondolinImage', () => {
	it('calls buildImage with configDir derived from buildConfigPath', async () => {
		const buildImageCalls: { cacheDir: string; configDir?: string }[] = [];
		const dependencies: GondolinImageBuilderDependencies = {
			loadBuildConfig: async () => ({
				arch: 'aarch64',
				distro: 'alpine',
			}),
			buildImage: async (options) => {
				buildImageCalls.push({ cacheDir: options.cacheDir, configDir: options.configDir });
				return { built: false, fingerprint: 'abc123', imagePath: '/cache/abc123' };
			},
		};

		const result = await buildGondolinImage(
			{
				buildConfigPath: '/project/images/gateway/build-config.json',
				cacheDir: '/state/shravan/images/gateway',
			},
			dependencies,
		);

		expect(result.fingerprint).toBe('abc123');
		expect(buildImageCalls[0]?.cacheDir).toBe('/state/shravan/images/gateway');
		expect(buildImageCalls[0]?.configDir).toBe('/project/images/gateway');
	});

	it('reports built vs cached status', async () => {
		const dependencies: GondolinImageBuilderDependencies = {
			loadBuildConfig: async () => ({ arch: 'aarch64', distro: 'alpine' }),
			buildImage: async () => ({
				built: true,
				fingerprint: 'def456',
				imagePath: '/cache/def456',
			}),
		};

		const result = await buildGondolinImage(
			{
				buildConfigPath: '/project/images/gateway/build-config.json',
				cacheDir: '/cache',
			},
			dependencies,
		);

		expect(result.built).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/build/gondolin-image-builder`
Expected: FAIL

- [ ] **Step 3: Implement gondolin-image-builder.ts**

```typescript
// packages/agent-vm/src/build/gondolin-image-builder.ts
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	buildImage as buildImageFromCore,
	type BuildImageOptions,
	type BuildImageResult,
} from 'gondolin-core';

export interface GondolinImageBuilderDependencies {
	readonly buildImage?: (options: BuildImageOptions) => Promise<BuildImageResult>;
	readonly loadBuildConfig?: (buildConfigPath: string) => Promise<unknown>;
}

async function loadBuildConfigFromJson(buildConfigPath: string): Promise<unknown> {
	const rawContents = await fs.readFile(buildConfigPath, 'utf8');
	return JSON.parse(rawContents);
}

export async function buildGondolinImage(
	options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
	},
	dependencies: GondolinImageBuilderDependencies = {},
): Promise<BuildImageResult> {
	const loadBuildConfig = dependencies.loadBuildConfig ?? loadBuildConfigFromJson;
	const buildImage = dependencies.buildImage ?? buildImageFromCore;
	const configDir = path.dirname(path.resolve(options.buildConfigPath));
	const buildConfig = await loadBuildConfig(options.buildConfigPath);

	return await buildImage({
		buildConfig: buildConfig as BuildImageOptions['buildConfig'],
		cacheDir: options.cacheDir,
		configDir,
	});
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/build/gondolin-image-builder`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/build/
git commit -m "feat: add gondolin-image-builder — typed build-config.json → Gondolin assets"
```

---

## Phase C: Schema Update + Build Command

### Task 3: Add `dockerfile` to system-config schema

**Files:**

- Modify: `packages/agent-vm/src/controller/system-config.ts`
- Modify: `system.json`

- [ ] **Step 1: Update the image schema to accept optional dockerfile**

In `packages/agent-vm/src/controller/system-config.ts`, update both gateway and tool:

Old:

```typescript
gateway: z.object({
  buildConfig: z.string().min(1),
}),
tool: z.object({
  buildConfig: z.string().min(1),
}),
```

New — extract a shared schema to avoid repetition:

```typescript
const imageConfigSchema = z.object({
	buildConfig: z.string().min(1),
	dockerfile: z.string().min(1).optional(),
});
```

Then use it:

```typescript
images: z.object({
  gateway: imageConfigSchema,
  tool: imageConfigSchema,
}),
```

- [ ] **Step 2: Add dockerfile to resolveRelativePaths**

In `resolveRelativePaths`, the images section needs to resolve the dockerfile path too:

```typescript
images: {
  gateway: {
    ...config.images.gateway,
    buildConfig: resolvePath(config.images.gateway.buildConfig),
    ...(config.images.gateway.dockerfile
      ? { dockerfile: resolvePath(config.images.gateway.dockerfile) }
      : {}),
  },
  tool: {
    ...config.images.tool,
    buildConfig: resolvePath(config.images.tool.buildConfig),
    ...(config.images.tool.dockerfile
      ? { dockerfile: resolvePath(config.images.tool.dockerfile) }
      : {}),
  },
},
```

- [ ] **Step 3: Add dockerfile paths to system.json**

```json
"images": {
  "gateway": {
    "buildConfig": "./images/gateway/build-config.json",
    "dockerfile": "./images/gateway/Dockerfile"
  },
  "tool": {
    "buildConfig": "./images/tool/build-config.json",
    "dockerfile": "./images/tool/Dockerfile"
  }
}
```

- [ ] **Step 4: Run existing tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/system-config`
Expected: PASS (dockerfile is optional, existing tests don't provide it)

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/system-config.ts system.json
git commit -m "feat: add optional dockerfile field to image config schema"
```

---

### Task 4: Implement the build command

**Files:**

- Create: `packages/agent-vm/src/cli/build-command.ts`
- Create: `packages/agent-vm/src/cli/build-command.test.ts`

The build command reads system.json, builds Docker images if dockerfiles are configured, then builds Gondolin VM assets for each zone into the correct cache paths.

- [ ] **Step 1: Write failing test**

```typescript
// packages/agent-vm/src/cli/build-command.test.ts
import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../controller/system-config.js';
import { runBuildCommand, type BuildCommandDependencies } from './build-command.js';

function createTestSystemConfig(): SystemConfig {
	return {
		host: {
			controllerPort: 18800,
			secretsProvider: { type: '1password', tokenSource: { type: 'env' } },
		},
		images: {
			gateway: {
				buildConfig: '/project/images/gateway/build-config.json',
				dockerfile: '/project/images/gateway/Dockerfile',
			},
			tool: {
				buildConfig: '/project/images/tool/build-config.json',
			},
		},
		zones: [
			{
				id: 'test-zone',
				gateway: {
					memory: '2G',
					cpus: 2,
					port: 18791,
					openclawConfig: './config/test/openclaw.json',
					stateDir: '/state/test',
					workspaceDir: '/workspaces/test',
				},
				secrets: {},
				allowedHosts: ['example.com'],
				websocketBypass: [],
				toolProfile: 'standard',
			},
		],
		toolProfiles: {
			standard: { memory: '1G', cpus: 1, workspaceRoot: '/workspaces/tools' },
		},
		tcpPool: { basePort: 19000, size: 5 },
	} satisfies SystemConfig;
}

describe('runBuildCommand', () => {
	it('builds Docker image when dockerfile is configured', async () => {
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const gondolinBuilds: { buildConfigPath: string; cacheDir: string }[] = [];
		const output: string[] = [];

		const dependencies: BuildCommandDependencies = {
			buildDockerImage: async (options) => {
				dockerBuilds.push(options);
			},
			buildGondolinImage: async (options) => {
				gondolinBuilds.push(options);
				return { built: true, fingerprint: 'abc123', imagePath: '/cache/abc123' };
			},
			resolveOciImageTag: async (buildConfigPath) => 'agent-vm-gateway:latest',
		};

		await runBuildCommand(
			{ systemConfig: createTestSystemConfig() },
			{
				stderr: {
					write: (msg: string) => {
						output.push(msg);
						return true;
					},
				},
				stdout: { write: () => true },
			},
			dependencies,
		);

		expect(dockerBuilds).toHaveLength(1);
		expect(dockerBuilds[0]?.dockerfilePath).toBe('/project/images/gateway/Dockerfile');
		expect(dockerBuilds[0]?.imageTag).toBe('agent-vm-gateway:latest');
	});

	it('skips Docker build when no dockerfile is configured', async () => {
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const config = createTestSystemConfig();

		const dependencies: BuildCommandDependencies = {
			buildDockerImage: async (options) => {
				dockerBuilds.push(options);
			},
			buildGondolinImage: async () => ({
				built: false,
				fingerprint: 'cached',
				imagePath: '/cache/cached',
			}),
			resolveOciImageTag: async () => 'agent-vm-tool:latest',
		};

		await runBuildCommand(
			{ systemConfig: config },
			{ stderr: { write: () => true }, stdout: { write: () => true } },
			dependencies,
		);

		// Gateway has dockerfile → 1 docker build. Tool has no dockerfile → 0 docker builds for tool.
		expect(dockerBuilds).toHaveLength(1);
	});

	it('builds Gondolin assets for each zone into the zone state dir', async () => {
		const gondolinBuilds: { cacheDir: string }[] = [];

		const dependencies: BuildCommandDependencies = {
			buildDockerImage: async () => {},
			buildGondolinImage: async (options) => {
				gondolinBuilds.push({ cacheDir: options.cacheDir });
				return { built: true, fingerprint: 'f1', imagePath: '/cache/f1' };
			},
			resolveOciImageTag: async () => 'tag:latest',
		};

		await runBuildCommand(
			{ systemConfig: createTestSystemConfig() },
			{ stderr: { write: () => true }, stdout: { write: () => true } },
			dependencies,
		);

		// 1 zone × 2 image types (gateway + tool)
		expect(gondolinBuilds).toHaveLength(2);
		expect(gondolinBuilds[0]?.cacheDir).toBe('/state/test/images/gateway');
		expect(gondolinBuilds[1]?.cacheDir).toBe('/state/test/images/tool');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/cli/build-command`
Expected: FAIL

- [ ] **Step 3: Implement build-command.ts**

```typescript
// packages/agent-vm/src/cli/build-command.ts
import fs from 'node:fs/promises';
import path from 'node:path';

import type { BuildImageResult } from 'gondolin-core';
import { z } from 'zod';

import type { SystemConfig } from '../controller/system-config.js';
import { buildDockerImage as buildDockerImageDefault } from '../build/docker-image-builder.js';
import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import type { CliIo } from './agent-vm-cli-support.js';

export interface BuildCommandDependencies {
	readonly buildDockerImage?: (options: {
		readonly dockerfilePath: string;
		readonly imageTag: string;
	}) => Promise<void>;
	readonly buildGondolinImage?: (options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
	}) => Promise<BuildImageResult>;
	readonly resolveOciImageTag?: (buildConfigPath: string) => Promise<string>;
}

const ociImageTagSchema = z.object({
	oci: z.object({
		image: z.string().min(1),
	}),
});

async function resolveOciImageTagFromConfig(buildConfigPath: string): Promise<string> {
	const rawConfig: unknown = JSON.parse(await fs.readFile(buildConfigPath, 'utf8'));
	const parsed = ociImageTagSchema.safeParse(rawConfig);
	if (!parsed.success) {
		throw new Error(
			`build-config.json at ${buildConfigPath} has no valid oci.image tag: ${parsed.error.message}`,
		);
	}
	return parsed.data.oci.image;
}

interface ImageTarget {
	readonly name: string;
	readonly buildConfigPath: string;
	readonly dockerfile?: string;
}

export async function runBuildCommand(
	options: { readonly systemConfig: SystemConfig },
	io: CliIo,
	dependencies: BuildCommandDependencies = {},
): Promise<void> {
	const buildDockerImage = dependencies.buildDockerImage ?? buildDockerImageDefault;
	const buildGondolinImage = dependencies.buildGondolinImage ?? buildGondolinImageDefault;
	const resolveOciImageTag = dependencies.resolveOciImageTag ?? resolveOciImageTagFromConfig;

	const imageTargets: readonly ImageTarget[] = [
		{
			name: 'gateway',
			buildConfigPath: options.systemConfig.images.gateway.buildConfig,
			dockerfile: options.systemConfig.images.gateway.dockerfile,
		},
		{
			name: 'tool',
			buildConfigPath: options.systemConfig.images.tool.buildConfig,
			dockerfile: options.systemConfig.images.tool.dockerfile,
		},
	];

	// Step 1: Build Docker images for targets that have Dockerfiles
	for (const target of imageTargets) {
		if (!target.dockerfile) {
			continue;
		}

		const imageTag = await resolveOciImageTag(target.buildConfigPath);
		io.stderr.write(`[build] Docker: ${target.name} → ${imageTag}\n`);
		await buildDockerImage({ dockerfilePath: target.dockerfile, imageTag });
		io.stderr.write(`[build] Docker: ${target.name} done\n`);
	}

	// Step 2: Build Gondolin VM assets per zone
	for (const zone of options.systemConfig.zones) {
		for (const target of imageTargets) {
			const cacheDir = path.join(zone.gateway.stateDir, 'images', target.name);
			io.stderr.write(`[build] Gondolin: ${target.name} (${zone.id}) → ${cacheDir}\n`);

			const result = await buildGondolinImage({
				buildConfigPath: target.buildConfigPath,
				cacheDir,
			});

			const status = result.built ? 'built' : 'cached';
			io.stderr.write(
				`[build] Gondolin: ${target.name} (${zone.id}) ${status} [${result.fingerprint}]\n`,
			);
		}
	}
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/cli/build-command`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/cli/build-command.ts packages/agent-vm/src/cli/build-command.test.ts
git commit -m "feat: add build command — Docker + Gondolin builds from system config"
```

---

### Task 5: Wire build into CLI entrypoint and delete shell script

**Files:**

- Modify: `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`
- Delete: `scripts/build-images.sh`

- [ ] **Step 1: Add `build` subcommand to entrypoint**

In `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`, add a `build` case after the `init` case:

```typescript
import { runBuildCommand } from './build-command.js';

// After the init block, before the controller check:
if (commandGroup === 'build') {
	const systemConfig = dependencies.loadSystemConfig(
		resolveConfigPath(subcommand ? [subcommand, ...restArguments] : restArguments),
	);
	await runBuildCommand({ systemConfig }, io);
	return;
}
```

This makes the command: `agent-vm build` (uses default system.json) or `agent-vm build --config ./custom.json`.

- [ ] **Step 2: Delete the shell script**

Run: `rm scripts/build-images.sh`

If the scripts directory is now empty, remove it too:
Run: `rmdir scripts 2>/dev/null || true`

- [ ] **Step 3: Run all tests**

Run: `pnpm vitest run`
Expected: PASS

- [ ] **Step 4: Verify the command works end-to-end**

Run: `cd /Users/shravansunder/Documents/dev/project-dev/agent-vm && pnpm -r build && node packages/agent-vm/dist/cli/agent-vm-entrypoint.js build`

Expected output:

```
[build] Docker: gateway → agent-vm-gateway:latest
[build] Docker: gateway done
[build] Docker: tool → agent-vm-tool:latest
[build] Docker: tool done
[build] Gondolin: gateway (shravan) → .../state/shravan/images/gateway
[build] Gondolin: gateway (shravan) cached [92bcc75df3584c75]
[build] Gondolin: tool (shravan) → .../state/shravan/images/tool
[build] Gondolin: tool (shravan) cached [e1e56961239b14a8]
```

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/cli/agent-vm-entrypoint.ts
git rm scripts/build-images.sh
git commit -m "feat: wire agent-vm build into CLI, delete shell script"
```

---

### Task 6: Refactor both gateway and tool image builders to use shared gondolin-image-builder

**Files:**

- Modify: `packages/agent-vm/src/gateway/gateway-image-builder.ts`
- Modify: `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`

Both the gateway-image-builder and tool-vm-lifecycle currently duplicate the "load config + call buildImage" logic independently. Gateway-image-builder was already updated with configDir; tool-vm-lifecycle at line 60-64 still calls `buildImageFromCore` directly without configDir. Both should delegate to the shared `gondolin-image-builder.ts` so there's genuinely one code path.

- [ ] **Step 1: Refactor gateway-image-builder to delegate**

```typescript
// packages/agent-vm/src/gateway/gateway-image-builder.ts
import type { BuildImageResult } from 'gondolin-core';

import {
	buildGondolinImage as buildGondolinImageDefault,
	type GondolinImageBuilderDependencies,
} from '../build/gondolin-image-builder.js';
import type { GatewayBuildImageOptions } from './gateway-zone-support.js';

export interface GatewayImageBuilderDependencies {
	readonly buildImage?: (options: GatewayBuildImageOptions) => Promise<BuildImageResult>;
	readonly buildGondolinImage?: GondolinImageBuilderDependencies['buildImage'];
	readonly loadBuildConfig?: GondolinImageBuilderDependencies['loadBuildConfig'];
}

export async function buildGatewayImage(
	options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
	},
	dependencies: GatewayImageBuilderDependencies = {},
): Promise<BuildImageResult> {
	if (dependencies.buildImage) {
		const loadBuildConfig =
			dependencies.loadBuildConfig ??
			(async (configPath: string) => {
				const fs = await import('node:fs/promises');
				return JSON.parse(await fs.readFile(configPath, 'utf8'));
			});
		return await dependencies.buildImage({
			buildConfig: await loadBuildConfig(options.buildConfigPath),
			cacheDir: options.cacheDir,
		});
	}

	return await buildGondolinImageDefault(options, {
		buildImage: dependencies.buildGondolinImage,
		loadBuildConfig: dependencies.loadBuildConfig,
	});
}
```

- [ ] **Step 2: Run existing tests**

Run: `pnpm vitest run packages/agent-vm/src/gateway/`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/agent-vm/src/gateway/gateway-image-builder.ts
git commit -m "refactor: gateway-image-builder delegates to shared gondolin-image-builder"
```

---

### Task 7: Update docs, init template, and fix all stale script references

**Files:**

- Modify: `packages/agent-vm/src/cli/init-command.ts` — update DEFAULT_SYSTEM_CONFIG to include `dockerfile` fields
- Modify: `/Users/shravansunder/Documents/dev/project-dev/agent-vm/docs/SETUP.md` — replace `./scripts/build-images.sh` with `agent-vm build`
- Modify: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/01-architecture-v4.md:73` — replace `./scripts/build-images.sh` with `agent-vm build`
- Modify: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/05-secrets-security-model.md:297` — replace `./scripts/build-images.sh` with `agent-vm build`

All three docs reference the shell script. They all become stale when it's deleted.

- [ ] **Step 1: Update init template**

In `packages/agent-vm/src/cli/init-command.ts`, update `DEFAULT_SYSTEM_CONFIG`:

```typescript
images: {
  gateway: {
    buildConfig: './images/gateway/build-config.json',
    dockerfile: './images/gateway/Dockerfile',
  },
  tool: {
    buildConfig: './images/tool/build-config.json',
    dockerfile: './images/tool/Dockerfile',
  },
},
```

- [ ] **Step 2: Update SETUP.md**

Replace:

````markdown
### 3. Build images

```bash
./scripts/build-images.sh
```
````

````

With:
```markdown
### 3. Build images

```bash
agent-vm build
````

Builds Docker OCI images from Dockerfiles, then Gondolin VM assets per zone.
First build takes ~2-5 minutes. Subsequent builds are cached by fingerprint.

````

- [ ] **Step 3: Update init test if it checks images config shape**

Run: `pnpm vitest run packages/agent-vm/src/cli/init-command`
Expected: PASS (or fix if test asserts on the old images shape)

- [ ] **Step 4: Run full check**

Run: `pnpm check`
Expected: 0 errors

- [ ] **Step 5: Commit in agent-vm**

```bash
git add packages/agent-vm/src/cli/init-command.ts docs/SETUP.md
git commit -m "docs: update setup guide and init template — agent-vm build replaces shell script"
````

- [ ] **Step 6: Commit in shravan-claw**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/shravan-claw
git add docs/01-architecture-v4.md docs/05-secrets-security-model.md
git commit -m "docs: update shravan-claw references — agent-vm build replaces shell script"
```

---

## Summary

| Task | What                                | Why                                                                                           |
| ---- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | Docker image builder                | Type-safe wrapper for `docker build`, mockable for tests                                      |
| 2    | Gondolin image builder              | Extracts the "load config + configDir + buildImage" pattern into a reusable module            |
| 3    | Schema: `dockerfile` field          | Config-driven Docker builds — users specify their Dockerfile, or omit for pre-built images    |
| 4    | `agent-vm build` command            | Orchestrates Docker → Gondolin per zone. Replaces the shell script with typed, testable code. |
| 5    | Wire into CLI + delete shell script | One CLI for everything. No more `scripts/build-images.sh`.                                    |
| 6    | Refactor gateway-image-builder      | One code path for Gondolin builds — build command and controller use the same module          |
| 7    | Docs + init template                | `agent-vm build` in setup guide, `dockerfile` in scaffolded system.json                       |

**Execution order:** 1 → 2 → 3 → 4 → 5 → 6 → 7

After all tasks, run:

```bash
pnpm check
agent-vm build  # Verify e2e
```
