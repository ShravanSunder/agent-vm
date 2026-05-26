import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { GatewayLifecycle } from '@agent-vm/gateway-interface';
import type { BuildConfig, ManagedVm, ManagedVmInstance } from '@agent-vm/gondolin-adapter';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { createSecretResolverFromSystemConfig } from '../controller/controller-runtime-support.js';
import { resolveZoneSecrets } from '../gateway/credential-manager.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';

type FakeManagedVmInstance = ManagedVmInstance & {
	readonly server: {
		readonly controller: {
			readonly child: {
				readonly pid: number;
			};
		};
	};
};

function createFakeManagedVmInstance(): FakeManagedVmInstance {
	return {
		close: async () => {},
		exec: () => createManagedExecProcessStub(),
		enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
		enableSsh: async () => ({
			command: 'ssh fake',
			host: '127.0.0.1',
			port: 2222,
			privateKeyPath: '/tmp/fake-key',
			user: 'root',
		}),
		fs: createManagedVmFsStub(),
		id: 'gateway-secret-resolution-smoke-instance',
		server: {
			controller: {
				child: {
					pid: 12_345,
				},
			},
		},
		setIngressRoutes: () => {},
	};
}

function createFakeManagedVm(): ManagedVm {
	const fakeVmInstance = createFakeManagedVmInstance();
	return {
		id: 'gateway-secret-resolution-smoke-vm',
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
		enableSsh: async () => ({
			command: 'ssh fake',
			host: '127.0.0.1',
			port: 2222,
			privateKeyPath: '/tmp/fake-key',
			user: 'root',
		}),
		exec: () => createManagedExecProcessStub(),
		fs: createManagedVmFsStub(),
		getHostPid: () => 12_345,
		getVmInstance: () => fakeVmInstance,
		setIngressRoutes: () => {},
	};
}

