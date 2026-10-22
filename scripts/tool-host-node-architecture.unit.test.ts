import { describe, expect, it } from 'vitest';

import { collectPortalArchitectureViolations } from './audit-portal-architecture.js';
import {
	collectToolHostNodeViolations,
	isForbiddenToolHostNodeImport,
} from './tool-host-node-architecture.js';

describe('Node host restricted dependency guard', () => {
	it.each([
		'node:fs',
		'fs',
		'typescript',
		'json-schema-to-typescript',
		'@agent-vm/oauth-broker-contracts',
		'@agent-vm/agent-portal-sdk/generated-tools',
		'@agent-collaboration/tool-engine/capability-dispatch',
	])('allows its runtime or explicit contract dependency %s', (specifier) => {
		expect(isForbiddenToolHostNodeImport(specifier)).toBe(false);
	});
	it.each([
		'@agent-vm/agent-vm',
		'@agent-vm/managed-vm',
		'@agent-vm/secret-management',
		'@earendil-works/gondolin',
		'@agent-vm/not-an-allowed-contract',
		'@agent-vm/gateway-runtime',
	])('rejects forbidden dependency %s', (specifier) => {
		expect(isForbiddenToolHostNodeImport(specifier)).toBe(true);
	});
	it.each([
		"import type { Host } from '@agent-vm/agent-vm';",
		"export * from '@agent-vm/managed-vm';",
		"export async function lazy(){return import('@agent-vm/secret-management');}",
		"export type Host=import('@agent-vm/gateway-runtime').Host;",
	])('rejects erased, re-export and lazy host edges: %s', (sourceText) => {
		const file = { filePath: 'packages/tool-host-node/src/controlled-dependency.ts', sourceText };
		expect(collectToolHostNodeViolations(file)).toHaveLength(1);
		expect(collectPortalArchitectureViolations({ files: [file] })).toHaveLength(1);
		expect(
			collectToolHostNodeViolations({
				...file,
				sourceText: "import {open} from 'node:fs/promises'; export {open};",
			}),
		).toEqual([]);
	});
});

describe('Node inbound protocol session policy', () => {
	it.each([
		'const sessions = new Map<string, unknown>();',
		'const protocolSessions = new Map();',
		'const transport = { sessionIdGenerator: () => "session" };',
		'const session = request.headers["Mcp-Session-Id"];',
	])('rejects surviving protocol session state: %s', (sourceText) => {
		for (const filePath of [
			'packages/tool-host-node/src/mcp-proxy-server/node-http-server.ts',
			'packages/tool-host-node/src/standalone-tool-portal/standalone-http-servers.ts',
		]) {
			expect(collectToolHostNodeViolations({ filePath, sourceText })).not.toEqual([]);
		}
	});
});
