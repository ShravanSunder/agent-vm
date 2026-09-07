import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVmEnableSshOptions, ManagedVmSshAccess } from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig, SystemConfig } from '../../config/system-config.js';
import type { GatewayExpectedAdmissionCohort } from '../../gateway/gateway-aggregate-admission-state.js';
import type {
	GatewayZone,
	GatewayZoneDestroyResult,
	GatewayZoneVmOperations,
} from '../../gateway/gateway-zone-support.js';
import { createManagedGatewayBootContract } from '../../gateway/managed-gateway-boot-contract.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../durable-state/controller-state-paths.js';
import { resolveControllerGatewayRecordTargets } from '../durable-state/controller-state-record-paths.js';
import { GatewayDestructionTimeoutError } from '../vm-ownership/gateway-destruction-budget.js';
import type { GatewayVmLifecycleAuthority } from '../vm-ownership/gateway-vm-lifecycle-authority.js';
import { createManagedGatewayZoneRuntime as createManagedGatewayZoneRuntimeImpl } from './managed-gateway-zone-runtime.js';
import { createZoneRuntimeRegistry } from './zone-runtime-registry.js';
import type { GatewayZoneRuntimeHandle, ManagedGatewayZoneRuntime } from './zone-runtime-types.js';

const zoneRuntimeRegistryTestRoot = path.join(
	os.tmpdir(),
	`agent-vm-zone-runtime-registry-test-${process.pid}`,
);

