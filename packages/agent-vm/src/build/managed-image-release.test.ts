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
				tag: '2026.05.07.1',
			},
			'worker-gateway': {
				repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
				tag: '2026.05.07.1',
			},
			'tool-vm': {
				repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
				tag: '2026.05.07.1',
			},
		},
		openClawVersion: '2026.5.2',
	};
}

describe('managed image release', () => {
	it('keeps managed image tags separate from npm package versions', async () => {
		const release = await resolveManagedImageRelease();

		expect(release.baseImages['openclaw-gateway']).toEqual({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base',
			tag: '2026.05.07.1',
		});
		expect(release.baseImages['worker-gateway']).toEqual({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
			tag: '2026.05.07.1',
		});
		expect(release.baseImages['tool-vm']).toEqual({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
			tag: '2026.05.07.1',
		});
		expect(release.openClawVersion).toBe('2026.5.7');
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
				'  "extraOpenClawPackages": [',
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
		expect(generatedDockerfile).toContain('RUN pnpm add -g "@agent-vm/openclaw-agent-vm-plugin@');
		expect(generatedDockerfile).toContain(
			'RUN pnpm add -g "openclaw@2026.5.7" "@openclaw/discord@2026.5.7"',
		);
		expect(generatedDockerfile).not.toContain('@openclaw/discord@2026.5.2');
		expect(result.plan).toMatchObject({
			baseImage: {
				reference: 'ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base:2026.05.07.1',
				source: 'managed-images.json',
			},
			dockerfilePath: path.join(outputDirectory, 'Dockerfile'),
			openClawAgentVmPluginPackage: {
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
			],
			warnings: [],
		});
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
				'  "extraOpenClawPackages": [',
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
});
