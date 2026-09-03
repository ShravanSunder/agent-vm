import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('OAuth approval UI package entrypoint', () => {
	it('remains a declaration-free barrel over contracts and rendering', async () => {
		const entrypointSource = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
		const sourceLines = entrypointSource.split('\n').filter((line) => line.length > 0);

		expect(sourceLines).toEqual([
			"export * from '../contracts.js';",
			"export * from './oauth-approval-renderer.js';",
		]);
	});
});
