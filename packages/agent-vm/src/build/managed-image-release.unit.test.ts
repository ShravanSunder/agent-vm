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

function createTestManagedImageRelease(): ManagedImageRelease {
	return {
		baseImages: {
			'openclaw-gateway': {
				repository: 'ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base',
				tag: '2026.05.27.1',
			},
			'worker-gateway': {
				repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
				tag: '2026.05.27.1',
			},
			'tool-vm': {
				repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
				tag: '2026.05.27.1',
			},
		},
		openAiCodexCliVersion: '0.134.0',
		openClawVersion: '2026.6.5',
	};
}

describe('managed image release', () => {
	it('keeps managed image tags separate from npm package versions', async () => {
		const release = await resolveManagedImageRelease();

		expect(release.baseImages['openclaw-gateway']).toEqual({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base',
			tag: '2026.05.27.1',
		});
		expect(release.baseImages['worker-gateway']).toEqual({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
			tag: '2026.05.27.1',
		});
		expect(release.baseImages['tool-vm']).toEqual({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
			tag: '2026.05.27.1',
		});
		expect(release.openClawVersion).toBe('2026.6.5');
		expect(release.openAiCodexCliVersion).toBe('0.134.0');
		expect(release.baseImages['tool-vm'].tag).not.toMatch(/^0\.0\.\d+$/u);
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
			'COPY --from=ghcr.io/astral-sh/uv:0.11.16 /uv /uvx /usr/local/bin/',
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
			requiredOpenClawPackageNames: ['@openclaw/discord'],
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		const openClawStageIndex = generatedDockerfile.indexOf(
			'FROM ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base:2026.05.27.1 AS openclaw-runtime',
		);
		const openClawInstallIndex = generatedDockerfile.indexOf(
			'RUN pnpm add -g "openclaw@2026.6.5" "@openclaw/codex@2026.6.5" "@openclaw/discord@2026.6.5"',
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
				'  "openClawPackageOverrides": [',
				'    "openclaw@2026.5.7",',
				'    "@openclaw/discord@2026.5.7"',
				'  ],',
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
		expect(generatedDockerfile).toContain('"@agent-vm/openclaw-mcp-portal-plugin@');
		expect(generatedDockerfile).toContain('"@agent-vm/mcp-portal@');
		expect(generatedDockerfile).toContain(
			'RUN pnpm add -g "openclaw@2026.5.7" "@openclaw/discord@2026.5.7" "@openclaw/codex@2026.5.7"',
		);
		expect(generatedDockerfile).toContain('"@openai/codex@0.134.0"');
		expect(generatedDockerfile).toContain('openclaw doctor --fix --non-interactive');
		expect(generatedDockerfile).toContain('/opt/openclaw-sdk/sandbox.js');
		expect(generatedDockerfile).toContain('package_root="$(pnpm root -g)"');
		expect(generatedDockerfile).toContain(
			'ln -sfn "$package_root/@agent-vm/openclaw-mcp-portal-plugin/dist" /home/openclaw/.openclaw/extensions/mcp-portal',
		);
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
			openClawMcpPortalPluginPackage: {
				source: 'installed-package',
			},
			mcpPortalPackage: {
				source: 'installed-package',
			},
			openClawPackages: [
				{
					name: 'openclaw',
					spec: 'openclaw@2026.5.7',
					source: 'overlay',
					version: '2026.5.7',
				},
				{
					name: '@openclaw/discord',
					spec: '@openclaw/discord@2026.5.7',
					source: 'overlay',
					version: '2026.5.7',
				},
				{
					name: '@openclaw/codex',
					spec: '@openclaw/codex@2026.5.7',
					source: 'overlay',
					version: '2026.5.7',
				},
			],
			warnings: [],
		});
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
				'  "openClawPackageOverrides": [',
				'    "@openclaw/discord"',
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
		).rejects.toThrow(/openClawPackageOverrides requires exact package versions/u);
	});

	it('reports legacy OpenClaw package overlay keys with the new override name', async () => {
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
		).rejects.toThrow(/rename extraOpenClawPackages to openClawPackageOverrides/u);
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
				'  "openClawPackageOverrides": [',
				'    "@openai/codex@0.134.0"',
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
		).rejects.toThrow(/only accepts OpenClaw runtime package pins/u);
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
		expect(generatedDockerfile).toContain('ENV PNPM_HOME=/pnpm');
		expect(generatedDockerfile).toContain('ENV PATH=${PNPM_HOME}:${PATH}');
		expect(generatedDockerfile).toContain(
			'RUN pnpm config set global-dir /pnpm/global && pnpm config set global-bin-dir /pnpm',
		);
		expect(generatedDockerfile).toContain('RUN pnpm add -g "@agent-vm/mcp-portal@');
		expect(generatedDockerfile).not.toMatch(
			/TOKEN|Authorization|\.npmrc|\.netrc|_authToken|Bearer/u,
		);
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
		expect(generatedDockerfile).toContain('RUN pnpm add -g "@openai/codex@0.134.0"');
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
				'  "openClawPackageOverrides": [',
				'    "openclaw@2026.5.7",',
				'    "@openclaw/discord@2026.5.2"',
				'  ],',
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
					'OpenClaw package versions differ: openclaw uses 2026.5.7, but @openclaw/discord uses 2026.5.2.',
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
				'  "openClawPackageOverrides": [',
				'    "@agent-vm/mcp-portal@0.0.1"',
				'  ],',
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
		).rejects.toThrow(/cannot override managed package @agent-vm\/mcp-portal/u);
	});
});