const systemConfig = {
	schemaVersion: 2,
	storageRootDir: zoneRuntimeRegistryTestRoot,
	cacheDir: path.join(zoneRuntimeRegistryTestRoot, 'cache'),
	controllerStateDir: path.join(zoneRuntimeRegistryTestRoot, 'controller-state'),
	controllerRuntimeDir: path.join(zoneRuntimeRegistryTestRoot, 'controller-runtime'),
	host: {
		controllerPort: 18800,
		projectNamespace: 'multi-zone-test',
	},
	imageProfiles: {
		gateways: {
			hermes: { type: 'hermes', buildConfig: './gateway.json' },
		},
		toolVms: {
			standard: { type: 'toolVm', buildConfig: './tool.json' },
		},
	},
	zones: [
		{
			id: 'shravan',
			agents: [{ id: 'main' }],
			gateway: {
				type: 'hermes',
				imageProfile: 'hermes',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './shravan/hermes.yaml',
				profileSecretProjectionsByAgent: { main: {} },
				profilesByAgent: { main: 'main' },
				stateDir: path.join(zoneRuntimeRegistryTestRoot, 'state', 'shravan'),
				zoneFilesDir: path.join(zoneRuntimeRegistryTestRoot, 'zone-files', 'shravan'),
				zoneRuntimeDir: path.join(zoneRuntimeRegistryTestRoot, 'shravan', 'runtime'),
			},
			secrets: {
				TEST_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'TEST_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
		{
			id: 'alevtina',
			agents: [{ id: 'main' }],
			gateway: {
				type: 'hermes',
				imageProfile: 'hermes',
				memory: '2G',
				cpus: 2,
				port: 18792,
				config: './alevtina/hermes.yaml',
				profileSecretProjectionsByAgent: { main: {} },
				profilesByAgent: { main: 'main' },
				stateDir: path.join(zoneRuntimeRegistryTestRoot, 'state', 'alevtina'),
				zoneFilesDir: path.join(zoneRuntimeRegistryTestRoot, 'zone-files', 'alevtina'),
				zoneRuntimeDir: path.join(zoneRuntimeRegistryTestRoot, 'alevtina', 'runtime'),
			},
			secrets: {
				TEST_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'TEST_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
	toolVmProfiles: {
		standard: {
			cpus: 1,
			imageProfile: 'standard',
			memory: '1G',
		},
	},
	tcpPool: { basePort: 19000, size: 5 },
} satisfies SystemConfig;

const loadedSystemConfig = {
	...systemConfig,
	systemConfigPath: path.join(zoneRuntimeRegistryTestRoot, 'config', 'system.json'),
} satisfies LoadedSystemConfig;

const testManagedGatewayBootContract = createManagedGatewayBootContract({
	bootEntry: 'hermes-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'hermes',
	ingress: { guestPort: 18_789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/hermes-service.log',
		serviceName: 'agent-vm-hermes-test',
	},
	readiness: { guestPort: 18_789, kind: 'framework-http', path: '/readyz' },
	role: 'framework-service',
});

function createTestExpectedAdmissionCohort(vmId: string): GatewayExpectedAdmissionCohort {
	return {
		controlIdentity: {
			controllerEpoch: 'controller-epoch-test',
			generationId: 'generation-test',
			peerId: 'tool-portal-control',
			processEpoch: `tool-portal-process-${vmId}`,
		},
		fence: {
			controllerEpoch: 'controller-epoch-test',
			gatewayEpoch: `gateway-epoch-${vmId}`,
			vmId,
			zoneId: 'shravan',
		},
		frameworkIdentity: {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: ['main'],
			frameworkEpoch: `framework-epoch-${vmId}`,
			frameworkKind: 'hermes',
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		},
		ingressIntent: {
			controlRoute: {
				audience: 'gateway-control',
				guestPort: 18_790,
				kind: 'tool-portal-control',
				prefix: '/_agent-vm/control',
				stripPrefix: true,
			},
			frameworkRootRoute: {
				guestPort: 18_789,
				kind: 'framework-root',
				prefix: '/',
				stripPrefix: true,
			},
		},
		providerRevision: 'provider-revision-test',
		requiredBackendRevision: 'required-backend-revision-test',
		semanticRevision: 'semantic-revision-test',
		toolPortalIdentity: {
			processEpoch: `tool-portal-process-${vmId}`,
			role: 'tool-portal',
			runtimeEpoch: `runtime-epoch-${vmId}`,
			serviceId: 'tool-portal-service-test',
		},
		udsIdentity: {
			frameworkEpoch: `framework-epoch-${vmId}`,
			gatewayEpoch: `gateway-epoch-${vmId}`,
			runtimeEpoch: `runtime-epoch-${vmId}`,
			socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
		},
	};
}

afterEach(async () => {
	await rm(zoneRuntimeRegistryTestRoot, { force: true, recursive: true });
});

type ManagedGatewayZoneRuntimeOptions = Parameters<typeof createManagedGatewayZoneRuntimeImpl>[0];
type ManagedGatewayRestartGatewayZone = NonNullable<
	ManagedGatewayZoneRuntimeOptions['restartGatewayZone']
>;
type TestManagedVm = Omit<GatewayZoneVmOperations, 'enableSsh'> & {
	enableSsh(
		options?: ManagedVmEnableSshOptions,
	): Promise<
		Partial<ManagedVmSshAccess> &
			Pick<ManagedVmSshAccess, 'close' | 'host' | 'port' | 'serverHostKey'>
	>;
};
type TestGatewayZoneStartResult = Omit<
	GatewayZoneRuntimeHandle,
	'bootContract' | 'destroyGateway' | 'executionModel' | 'expectedCohort' | 'gatewayIdentity' | 'vm'
> & {
	readonly destroyGateway?: GatewayZoneRuntimeHandle['destroyGateway'];
	readonly gatewayIdentity?: GatewayZoneRuntimeHandle['gatewayIdentity'];
	readonly vm: TestManagedVm;
};
type TestManagedGatewayZoneRuntimeOptions = Omit<
	ManagedGatewayZoneRuntimeOptions,
	'createVmOwnership' | 'restartGatewayZone' | 'runtimeRecordTarget'
> & {
	readonly createVmOwnership?: ManagedGatewayZoneRuntimeOptions['createVmOwnership'];
	readonly restartGatewayZone?: (
		...args: Parameters<ManagedGatewayRestartGatewayZone>
	) => Promise<TestGatewayZoneStartResult>;
};

function createTestVmOwnership(vmId = 'gateway-vm-test'): GatewayVmLifecycleAuthority {
	const gatewaySeed = {
		bootId: 'boot-test',
		controllerEpoch: 'controller-epoch-test',
		gatewayEpochId: `gateway-epoch-${vmId}`,
		generationId: 'generation-test',
		zoneId: 'shravan',
	} as const;
	let gatewayIdentity = { ...gatewaySeed, gatewayVmId: vmId };
	return {
		gatewaySeed,
		abandonUnattachedGatewaySeedAfter: async (cleanupOwnedResources) => {
			await cleanupOwnedResources();
		},
		get gatewayIdentity() {
			return gatewayIdentity;
		},
		attachGatewayVm(gatewayVmId) {
			gatewayIdentity = { ...gatewaySeed, gatewayVmId };
			return gatewayIdentity;
		},
		async containPendingCreate(containmentOptions): Promise<void> {
			await containmentOptions.closeLateCreatedVm(await containmentOptions.pendingCreate);
		},
		destroyLive: async (closeLiveVm) => {
			await closeLiveVm();
		},
	};
}

function createTestGatewayIdentity(vmId: string): GatewayZoneRuntimeHandle['gatewayIdentity'] {
	return {
		bootId: 'boot-test',
		controllerEpoch: 'controller-epoch-test',
		gatewayEpochId: `gateway-epoch-${vmId}`,
		gatewayVmId: vmId,
		generationId: 'generation-test',
		zoneId: 'shravan',
	};
}

function createManagedGatewayZoneRuntime(
	options: TestManagedGatewayZoneRuntimeOptions,
): ReturnType<typeof createManagedGatewayZoneRuntimeImpl> {
	const { createVmOwnership, restartGatewayZone, ...runtimeOptions } = options;
	return createManagedGatewayZoneRuntimeImpl({
		managedVmExactProcessTermination: {
			terminateRecordedHostProcess: async ({ identity }) => ({
				hostProcessId: identity.hostProcessId,
				kind: 'already-absent',
			}),
		},
		managedVmFactory: {
			createManagedVm: async () => {
				throw new Error('unit test must inject restartGatewayZone');
			},
		},
		managedVmImages: {
			prepareImage: async () => ({
				built: false,
				fingerprint: 'test-fingerprint',
				imageReference: '/tmp/test-image',
			}),
		},
		managedVmOwnedDirectories: {
			openHostDirectory: () => {
				throw new Error('unit test must inject restartGatewayZone');
			},
		},
		preflightGatewayZoneStart: async (startOptions) => {
			const secretResolver = startOptions.secretResolver ?? options.secretResolver;
			const gatewaySecretRefs = {
				TEST_GATEWAY_TOKEN: { ref: 'TEST_GATEWAY_TOKEN', source: 'environment' },
			} as const;
			const resolvedGatewaySecrets = await secretResolver.resolveAll(gatewaySecretRefs);
			return {
				secretResolver: {
					resolve: async (secretRef) => await secretResolver.resolve(secretRef),
					resolveAll: async (refs) => {
						const resolvedSecrets: Record<string, string> = {};
						const missingRefs: Record<string, (typeof refs)[string]> = {};
						for (const [secretName, secretRef] of Object.entries(refs)) {
							const cachedSecretValue = resolvedGatewaySecrets[secretName];
							if (cachedSecretValue === undefined) {
								missingRefs[secretName] = secretRef;
							} else {
								resolvedSecrets[secretName] = cachedSecretValue;
							}
						}
						if (Object.keys(missingRefs).length > 0) {
							Object.assign(resolvedSecrets, await secretResolver.resolveAll(missingRefs));
						}
						return resolvedSecrets;
					},
				},
			};
		},
		...runtimeOptions,
		createVmOwnership:
			createVmOwnership ?? (async () => createTestVmOwnership('gateway-vm-created')),
		runtimeRecordTarget: resolveControllerGatewayRecordTargets({
			gatewayStateRoot: resolveControllerGatewayStateRoot({
				controllerStateRoot: createControllerStateRoot({
					controllerStateDirectoryPath: options.systemConfig.controllerStateDir,
				}),
				zoneId: options.zone.id,
			}),
		}).managedGatewayRuntimeRecord,
		...(restartGatewayZone
			? {
					restartGatewayZone: async (...args: Parameters<ManagedGatewayRestartGatewayZone>) => {
						const result = await restartGatewayZone(...args);
						return {
							...result,
							bootContract: testManagedGatewayBootContract,
							destroyGateway: result.destroyGateway ?? (async () => ({ kind: 'destroyed-clean' })),
							executionModel: 'managed-gateway',
							expectedCohort: createTestExpectedAdmissionCohort(result.vm.id),
							gatewayIdentity: result.gatewayIdentity ?? createTestGatewayIdentity(result.vm.id),
							vm: {
								...result.vm,
								enableSsh: async (enableSshOptions) => {
									const sshAccess = await result.vm.enableSsh(enableSshOptions);
									return {
										command: sshAccess.command ?? 'ssh sandbox@127.0.0.1',
										identityFile: sshAccess.identityFile ?? '/tmp/test-identity',
										user: sshAccess.user ?? 'sandbox',
										...sshAccess,
									};
								},
							},
						};
					},
				}
			: {}),
	});
}

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
	const relativePath = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

const managedGatewayZone = systemConfig.zones.find((zone) => zone.id === 'shravan');
if (!managedGatewayZone || managedGatewayZone.gateway.type !== 'hermes') {
	throw new Error('Expected shravan Hermes test zone.');
}

function isManagedGatewayZone(zone: GatewayZone | undefined): zone is GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'hermes' }>;
} {
	return zone?.gateway.type === 'hermes';
}

function getManagedGatewayZone(): GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'hermes' }>;
} {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === 'shravan');
	if (!isManagedGatewayZone(zone)) {
		throw new Error('Expected shravan Hermes test zone.');
	}
	return zone;
}

