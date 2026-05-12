import { describe, expect, it } from 'vitest';

import {
	hashPortalApprovalCalls,
	InMemoryPortalApprovalBridge,
	normalizePortalApprovalArguments,
} from './portal-approval-bridge.js';

describe('portal approval bridge', () => {
	it('scopes grants to the server-injected approval nonce', () => {
		const bridge = new InMemoryPortalApprovalBridge();
		const grant = {
			approvalNonce: 'nonce-a',
			bindingId: 'binding-a',
			callsHash: 'hash',
		};

		bridge.grant(grant);

		expect(bridge.consume({ ...grant, approvalNonce: 'nonce-b' })).toBe(false);
		expect(bridge.consume(grant)).toBe(true);
		expect(bridge.consume(grant)).toBe(false);
	});

	it('binds consumed approval nonces to transport session cleanup for allow-always', () => {
		const bridge = new InMemoryPortalApprovalBridge();
		const oneTimeGrant = {
			approvalNonce: 'nonce-a',
			bindingId: 'binding-a',
			callsHash: 'hash',
		};
		const persistentGrant = {
			bindingId: 'binding-a',
			callsHash: 'hash',
			sessionId: 'hook-session-a',
		};

		bridge.grantAlways(persistentGrant);
		bridge.grant(oneTimeGrant, {
			clearPersistentSessionOnConsume: {
				bindingId: 'binding-a',
				sessionId: 'hook-session-a',
			},
		});
		const consumeResult = bridge.consumeGrant(oneTimeGrant);
		if (!consumeResult.ok) {
			throw new Error('expected approval grant to be consumed');
		}
		const persistentSessionId = consumeResult.clearPersistentSessionOnConsume?.sessionId;
		if (persistentSessionId === undefined) {
			throw new Error('expected approval grant to carry persistent session cleanup');
		}
		bridge.bindTransportSessionToPersistentSession({
			bindingId: 'binding-a',
			persistentSessionId,
			transportSessionId: 'mcp-transport-session-a',
		});

		expect(bridge.hasAlways(persistentGrant)).toBe(true);

		bridge.clearTransportSession('binding-a', 'mcp-transport-session-a');

		expect(bridge.hasAlways(persistentGrant)).toBe(false);
	});

	it('keeps allow-always grants reusable until their binding or session is cleared', () => {
		const bridge = new InMemoryPortalApprovalBridge();
		const bindingGrant = {
			bindingId: 'binding-a',
			callsHash: 'hash',
		};
		const sessionGrant = {
			bindingId: 'binding-a',
			callsHash: 'hash',
			sessionId: 'session-a',
		};

		bridge.grantAlways(bindingGrant);
		bridge.grantAlways(sessionGrant);

		expect(bridge.hasAlways(bindingGrant)).toBe(true);
		expect(bridge.hasAlways(bindingGrant)).toBe(true);
		expect(bridge.hasAlways(sessionGrant)).toBe(true);

		bridge.clearSession('binding-a', 'session-a');

		expect(bridge.hasAlways(bindingGrant)).toBe(true);
		expect(bridge.hasAlways(sessionGrant)).toBe(false);

		bridge.clearBinding('binding-a');

		expect(bridge.hasAlways(bindingGrant)).toBe(false);
	});

	it('hashes normalized approval calls as a stable batch', () => {
		expect(
			hashPortalApprovalCalls([
				{
					arguments: { title: 'Ship portal' },
					id: 'create',
					namespace: 'linear',
					toolName: 'create_issue',
				},
			]),
		).toBe(
			hashPortalApprovalCalls([
				{
					arguments: { title: 'Ship portal' },
					id: 'create',
					namespace: 'linear',
					toolName: 'create_issue',
				},
			]),
		);
	});

	it('hashes approval calls by semantic tool arguments rather than caller ids', () => {
		const firstHash = hashPortalApprovalCalls([
			{
				arguments: { title: 'Ship portal' },
				id: 'first-id',
				namespace: 'linear',
				toolName: 'create_issue',
			},
		]);
		const secondHash = hashPortalApprovalCalls([
			{
				arguments: { title: 'Ship portal' },
				id: 'second-id',
				namespace: 'linear',
				toolName: 'create_issue',
			},
		]);

		expect(firstHash).toBe(secondHash);
	});

	it('normalizes approval arguments with JSON Schema defaults before hashing', () => {
		const normalized = normalizePortalApprovalArguments(
			{
				inputSchema: {
					properties: {
						priority: { default: 'medium', type: 'string' },
						title: { type: 'string' },
					},
					required: ['title'],
					type: 'object',
				},
				namespace: 'linear',
				toolName: 'create_issue',
			},
			{ title: 'Ship portal' },
		);

		expect(normalized).toEqual({ priority: 'medium', title: 'Ship portal' });
	});
});
