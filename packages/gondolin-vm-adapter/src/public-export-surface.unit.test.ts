import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('gondolin-vm-adapter public export surface', () => {
	it('keeps the curated index free of broad and native SDK exports', async () => {
		const indexSource = await fs.readFile(new URL('./index.ts', import.meta.url), 'utf8');

		expect(indexSource).not.toContain('export *');
		expect(indexSource).not.toContain('@earendil-works/gondolin');
		expect(indexSource).not.toMatch(
			/BuildConfig|BuildImageOptions|BuildImageResult|getDefaultBuildConfig|PinnedRealFsRoot|ManagedVmInstance|getVmInstance/u,
		);
		expect(indexSource).toContain('createGondolinManagedVmProvider');
		expect(indexSource).toContain('resolveGondolinMinimumZigVersion');
		expect(indexSource).toContain('resolveGondolinPackageSpec');
		expect(indexSource).toContain('hasBuiltImageAssets');
	});
});