function getHermesZone(): GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'hermes' }>;
} {
	return {
		...getManagedGatewayZone(),
		agents: [{ id: 'main' }],
		gateway: {
			config: './hermes/config.yaml',
			cpus: 2,
			imageProfile: 'hermes',
			memory: '2G',
			port: 18_793,
			profilesByAgent: { main: 'main' },
			profileSecretProjectionsByAgent: {
				main: {
					API_SERVER_KEY: 'API_SERVER_KEY_MAIN',
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN',
				},
			},
			stateDir: path.join(zoneRuntimeRegistryTestRoot, 'state', 'hermes-zone'),
			type: 'hermes',
			zoneFilesDir: path.join(zoneRuntimeRegistryTestRoot, 'zone-files', 'hermes-zone'),
			zoneRuntimeDir: path.join(zoneRuntimeRegistryTestRoot, 'hermes-zone', 'runtime'),
		},
		id: 'hermes-zone',
		secrets: {
			API_SERVER_KEY_MAIN: {
				audience: 'gateway',
				envVar: 'API_SERVER_KEY_MAIN',
				injection: 'env',
				source: 'environment',
			},
		},
	};
}

describe('zone runtime registry test fixture paths', () => {
	it('keeps generated runtime and state paths outside the repository checkout', () => {
		const generatedPaths = [
			systemConfig.cacheDir,
			systemConfig.controllerRuntimeDir,
			...systemConfig.zones.flatMap((zone) => [
				zone.gateway.stateDir,
				zone.gateway.zoneRuntimeDir,
				...(zone.gateway.type === 'hermes' ? [zone.gateway.zoneFilesDir] : []),
			]),
		];

		expect(
			generatedPaths.filter((generatedPath) =>
				isPathInsideDirectory(path.resolve(generatedPath), process.cwd()),
			),
		).toEqual([]);
	});
});

