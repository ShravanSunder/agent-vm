import type { CompiledCatalogTypescriptBundle } from '@agent-vm/mcp-portal/catalog-typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const definitionFingerprint = 'a'.repeat(64);

function emptyCompiledBundle(): CompiledCatalogTypescriptBundle {
	return {
		definitionFingerprint,
		files: [],
		manifest: {
			definitionFingerprint,
			generatorVersion: '2',
			namespaces: [],
			sdkContractVersion: '1',
			tools: [],
		},
		nativeTools: [],
	};
}

afterEach(() => {
	vi.doUnmock('@agent-vm/mcp-portal/catalog-typescript');
	vi.resetModules();
});

describe('prepared catalog compiler loading', () => {
	it('loads the TypeScript compiler only when catalog preparation is requested', async () => {
		const compilerModuleFactory = vi.fn(() => ({
			compileCatalogTypescriptModules: vi.fn(async () => emptyCompiledBundle()),
			fingerprintCatalogTypescriptInput: vi.fn(() => definitionFingerprint),
		}));
		vi.resetModules();
		vi.doMock('@agent-vm/mcp-portal/catalog-typescript', compilerModuleFactory);

		const { createPreparedCatalogSourceCache } = await import('../index.js');
		const cache = createPreparedCatalogSourceCache();

		expect(compilerModuleFactory).not.toHaveBeenCalled();

		const prepared = await cache.prepare({
			authority: {
				activeRevision: 'active-1',
				catalogRevision: 'catalog-1',
				connectionId: 'connection-1',
				gatewayEpoch: 'gateway-1',
				profileAssignmentRevision: 'assignment-1',
				profileId: 'profile-1',
				profilePolicyRevision: 'policy-1',
				providerRevision: 'provider-1',
				schemaRevision: 'schema-1',
				stablePrincipal: 'principal-1',
			},
			input: { tools: [] },
		});

		expect(prepared.kind).toBe('complete');
		expect(compilerModuleFactory).toHaveBeenCalledOnce();
	});
});
