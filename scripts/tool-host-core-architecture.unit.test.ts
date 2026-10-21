import { describe, expect, it } from 'vitest';

import {
	collectPortalArchitectureViolations,
	collectToolHostCoreViolations,
	isForbiddenToolHostCoreImport,
} from './audit-portal-architecture.ts';

function violations(sourceText: string): readonly string[] {
	return collectToolHostCoreViolations({
		filePath: 'packages/tool-host-core/src/hosted-mcp-proxy.ts',
		sourceText,
	});
}

describe('portable hosted proxy architecture', () => {
	it.each(['tool-access', 'tool-engine', 'tool-host-core'])(
		'refuses Cloudflare imports in %s',
		(packageName) => {
			expect(
				collectPortalArchitectureViolations({
					files: [
						{
							filePath: `packages/${packageName}/src/hosted-proxy.ts`,
							sourceText: "import { DurableObject } from 'cloudflare:workers';",
						},
					],
				}).join('\n'),
			).toContain('forbidden import cloudflare:workers');
		},
	);
	it.each([
		"import 'node:fs';",
		"export * from 'cloudflare:workers';",
		"export type Host = import('@cloudflare/workers-types').DurableObject;",
		"const lazy = () => import('cloudflare:workers');",
		"import host = require('cloudflare:workers');",
		'/// <reference types="@cloudflare/workers-types" />',
	])('rejects runtime-bound syntax %s', (sourceText) => {
		expect(violations(sourceText).length).toBeGreaterThan(0);
	});
	it.each([
		'DurableObjectState',
		'ExecutionContext',
		'AnalyticsEngineDataset',
		'WebSocketPair',
		'IncomingRequestCfProperties',
	])('rejects the ambient Workers global %s', (name) => {
		expect(violations(`export type Host = ${name};`).join('\n')).toContain(
			`Workers global ${name}`,
		);
	});
	it('permits web APIs, core internal paths and access/engine contracts while forbidding host dependencies', () => {
		expect(
			violations(
				'export const handle = (request: Request): Promise<Response> => Promise.resolve(new Response(request.url));',
			),
		).toEqual([]);
		for (const specifier of [
			'@agent-collaboration/tool-access/contracts',
			'@agent-collaboration/tool-engine/mcp-gateway',
			'#tool-host-core/hosted-mcp-proxy/hosted-mcp-proxy',
			'file:///packed/tool-host-core/dist/index.js',
		])
			expect(isForbiddenToolHostCoreImport(specifier)).toBe(false);
		expect(
			violations("import '@modelcontextprotocol/sdk/client/streamableHttp.js';").join('\n'),
		).toContain('must inject SDK client transports');
		for (const specifier of [
			'fs',
			'typescript',
			'json-schema-to-typescript',
			'@agent-collaboration/tool-host-node',
			'@agent-collaboration/tool-host-cloudflare',
			'@agent-vm/agent-vm',
			'@gondolin/provider',
			'@cloudflare/workers-types',
			'pkce-challenge',
		])
			expect(isForbiddenToolHostCoreImport(specifier)).toBe(true);
	});
});