function createResolvingSecretResolver(): SecretResolver {
	return {
		resolve: async () => 'resolved-secret',
		resolveAll: async (secretRefs) =>
			Object.fromEntries(
				Object.keys(secretRefs).map((secretName) => [secretName, `resolved:${secretName}`]),
			),
	};
}

describe('createManagedGatewayZoneRuntime', () => {
	it('starts, snapshots, reads logs, and stops one Hermes gateway zone', async () => {
		const destroyGateway = vi.fn(async () => ({ kind: 'destroyed-clean' }) as const);
		const exec = vi.fn((command: string) =>
			createManagedExecProcessStub({
				stdout: command.includes('/var/log/agent-vm/')
					? 'gateway and runtime log output'
					: command.includes('/readyz')
						? '200'
						: 'command output',
			}),
		);
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: async (zoneId) => {
				expect(zoneId).toBe('shravan');
				return {
					destroyGateway,
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							command: 'ssh root@127.0.0.1',
							host: '127.0.0.1',
							port: 22,
						})),
						exec,
						getHostProcessId: () => 48_282,
						id: 'vm-shravan',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					zone: managedGatewayZone,
				};
			},
			runControllerCredentialsRefresh: async (_options, dependencies) => {
				await dependencies.refreshZoneSecrets('shravan');
				await dependencies.restartGatewayZone('shravan');
				return { ok: true, zoneId: 'shravan' };
			},
			runControllerDestroy: async (options, dependencies) => {
				await dependencies.stopGatewayZone(options.zoneId);
				await dependencies.releaseZoneLeases(options.zoneId);
				return { ok: true, purged: options.purge, zoneId: options.zoneId };
			},
			runControllerLogs: async (options, dependencies) => ({
				output: await dependencies.readGatewayLogs(options.zoneId),
				zoneId: options.zoneId,
			}),
			runControllerUpgrade: async (_options, dependencies) => {
				await dependencies.rebuildGatewayImage('shravan');
				await dependencies.restartGatewayZone('shravan');
				return { ok: true, zoneId: 'shravan' };
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getManagedGatewayZone(),
		});

		await runtime.start();

		expect(runtime.getSnapshot()).toMatchObject({
			bootedAt: '2026-04-30T10:00:00.000Z',
			gateway: {
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: { id: 'vm-shravan' },
			},
			lifecycleState: 'running',
		});
		await expect(runtime.getLogs()).resolves.toEqual({
			output: 'gateway and runtime log output',
			zoneId: 'shravan',
		});
		expect(exec).toHaveBeenCalledWith(
			[
				"echo '===== framework service log (/var/log/agent-vm/hermes-service.log) ====='",
				"tail -n 400 '/var/log/agent-vm/hermes-service.log' 2>/dev/null || true",
				'echo',
				"echo '===== Tool Portal service log (/var/log/agent-vm/tool-portal-service.log) ====='",
				"tail -n 400 '/var/log/agent-vm/tool-portal-service.log' 2>/dev/null || true",
			].join('; '),
		);
		await expect(runtime.getHealth()).resolves.toEqual({
			ok: true,
			observation: 'http 200',
			path: '/readyz',
			port: 18789,
			statusCode: 200,
			zoneId: 'shravan',
		});
		await runtime.stop();
		expect(destroyGateway).toHaveBeenCalledTimes(1);
		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });
	});

	it('records startup failure and keeps the zone inspectable', async () => {
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: async () => {
				throw new Error('gateway boot failed');
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getManagedGatewayZone(),
		});

		await expect(runtime.start()).rejects.toThrow("Failed to start zone 'shravan'");
		expect(runtime.getSnapshot()).toEqual({
			lastError: 'gateway boot failed',
			lifecycleState: 'failed',
		});
		await expect(runtime.getLogs()).rejects.toThrow(
			"Gateway runtime for zone 'shravan' is unavailable. Last error: gateway boot failed",
		);
	});

	it('delegates exact teardown to the Gateway destruction transaction and blocks replacement on rejection', async () => {
		const close = vi.fn(async () => {});
		let gatewayStartCount = 0;
		const destroyGateway = vi.fn(async (): Promise<GatewayZoneDestroyResult> => {
			throw new Error('exact Gateway destruction is unproven');
		});
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const gatewayVmId = `gateway-vm-${gatewayStartCount}`;
				const gatewayHostPid = 48_282 + gatewayStartCount;
				return {
					destroyGateway,
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						close: gatewayStartCount === 1 ? close : vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							command: 'ssh root@127.0.0.1',
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => gatewayHostPid,
						id: gatewayVmId,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					zone: managedGatewayZone,
				};
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getManagedGatewayZone(),
		});

		await runtime.start();
		await expect(runtime.restart()).rejects.toThrow(/exact Gateway destruction.*unproven/u);

		expect(destroyGateway).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
		expect(gatewayStartCount).toBe(1);
		expect(runtime.getSnapshot()).toMatchObject({
			lifecycleState: 'failed',
		});
	});

	it('releases the lifecycle queue after subtree timeout but refuses G2 while G1 is incomplete', async () => {
		// Arrange
		let gatewayStartCount = 0;
		let rejectTimedOutGatewayDestroy: ((error: unknown) => void) | undefined;
		const timedOutGatewayDestroy = new Promise<never>((_resolve, reject) => {
			rejectTimedOutGatewayDestroy = reject;
		});
		const destroyGateway = vi.fn(async (): Promise<GatewayZoneDestroyResult> => {
			return await timedOutGatewayDestroy;
		});
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const gatewayVmId = `gateway-vm-${gatewayStartCount}`;
				const gatewayHostPid = 48_282 + gatewayStartCount;
				return {
					destroyGateway,
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						close: vi.fn(
							async () =>
								await new Promise<never>(() => {
									// The exact close may settle late; ownership timeout must fence G2 first.
								}),
						),
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							command: 'ssh root@127.0.0.1',
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => gatewayHostPid,
						id: gatewayVmId,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					zone: managedGatewayZone,
				};
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getManagedGatewayZone(),
		});

		await runtime.start();
		const stopPromise = runtime.stop();
		const stopRejection = expect(stopPromise).rejects.toMatchObject({
			code: 'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
		});
		await vi.waitFor(() => {
			expect(destroyGateway).toHaveBeenCalledOnce();
		});

		// Act
		rejectTimedOutGatewayDestroy?.(
			new GatewayDestructionTimeoutError(
				'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
				'Gateway subtree',
				300_000,
			),
		);

		// Assert
		await stopRejection;
		await expect(runtime.start()).rejects.toMatchObject({
			message: expect.stringMatching(/Gateway subtree.*timed out/iu),
			name: 'ControllerZoneRuntimeUnavailableError',
		});
		expect(gatewayStartCount).toBe(1);
		expect(runtime.getSnapshot()).toMatchObject({ lifecycleState: 'failed' });
	});

	it('keeps the lifecycle queue locked until a timed-out restart settles', async () => {
		type RestartGatewayZone = NonNullable<
			Parameters<typeof createManagedGatewayZoneRuntime>[0]['restartGatewayZone']
		>;
		let gatewayStartCount = 0;
		let resolveSecondGatewayStart:
			| ((value: Awaited<ReturnType<RestartGatewayZone>>) => void)
			| undefined;
		const restartTimeoutCallbacks: (() => void)[] = [];
		const clearTimeoutImpl = vi.fn();
		const createGatewayStartResult = (
			gatewayVmId: string,
		): Awaited<ReturnType<RestartGatewayZone>> => ({
			destroyGateway: vi.fn(async () => ({ kind: 'destroyed-clean' }) as const),
			image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			vm: {
				enableSsh: vi.fn(async () => ({
					close: async () => {},
					serverHostKey: TEST_SSH_SERVER_HOST_KEY,
					command: 'ssh root@127.0.0.1',
					host: '127.0.0.1',
					port: 22,
				})),
				exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
				getHostProcessId: () => 48_282,
				id: gatewayVmId,
			},
			zone: managedGatewayZone,
		});
		const runtime = createManagedGatewayZoneRuntime({
			clearTimeoutImpl,
			isProcessAlive: () => true,
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				if (gatewayStartCount === 2) {
					return await new Promise<Awaited<ReturnType<RestartGatewayZone>>>((resolve) => {
						resolveSecondGatewayStart = resolve;
					});
				}
				return createGatewayStartResult(`gateway-vm-${gatewayStartCount}`);
			},
			secretResolver: createResolvingSecretResolver(),
			setTimeoutImpl: (callback, delayMs) => {
				if (delayMs === 5_000) {
					restartTimeoutCallbacks.push(callback);
				} else {
					expect(delayMs).toBe(60_000);
				}
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			systemConfig: loadedSystemConfig,
			zone: getManagedGatewayZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart({ timeoutMs: 5_000 });
		await vi.waitFor(() => {
			expect(restartTimeoutCallbacks).toHaveLength(1);
		});
		await vi.waitFor(() => {
			expect(resolveSecondGatewayStart).toBeDefined();
		});
		restartTimeoutCallbacks[0]?.();

		await expect(restartPromise).rejects.toThrow(
			"Managed Gateway restart timed out for zone 'shravan' after 5000ms",
		);
		let shutdownSettled = false;
		const shutdownPromise = runtime.shutdown().then(() => {
			shutdownSettled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});

		expect(shutdownSettled).toBe(false);
		if (resolveSecondGatewayStart === undefined) {
			throw new Error('Expected second gateway start to be pending.');
		}
		resolveSecondGatewayStart(createGatewayStartResult('gateway-vm-stale'));
		await expect(shutdownPromise).resolves.toBeUndefined();

		expect(clearTimeoutImpl).toHaveBeenCalledOnce();
		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });
	});

	it('serializes shutdown behind an in-flight Hermes gateway restart', async () => {
		type RestartGatewayZone = NonNullable<
			Parameters<typeof createManagedGatewayZoneRuntime>[0]['restartGatewayZone']
		>;
		let gatewayStartCount = 0;
		let resolveSecondGatewayStart:
			| ((value: Awaited<ReturnType<RestartGatewayZone>>) => void)
			| undefined;
		const optionsRestartGatewayZone: RestartGatewayZone = async () => {
			gatewayStartCount += 1;
			const gatewayVmId = `gateway-vm-${gatewayStartCount}`;
			const gatewayHostPid = 48_282 + gatewayStartCount;
			const result = {
				destroyGateway: vi.fn(async () => ({ kind: 'destroyed-clean' }) as const),
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh root@127.0.0.1',
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => gatewayHostPid,
					id: gatewayVmId,
				},
				zone: managedGatewayZone,
			} satisfies Awaited<ReturnType<RestartGatewayZone>>;
			if (gatewayStartCount === 2) {
				return await new Promise<Awaited<ReturnType<RestartGatewayZone>>>((resolve) => {
					resolveSecondGatewayStart = resolve;
				});
			}
			return result;
		};
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: optionsRestartGatewayZone,
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getManagedGatewayZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart();
		await vi.waitFor(() => {
			expect(gatewayStartCount).toBe(2);
		});
		const shutdownPromise = runtime.shutdown();
		// Let shutdown queue behind the suspended restart before inspecting the stopped snapshot.
		await Promise.resolve();
		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });

		if (!resolveSecondGatewayStart) {
			throw new Error('Expected second gateway start to be pending.');
		}
		resolveSecondGatewayStart({
			destroyGateway: vi.fn(async () => ({ kind: 'destroyed-clean' }) as const),
			image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			vm: {
				enableSsh: vi.fn(async () => ({
					close: async () => {},
					serverHostKey: TEST_SSH_SERVER_HOST_KEY,
					command: 'ssh root@127.0.0.1',
					host: '127.0.0.1',
					port: 22,
				})),
				exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
				getHostProcessId: () => 48_284,
				id: 'gateway-vm-2',
			},
			zone: managedGatewayZone,
		});

		await restartPromise;
		await shutdownPromise;

		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });
	});

	it('refreshes only gateway audience secrets for Hermes zones', async () => {
		const baseZone = getManagedGatewayZone();
		const zone = {
			...baseZone,
			secrets: {
				...baseZone.secrets,
				LINEAR_API_KEY: {
					source: '1password',
					ref: 'op://agent-vm/shravan-linear/credential',
					injection: 'http-mediation',
					audience: 'tool-vm',
					hosts: ['api.linear.app'],
					agentAccess: 'all',
				},
			},
			egressHosts: [...baseZone.egressHosts, { host: 'api.linear.app', audience: 'tool-vm' }],
		} satisfies GatewayZone & {
			readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'hermes' }>;
		};
		const config = {
			...loadedSystemConfig,
			zones: [
				zone,
				...loadedSystemConfig.zones.filter((candidateZone) => candidateZone.id !== zone.id),
			],
		} satisfies LoadedSystemConfig;
		const resolvedSecretRefBatches: unknown[] = [];
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: async () => {
				throw new Error('restart is not needed by this refresh test');
			},
			runControllerCredentialsRefresh: async (_options, dependencies) => {
				await dependencies.refreshZoneSecrets('shravan');
				return { ok: true, zoneId: 'shravan' };
			},
			secretResolver: {
				resolve: async () => {
					throw new Error('resolve should not be called during credentials refresh');
				},
				resolveAll: async (refs) => {
					resolvedSecretRefBatches.push(refs);
					return Object.fromEntries(
						Object.entries(refs).map(([secretName, secretRef]) => [
							secretName,
							`resolved:${secretRef.ref}`,
						]),
					);
				},
			},
			systemConfig: config,
			zone,
		});

		await expect(runtime.refreshCredentials()).resolves.toEqual({ ok: true, zoneId: 'shravan' });

		expect(resolvedSecretRefBatches).toEqual([
			{
				TEST_GATEWAY_TOKEN: {
					source: 'environment',
					ref: 'TEST_GATEWAY_TOKEN',
				},
			},
		]);
	});
});

