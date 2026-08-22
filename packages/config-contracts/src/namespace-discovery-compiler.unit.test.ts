import { describe, expect, it } from 'vitest';

import { mcpConfigSchema } from './mcp-config.js';
import { compileToolPortalNamespaceDiscoveryByProfile } from './namespace-discovery-compiler.js';
import { toolPortalConfigSchema } from './tool-portal-config.js';

const selector = { allow: '*' as const, deny: [] };

function compileWithProviders(providers: unknown): unknown {
	return compileToolPortalNamespaceDiscoveryByProfile({
		mcpConfig: mcpConfigSchema.parse({ providers, schemaVersion: 1 }),
		toolPortalConfig: toolPortalConfigSchema.parse({
			agents: { sun: { profile: 'default' } },
			mode: 'managed',
			profiles: {
				default: {
					namespaces: {
						deepwiki: {
							backend: { kind: 'mcp_provider' },
							calls: { requiresApproval: selector, withoutApproval: { allow: [], deny: [] } },
							tools: selector,
						},
						local: {
							backend: {
								kind: 'controller_execution',
								operations: { controller_host_probe: { kind: 'registered_action' } },
							},
							calls: { requiresApproval: { allow: [], deny: [] }, withoutApproval: selector },
							discovery: { summary: 'Controller-local tools.' },
							tools: selector,
						},
					},
				},
			},
			schemaVersion: 1,
		}),
	});
}

describe('compileToolPortalNamespaceDiscoveryByProfile', () => {
	it('resolves provider summaries by public namespace and preserves non-MCP summaries', () => {
		expect(
			compileWithProviders({
				'deepwiki-production': {
					discovery: { summary: 'Repository documentation and Q&A.' },
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://deepwiki.test/mcp' },
				},
			}),
		).toEqual({
			default: [
				{ namespace: 'deepwiki', summary: 'Repository documentation and Q&A.' },
				{ namespace: 'local', summary: 'Controller-local tools.' },
			],
		});
	});

	it('fails deterministic missing and ambiguous provider namespace resolution', () => {
		expect(() => compileWithProviders({})).toThrow('found 0');
		expect(() =>
			compileWithProviders({
				first: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://first.test/mcp' },
				},
				second: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://second.test/mcp' },
				},
			}),
		).toThrow('found 2');
	});
});
