import { describe, expect, it } from 'vitest';

import { mapSystemGatewayZoneToLifecycleZone, type GatewayZone } from './gateway-zone-support.js';

function createGatewayZone(ingress?: GatewayZone['gateway']['ingress']): GatewayZone {
	return {
		id: 'shravan',
		gateway: {
			type: 'openclaw',
			imageProfile: 'openclaw',
			memory: '2G',
			cpus: 2,
			port: 18791,
			config: './gateways/shravan/openclaw.json',
			...(ingress === undefined ? {} : { ingress }),
			stateDir: './state/shravan',
			zoneFilesDir: './zone-files/shravan',
		},
		secrets: {},
		egressHosts: [],
		defaultToolVmProfile: 'standard',
		agentToolVmProfiles: {},
		websocketBypass: [],
	};
}

describe('mapSystemGatewayZoneToLifecycleZone', () => {
	it('omits ingress when no gateway ingress timeouts are configured', () => {
		const lifecycleZone = mapSystemGatewayZoneToLifecycleZone(createGatewayZone());

		expect(lifecycleZone.gateway).not.toHaveProperty('ingress');
	});

	it('preserves only configured gateway ingress timeout fields', () => {
		const lifecycleZone = mapSystemGatewayZoneToLifecycleZone(
			createGatewayZone({ upstreamResponseTimeoutMs: 120_000 }),
		);

		expect(lifecycleZone.gateway).toMatchObject({
			ingress: { upstreamResponseTimeoutMs: 120_000 },
		});
		expect(lifecycleZone.gateway.ingress).not.toHaveProperty('upstreamHeaderTimeoutMs');
	});
});
