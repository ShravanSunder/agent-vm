import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntimeCatalogProjectionOperations } from '../tool-portal-projections.js';
import {
	createGatewayRuntimePrivateUdsDispatcher,
	type GatewayRuntimePrivateUdsDispatcher,
} from './gateway-runtime-private-uds-dispatcher.js';

const trustedContext = {
	correlation: { sessionId: 'session-1', turnId: 'turn-1' },
	principal: {
		agentId: 'agent-1',
		frameworkIdentity: { kind: 'hermes' as const, profileName: 'main' },
		profileAssignmentRevision: 'assignment-1',
		toolPortalProfileId: 'profile-1',
	},
};

function createDispatcher(
	catalogOperations: GatewayRuntimeCatalogProjectionOperations,
): GatewayRuntimePrivateUdsDispatcher {
	return createGatewayRuntimePrivateUdsDispatcher({
		approvalOperations: { decide: vi.fn() },
		artifactOperations: { read: vi.fn() },
		catalogOperations,
		portalOperations: { call: vi.fn(), describe: vi.fn(), list: vi.fn(), search: vi.fn() },
		sandboxDispatch: vi.fn(),
	});
}

describe('gateway runtime private UDS catalog dispatch', () => {
	it('validates and dispatches all catalog methods with connection, signal, and trusted context', async () => {
		const catalogOperations = {
			offer: vi.fn(async () => ({
				kind: 'unavailable' as const,
				reason: 'catalog-source-unavailable' as const,
			})),
			prepare: vi.fn(async () => ({
				diagnostics: [],
				kind: 'incomplete' as const,
				reason: 'catalog-incomplete' as const,
			})),
			read: vi.fn(async () => ({
				kind: 'unavailable' as const,
				reason: 'catalog-source-unavailable' as const,
			})),
			release: vi.fn(async () => ({ kind: 'released' as const })),
		};
		const dispatcher = createDispatcher(catalogOperations);
		const signal = new AbortController().signal;
		const fingerprint = 'a'.repeat(64);
		await Promise.all(
			(
				[
					['portal.catalog.prepare', {}],
					['portal.catalog.offer', { definitionFingerprint: fingerprint }],
					[
						'portal.catalog.read',
						{
							definitionFingerprint: fingerprint,
							length: 64 * 1_024,
							offerId: 'offer-1',
							offset: 0,
						},
					],
					['portal.catalog.release', { definitionFingerprint: fingerprint, offerId: 'offer-1' }],
				] as const
			).map(
				async ([method, publicRequest]) =>
					await dispatcher.dispatch({
						connectionId: 'connection-1',
						method,
						params: { publicRequest, trustedContext },
						signal,
					}),
			),
		);
		for (const operation of Object.values(catalogOperations)) {
			expect(operation).toHaveBeenCalledWith(
				expect.objectContaining({ connectionId: 'connection-1', signal, trustedContext }),
			);
		}
	});

	it('rejects oversized reads before catalog authority is consulted', async () => {
		const catalogOperations = { offer: vi.fn(), prepare: vi.fn(), read: vi.fn(), release: vi.fn() };
		const dispatcher = createDispatcher(catalogOperations);
		await expect(
			dispatcher.dispatch({
				connectionId: 'connection-1',
				method: 'portal.catalog.read',
				params: {
					publicRequest: {
						definitionFingerprint: 'a'.repeat(64),
						length: 64 * 1_024 + 1,
						offerId: 'offer-1',
						offset: 0,
					},
					trustedContext,
				},
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'invalid-request' });
		expect(catalogOperations.read).not.toHaveBeenCalled();
	});
});
