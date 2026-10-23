import { expect, it } from 'vitest';

import { isAllowedSdkNodeShimImport } from './tool-host-core-closure-policy.ts';

const sdkNodeShim = '/packed/node_modules/@modelcontextprotocol/server/dist/shimsNode.mjs';
const edge = { condition: 'node', importer: sdkNodeShim, sdkNodeShim, specifier: 'node:process' };

it('allows only the exact SDK Node shim edge in the Node condition', () => {
	expect(isAllowedSdkNodeShimImport(edge)).toBe(true);
	for (const condition of ['browser', 'workerd'])
		expect(isAllowedSdkNodeShimImport({ ...edge, condition })).toBe(false);
	for (const importer of [
		'/packed/core/dist/index.js',
		`${sdkNodeShim}.poison`,
		'/other/node_modules/@modelcontextprotocol/server/dist/shimsNode.mjs',
	])
		expect(isAllowedSdkNodeShimImport({ ...edge, importer })).toBe(false);
	for (const specifier of ['process', 'node:fs', 'node:crypto', 'cloudflare:workers'])
		expect(isAllowedSdkNodeShimImport({ ...edge, specifier })).toBe(false);
	expect(
		isAllowedSdkNodeShimImport({
			...edge,
			importer: '/arbitrary/shim.mjs',
			sdkNodeShim: '/arbitrary/shim.mjs',
		}),
	).toBe(false);
});
