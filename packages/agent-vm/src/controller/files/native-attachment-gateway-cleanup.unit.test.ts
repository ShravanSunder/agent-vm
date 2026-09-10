import { describe, expect, it, vi } from 'vitest';

import type { GatewayZoneDestroyResult } from '../../gateway/gateway-zone-support.js';
import { createNativeAttachmentGatewayDestroy } from './native-attachment-gateway-cleanup.js';

describe('native staging accounting at existing Gateway destruction', () => {
	it('reports host cleanup debt separately from successful VM destruction', async () => {
		// Arrange
		const error = new Error('Host directory deletion failed.');
		const destroy = createNativeAttachmentGatewayDestroy({
			gateway: {
				gatewayIdentity: { zoneId: 'zone', gatewayVmId: 'vm' },
				destroyGateway: async () => ({ kind: 'destroyed-clean' }),
			},
			staging: {
				releaseGatewayAfterContainment: async () => {
					throw error;
				},
			},
		});
		// Act / Assert
		expect(await destroy()).toEqual({
			kind: 'destroyed-cleanup-incomplete',
			cleanupFailures: [{ stage: 'native-attachment-cleanup', error }],
		});
	});
	it.each(['destroyed-clean', 'destroyed-cleanup-incomplete'] as const)(
		'releases rootfs reservations only after %s proves exact destruction',
		async (kind) => {
			// Arrange
			const destruction = Promise.withResolvers<GatewayZoneDestroyResult>();
			const releaseGatewayAfterContainment = vi.fn();
			const destroyGateway = vi.fn(() => destruction.promise);
			const destroy = createNativeAttachmentGatewayDestroy({
				gateway: { destroyGateway, gatewayIdentity: { zoneId: 'zone', gatewayVmId: 'vm' } },
				staging: { releaseGatewayAfterContainment },
			});
			// Act
			const result = destroy();
			expect(releaseGatewayAfterContainment).not.toHaveBeenCalled();
			const outcome: GatewayZoneDestroyResult =
				kind === 'destroyed-clean'
					? { kind }
					: {
							kind,
							cleanupFailures: [
								{ stage: 'control-session-disposal', error: new Error('cleanup pending') },
							],
						};
			destruction.resolve(outcome);
			// Assert
			expect(await result).toBe(outcome);
			expect(destroyGateway).toHaveBeenCalledOnce();
			expect(releaseGatewayAfterContainment).toHaveBeenCalledExactlyOnceWith({
				zoneId: 'zone',
				gatewayVmId: 'vm',
			});
		},
	);

	it('retains quota when exact destruction is unproven', async () => {
		// Arrange
		const failure = new Error('exact destruction unconfirmed');
		const releaseGatewayAfterContainment = vi.fn();
		const destroy = createNativeAttachmentGatewayDestroy({
			gateway: {
				gatewayIdentity: { zoneId: 'zone', gatewayVmId: 'vm' },
				destroyGateway: async () => {
					throw failure;
				},
			},
			staging: { releaseGatewayAfterContainment },
		});
		// Act / Assert
		await expect(destroy()).rejects.toBe(failure);
		expect(releaseGatewayAfterContainment).not.toHaveBeenCalled();
	});
});
