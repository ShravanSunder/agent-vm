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
	it('does not support interactive auth', () => {
		expect(workerLifecycle.authConfig).toBeUndefined();
	});

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
		expect(vmSpec.environment.WORKER_CONFIG_PATH).toBe('/state/effective-worker.json');
		expect(vmSpec.environment.WORKSPACE_DIR).toBe('/workspace');
		expect(vmSpec.tcpHosts['controller.vm.host:18800']).toBe('127.0.0.1:18800');
	});

	it('builds a concrete worker process spec', () => {
		const processSpec = workerLifecycle.buildProcessSpec(zone, {
			OPENAI_API_KEY: 'openai-token',
		});

		expect(processSpec.bootstrapCommand).toBe('true');
		expect(processSpec.startCommand).toContain('/opt/agent-vm-worker/dist/main.js');
		expect(processSpec.startCommand).toContain('serve --port 18789');
		expect(processSpec.healthCheck).toEqual({ type: 'http', port: 18789, path: '/health' });
		expect(processSpec.logPath).toBe('/tmp/agent-vm-worker.log');
	});
});
