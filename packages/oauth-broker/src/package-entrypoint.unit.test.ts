import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('OAuth broker package entrypoints', () => {
	it('keep package entrypoints as declaration-free barrels', async () => {
		const entrypointSources = await Promise.all([
			readFile(new URL('./index.ts', import.meta.url), 'utf8'),
			readFile(new URL('./google/index.ts', import.meta.url), 'utf8'),
		]);

		for (const entrypointSource of entrypointSources) {
			expect(entrypointSource).not.toMatch(/\b(?:const|function|interface|type)\s+/u);
			expect(
				entrypointSource
					.split('\n')
					.filter((line) => line.length > 0)
					.every((line) => line.startsWith('export ')),
			).toBe(true);
		}
	});
});
