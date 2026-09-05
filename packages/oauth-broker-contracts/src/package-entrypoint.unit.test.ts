import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('OAuth broker contracts package entrypoint', () => {
	it('remains a declaration-free barrel over responsibility-named contract modules', async () => {
		const entrypointSource = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
		const sourceLines = entrypointSource.split('\n').filter((line) => line.length > 0);

		expect(sourceLines.length).toBeGreaterThan(1);
		expect(sourceLines.every((line) => line.startsWith('export * from '))).toBe(true);
		expect(entrypointSource).not.toMatch(/\b(?:const|function|interface|type)\s+/u);
	});
});
