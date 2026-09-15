import { describe, expect, it } from 'vitest';

import {
	classifyLocalToolPortalSocketFailure,
	createLocalToolPortalTransport,
} from './local-transport.js';

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
	it.each(['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EACCES', 'ETIMEDOUT', 'ENAMETOOLONG'])(
		'retains allowlisted socket failure code %s without exposing raw error data',
		(code) => {
			const sensitiveCanary = 'private-socket-path-and-provider-data';
			expect(
				classifyLocalToolPortalSocketFailure({
					code,
					message: sensitiveCanary,
					path: sensitiveCanary,
				}),
			).toBe(code);
			expect(
				classifyLocalToolPortalSocketFailure({
					code: `SECRET_${sensitiveCanary}`,
					message: sensitiveCanary,
				}),
			).toBe('other');
		},
	);
});
