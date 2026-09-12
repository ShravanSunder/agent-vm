import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('OAuth approval UI package entrypoint', () => {
	it('keeps the bundled browser SDK out of installed server dependencies', async () => {
		const manifest: unknown = JSON.parse(
			await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
		);
		const parsed = z
			.object({
				dependencies: z.record(z.string(), z.string()),
				devDependencies: z.record(z.string(), z.string()),
				files: z.array(z.string()),
			})
			.parse(manifest);
		expect(parsed.dependencies['@clerk/clerk-js']).toBeUndefined();
		expect(parsed.devDependencies['@clerk/clerk-js']).toBe('6.31.1');
		expect(parsed.files).toEqual(['dist']);
	});
	it('remains a declaration-free barrel over contracts and rendering', async () => {
		const entrypointSource = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
		const sourceLines = entrypointSource.split('\n').filter((line) => line.length > 0);

		expect(sourceLines).toEqual([
			"export * from '../contracts.js';",
			"export * from './oauth-approval-renderer.js';",
			"export * from './oauth-account-policy-renderer.js';",
			"export * from './google-onboarding-renderer.js';",
			"export * from './waiting-for-access-renderer.js';",
		]);
	});
});
