import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	generateManagedDockerfile,
	type ManagedImageRelease,
	resolveManagedImageRelease,
	resolveManagedOpenClawAgentVmPluginPackageSpec,
} from './managed-image-dockerfile.js';

const managedOpenClawVersion = '2026.7.1-2';
const managedOpenClawDiscordVersion = '2026.7.1';
const managedOpenAiCodexCliVersion = '0.139.0';
const managedDockerfileForbiddenSecretPattern =
	/TOKEN|Authorization|\.npmrc|\.netrc|_authToken|Bearer/u;

function expectManagedDockerfileToAvoidSecretMaterial(generatedDockerfile: string): void {
	expect(generatedDockerfile).not.toMatch(managedDockerfileForbiddenSecretPattern);
}

function expectToolVmDockerfileToInstallGitHubCliFromStableApt(generatedDockerfile: string): void {
	const githubCliKeyringPath = '/usr/share/keyrings/githubcli-archive-keyring.gpg';
	const githubCliSource = 'https://cli.github.com/packages stable main';
	const sourceIndex = generatedDockerfile.indexOf(githubCliSource);
	const installIndex = generatedDockerfile.indexOf('apt-get install -y --no-install-recommends gh');

	expect(generatedDockerfile).toContain(
		'https://cli.github.com/packages/githubcli-archive-keyring.gpg',
	);
	expect(generatedDockerfile).toContain(`signed-by=${githubCliKeyringPath}`);
	expect(generatedDockerfile).toContain(githubCliSource);
	expect(sourceIndex).toBeGreaterThan(-1);
	expect(installIndex).toBeGreaterThan(sourceIndex);
}

