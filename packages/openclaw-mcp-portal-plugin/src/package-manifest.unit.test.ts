import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
	readonly files?: readonly string[];
}

async function readPackageManifest(): Promise<PackageManifest> {
	const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8');
	return JSON.parse(packageJson) as PackageManifest;
}

describe('openclaw mcp portal package manifest', () => {
	it('publishes the OpenClaw plugin manifest at package root', async () => {
		const packageManifest = await readPackageManifest();

		await expect(access(new URL('../openclaw.plugin.json', import.meta.url))).resolves.toBe(
			undefined,
		);
		expect(packageManifest.files).toContain('openclaw.plugin.json');
	});
});
