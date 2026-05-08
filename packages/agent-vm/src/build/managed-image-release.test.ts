import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
	resolveManagedImageRelease,
	resolveManagedOpenClawAgentVmPluginPackageSpec,
} from './managed-image-dockerfile.js';

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
		expect(release.openClawVersion).toBe('2026.5.2');
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
});
