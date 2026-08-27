import { describe, expect, it } from 'vitest';

import {
	gatewayEpochIdentitySchema,
	gatewayEpochSeedSchema,
	gatewayIdentitiesEqual,
	gatewaySeedsEqual,
} from './vm-ownership-contracts.js';

describe('controller-owned VM membership contracts', () => {
	it('builds a full Gateway identity by adding only the stock Gondolin VM id to its seed', () => {
		const seed = gatewayEpochSeedSchema.parse({
			bootId: 'boot-1',
			controllerEpoch: 'controller-1',
			gatewayEpochId: 'gateway-epoch-1',
			generationId: 'generation-1',
			zoneId: 'hermes',
		});
		const identity = gatewayEpochIdentitySchema.parse({ ...seed, gatewayVmId: 'gateway-vm-1' });

		expect(gatewaySeedsEqual(seed, identity)).toBe(true);
		expect(gatewayIdentitiesEqual(identity, { ...identity })).toBe(true);
		expect(gatewayIdentitiesEqual(identity, { ...identity, gatewayVmId: 'gateway-vm-2' })).toBe(
			false,
		);
	});

	it('rejects unknown durable or dependency-private identity fields', () => {
		expect(
			gatewayEpochSeedSchema.safeParse({
				bootId: 'boot-1',
				controllerEpoch: 'controller-1',
				gatewayEpochId: 'gateway-epoch-1',
				generationId: 'generation-1',
				dependencyPrivatePath: '/private/dependency/state',
				zoneId: 'hermes',
			}).success,
		).toBe(false);
	});
});
