import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { resolveManagedImageRelease } from './managed-image-dockerfile.js';

interface PackageJson {
	readonly version?: unknown;
}

async function readPackageVersion(packageJsonUrl: URL): Promise<string> {
	const packageJson = JSON.parse(await fs.readFile(packageJsonUrl, 'utf8')) as PackageJson;
	if (typeof packageJson.version !== 'string') {
		throw new Error(`Missing package version in ${packageJsonUrl.href}.`);
	}
	return packageJson.version;
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
		expect(release.openClawVersion).toBe('2026.5.2');
		expect(release.baseImages['tool-vm'].tag).not.toMatch(/^0\.0\.\d+$/u);
	});

	it('pins the bundled OpenClaw plugin to the package release version', async () => {
		const release = await resolveManagedImageRelease();
		const openClawAgentVmPluginVersion = await readPackageVersion(
			new URL('../../../openclaw-agent-vm-plugin/package.json', import.meta.url),
		);

		expect(release.openClawAgentVmPluginVersion).toBe(openClawAgentVmPluginVersion);
	});
});
