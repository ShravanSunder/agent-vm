import { describe, expect, expectTypeOf, it } from 'vitest';

import { gatewayTypeValues, type GatewayType } from './gateway-runtime-contract.js';

describe('gateway type registry', () => {
	it('covers every configured gateway type exactly once', () => {
		const exhaustiveGatewayTypeRegistry = {
			hermes: true,
			worker: true,
		} satisfies Record<GatewayType, true>;

		expect(gatewayTypeValues).toEqual(Object.keys(exhaustiveGatewayTypeRegistry));
		expect(new Set(gatewayTypeValues).size).toBe(gatewayTypeValues.length);
		expectTypeOf(gatewayTypeValues).toEqualTypeOf<readonly ['hermes', 'worker']>();
	});
});
