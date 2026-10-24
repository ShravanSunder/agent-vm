import { expect, it } from 'vitest';

import {
	collectWorkspaceMcpBoundaryViolations,
	collectProductionReadbackViolations,
} from './workspace-mcp-boundary.ts';

const entry = 'packages/tool-host-core/src/hosted-mcp-proxy/hosted-mcp-proxy.ts';
it('allows membership reads and approval replay consumption through a distinct port', () => {
	expect(
		collectWorkspaceMcpBoundaryViolations([
			{
				filePath: entry,
				sourceText:
					'export interface McpPort { readMembership(clientId: string): Promise<unknown>; consumeApprovalToken(token: string, expiry: number): Promise<unknown> }',
			},
		]),
	).toEqual([]);
});
it.each([
	'setMembership',
	'beginAgentRemoval',
	'completeAgentRemoval',
	'AgentManagementAuthority',
	'AgentClientManagementPort',
])('rejects direct and transitive MCP access to %s', (name) => {
	const leaf = 'packages/tool-host-core/src/caller-admission/unsafe-membership.ts';
	const files = [
		{ filePath: entry, sourceText: "import '#tool-host-core/caller-admission/unsafe-membership';" },
		{ filePath: leaf, sourceText: `export interface UnsafePort { ${name}: unknown }` },
	];
	expect(collectWorkspaceMcpBoundaryViolations(files)).toEqual([
		`${leaf}: MCP closure reaches membership write surface ${name}`,
	]);
});

const productionEntry = 'packages/tool-host-cloudflare/src/index.ts';
it('allows production membership and management without exposing proof readbacks', () => {
	expect(
		collectProductionReadbackViolations([
			{
				filePath: productionEntry,
				sourceText:
					"export const route = '/management/workspaces'; export interface Port { readMembership(): unknown; setMembership(): unknown }",
			},
		]),
	).toEqual([]);
});
it.each([
	"export const route = '/__auth-proof';",
	'export interface ProofPort { readStoredAgentState(): unknown }',
])('rejects a production proof surface: %s', (sourceText) => {
	expect(
		collectProductionReadbackViolations([{ filePath: productionEntry, sourceText }]).join('\n'),
	).toContain('production closure reaches proof-only readback');
});
it('rejects transitive proof fixture imports from production', () => {
	const files = [
		{
			filePath: productionEntry,
			sourceText: "export * from '#worker-host/worker-bindings/unsafe-readback';",
		},
		{
			filePath: 'packages/tool-host-cloudflare/src/worker-bindings/unsafe-readback.ts',
			sourceText: "import '#worker-host/test-fixtures/unsafe-proof';",
		},
		{
			filePath: 'packages/tool-host-cloudflare/src/test-fixtures/unsafe-proof.ts',
			sourceText: 'export const readback = 1;',
		},
	];
	expect(collectProductionReadbackViolations(files).join('\n')).toContain(
		'production closure imports proof fixture',
	);
});
