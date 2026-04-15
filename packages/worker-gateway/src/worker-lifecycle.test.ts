import type { GatewayZoneConfig } from '@shravansunder/gateway-interface';
import { describe, expect, it } from 'vitest';

import { workerLifecycle } from './worker-lifecycle.js';

const zone: GatewayZoneConfig = {
	allowedHosts: ['api.openai.com'],
	gateway: {
		cpus: 2,
		gatewayConfig: '/host/config/shravan/worker.json',
		memory: '2G',
		port: 18791,
		stateDir: '/host/state/shravan',
		type: 'worker',
		workspaceDir: '/host/workspaces/shravan',
	},
	id: 'shravan',
	secrets: {
		OPENAI_API_KEY: {
			injection: 'env',
			source: '1password',
			ref: 'op://vault/item/openai',
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
		const vmSpec = workerLifecycle.buildVmSpec({
			controllerPort: 18800,
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: { OPENAI_API_KEY: 'openai-token' },
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone,
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
		expect(vmSpec.sessionLabel).toBe('claw-tests-a1b2c3d4:shravan:gateway');
		expect(vmSpec.tcpHosts['controller.vm.host:18800']).toBe('127.0.0.1:18800');
	});

	it('builds a process spec that starts the worker HTTP server', () => {
		const processSpec = workerLifecycle.buildProcessSpec(zone, {
			OPENAI_API_KEY: 'openai-token',
		});

		expect(processSpec.bootstrapCommand).toContain('npm install -g @openai/codex');
		expect(processSpec.bootstrapCommand).toContain('/state/agent-vm-worker.tgz');
		expect(processSpec.startCommand).toContain('agent-vm-worker');
		expect(processSpec.startCommand).toContain('serve --port 18789');
		expect(processSpec.healthCheck).toEqual({ type: 'http', port: 18789, path: '/health' });
		expect(processSpec.guestListenPort).toBe(18789);
		expect(processSpec.logPath).toBe('/tmp/agent-vm-worker.log');
	});
});
