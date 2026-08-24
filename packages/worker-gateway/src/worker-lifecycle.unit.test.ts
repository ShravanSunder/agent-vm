import type { GatewayZoneConfig } from '@agent-vm/gateway-lifecycle';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { workerLifecycle } from './worker-lifecycle.js';

const zone: GatewayZoneConfig = {
	egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
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
			audience: 'gateway',
			source: '1password',
			ref: 'op://vault/item/openai',
		},
	},
};

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('workerLifecycle', () => {
	it('retains the direct process lifecycle', () => {
		expect(workerLifecycle.executionModel).toBe('direct-process');
		expect(workerLifecycle).toEqual(
			expect.objectContaining({ buildProcessSpec: expect.any(Function) }),
		);
	});

	it('does not support interactive auth', () => {
		expect(workerLifecycle.authConfig).toBeUndefined();
	});

	it('builds a worker VM spec with /state mounted and /work on rootfs', () => {
		const vmRequirements = workerLifecycle.buildVmRequirements({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: { OPENAI_API_KEY: 'openai-token' },
			zoneRuntimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone,
		});

		expect(vmRequirements.mounts['/state']).toEqual({
			access: 'read-write',
			hostPath: '/host/state/shravan',
			kind: 'host-directory',
		});
		expect(vmRequirements.mounts['/work']).toBeUndefined();
		expect(vmRequirements.mounts['/workspace']).toBeUndefined();
		expect(vmRequirements.environment.OPENAI_API_KEY).toBe('openai-token');
		expect(vmRequirements.environment.AGENT_VM_ZONE_ID).toBe('shravan');
		expect(vmRequirements.environment.CONTROLLER_BASE_URL).toBeUndefined();
		expect(vmRequirements.environment.PNPM_HOME).toBe('/pnpm');
		expect(vmRequirements.environment.PATH).toBe(
			'/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
		);
		// IPv4-preference egress for the Node controller-client to defeat
		// Happy Eyeballs racing on gondolin's shared synthetic AAAA.
		// See FORCE_IPV4_EGRESS_NODE_OPTIONS in @agent-vm/gateway-lifecycle.
		expect(vmRequirements.environment.NODE_OPTIONS).toBe(
			'--dns-result-order=ipv4first --no-network-family-autoselection',
		);
		expect(vmRequirements.environment.WORKER_CONFIG_PATH).toBe('/state/effective-worker.json');
		expect(vmRequirements.environment.WORK_DIR).toBe('/work');
		expect(vmRequirements.environment.REPOS_DIR).toBe('/work/repos');
		expect(vmRequirements.environment.TMPDIR).toBe('/work/tmp');
		expect(vmRequirements.environment.npm_config_cache).toBe('/work/cache/npm');
		expect(vmRequirements.environment.pnpm_config_store_dir).toBe('/work/cache/pnpm/store');
		expect(vmRequirements.allowedHosts).toEqual(['api.openai.com']);
		expect(vmRequirements.allowedHosts).not.toContain('controller.vm.host');
		expect(vmRequirements.sessionLabel).toBe('claw-tests-a1b2c3d4:shravan:gateway');
		expect(vmRequirements.tcpHosts['controller.vm.host:18800']).toBeUndefined();
		expect(vmRequirements.tcpHosts).toEqual({});
	});

	it('denies Worker Git SSH reads when no trusted repo allowlist is available', async () => {
		vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent-vm-test-agent.sock');

		const vmRequirements = workerLifecycle.buildVmRequirements({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: { OPENAI_API_KEY: 'openai-token' },
			zoneRuntimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone,
		});

		expect(vmRequirements.sshEgress).toBeUndefined();
	});

	it('allows only trusted Worker Git SSH reads from prepared repos', async () => {
		vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent-vm-test-agent.sock');

		const vmRequirements = workerLifecycle.buildVmRequirements({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: { OPENAI_API_KEY: 'openai-token' },
			zoneRuntimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone: {
				...zone,
				gitReadAllowlistRepos: ['ssh://git@git.example.com/org/repo.git'],
			},
		});

		expect(vmRequirements.sshEgress).toEqual({
			agentSocket: '/tmp/agent-vm-test-agent.sock',
			allowedHosts: ['git.example.com'],
			allowedRepositories: ['org/repo'],
			kind: 'git-read-only',
		});
	});

	it('omits Worker SSH egress when no host SSH agent is available', () => {
		vi.stubEnv('SSH_AUTH_SOCK', '');

		const vmRequirements = workerLifecycle.buildVmRequirements({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: { OPENAI_API_KEY: 'openai-token' },
			zoneRuntimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone,
		});

		expect(vmRequirements.sshEgress).toBeUndefined();
	});

	it('keeps Tool VM audience secrets out of worker gateway env and mediation', () => {
		const mixedAudienceZone: GatewayZoneConfig = {
			...zone,
			egressHosts: [
				{ host: 'api.openai.com', audience: 'gateway' },
				{ host: 'api.github.com', audience: 'both' },
				{ host: 'api.linear.app', audience: 'tool-vm' },
			],
			secrets: {
				...zone.secrets,
				GITHUB_TOKEN: {
					source: 'environment',
					envVar: 'GITHUB_TOKEN',
					injection: 'http-mediation',
					audience: 'both',
					hosts: ['api.github.com'],
				},
				LINEAR_API_KEY: {
					source: 'environment',
					envVar: 'LINEAR_API_KEY',
					injection: 'http-mediation',
					audience: 'tool-vm',
					hosts: ['api.linear.app'],
				},
			},
		};

		const vmRequirements = workerLifecycle.buildVmRequirements({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: {
				OPENAI_API_KEY: 'openai-token',
				GITHUB_TOKEN: 'github-token',
				LINEAR_API_KEY: 'linear-token',
			},
			zoneRuntimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone: mixedAudienceZone,
		});

		expect(vmRequirements.environment).toEqual(
			expect.objectContaining({ OPENAI_API_KEY: 'openai-token' }),
		);
		expect(vmRequirements.environment).not.toHaveProperty('LINEAR_API_KEY');
		expect(vmRequirements.mediatedSecrets).toEqual({
			GITHUB_TOKEN: {
				hosts: ['api.github.com'],
				value: 'github-token',
			},
		});
		expect(vmRequirements.allowedHosts).toEqual(['api.openai.com', 'api.github.com']);
		expect(vmRequirements.allowedHosts).not.toContain('controller.vm.host');
	});

	it('preserves the forced IPv4-preference flags even when a zone secret supplies NODE_OPTIONS', () => {
		// Regression test for the merge-order bug surfaced in PR #93
		// review: a zone secret named NODE_OPTIONS must NOT drop our
		// forced flags, because Happy Eyeballs would race the
		// synthetic AAAA again.
		const zoneWithNodeOptionsSecret: GatewayZoneConfig = {
			...zone,
			secrets: {
				...zone.secrets,
				NODE_OPTIONS: {
					injection: 'env',
					audience: 'gateway',
					source: 'environment',
					envVar: 'NODE_OPTIONS',
				},
			},
		};

		const vmRequirements = workerLifecycle.buildVmRequirements({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: {
				OPENAI_API_KEY: 'openai-token',
				NODE_OPTIONS: '--inspect=0.0.0.0:9229',
			},
			zoneRuntimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone: zoneWithNodeOptionsSecret,
		});

		// Forced flags lead; user value follows.
		expect(vmRequirements.environment.NODE_OPTIONS).toBe(
			'--dns-result-order=ipv4first --no-network-family-autoselection --inspect=0.0.0.0:9229',
		);
	});

	it('builds a process spec that starts the worker HTTP server', () => {
		const processSpec = workerLifecycle.buildProcessSpec(zone, {
			OPENAI_API_KEY: 'openai-token',
		});

		expect(processSpec.bootstrapCommand).not.toContain('npm install -g --force @openai/codex');
		expect(processSpec.bootstrapCommand).not.toContain(' npm install');
		expect(processSpec.bootstrapCommand).toContain('PNPM_HOME=/pnpm');
		expect(processSpec.bootstrapCommand).toContain('PATH=/pnpm:$PATH');
		expect(processSpec.bootstrapCommand).toContain('mkdir -p /workspace /work/repos /work/tmp');
		expect(processSpec.bootstrapCommand).toContain('/work/cache/pnpm/store');
		expect(processSpec.bootstrapCommand).toContain('/state/agent-vm-worker-packages/package.json');
		expect(processSpec.bootstrapCommand).toContain('/state/agent-vm-worker-packages/node_modules');
		expect(processSpec.bootstrapCommand).toContain('/state/agent-vm-worker.tgz');
		expect(processSpec.bootstrapCommand).toContain(
			'worker_package_root="$(pnpm root -g --silent)"',
		);
		expect(processSpec.bootstrapCommand).toContain(
			'ln -sfn "$worker_bin_target" /pnpm/agent-vm-worker',
		);
		expect(processSpec.startCommand).toContain('agent-vm-worker');
		expect(processSpec.startCommand).toContain('PNPM_HOME=/pnpm');
		expect(processSpec.startCommand).toContain('PATH=/pnpm:$PATH');
		expect(processSpec.startCommand).toContain('cd /work');
		expect(processSpec.startCommand).toContain('serve --port 18789');
		expect(processSpec.healthCheck).toEqual({ type: 'http', port: 18789, path: '/health' });
		expect(processSpec.serviceHealthCheck).toEqual({
			type: 'http',
			port: 18789,
			path: '/health',
		});
		expect(processSpec.guestListenPort).toBe(18789);
		expect(processSpec.logPath).toBe('/tmp/agent-vm-worker.log');
	});
});