describe('createZoneRuntimeRegistry', () => {
	it('starts all selected zones with partial-start semantics', async () => {
		const shravanRuntime = createFakeManagedGatewayRuntime('shravan');
		const hermesRuntime = createFakeManagedGatewayRuntime('hermes-zone');
		const alevtinaRuntime = createFakeManagedGatewayRuntime('alevtina', {
			getLogs: async () => {
				throw new Error("Gateway runtime for zone 'alevtina' is unavailable");
			},
			getSnapshot: () => ({
				lastError: 'alevtina boot failed',
				lifecycleState: 'failed',
			}),
			start: async () => {
				throw new Error('alevtina boot failed');
			},
		});
		const writeLog = vi.fn();
		const registry = createZoneRuntimeRegistry({
			createRuntimeForZone: (zone) =>
				zone.id === 'shravan'
					? shravanRuntime
					: zone.id === 'hermes-zone'
						? hermesRuntime
						: alevtinaRuntime,
			systemConfig: {
				...loadedSystemConfig,
				zones: [
					getManagedGatewayZone(),
					getHermesZone(),
					{ ...getManagedGatewayZone(), id: 'alevtina' },
				],
			},
			writeLog,
			zoneIds: ['shravan', 'hermes-zone', 'alevtina'],
		});

		await registry.startSelectedZones();

		expect(writeLog).toHaveBeenCalledWith('warning', {
			operation: 'start-gateway-zone',
			zoneId: 'alevtina',
		});
		expect(registry.getSnapshotByZone()).toEqual({
			alevtina: {
				lastError: 'alevtina boot failed',
				lifecycleState: 'failed',
			},
			'hermes-zone': { lifecycleState: 'running' },
			shravan: { lifecycleState: 'running' },
		});
		expect(registry.getManagedGatewayRuntime('hermes-zone').gatewayType).toBe('hermes');
		await expect(registry.getManagedGatewayRuntime('shravan').getLogs()).resolves.toEqual({
			output: 'logs for shravan',
			zoneId: 'shravan',
		});
		await expect(registry.getManagedGatewayRuntime('alevtina').getLogs()).rejects.toThrow(
			"Gateway runtime for zone 'alevtina' is unavailable",
		);
	});

	it('rejects operations for an unknown zone', async () => {
		const registry = createZoneRuntimeRegistry({
			createRuntimeForZone: (zone) => createFakeManagedGatewayRuntime(zone.id),
			systemConfig: loadedSystemConfig,
			zoneIds: ['shravan'],
		});

		expect(() => registry.getManagedGatewayRuntime('missing-zone')).toThrow(
			"Unknown zone 'missing-zone'.",
		);
		await expect(registry.destroyZone('missing-zone', false)).rejects.toThrow(
			"Unknown zone 'missing-zone'.",
		);
	});
});

