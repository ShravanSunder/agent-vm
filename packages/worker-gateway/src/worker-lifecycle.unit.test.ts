import type { GatewayZoneConfig } from '@agent-vm/gateway-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { workerLifecycle } from './worker-lifecycle.js';

const zone: GatewayZoneConfig = {
	egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
	gateway: {
		cpus: 2,
		config: '/host/config/shravan/worker.json',
		memory: '2G',
		port: 18791,
		ssh: { secretEnv: 'explicit' },
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
	it('does not support interactive auth', () => {
		expect(workerLifecycle.authConfig).toBeUndefined();
	});

	it('builds a worker VM spec with /state mounted and /work on rootfs', () => {
		const vmSpec = workerLifecycle.buildVmSpec({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: { OPENAI_API_KEY: 'openai-token' },
			runtimeDir: '/host/runtime',
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
		expect(vmSpec.vfsMounts['/work']).toBeUndefined();
		expect(vmSpec.vfsMounts['/workspace']).toBeUndefined();
		expect(vmSpec.environment.OPENAI_API_KEY).toBe('openai-token');
		expect(vmSpec.environment.AGENT_VM_ZONE_ID).toBe('shravan');
		expect(vmSpec.environment.CONTROLLER_BASE_URL).toBeUndefined();
		expect(vmSpec.environment.PNPM_HOME).toBe('/pnpm');
		expect(vmSpec.environment.PATH).toBe(
			'/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
		);
		// IPv4-preference egress for the Node controller-client to defeat
		// Happy Eyeballs racing on gondolin's shared synthetic AAAA.
		// See FORCE_IPV4_EGRESS_NODE_OPTIONS in @agent-vm/gateway-contracts.
		expect(vmSpec.environment.NODE_OPTIONS).toBe(
			'--dns-result-order=ipv4first --no-network-family-autoselection',
		);
		expect(vmSpec.environment.WORKER_CONFIG_PATH).toBe('/state/effective-worker.json');
		expect(vmSpec.environment.WORK_DIR).toBe('/work');
		expect(vmSpec.environment.REPOS_DIR).toBe('/work/repos');
		expect(vmSpec.environment.TMPDIR).toBe('/work/tmp');
		expect(vmSpec.environment.npm_config_cache).toBe('/work/cache/npm');
		expect(vmSpec.environment.pnpm_config_store_dir).toBe('/work/cache/pnpm/store');
		expect(vmSpec.allowedHosts).toEqual(['api.openai.com']);
		expect(vmSpec.allowedHosts).not.toContain('controller.vm.host');
		expect(vmSpec.sessionLabel).toBe('claw-tests-a1b2c3d4:shravan:gateway');
		expect(vmSpec.tcpHosts['controller.vm.host:18800']).toBeUndefined();
		expect(vmSpec.tcpHosts).toEqual({});
	});

	it('denies Worker Git SSH reads when no trusted repo allowlist is available', async () => {
		vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent-vm-test-agent.sock');

		const vmSpec = workerLifecycle.buildVmSpec({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: { OPENAI_API_KEY: 'openai-token' },
			runtimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone,
		});

		expect(vmSpec.sshEgress).toBeUndefined();
	});

	it('allows only trusted Worker Git SSH reads from prepared repos', async () => {
		vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent-vm-test-agent.sock');

		const vmSpec = workerLifecycle.buildVmSpec({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: { OPENAI_API_KEY: 'openai-token' },
			runtimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone: {
				...zone,
				gitReadAllowlistRepos: ['ssh://git@git.example.com/org/repo.git'],
			},
		});

		expect(vmSpec.sshEgress?.allowedHosts).toEqual(['git.example.com']);
		expect(vmSpec.sshEgress?.agent).toBe('/tmp/agent-vm-test-agent.sock');
		if (!vmSpec.sshEgress?.execPolicy) {
			throw new Error('Expected Worker gateway read-only Git SSH policy');
		}
		await expect(
			Promise.resolve(
				vmSpec.sshEgress.execPolicy({
					command: "git-upload-pack 'org/repo.git'",
					guestUsername: 'git',
					hostname: 'git.example.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_000 },
				}),
			),
		).resolves.toEqual({ allow: true });
		await expect(
			Promise.resolve(
				vmSpec.sshEgress.execPolicy({
					command: "git-upload-pack 'org/other-private.git'",
					guestUsername: 'git',
					hostname: 'git.example.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_003 },
				}),
			),
		).resolves.toMatchObject({ allow: false });
		await expect(
			Promise.resolve(
				vmSpec.sshEgress.execPolicy({
					command: "git-receive-pack 'org/repo.git'",
					guestUsername: 'git',
					hostname: 'git.example.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_001 },
				}),
			),
		).resolves.toMatchObject({ allow: false });
		await expect(
			Promise.resolve(
				vmSpec.sshEgress.execPolicy({
					command: 'bash',
					guestUsername: 'git',
					hostname: 'git.example.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_002 },
				}),
			),
		).resolves.toMatchObject({ allow: false });
	});

	it('omits Worker SSH egress when no host SSH agent is available', () => {
		vi.stubEnv('SSH_AUTH_SOCK', '');

		const vmSpec = workerLifecycle.buildVmSpec({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: { OPENAI_API_KEY: 'openai-token' },
			runtimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone,
		});

		expect(vmSpec.sshEgress).toBeUndefined();
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

		const vmSpec = workerLifecycle.buildVmSpec({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: {
				OPENAI_API_KEY: 'openai-token',
				GITHUB_TOKEN: 'github-token',
				LINEAR_API_KEY: 'linear-token',
			},
			runtimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone: mixedAudienceZone,
		});

		expect(vmSpec.environment).toEqual(expect.objectContaining({ OPENAI_API_KEY: 'openai-token' }));
		expect(vmSpec.environment).not.toHaveProperty('LINEAR_API_KEY');
		expect(vmSpec.mediatedSecrets).toEqual({
			GITHUB_TOKEN: {
				hosts: ['api.github.com'],
				value: 'github-token',
			},
		});
		expect(vmSpec.allowedHosts).toEqual(['api.openai.com', 'api.github.com']);
		expect(vmSpec.allowedHosts).not.toContain('controller.vm.host');
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

		const vmSpec = workerLifecycle.buildVmSpec({
			controllerPort: 18800,
			gatewayCacheDir: '/host/cache/gateways/shravan',
			projectNamespace: 'claw-tests-a1b2c3d4',
			resolvedSecrets: {
				OPENAI_API_KEY: 'openai-token',
				NODE_OPTIONS: '--inspect=0.0.0.0:9229',
			},
			runtimeDir: '/host/runtime',
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			zone: zoneWithNodeOptionsSecret,
		});

		// Forced flags lead; user value follows.
		expect(vmSpec.environment.NODE_OPTIONS).toBe(
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
		expect(processSpec.bootstrapCommand).toContain('mkdir -p /work/repos /work/tmp');
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
		expect(processSpec.guestListenPort).toBe(18789);
		expect(processSpec.logPath).toBe('/tmp/agent-vm-worker.log');
	});
});
