import { describe, it, vi, expect } from 'vitest';

import { PortalCatalogPreparationError } from '#mcp-gateway/agent-catalog-views/agent-catalog-view-cache';
import {
	retainCatalog,
	createHarness,
	frozenNames,
	identities,
	output,
	callInput,
} from '#mcp-gateway/test-fixtures/mcp-gateway-harness';

describe('portable MCP gateway through the neutral dispatcher', () => {
	it.each(['prepare', 'list'] as const)(
		'refuses incomplete full catalog discovery through %s before publication',
		async (path) => {
			const publisher = vi.fn(retainCatalog);
			const harness = createHarness(undefined, 'incomplete');
			harness.setPrepared(publisher);
			const preparation =
				path === 'prepare' ? harness.gateway.prepareCatalog() : harness.gateway.listTools('direct');
			await expect(preparation).rejects.toThrowError(
				new PortalCatalogPreparationError([
					{
						namespace: 'beta',
						kind: 'upstream_discovery_failed',
						message: 'beta discovery unavailable',
					},
				]),
			);
			await expect(preparation).rejects.toMatchObject({
				name: 'PortalCatalogPreparationError',
				failedNamespaces: ['beta'],
				message:
					'MCP Portal catalog preparation failed for namespace(s): beta. Run live MCP validation or use indirect mode for partial discovery diagnostics.',
			});
			expect(publisher).not.toHaveBeenCalled();
		},
	);

	it.each(['prepare', 'list'] as const)(
		'refuses duplicate exported full catalog names through %s before publication',
		async (path) => {
			const harness = createHarness(undefined, 'duplicate');
			const publisher = vi.fn(retainCatalog);
			harness.setPrepared(publisher);
			const preparation =
				path === 'prepare' ? harness.gateway.prepareCatalog() : harness.gateway.listTools('direct');
			await expect(preparation).rejects.toBeInstanceOf(PortalCatalogPreparationError);
			await expect(preparation).rejects.toMatchObject({
				name: 'PortalCatalogPreparationError',
				failedNamespaces: ['alpha'],
				message:
					'MCP Portal catalog preparation failed for namespace(s): alpha. Run live MCP validation or use indirect mode for partial discovery diagnostics.',
			});
			expect(publisher).not.toHaveBeenCalled();
		},
	);

	it('publishes a complete allowed full catalog', async () => {
		const harness = createHarness();
		const publisher = vi.fn(retainCatalog);
		harness.setPrepared(publisher);
		expect((await harness.gateway.listTools('direct')).tools.map((tool) => tool.name)).toEqual([
			...frozenNames,
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		expect(publisher).toHaveBeenCalledOnce();
	});

	it('keeps healthy compact discovery, describe and calls available with failure diagnostics', async () => {
		const harness = createHarness(undefined, 'incomplete');
		const publisher = vi.fn(retainCatalog);
		harness.setPrepared(publisher);
		const listed = await harness.gateway.list({ requests: [{ id: 'r' }] });
		expect(identities(output(listed, 'r'))).toEqual(['alpha.ask', 'alpha.read']);
		const described = await harness.gateway.describe({
			requests: [{ id: 'r', tools: [{ namespace: 'alpha', toolName: 'read' }] }],
		});
		expect(identities(output(described, 'r'))).toEqual(['alpha.read']);
		const called = await harness.gateway.call(callInput());
		expect(called.results['original-item']?.ok).toBe(true);
		expect(harness.effects).toHaveLength(1);
		for (const result of [listed, described, called]) {
			expect(result.diagnostics).toMatchObject([
				{ kind: 'upstream_discovery_failed', namespace: 'beta' },
			]);
		}
		expect((await harness.gateway.listTools('indirect')).tools.map((tool) => tool.name)).toEqual([
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		expect(publisher).not.toHaveBeenCalled();
	});

	it('keeps the same literal allowed corpus across list, search, describe and native catalog', async () => {
		const { gateway } = createHarness();
		expect(identities(output(await gateway.list({ requests: [{ id: 'r' }] }), 'r'))).toEqual([
			'alpha.ask',
			'alpha.read',
			'beta.ask',
			'beta.read',
		]);
		expect(
			identities(output(await gateway.search({ requests: [{ id: 'r', query: 'read' }] }), 'r')),
		).toEqual(['alpha.read', 'beta.read']);
		const catalog = await gateway.prepareCatalog();
		expect(catalog.tools.map((tool) => tool.descriptor.name)).toEqual(frozenNames);
		expect((await gateway.listTools('direct')).tools.map((tool) => tool.name)).toEqual([
			...frozenNames,
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		expect((await gateway.listTools('indirect')).tools.map((tool) => tool.name)).toEqual([
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		expect((await gateway.listTools('indirect')).tools[0]?.description).toBe(
			'List authorized MCP namespaces and compact tool summaries. Allowed namespaces for this agent: alpha, beta.',
		);
		expect(
			identities(
				output(
					await gateway.describe({ requests: [{ id: 'r', refs: ['mcp:YWxwaGE:cmVhZA'] }] }),
					'r',
				),
			),
		).toEqual(['alpha.read']);
	});

	it('keeps configured skill search hints while filtering hidden references', async () => {
		const h = createHarness();
		expect(
			identities(
				output(
					await h.gateway.search({ requests: [{ id: 'r', query: 'workflow-only-marker' }] }),
					'r',
				),
			),
		).toEqual(['alpha.read']);
		h.setDenyRead();
		expect(
			identities(
				output(
					await h.gateway.search({ requests: [{ id: 'r', query: 'workflow-only-marker' }] }),
					'r',
				),
			),
		).toEqual([]);
	});
});