describe('smoke: gateway startup secret resolution', () => {
	it('batches gateway startup 1Password refs through the production composite resolver', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-secret-resolution-smoke-'));
		const stateDir = path.join(tempRoot, 'state');
		const cacheDir = path.join(tempRoot, 'cache');
		const runtimeDir = path.join(tempRoot, 'runtime');
		const buildConfigPath = path.join(tempRoot, 'gateway-build.json');
		const gatewayConfigPath = path.join(tempRoot, 'worker-gateway.json');
		await fs.mkdir(stateDir, { recursive: true });
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.mkdir(runtimeDir, { recursive: true });
		await fs.writeFile(buildConfigPath, '{}');
		await fs.writeFile(gatewayConfigPath, '{}');

		const systemConfig = {
			schemaVersion: 1,
			cacheDir,
			runtimeDir,
			host: {
				controllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				secretsProvider: {
					type: '1password',
					tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
				},
			},
			imageProfiles: {
				gateways: {
					worker: {
						type: 'worker',
						buildConfig: buildConfigPath,
					},
				},
				toolVms: {},
			},
			zones: [
				{
					id: 'secret-smoke',
					gateway: {
						type: 'worker',
						imageProfile: 'worker',
						memory: '1G',
						cpus: 1,
						port: 18791,
						config: gatewayConfigPath,
						stateDir,
					},
					secrets: {
						ENV_ONLY_TOKEN: {
							source: 'environment',
							envVar: 'SECRET_SMOKE_ENV_ONLY_TOKEN',
							injection: 'env',
							audience: 'gateway',
						},
						OPENCLAW_GATEWAY_TOKEN: {
							source: '1password',
							ref: 'op://agent-vm/secret-smoke-gateway/password',
							injection: 'env',
							audience: 'gateway',
						},
						PERPLEXITY_API_KEY: {
							source: '1password',
							ref: 'op://agent-vm/secret-smoke-perplexity/credential',
							injection: 'http-mediation',
							audience: 'gateway',
							hosts: ['api.perplexity.ai'],
						},
						TOOL_VM_HTTP_TOKEN: {
							source: '1password',
							ref: 'op://agent-vm/secret-smoke-tool-vm/credential',
							injection: 'http-mediation',
							audience: 'tool-vm',
							hosts: ['api.example.test'],
						},
					},
					egressHosts: [{ host: 'api.perplexity.ai', audience: 'gateway' }],
					websocketBypass: [],
				},
			],
			tcpPool: { basePort: 19000, size: 4 },
			toolVmProfiles: {},
			systemConfigPath: path.join(tempRoot, 'system.jsonc'),
		} satisfies LoadedSystemConfig;

		const innerResolve = vi.fn(async () => {
			throw new Error('inner resolve should not be used during startup batch resolution');
		});
		const innerResolveAll = vi.fn(async (refs: Record<string, SecretRef>) =>
			Object.fromEntries(Object.keys(refs).map((name) => [name, `resolved:${name}`])),
		);
		const innerResolver: SecretResolver = {
			resolve: innerResolve,
			resolveAll: innerResolveAll,
		};
		const createInnerResolver = vi.fn(
			async ({ serviceAccountToken }: { readonly serviceAccountToken: string }) => {
				expect(serviceAccountToken).toBe('service-token');
				return innerResolver;
			},
		);

		const secretResolver = await createSecretResolverFromSystemConfig(
			systemConfig,
			createInnerResolver,
			async () => 'service-token',
		);
		const previousEnvOnlyToken = process.env.SECRET_SMOKE_ENV_ONLY_TOKEN;
		process.env.SECRET_SMOKE_ENV_ONLY_TOKEN = 'env-only-token';

		const lifecycle: GatewayLifecycle = {
			buildProcessSpec: () => ({
				bootstrapCommand: 'true',
				startCommand: 'true',
				healthCheck: { type: 'command', command: 'true' },
				guestListenPort: 18789,
				logPath: '/tmp/gateway.log',
			}),
			buildVmSpec: () => ({
				allowedHosts: [],
				environment: {},
				mediatedSecrets: {},
				rootfsMode: 'memory',
				sessionLabel: 'secret-smoke',
				tcpHosts: {},
				vfsMounts: {},
			}),
			prepareHostState: async () => {},
		};

		try {
			await startGatewayZone(
				{
					secretResolver,
					systemConfig,
					zoneId: 'secret-smoke',
				},
				{
					buildImage: async () => ({
						built: false,
						fingerprint: 'gateway-secret-resolution-smoke',
						imagePath: path.join(tempRoot, 'image'),
					}),
					cleanupOrphanedGatewayIfPresent: async () => ({
						cleanedUp: false,
						killedPid: null,
					}),
					createManagedVm: async () => createFakeManagedVm(),
					loadBuildConfig: async () =>
						({
							arch: 'aarch64',
							distro: 'alpine',
						}) satisfies BuildConfig,
					loadGatewayLifecycle: () => lifecycle,
					readProcessIdentity: async () => ({
						command: 'qemu-system-aarch64 -m 2G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					writeGatewayRuntimeRecord: async () => {},
				},
			);
		} finally {
			if (previousEnvOnlyToken === undefined) {
				delete process.env.SECRET_SMOKE_ENV_ONLY_TOKEN;
			} else {
				process.env.SECRET_SMOKE_ENV_ONLY_TOKEN = previousEnvOnlyToken;
			}
		}

		expect(createInnerResolver).toHaveBeenCalledTimes(1);
		expect(innerResolve).not.toHaveBeenCalled();
		expect(innerResolveAll).toHaveBeenCalledTimes(1);
		expect(innerResolveAll).toHaveBeenCalledWith({
			OPENCLAW_GATEWAY_TOKEN: {
				source: '1password',
				ref: 'op://agent-vm/secret-smoke-gateway/password',
			},
			PERPLEXITY_API_KEY: {
				source: '1password',
				ref: 'op://agent-vm/secret-smoke-perplexity/credential',
			},
		});

		await expect(
			resolveZoneSecrets({
				audience: 'tool-vm',
				injection: 'http-mediation',
				secretResolver,
				systemConfig,
				zoneId: 'secret-smoke',
			}),
		).resolves.toEqual({
			TOOL_VM_HTTP_TOKEN: 'resolved:TOOL_VM_HTTP_TOKEN',
		});
		expect(innerResolve).not.toHaveBeenCalled();
		expect(innerResolveAll).toHaveBeenCalledTimes(2);
		expect(innerResolveAll).toHaveBeenLastCalledWith({
			TOOL_VM_HTTP_TOKEN: {
				source: '1password',
				ref: 'op://agent-vm/secret-smoke-tool-vm/credential',
			},
		});
	});
});
