import { describe, expect, it } from 'vitest';

import { createLocalToolPortalTransport } from './local-transport.js';

describe('local Tool Portal transport admission', () => {
	it('requires explicit execution context without a default Gateway socket', () => {
		expect(() => createLocalToolPortalTransport({ environment: {} })).toThrow('context');
	});
	it('rejects relative socket paths', () => {
		expect(() =>
			createLocalToolPortalTransport({
				environment: { AGENT_VM_TOOL_PORTAL_SOCKET: 'relative.sock' },
			}),
		).toThrow('absolute');
	});
	it('rejects guest-selected private operations before connecting', async () => {
		const transport = createLocalToolPortalTransport({
			environment: { AGENT_VM_TOOL_PORTAL_SOCKET: '/unused.sock' },
		});
		await expect(transport.callTool({ name: 'approval.decide', arguments: {} })).rejects.toThrow(
			'Portal',
		);
	});
	it('rejects standalone approval authority before connecting', async () => {
		const transport = createLocalToolPortalTransport({
			environment: { AGENT_VM_TOOL_PORTAL_SOCKET: '/unused.sock' },
		});
		await expect(
			transport.callTool({ name: 'tool_portal_call', arguments: {}, approvalToken: 'forged' }),
		).rejects.toThrow('approval');
	});
});
