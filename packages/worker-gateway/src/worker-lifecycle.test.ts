import type { GatewayZoneConfig } from 'gateway-interface';
import { describe, expect, it } from 'vitest';

import { workerLifecycle } from './worker-lifecycle.js';

const zone: GatewayZoneConfig = {
	allowedHosts: ['api.openai.com'],
	gateway: {
		cpus: 2,
		gatewayConfig: '/host/config/shravan/coding.json',
		memory: '2G',
		port: 18791,
		stateDir: '/host/state/shravan',
		type: 'coding',
		workspaceDir: '/host/workspaces/shravan',
	},
	id: 'shravan',
	secrets: {
		OPENAI_API_KEY: {
			injection: 'env',
			ref: 'op://vault/item/openai',
			source: '1password',
		},
	},
	toolProfile: 'standard',
	websocketBypass: [],
};

describe('workerLifecycle', () => {
	it('builds a worker VM spec with /state and /workspace mounts', () => {
		const vmSpec = workerLifecycle.buildVmSpec(zone, { OPENAI_API_KEY: 'openai-token' }, 18800, {
			basePort: 19000,
			size: 5,
		});

		expect(vmSpec.vfsMounts['/state']).toEqual({
			hostPath: '/host/state/shravan',
			kind: 'realfs',
		});
		expect(vmSpec.vfsMounts['/workspace']).toEqual({
			hostPath: '/host/workspaces/shravan',
			kind: 'realfs',
		});
		expect(vmSpec.environment.OPENAI_API_KEY).toBe('openai-token');
		expect(vmSpec.tcpHosts['controller.vm.host:18800']).toBe('127.0.0.1:18800');
	});

	it('throws clearly until agent-vm-worker exists', () => {
		expect(() =>
			workerLifecycle.buildProcessSpec(zone, {
				OPENAI_API_KEY: 'openai-token',
			}),
		).toThrow(/agent-vm-worker/u);
	});
});