function createTestManagedImageRelease(): ManagedImageRelease {
	return {
		baseImages: {
			'openclaw-gateway': {
				openclawPackageVersion: managedOpenClawVersion,
				openclawPluginList: [
					'@openclaw/codex',
					'@openclaw/discord',
					'@openclaw/diagnostics-otel',
				],
				packageOverrides: {
					npm: [`@openai/codex@${managedOpenAiCodexCliVersion}`],
					openclaw: [`@openclaw/discord@${managedOpenClawDiscordVersion}`],
					pnpm: { undici: '8.5.0' },
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base',
				tag: '2026.05.27.1',
			},
			'worker-gateway': {
				packageOverrides: {
					npm: [`@openai/codex@${managedOpenAiCodexCliVersion}`],
					openclaw: [],
					pnpm: {},
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
				tag: '2026.05.27.1',
			},
			'tool-vm': {
				packageOverrides: {
					npm: [],
					openclaw: [],
					pnpm: {},
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
				tag: '2026.05.27.1',
			},
		},
	};
}

describe('managed image release', () => {
	it('keeps managed image tags separate from npm package versions', async () => {
		const release = await resolveManagedImageRelease();

		expect(release.baseImages['openclaw-gateway']).toMatchObject({
			openclawPackageVersion: managedOpenClawVersion,
			openclawPluginList: [
				'@openclaw/codex',
				'@openclaw/discord',
				'@openclaw/diagnostics-otel',
			],
			repository: 'ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base',
			packageOverrides: {
				npm: [`@openai/codex@${managedOpenAiCodexCliVersion}`],
				openclaw: [`@openclaw/discord@${managedOpenClawDiscordVersion}`],
				pnpm: {},
			},
			tag: '2026.05.27.1',
		});
		expect(release.baseImages['worker-gateway']).toMatchObject({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
			packageOverrides: {
				npm: [`@openai/codex@${managedOpenAiCodexCliVersion}`],
			},
			tag: '2026.05.27.1',
		});
		expect(release.baseImages['tool-vm']).toMatchObject({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
			tag: '2026.05.27.1',
		});
		expect(release).not.toHaveProperty('openClawVersion');
		expect(release).not.toHaveProperty('openAiCodexCliVersion');
		expect(release).not.toHaveProperty('openClawRuntimeDependencyPatches');
		expect(release.baseImages['tool-vm'].tag).not.toMatch(/^0\.0\.\d+$/u);
	});

	it('keeps repo-local OpenClaw validation examples aligned with the managed release', async () => {
		const release = await resolveManagedImageRelease();
		const expectedOpenClawPackageSpec = `openclaw@${release.baseImages['openclaw-gateway'].openclawPackageVersion}`;
		const gettingStartedGuide = await fs.readFile(
			new URL('../../../../docs/getting-started/openclaw-guide.md', import.meta.url),
			'utf8',
		);
		const validateAndDoctorReference = await fs.readFile(
			new URL('../../../../docs/reference/validate-and-doctor.md', import.meta.url),
			'utf8',
		);
		const manualTemplates = await fs.readFile(
			new URL('../cli/manual-templates.ts', import.meta.url),
			'utf8',
		);

		expect(gettingStartedGuide).toContain(`pnpm add -D ${expectedOpenClawPackageSpec}`);
		expect(validateAndDoctorReference).toContain(`pnpm add -D ${expectedOpenClawPackageSpec}`);
		expect(manualTemplates).toContain('Do not restate the managed default package set');
		expect(manualTemplates).not.toContain(
			`openClawPackageOverrides only for explicit OpenClaw runtime package pins such as ${expectedOpenClawPackageSpec}`,
		);
	});

	it('does not carry the OpenClaw plugin npm version in the managed image release', async () => {
		const release = await resolveManagedImageRelease();
		const manifest = JSON.parse(
			await fs.readFile(new URL('../../managed-images.json', import.meta.url), 'utf8'),
		) as Record<string, unknown>;

		expect(manifest).not.toHaveProperty('openClawAgentVmPluginVersion');
		expect(release).not.toHaveProperty('openClawAgentVmPluginVersion');
	});

	it('derives the OpenClaw plugin npm spec from the installed package metadata', async () => {
		const pluginPackageJson = JSON.parse(
			await fs.readFile(
				new URL('../../../openclaw-agent-vm-plugin/package.json', import.meta.url),
				'utf8',
			),
		) as Record<string, unknown>;

		await expect(resolveManagedOpenClawAgentVmPluginPackageSpec()).resolves.toBe(
			`${pluginPackageJson.name}@${pluginPackageJson.version}`,
		);
	});

	it('installs the common Gateway runtime executable beside the OpenClaw plugin', async () => {
		// Arrange
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-gateway-runtime-'),
		);

		// Act
		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory: path.join(temporaryDirectory, 'generated'),
			requiredOpenClawPackageNames: [],
		});
		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');

		// Assert
		expect(generatedDockerfile).toMatch(
			/RUN pnpm add -g "@agent-vm\/openclaw-agent-vm-plugin@[^"]+" "@agent-vm\/gateway-runtime@[^"]+"/u,
		);
		expect(result.plan.gatewayRuntimePackage).toMatchObject({
			name: '@agent-vm/gateway-runtime',
			source: 'installed-package',
		});
		expect(generatedDockerfile).toContain(
			'ln -sfn "$gateway_runtime_bin" /usr/local/bin/agent-vm-gateway-runtime',
		);
	});

	it('creates the non-secret OpenClaw auth shell environment in the managed image', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-openclaw-auth-shell-'),
		);

		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory: path.join(temporaryDirectory, 'generated'),
			requiredOpenClawPackageNames: [],
		});
		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');

		expect(generatedDockerfile).toContain('install -d -m 0755 /etc/profile.d');
		expect(generatedDockerfile).toContain(
			"'export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/state/effective-openclaw.json'",
		);
		expect(generatedDockerfile).not.toContain(
			"'export OPENCLAW_CONFIG_PATH=/run/agent-vm/managed-gateway/framework-service.json'",
		);
		expect(generatedDockerfile).toContain(
			"'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state'",
		);
		expect(generatedDockerfile).toContain('> /etc/profile.d/openclaw-env.sh');
		expect(generatedDockerfile).toContain('chmod 0644 /etc/profile.d/openclaw-env.sh');
		expectManagedDockerfileToAvoidSecretMaterial(generatedDockerfile);
	});

	it('keeps uv in the OpenClaw gateway base instead of generated Dockerfiles', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-managed-uv-'));
		const outputDirectory = path.join(temporaryDirectory, 'generated');

		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			requiredOpenClawPackageNames: [],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).not.toContain(
			'COPY --from=ghcr.io/astral-sh/uv:0.11.31 /uv /uvx /usr/local/bin/',
		);
		expect(generatedDockerfile).not.toContain('RUN uv --version && uvx --version');
	});

	it('keeps stable OpenClaw runtime preparation ahead of volatile agent-vm package installs', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-managed-stage-'));
		const outputDirectory = path.join(temporaryDirectory, 'generated');

		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			requiredOpenClawPackageNames: ['@openclaw/discord', '@openclaw/diagnostics-otel'],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		const openClawStageIndex = generatedDockerfile.indexOf(
			'FROM ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base:2026.05.27.1 AS openclaw-runtime',
		);
		const openClawInstallIndex = generatedDockerfile.indexOf(
			'WORKDIR /opt/openclaw-runtime-packages',
		);
		const openClawPostinstallIndex = generatedDockerfile.indexOf(
			'(cd "$openclaw_package_root" && node scripts/postinstall-bundled-plugins.mjs)',
		);
		const finalStageIndex = generatedDockerfile.indexOf('FROM openclaw-runtime');
		const agentVmInstallIndex = generatedDockerfile.indexOf(
			'RUN pnpm add -g "@agent-vm/openclaw-agent-vm-plugin@',
		);

		expect(openClawStageIndex).toBeGreaterThanOrEqual(0);
		expect(openClawInstallIndex).toBeGreaterThan(openClawStageIndex);
		expect(openClawPostinstallIndex).toBeGreaterThan(openClawInstallIndex);
		expect(generatedDockerfile).not.toContain('openclaw-diagnostics-otel.tgz');
		expect(finalStageIndex).toBeGreaterThan(openClawPostinstallIndex);
		expect(agentVmInstallIndex).toBeGreaterThan(finalStageIndex);
	});

	it('reports overlay OpenClaw package pins as deployment-owned plan entries', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-managed-plan-'));
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "extraAptPackages": [],',
				'  "packageOverrides": {',
				'    "openclaw": [',
				'      "@openclaw/discord@2026.5.7"',
				'    ]',
				'  },',
				'  "runAfterBase": []',
				'}',
				'',
			].join('\n'),
			'utf8',
		);
		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
			requiredOpenClawPackageNames: ['@openclaw/discord'],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain('ENV PNPM_HOME=/pnpm');
		expect(generatedDockerfile).toContain('ENV PATH=${PNPM_HOME}:${PATH}');
		expect(generatedDockerfile).toContain(
			'RUN pnpm config set global-dir /pnpm/global && pnpm config set global-bin-dir /pnpm',
		);
		expect(generatedDockerfile).toContain('RUN pnpm add -g "@agent-vm/openclaw-agent-vm-plugin@');
		expect(generatedDockerfile).not.toContain('@agent-vm/openclaw-mcp-portal-plugin');
		expect(generatedDockerfile).not.toContain('@agent-vm/mcp-portal');
		expect(generatedDockerfile).toContain('"openclaw": "2026.7.1-2"');
		expect(generatedDockerfile).toContain(
			"openclaw plugins install 'npm:@openclaw/codex' --pin",
		);
		expect(generatedDockerfile).toContain(
			"openclaw plugins install 'npm:@openclaw/discord@2026.5.7' --pin",
		);
		expect(generatedDockerfile).toContain(`"@openai/codex@${managedOpenAiCodexCliVersion}"`);
		expect(generatedDockerfile).toContain('openclaw doctor --fix --non-interactive');
		expect(generatedDockerfile).toContain(
			'ln -sfn "$openclaw_package_root/dist/plugin-sdk/sandbox.js" /opt/openclaw-sdk/sandbox.js',
		);
		expect(generatedDockerfile).toContain(
			'ln -sfn "$openclaw_package_root/dist/plugin-sdk/diagnostic-runtime.js" /opt/openclaw-sdk/diagnostic-runtime.js',
		);
		expect(generatedDockerfile).toContain('package_root="$(pnpm root -g)"');
		expect(generatedDockerfile).toContain(
			'ln -sfn "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist" /home/openclaw/.openclaw/extensions/gondolin',
		);
		expect(generatedDockerfile).not.toContain('/home/openclaw/.openclaw/extensions/mcp-portal');
		expect(generatedDockerfile).not.toContain('portal-server.js');
		expect(generatedDockerfile).not.toContain('@openclaw/discord@2026.5.2');
		expect(result.plan).toMatchObject({
			baseImage: {
				reference: 'ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base:2026.05.27.1',
				source: 'managed-images.json',
			},
			dockerfilePath: path.join(outputDirectory, 'Dockerfile'),
			openClawAgentVmPluginPackage: {
				source: 'installed-package',
			},
			openClawPackages: [
				{
					name: 'openclaw',
					spec: 'openclaw@2026.7.1-2',
					source: 'managed-images.json',
					version: '2026.7.1-2',
				},
				{
					name: '@openclaw/codex',
					spec: '@openclaw/codex',
					source: 'managed-default',
				},
				{
					name: '@openclaw/discord',
					spec: '@openclaw/discord@2026.5.7',
					source: 'overlay.jsonc/packageOverrides.openclaw',
					version: '2026.5.7',
				},
				{
					name: '@openclaw/diagnostics-otel',
					spec: '@openclaw/diagnostics-otel',
					source: 'managed-default',
				},
			],
			warnings: [
				{
					message:
						'OpenClaw package versions differ: openclaw uses 2026.7.1-2, but @openclaw/discord uses 2026.5.7.',
					type: 'openclaw-package-version-mismatch',
				},
			],
		});
	});

	it('renders managed OpenClaw runtime dependency patches as managed image graph overrides', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-runtime-patches-'),
		);
		const outputDirectory = path.join(temporaryDirectory, 'generated');

		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			requiredOpenClawPackageNames: ['@openclaw/discord'],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).not.toContain(
			'RUN pnpm add -g "openclaw@2026.7.1-2" "@openclaw/discord@2026.7.1" "@openclaw/codex@2026.7.1-1"',
		);
		expect(generatedDockerfile).toContain('WORKDIR /opt/openclaw-runtime-packages');
		expect(generatedDockerfile).toContain('"openclaw": "2026.7.1-2"');
		expect(generatedDockerfile).toContain(
			"openclaw plugins install 'npm:@openclaw/discord@2026.7.1' --pin",
		);
		expect(generatedDockerfile).toContain(
			"openclaw plugins install 'npm:@openclaw/codex' --pin",
		);
		expect(generatedDockerfile).toContain('"pnpm": {');
		expect(generatedDockerfile).toContain('"overrides": {');
		expect(generatedDockerfile).toContain('"undici": "8.5.0"');
		expect(generatedDockerfile).toContain('RUN pnpm install --prod --ignore-scripts');
		expect(generatedDockerfile).toContain(
			'override_package_root="/opt/openclaw-runtime-packages/node_modules/undici"',
		);
		expect(generatedDockerfile).toContain(
			'bundled_dependency_path="$package_root/node_modules/undici"',
		);
		expect(generatedDockerfile).toContain('mkdir -p "$(dirname "$bundled_dependency_path")"');
		expect(generatedDockerfile).toContain(
			'ln -sfn "$override_package_root" "$bundled_dependency_path"',
		);
		expect(generatedDockerfile).toContain(
			'ln -sfn /opt/openclaw-runtime-packages/node_modules/openclaw "$global_package_root/openclaw"',
		);
		expect(generatedDockerfile).toContain(
			'ln -sfn "$plugin_package_root" "$global_package_root/@openclaw/discord"',
		);
		expect(generatedDockerfile).toContain(
			'ln -sfn "$openclaw_package_root/openclaw.mjs" /pnpm/openclaw',
		);
		expect(generatedDockerfile).toContain('WORKDIR /\nRUN package_root="$(pnpm root -g)"');
		expectManagedDockerfileToAvoidSecretMaterial(generatedDockerfile);
		expect(result.plan.openClawDependencyOverrides).toEqual([
			{
				name: 'undici',
				source: 'managed-images.json/packageOverrides.pnpm',
				version: '8.5.0',
			},
		]);
	});

	it('resets the OpenClaw final-stage workdir before deployment overlay commands', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-openclaw-workdir-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "copy": [{ "from": "relative-source.txt", "to": "relative-target.txt" }],',
				'  "runAfterBase": ["test -f relative-target.txt"]',
				'}',
				'',
			].join('\n'),
			'utf8',
		);
		await fs.writeFile(path.join(temporaryDirectory, 'relative-source.txt'), 'overlay\n', 'utf8');

		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
			requiredOpenClawPackageNames: [],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain(
			'RUN pnpm add -g "@agent-vm/openclaw-agent-vm-plugin@',
		);
		expect(generatedDockerfile).toContain(
			'WORKDIR /\nCOPY overlay/relative-source.txt relative-target.txt\nRUN test -f relative-target.txt',
		);
	});

	it('rejects deployment overlay pnpm overrides', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-pnpm-overrides-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "pnpmOverrides": {',
				'    "undici": "8.5.0"',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'openclaw-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'openclaw',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
				requiredOpenClawPackageNames: [],
			}),
		).rejects.toThrow(/move pnpmOverrides to packageOverrides\.pnpm/u);
	});

	it('accepts per-overlay packageOverrides buckets with source-labeled output', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-package-overrides-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "openclaw": ["@openclaw/discord@2026.6.8"],',
				'    "npm": ["@openai/codex@0.139.1"],',
				'    "pnpm": { "undici": "8.6.0" }',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
			requiredOpenClawPackageNames: ['@openclaw/discord'],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain(
			"openclaw plugins install 'npm:@openclaw/discord@2026.6.8' --pin",
		);
		expect(generatedDockerfile).toContain('"undici": "8.6.0"');
		expect(generatedDockerfile).toContain('RUN pnpm add -g --ignore-scripts "@openai/codex@0.139.1"');
		expect(result.plan.directNpmPackages).toContainEqual({
			name: '@openai/codex',
			source: 'overlay.jsonc/packageOverrides.npm',
			spec: '@openai/codex@0.139.1',
			version: '0.139.1',
		});
		expect(result.plan.openClawDependencyOverrides).toEqual([
			{
				name: 'undici',
				source: 'overlay.jsonc/packageOverrides.pnpm',
				version: '8.6.0',
			},
		]);
	});

	it('renders every direct npm package override for OpenClaw gateway images', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-direct-npm-openclaw-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "npm": ["left-pad@1.3.0"]',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
			requiredOpenClawPackageNames: [],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain(
			'RUN pnpm add -g --ignore-scripts "@openai/codex@0.139.0" "left-pad@1.3.0"',
		);
		expect(result.plan.directNpmPackages).toEqual([
			{
				name: '@openai/codex',
				source: 'managed-images.json/packageOverrides.npm',
				spec: '@openai/codex@0.139.0',
				version: '0.139.0',
			},
			{
				name: 'left-pad',
				source: 'overlay.jsonc/packageOverrides.npm',
				spec: 'left-pad@1.3.0',
				version: '1.3.0',
			},
		]);
	});

	it('accepts legacy uppercase direct npm package override names', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-legacy-uppercase-npm-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "npm": ["JSONStream@1.3.5"]',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'tool-vm',
			imageTargetFamily: 'toolVm',
			imageTargetName: 'default',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
			requiredOpenClawPackageNames: [],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain('RUN pnpm add -g --ignore-scripts "JSONStream@1.3.5"');
		expect(result.plan.directNpmPackages).toEqual([
			{
				name: 'JSONStream',
				source: 'overlay.jsonc/packageOverrides.npm',
				spec: 'JSONStream@1.3.5',
				version: '1.3.5',
			},
		]);
	});

	it('renders direct npm package overrides for worker gateway images', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-direct-npm-worker-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "npm": ["zx@8.1.0"]',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'worker-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'worker',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
			requiredOpenClawPackageNames: [],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain('ENV PNPM_HOME=/pnpm');
		expect(generatedDockerfile).toContain(
			'RUN pnpm add -g --ignore-scripts "@openai/codex@0.139.0" "zx@8.1.0"',
		);
		expect(result.plan.directNpmPackages.map((packageEntry) => packageEntry.name)).toEqual([
			'@openai/codex',
			'zx',
		]);
	});

	it('renders direct npm package overrides for Tool VM images', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-direct-npm-tool-vm-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "npm": ["zx@8.1.0"]',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'tool-vm',
			imageTargetFamily: 'toolVm',
			imageTargetName: 'default',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
			requiredOpenClawPackageNames: [],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain('RUN pnpm add -g "@agent-vm/mcp-portal@');
		expect(generatedDockerfile).toContain('RUN pnpm add -g --ignore-scripts "zx@8.1.0"');
		expect(result.plan.directNpmPackages).toEqual([
			{
				name: 'zx',
				source: 'overlay.jsonc/packageOverrides.npm',
				spec: 'zx@8.1.0',
				version: '8.1.0',
			},
		]);
	});

	it('fails closed when a managed runtime patch does not apply to the active OpenClaw version', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-runtime-patch-version-'),
		);
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		const release = {
			...createTestManagedImageRelease(),
			baseImages: {
				...createTestManagedImageRelease().baseImages,
				'openclaw-gateway': {
					...createTestManagedImageRelease().baseImages['openclaw-gateway'],
					openclawPackageVersion: '2026.6.8',
					packageOverrides: {
						...createTestManagedImageRelease().baseImages['openclaw-gateway'].packageOverrides,
						pnpm: { undici: '8.3.0' },
					},
				},
			},
		} satisfies ManagedImageRelease;

		await expect(
			generateManagedDockerfile({
				base: 'openclaw-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'openclaw',
				managedImageRelease: release,
				outputDirectory,
				requiredOpenClawPackageNames: [],
			}),
		).rejects.toThrow(/OpenClaw 2026\.6\.8 requires stable undici@8\.5\.0/u);
	});

	it('rejects non-stable undici versions for the OpenClaw crash-mitigation floor', async () => {
		const blockedUndiciVersions = ['8.5.0-beta.1', '8.5.0-rc.0', '8.5.0+build'];
		await Promise.all(blockedUndiciVersions.map(async (undiciVersion) => {
			const temporaryDirectory = await fs.mkdtemp(
				path.join(os.tmpdir(), 'agent-vm-managed-undici-floor-'),
			);
			const outputDirectory = path.join(temporaryDirectory, 'generated');
			const release = {
				...createTestManagedImageRelease(),
				baseImages: {
					...createTestManagedImageRelease().baseImages,
					'openclaw-gateway': {
						...createTestManagedImageRelease().baseImages['openclaw-gateway'],
						openclawPackageVersion: '2026.6.8',
						packageOverrides: {
							...createTestManagedImageRelease().baseImages['openclaw-gateway'].packageOverrides,
							pnpm: { undici: undiciVersion },
						},
					},
				},
			} satisfies ManagedImageRelease;

			await expect(
				generateManagedDockerfile({
					base: 'openclaw-gateway',
					imageTargetFamily: 'gateway',
					imageTargetName: 'openclaw',
					managedImageRelease: release,
					outputDirectory,
					requiredOpenClawPackageNames: [],
				}),
			).rejects.toThrow(/requires stable undici@8\.5\.0/u);
		}));
	});

	it('fails closed when OpenClaw 2026.6.8 omits the required undici runtime patch', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-runtime-patch-missing-'),
		);
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		const release = {
			...createTestManagedImageRelease(),
			baseImages: {
				...createTestManagedImageRelease().baseImages,
				'openclaw-gateway': {
					...createTestManagedImageRelease().baseImages['openclaw-gateway'],
					openclawPackageVersion: '2026.6.8',
					packageOverrides: {
						...createTestManagedImageRelease().baseImages['openclaw-gateway'].packageOverrides,
						pnpm: {},
					},
				},
			},
		} satisfies ManagedImageRelease;

		await expect(
			generateManagedDockerfile({
				base: 'openclaw-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'openclaw',
				managedImageRelease: release,
				outputDirectory,
				requiredOpenClawPackageNames: [],
			}),
		).rejects.toThrow(/OpenClaw 2026\.6\.8 requires stable undici@8\.5\.0/u);
	});

	it('rejects unpinned OpenClaw package overrides', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-managed-unpinned-'));
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
				[
					'{',
					'  "schemaVersion": 1,',
					'  "packageOverrides": {',
					'    "openclaw": ["@openclaw/discord"]',
					'  }',
					'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'openclaw-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'openclaw',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
				requiredOpenClawPackageNames: [],
			}),
		).rejects.toThrow(/Package override specs require exact package versions/u);
	});

	it('reports legacy extra OpenClaw package overlay keys with the new override name', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-managed-legacy-'));
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "extraOpenClawPackages": [',
				'    "@openclaw/discord@2026.5.7"',
				'  ]',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'openclaw-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'openclaw',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
				requiredOpenClawPackageNames: [],
			}),
		).rejects.toThrow(/move extraOpenClawPackages to packageOverrides\.openclaw/u);
	});

	it('reports legacy OpenClaw package override keys with the new override name', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-managed-legacy-override-'));
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "openClawPackageOverrides": [',
				'    "@openclaw/discord@2026.5.7"',
				'  ]',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'openclaw-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'openclaw',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
				requiredOpenClawPackageNames: [],
			}),
		).rejects.toThrow(/move openClawPackageOverrides to packageOverrides\.openclaw/u);
	});

	it('rejects non-OpenClaw package overrides', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-managed-non-openclaw-'));
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
				[
					'{',
					'  "schemaVersion": 1,',
					'  "packageOverrides": {',
					`    "openclaw": ["@openai/codex@${managedOpenAiCodexCliVersion}"]`,
					'  }',
					'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'openclaw-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'openclaw',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
				requiredOpenClawPackageNames: [],
			}),
		).rejects.toThrow(/only accepts OpenClaw runtime package pins/u);
	});

	it('rejects malformed scoped direct npm package overrides before Docker generation', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-malformed-npm-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "npm": ["@scope/@1.2.3"]',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'tool-vm',
				imageTargetFamily: 'toolVm',
				imageTargetName: 'default',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
				requiredOpenClawPackageNames: [],
			}),
		).rejects.toThrow(/Package override specs require valid npm package names/u);
	});

	it('rejects malformed scoped OpenClaw package overrides before Docker generation', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-malformed-openclaw-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "openclaw": ["@openclaw/@1.2.3"]',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'openclaw-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'openclaw',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
				requiredOpenClawPackageNames: [],
			}),
		).rejects.toThrow(/Package override specs require valid npm package names/u);
	});

	it('installs MCP Portal in Tool VM Dockerfiles without credential literals', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-tool-vm-plan-'));
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "extraAptPackages": [],',
				'  "runAfterBase": []',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'tool-vm',
			imageTargetFamily: 'toolVm',
			imageTargetName: 'default',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain(
			'RUN rm -rf /scratch && install -d -m 0755 /work /workspace',
		);
		expectToolVmDockerfileToInstallGitHubCliFromStableApt(generatedDockerfile);
		expect(generatedDockerfile).toContain('ENV PNPM_HOME=/pnpm');
		expect(generatedDockerfile).toContain('ENV PATH=${PNPM_HOME}:${PATH}');
		expect(generatedDockerfile).toContain(
			'RUN pnpm config set global-dir /pnpm/global && pnpm config set global-bin-dir /pnpm',
		);
		expect(generatedDockerfile).toContain('RUN pnpm add -g "@agent-vm/mcp-portal@');
		expectManagedDockerfileToAvoidSecretMaterial(generatedDockerfile);
		expect(result.plan.mcpPortalPackage).toMatchObject({
			name: '@agent-vm/mcp-portal',
			source: 'installed-package',
		});
	});

	it('uses local overlay packages for Tool VM MCP Portal during beta tarball sync builds', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-tool-vm-local-'));
		const overlayDirectory = path.join(temporaryDirectory, 'overlay-source');
		const localPackageDirectory = path.join(overlayDirectory, 'local-agent-vm');
		const overlayPath = path.join(overlayDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.mkdir(localPackageDirectory, { recursive: true });
		await fs.writeFile(path.join(localPackageDirectory, 'agent-vm-mcp-portal-0.0.93-local.tgz'), '');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "copy": [',
				'    {',
				'      "from": "local-agent-vm/agent-vm-mcp-portal-0.0.93-local.tgz",',
				'      "to": "/tmp/agent-vm-mcp-portal-0.0.93-local.tgz"',
				'    }',
				'  ],',
				'  "runAfterBase": [',
				'    "cd /opt/agent-vm/local-packages && pnpm install --prod --ignore-scripts",',
				'    "ln -sfn /opt/agent-vm/local-packages/node_modules/.bin/mcp-portal /pnpm/mcp-portal"',
				'  ]',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'tool-vm',
			imageTargetFamily: 'toolVm',
			imageTargetName: 'default',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expectToolVmDockerfileToInstallGitHubCliFromStableApt(generatedDockerfile);
		expect(generatedDockerfile).not.toContain('RUN pnpm add -g "@agent-vm/mcp-portal@');
		expect(generatedDockerfile).toContain(
			'COPY overlay/local-agent-vm/agent-vm-mcp-portal-0.0.93-local.tgz /tmp/agent-vm-mcp-portal-0.0.93-local.tgz',
		);
		expect(generatedDockerfile).toContain(
			'ln -sfn /opt/agent-vm/local-packages/node_modules/.bin/mcp-portal /pnpm/mcp-portal',
		);
		expect(result.plan.mcpPortalPackage).toMatchObject({
			name: '@agent-vm/mcp-portal',
			source: 'local-overlay',
			spec: 'local-agent-vm',
		});
	});

	it('uses local overlay packages for OpenClaw agent-vm plugins during beta tarball sync builds', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-openclaw-local-'));
		const overlayDirectory = path.join(temporaryDirectory, 'overlay-source');
		const localPackageDirectory = path.join(overlayDirectory, 'local-agent-vm');
		const overlayPath = path.join(overlayDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.mkdir(localPackageDirectory, { recursive: true });
		await fs.writeFile(
			path.join(localPackageDirectory, 'agent-vm-openclaw-agent-vm-plugin-0.0.93-local.tgz'),
			'',
		);
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "copy": [',
				'    {',
				'      "from": "local-agent-vm/agent-vm-openclaw-agent-vm-plugin-0.0.93-local.tgz",',
				'      "to": "/tmp/agent-vm-openclaw-agent-vm-plugin-0.0.93-local.tgz"',
				'    }',
				'  ],',
				'  "runAfterBase": [',
				'    "cd /opt/agent-vm/local-packages && pnpm install --prod --ignore-scripts",',
				'    "ln -sfn /opt/agent-vm/local-packages/node_modules/@agent-vm/openclaw-agent-vm-plugin \\"$package_root/@agent-vm/openclaw-agent-vm-plugin\\""',
				'  ]',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
			requiredOpenClawPackageNames: ['@openclaw/discord'],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).not.toContain(
			'@agent-vm/openclaw-agent-vm-plugin@0.0.93',
		);
		expect(generatedDockerfile).not.toContain('@agent-vm/mcp-portal@0.0.93');
		expect(generatedDockerfile).toContain(
			`RUN pnpm add -g --ignore-scripts "@openai/codex@${managedOpenAiCodexCliVersion}"`,
		);
		expect(generatedDockerfile).toContain(
			'COPY overlay/local-agent-vm/agent-vm-openclaw-agent-vm-plugin-0.0.93-local.tgz /tmp/agent-vm-openclaw-agent-vm-plugin-0.0.93-local.tgz',
		);
		expect(result.plan.openClawAgentVmPluginPackage).toBeUndefined();
		expect(result.plan.mcpPortalPackage).toBeUndefined();
	});

	it('warns when OpenClaw package family versions differ', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-managed-warning-'));
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
				[
					'{',
					'  "schemaVersion": 1,',
					'  "extraAptPackages": [],',
					'  "packageOverrides": {',
					'    "openclaw": [',
					'      "@openclaw/discord@2026.5.2"',
					'    ]',
					'  },',
					'  "runAfterBase": []',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'openclaw-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'openclaw',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
			requiredOpenClawPackageNames: [],
		});

		expect(result.plan.warnings).toEqual([
			{
				type: 'openclaw-package-version-mismatch',
				message:
					'OpenClaw package versions differ: openclaw uses 2026.7.1-2, but @openclaw/discord uses 2026.5.2.',
			},
		]);
	});

	it('rejects overlay attempts to override managed agent-vm portal packages', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-override-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
				[
					'{',
					'  "schemaVersion": 1,',
					'  "extraAptPackages": [],',
					'  "packageOverrides": {',
					'    "openclaw": ["@agent-vm/mcp-portal@0.0.1"]',
					'  },',
					'  "runAfterBase": []',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'openclaw-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'openclaw',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
				requiredOpenClawPackageNames: [],
			}),
		).rejects.toThrow(/packageOverrides\.openclaw only accepts OpenClaw runtime package pins/u);
	});
});
