import { describe, expect, it } from 'vitest';

import {
	collectToolAccessViolations,
	isForbiddenToolAccessImport,
} from '../../../../scripts/audit-portal-architecture.js';

describe('tool-access source and declaration guard', () => {
	it.each([
		'node:fs',
		'fs',
		'fs/promises',
		'node:test',
		'@agent-vm/agent-vm',
		'@agent-vm/managed-vm',
		'@gondolin/sdk',
		'@agent-vm/gondolin-vm-adapter',
		'@agent-vm/tool-portal',
		'@agent-vm/mcp-portal',
		'@agent-vm/gateway-runtime',
		'@agent-collaboration/tool-engine',
		'@agent-collaboration/tool-host-cloudflare',
		'file:///outside/node_modules/@agent-collaboration/tool-host-node/dist/index.js',
	])('rejects forbidden module or resolved path %s', (specifier) => {
		expect(isForbiddenToolAccessImport(specifier)).toBe(true);
	});
	it.each(['zod', '@agent-vm/oauth-broker-contracts', './pure-policy.js'])(
		'permits portable dependencies %s',
		(specifier) => {
			expect(isForbiddenToolAccessImport(specifier)).toBe(false);
		},
	);
	it.each([
		"import type { Host } from '@agent-collaboration/tool-host-node';",
		"export type Host = import('@agent-collaboration/tool-engine').Host;",
		"export * from '@agent-vm/gateway-runtime';",
		"import 'node:fs';",
		"export async function lazy() { return import('node:fs'); }",
	])('catches erased, side-effect, re-exported and lazy imports: %s', (sourceText) => {
		expect(
			collectToolAccessViolations({
				filePath: 'packages/tool-access/src/contracts/portable-policy.ts',
				sourceText,
			}),
		).toHaveLength(1);
	});
	it.each(['target', 'executionTarget', 'image', 'credential', 'executor'])(
		'rejects execution-bearing field %s in types and schemas',
		(field) => {
			for (const sourceText of [
				`export interface Policy { ${field}: string }`,
				`export const policy = z.strictObject({${field}: z.string()});`,
			]) {
				expect(
					collectToolAccessViolations({
						filePath: 'packages/tool-access/src/contracts/portable-policy.ts',
						sourceText,
					}),
				).toEqual([
					`packages/tool-access/src/contracts/portable-policy.ts: tool-access execution-bearing contract field ${field}`,
				]);
			}
		},
	);
	it('permits execution-neutral kinds and references', () => {
		expect(
			collectToolAccessViolations({
				filePath: 'packages/tool-access/src/contracts/portable-policy.ts',
				sourceText:
					"import { z } from 'zod'; export const policy = z.strictObject({backendKind: z.string(), credentialNeed: z.string()});",
			}),
		).toEqual([]);
	});
});
