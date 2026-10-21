import { createNodeToolPortalMcpTransport } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport';
import { expect, it } from 'vitest';

import { startControlledProvider } from '#node-host/test-fixtures/node-host-fixture';
import { createNodeToolPortalMcpTransport as createOldTransport } from '#node-host/test-fixtures/old-node-tool-portal-mcp-transport';

it('the Portal SDK modern pin refuses an old-only real server without initialize or legacy SSE fallback', async () => {
	const provider = await startControlledProvider('old-only');
	const current = createNodeToolPortalMcpTransport({
		kind: 'http',
		endpoint: new URL(provider.url),
		authorization: 'fixture',
	});
	const old = createOldTransport({
		kind: 'http',
		endpoint: new URL(provider.url),
		authorization: 'fixture',
	});
	try {
		await expect(current.connect()).rejects.toThrow();
		expect(provider.httpMethods).toEqual(['server/discover']);
		expect(provider.protocolMessages).not.toContain('initialize');
		expect(provider.legacySseRequests).toBe(0);
		expect(provider.listings).toHaveLength(0);
		expect(provider.effects).toHaveLength(0);
		// Positive control: this same server really accepts legacy initialization.
		await old.connect();
		expect(provider.protocolMessages).toContain('initialize');
	} finally {
		await Promise.all([current.close(), old.close()]);
		await provider.close();
	}
});
