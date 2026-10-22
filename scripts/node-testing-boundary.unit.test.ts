import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { collectPortalArchitectureViolations } from './audit-portal-architecture.js';
import {
	collectToolHostNodeViolations,
	isNodeHostTestingDependency,
} from './tool-host-node-architecture.js';

describe('Node upstream testing entry boundary', () => {
	it.each([
		"import {startFakeUpstreamMcpServer} from '@agent-vm/mcp-portal/testing/fake-upstream-mcp-server';",
		"import {startFakeUpstreamMcpServer} from '@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server';",
		"export * from '#node-host/testing/fake-upstream-mcp-server';",
		"export * from './testing/fake-upstream-mcp-server.js';",
		"export type Fixture = import('@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server').StartedFakeUpstreamMcpServer;",
		"export async function fixture(){return import('@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server');}",
	])('rejects production dependency on workspace testing code: %s', (sourceText) => {
		expect(
			collectPortalArchitectureViolations({
				files: [{ filePath: 'packages/tool-host-node/src/index.ts', sourceText }],
			}),
		).not.toEqual([]);
		expect(
			collectPortalArchitectureViolations({
				files: [
					{
						filePath: 'packages/tool-host-node/src/testing/allowed-fixture.integration.test.ts',
						sourceText,
					},
				],
			}),
		).toEqual([]);
	});
	it.each(['hono', '@hono/node-server'])(
		'permits workspace fixture dependency %s without allowing it in production',
		(specifier) => {
			const sourceText = `import { fixture } from '${specifier}'; export { fixture };`;
			expect(
				collectToolHostNodeViolations({
					filePath: 'packages/tool-host-node/src/testing/fake-upstream-mcp-server.ts',
					sourceText,
				}),
			).toEqual([]);
			expect(
				collectToolHostNodeViolations({
					filePath: 'packages/tool-host-node/src/bin/tool-host-node.ts',
					sourceText,
				}),
			).not.toEqual([]);
			expect(isNodeHostTestingDependency(specifier)).toBe(true);
		},
	);
	it('keeps fixture libraries out of production package dependencies', async () => {
		const source = await readFile(
			new URL('../packages/tool-host-node/package.json', import.meta.url),
			'utf8',
		);
		const manifest: unknown = JSON.parse(source);
		expect(manifest).toMatchObject({
			devDependencies: { hono: '4.12.34', '@hono/node-server': '2.0.10' },
		});
		expect(manifest).not.toMatchObject({ dependencies: { hono: expect.anything() } });
		expect(manifest).not.toMatchObject({
			dependencies: { '@hono/node-server': expect.anything() },
		});
	});
});

it.each([
	"import {createPortalCore} from 'legacy-mcp-portal/core';",
	"export * from 'legacy-mcp-portal/core';",
	"export type Legacy = import('legacy-mcp-portal/core').PortalCore;",
	"export async function load(){return import('legacy-mcp-portal/core');}",
	"const legacy = require('legacy-mcp-portal');",
])('rejects the pinned legacy oracle in product code: %s', (sourceText) => {
	for (const filePath of [
		'packages/tool-host-cloudflare/src/index.ts',
		'packages/tool-host-core/src/index.ts',
		'packages/tool-engine/src/index.ts',
	]) {
		expect(collectPortalArchitectureViolations({ files: [{ filePath, sourceText }] })).not.toEqual(
			[],
		);
	}
	expect(
		collectPortalArchitectureViolations({
			files: [
				{
					filePath:
						'packages/tool-host-cloudflare/src/test-fixtures/legacy-proxy-reference-test-fixture.ts',
					sourceText,
				},
			],
		}),
	).toEqual([]);
});