function createFakeManagedGatewayRuntime(
	zoneId: string,
	overrides: Partial<ManagedGatewayZoneRuntime> = {},
): ManagedGatewayZoneRuntime {
	let lifecycleState: 'running' | 'failed' | 'stopped' = 'stopped';
	return {
		coldStart: async () => {
			lifecycleState = 'running';
			return { leaseReleaseFailureCount: 0 };
		},
		destroy: async (purged) => ({ ok: true, purged, zoneId }),
		enableSsh: async () => ({
			close: async () => {},
			serverHostKey: TEST_SSH_SERVER_HOST_KEY,
			command: 'ssh root@127.0.0.1',
			identityFile: '/tmp/test-identity',
			user: 'root',
			host: '127.0.0.1',
			port: 22,
		}),
		exec: async () => ({ exitCode: 0, stderr: '', stdout: zoneId }),
		ensureCurrentControlSessionDialing: () => ({ status: 'not-current' }),
		gatewayType: 'hermes',
		getDiagnosis: () => ({
			channelProviderPlane: 'unknown',
			controllerLiveness: 'ok',
			currentRecoveryBlocker: 'none',
			gatewayInfrastructure: lifecycleState,
			lastOperation: 'none',
			originalOutageCause: { kind: 'unknown' },
			selectedZoneReadiness: lifecycleState === 'running' ? 'running' : 'failed',
			toolVmLeaseState: 'not-applicable',
			toolVmPlane: 'unknown',
		}),
		getHealth: async () => ({ ok: true, observation: 'http 200', zoneId }),
		getServiceHealth: async () => ({ ok: true, observation: 'http 200', zoneId }),
		getLifecycleState: () => {
			switch (lifecycleState) {
				case 'failed':
					return {
						coldStartEligible: true,
						error: { code: 'vm-start-failed', message: 'fake runtime failed' },
						kind: 'failed',
					};
				case 'running':
					return {
						gateway: {
							ingress: { host: '127.0.0.1', port: 18791 },
							bootContract: testManagedGatewayBootContract,
							destroyGateway: async () => ({ kind: 'destroyed-clean' }),
							executionModel: 'managed-gateway',
							expectedCohort: createTestExpectedAdmissionCohort('fake-hermes-runtime'),
							gatewayIdentity: createTestGatewayIdentity('fake-hermes-runtime'),
							image: {
								built: false,
								fingerprint: 'fake-hermes-image',
								imageReference: '/tmp/fake-hermes-image',
							},
							vm: {
								enableSsh: async () => ({
									close: async () => {},
									serverHostKey: TEST_SSH_SERVER_HOST_KEY,
									command: 'ssh root@127.0.0.1',
									identityFile: '/tmp/test-identity',
									user: 'root',
									host: '127.0.0.1',
									port: 22,
								}),
								exec: () => createManagedExecProcessStub({ stdout: 'ok' }),
								getHostProcessId: () => 12345,
								id: 'fake-hermes-runtime',
							},
							zone: getManagedGatewayZone(),
						},
						kind: 'running',
					};
				case 'stopped':
					return { kind: 'stopped' };
			}
			throw new Error(`Unhandled fake lifecycle state: ${String(lifecycleState)}`);
		},
		getLogs: async () => ({ output: `logs for ${zoneId}`, zoneId }),
		getSnapshot: () => ({ lifecycleState }),
		refreshCredentials: async () => ({ ok: true, zoneId }),
		restart: async () => ({ leaseReleaseFailureCount: 0 }),
		shutdown: async () => {
			lifecycleState = 'stopped';
		},
		start: async () => {
			lifecycleState = 'running';
		},
		stop: async () => {
			lifecycleState = 'stopped';
		},
		upgrade: async () => ({ ok: true, zoneId }),
		zoneId,
		...overrides,
	};
}
