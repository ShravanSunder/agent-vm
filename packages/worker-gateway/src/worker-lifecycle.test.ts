import type { GatewayZoneConfig } from '@agent-vm/gateway-interface';
import { describe, expect, it } from 'vitest';

import { workerLifecycle } from './worker-lifecycle.js';

const zone: GatewayZoneConfig = {
	allowedHosts: ['api.openai.com'],
	gateway: {
		cpus: 2,
		config: '/host/config/shravan/worker.json',
		memory: '2G',
		port: 18791,
		stateDir: '/host/state/shravan',
		type: 'worker',
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

	it('builds a worker VM spec with /state mounted and /work on rootfs', () => {
		const vmSpec = workerLifecycle.buildVmSpec({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
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
		expect(vmSpec.vfsMounts['/workspace']).toBeUndefined();
		expect(vmSpec.environment.OPENAI_API_KEY).toBe('openai-token');
		expect(vmSpec.environment.AGENT_VM_ZONE_ID).toBe('shravan');
		expect(vmSpec.environment.CONTROLLER_BASE_URL).toBe('http://controller.vm.host:18800');
		expect(vmSpec.environment.WORKER_CONFIG_PATH).toBe('/state/effective-worker.json');
		expect(vmSpec.environment.WORK_DIR).toBe('/work');
		expect(vmSpec.environment.REPOS_DIR).toBe('/work/repos');
		expect(vmSpec.environment.TMPDIR).toBe('/work/tmp');
		expect(vmSpec.environment.npm_config_cache).toBe('/work/cache/npm');
		expect(vmSpec.sessionLabel).toBe('claw-tests-a1b2c3d4:shravan:gateway');
		expect(vmSpec.tcpHosts['controller.vm.host:18800']).toBe('127.0.0.1:18800');
	});

	it('builds a process spec that starts the worker HTTP server', () => {
		const processSpec = workerLifecycle.buildProcessSpec(zone, {
			OPENAI_API_KEY: 'openai-token',
		});

		expect(processSpec.bootstrapCommand).toContain('npm install -g --force @openai/codex');
		expect(processSpec.bootstrapCommand).toContain('mkdir -p /work/repos /work/tmp');
		expect(processSpec.bootstrapCommand).toContain('/state/agent-vm-worker.tgz');
		expect(processSpec.startCommand).toContain('agent-vm-worker');
		expect(processSpec.startCommand).toContain('cd /work');
		expect(processSpec.startCommand).toContain('serve --port 18789');
		expect(processSpec.healthCheck).toEqual({ type: 'http', port: 18789, path: '/health' });
		expect(processSpec.guestListenPort).toBe(18789);
		expect(processSpec.logPath).toBe('/tmp/agent-vm-worker.log');
	});
});
