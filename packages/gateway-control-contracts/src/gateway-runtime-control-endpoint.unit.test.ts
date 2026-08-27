import { describe, expect, it } from 'vitest';

import {
	GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_GUEST_PORT,
	GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_LISTEN_HOST,
	GATEWAY_RUNTIME_TOOL_PORTAL_PRODUCTION_CONTROL_ENDPOINT,
	GatewayRuntimeToolPortalProductionControlEndpointSchema,
} from './index.js';

describe('Gateway runtime Tool Portal production control endpoint contract', () => {
	it('publishes the immutable production loopback endpoint', () => {
		// Arrange / Act
		const parsed = GatewayRuntimeToolPortalProductionControlEndpointSchema.parse(
			GATEWAY_RUNTIME_TOOL_PORTAL_PRODUCTION_CONTROL_ENDPOINT,
		);

		// Assert
		expect(parsed).toEqual({ host: '127.0.0.1', port: 18_790 });
		expect(GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_LISTEN_HOST).toBe('127.0.0.1');
		expect(GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_GUEST_PORT).toBe(18_790);
		expect(Object.isFrozen(GATEWAY_RUNTIME_TOOL_PORTAL_PRODUCTION_CONTROL_ENDPOINT)).toBe(true);
	});

	it.each([
		['ephemeral port', { host: '127.0.0.1', port: 0 }],
		['Hermes guest port', { host: '127.0.0.1', port: 18_789 }],
		['Tool VM pool port', { host: '127.0.0.1', port: 19_001 }],
		['wildcard host', { host: '0.0.0.0', port: 18_790 }],
		['IPv6 loopback host', { host: '::1', port: 18_790 }],
		['unknown field', { host: '127.0.0.1', port: 18_790, path: '/ready' }],
		['missing host', { port: 18_790 }],
		['missing port', { host: '127.0.0.1' }],
	])('rejects %s', (_caseName, invalidEndpoint) => {
		// Arrange / Act
		const result =
			GatewayRuntimeToolPortalProductionControlEndpointSchema.safeParse(invalidEndpoint);

		// Assert
		expect(result.success).toBe(false);
	});

	it('rejects mutation of the exported production endpoint', () => {
		// Arrange / Act / Assert
		expect(() =>
			Object.assign(GATEWAY_RUNTIME_TOOL_PORTAL_PRODUCTION_CONTROL_ENDPOINT, { port: 19_001 }),
		).toThrow(TypeError);
		expect(GATEWAY_RUNTIME_TOOL_PORTAL_PRODUCTION_CONTROL_ENDPOINT).toEqual({
			host: '127.0.0.1',
			port: 18_790,
		});
	});
});
