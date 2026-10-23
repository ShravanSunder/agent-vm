import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceToolCatalog } from '#mcp-gateway/agent-catalog-views/workspace-tool-catalog';

function fixture(): {
	readonly catalog: ReturnType<typeof createWorkspaceToolCatalog>;
	readonly calls: string[];
	readonly close: ReturnType<typeof vi.fn>;
	readonly fail: Set<string>;
	readonly advance: (amount: number) => void;
} {
	let now = 1000;
	const calls: string[] = [];
	const fail = new Set<string>();
	const close = vi.fn();
	const catalog = createWorkspaceToolCatalog({
		namespaces: ['alpha', 'beta', 'gamma'],
		discoveryScope: 'organization',
		catalogTtlMs: 60000,
		now: () => now,
		runtime: {
			closeAgentScope: close,
			listTools: async ({ namespace }) => {
				calls.push(namespace);
				if (fail.has(namespace)) throw new Error('provider unavailable');
				return [{ name: `${namespace}-${calls.length}`, inputSchema: { type: 'object' } }];
			},
		},
	});
	return {
		catalog,
		calls,
		close,
		fail,
		advance: (amount) => {
			now += amount;
		},
	};
}

describe('organization catalog lifecycle', () => {
	it('keeps healthy startup tools and retries only failed namespaces on the next read', async () => {
		const { catalog, fail, calls, close } = fixture();
		fail.add('gamma');
		const initial = await catalog.read();
		expect([...initial.toolsByNamespace.keys()]).toEqual(['alpha', 'beta']);
		expect(initial.discoveryFailures).toMatchObject([{ namespace: 'gamma' }]);
		fail.clear();
		const recovered = await catalog.read();
		expect([...recovered.toolsByNamespace.keys()]).toEqual(['alpha', 'beta', 'gamma']);
		expect(recovered.discoveryFailures).toEqual([]);
		expect(calls).toEqual(['alpha', 'beta', 'gamma', 'gamma']);
		await catalog.read();
		expect(calls).toHaveLength(4);
		expect(close).toHaveBeenCalledTimes(2);
	});
	it('refreshes a complete catalog on access at 60000ms, retaining the full old snapshot on failure', async () => {
		const { catalog, advance, fail, calls } = fixture();
		const complete = await catalog.read();
		advance(59999);
		expect(await catalog.read()).toEqual(complete);
		expect(calls).toHaveLength(3);
		fail.add('gamma');
		advance(1);
		const stale = await catalog.read();
		expect(stale.toolsByNamespace).toEqual(complete.toolsByNamespace);
		expect(stale.discoveryFailures).toMatchObject([{ namespace: 'gamma' }]);
		expect(calls).toEqual(['alpha', 'beta', 'gamma', 'alpha', 'beta', 'gamma']);
		fail.clear();
		const recovered = await catalog.read();
		expect(recovered.discoveryFailures).toEqual([]);
		expect(recovered.toolsByNamespace.get('alpha')).not.toEqual(
			complete.toolsByNamespace.get('alpha'),
		);
		expect(calls).toEqual(['alpha', 'beta', 'gamma', 'alpha', 'beta', 'gamma', 'gamma']);
	});
	it('coalesces concurrent discovery and refresh requests without background work', async () => {
		const { catalog, calls, advance } = fixture();
		const first = await Promise.all([catalog.read(), catalog.read(), catalog.read()]);
		expect(first[0]).toEqual(first[1]);
		expect(calls).toHaveLength(3);
		advance(60000);
		await Promise.all([catalog.read(), catalog.read()]);
		expect(calls).toHaveLength(6);
	});
});
