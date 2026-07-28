import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	ManagedVmEnableSshOptions,
	ManagedVmImageBuildResult,
	ManagedVmOwnedDirectoryCapability,
	ManagedVmSshAccess,
	OwnedHostDirectory,
} from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { LoadedSystemConfig, SystemConfig } from '../../config/system-config.js';
import type { GatewayExpectedAdmissionCohort } from '../../gateway/gateway-aggregate-admission-state.js';
import { GatewayOwnershipUnsafeError } from '../../gateway/gateway-ownership-evidence.js';
import type {
	DirectProcessGatewayZoneStartResult,
	GatewayZone,
	GatewayZoneDestroyResult,
	GatewayZoneVmOperations,
} from '../../gateway/gateway-zone-support.js';
import { createManagedGatewayBootContract } from '../../gateway/managed-gateway-boot-contract.js';
import type { GatewayRuntimeArtifactLimits } from '../../gateway/managed-gateway-runtime-input-builders.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../durable-state/controller-state-paths.js';
import { resolveControllerGatewayRecordTargets } from '../durable-state/controller-state-record-paths.js';
import type { GatewayVmLifecycleAuthority } from '../vm-ownership/gateway-vm-lifecycle-authority.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import type { GatewayLifecycleOperationRecord } from './gateway-lifecycle-operation-record.js';
import {
	createManagedGatewayZoneRuntime as createManagedGatewayZoneRuntimeImpl,
	requireManagedGatewayStartResult,
} from './managed-gateway-zone-runtime.js';
import type { GatewayZoneRuntimeHandle } from './zone-runtime-types.js';

const managedGatewayZoneRuntimeTestRoot = path.join(
	tmpdir(),
	`agent-vm-managed-gateway-zone-runtime-test-${process.pid}`,
);

const preflightedGatewayImage = {
	built: false,
	fingerprint: 'preflighted-fingerprint',
	imageReference: '/tmp/preflighted-gateway-image',
} satisfies ManagedVmImageBuildResult;

const testExpectedAdmissionCohort = {
	controlIdentity: {
		controllerEpoch: 'controller-epoch-1',
		generationId: 'gateway-generation-1',
		peerId: 'tool-portal-control',
		processEpoch: 'tool-portal-process-1',
	},
	fence: {
		controllerEpoch: 'controller-epoch-1',
		gatewayEpoch: 'gateway-epoch-1',
		vmId: 'gateway-vm-test',
		zoneId: 'shravan',
	},
	frameworkIdentity: {
		attachmentGeneration: 1,
		clientKind: 'openclaw-managed-plugin',
		configuredAgentIds: ['main'],
		frameworkEpoch: 'openclaw-framework-epoch-1',
		frameworkKind: 'openclaw',
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
	providerRevision: 'provider-revision-1',
	requiredBackendRevision: 'backend-revision-1',
	semanticRevision: 'semantic-revision-1',
	toolPortalIdentity: {
		processEpoch: 'tool-portal-process-1',
		role: 'tool-portal',
		runtimeEpoch: 'tool-portal-runtime-1',
		serviceId: 'tool-portal-service-1',
	},
	udsIdentity: {
		frameworkEpoch: 'openclaw-framework-epoch-1',
		gatewayEpoch: 'gateway-epoch-1',
		runtimeEpoch: 'tool-portal-runtime-1',
		socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
	},
} satisfies GatewayExpectedAdmissionCohort;

const testManagedGatewayBootContract = createManagedGatewayBootContract({
	bootEntry: 'openclaw-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'openclaw',
	ingress: { guestPort: 18_789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/openclaw-service.log',
		serviceName: 'agent-vm-openclaw-test',
	},
	readiness: { guestPort: 18_789, kind: 'framework-http', path: '/readyz' },
	role: 'framework-service',
});

const systemConfig = {
	schemaVersion: 2,
	storageRootDir: managedGatewayZoneRuntimeTestRoot,
	cacheDir: path.join(managedGatewayZoneRuntimeTestRoot, 'cache'),
	controllerStateDir: path.join(managedGatewayZoneRuntimeTestRoot, 'controller-state'),
	controllerRuntimeDir: path.join(managedGatewayZoneRuntimeTestRoot, 'controller-runtime'),
	host: {
		controllerPort: 18800,
		projectNamespace: 'gateway-runtime-tests',
	},
	imageProfiles: {
		gateways: {
			openclaw: { type: 'openclaw', buildConfig: './gateway.json' },
		},
		toolVms: {
			standard: { type: 'toolVm', buildConfig: './tool.json' },
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './shravan/openclaw.json',
				stateDir: path.join(managedGatewayZoneRuntimeTestRoot, 'state', 'shravan'),
				zoneFilesDir: path.join(managedGatewayZoneRuntimeTestRoot, 'zone-files', 'shravan'),
				zoneRuntimeDir: path.join(managedGatewayZoneRuntimeTestRoot, 'shravan', 'runtime'),
			},
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
	tcpPool: { basePort: 19000, size: 5 },
	toolVmProfiles: {
		standard: {
			cpus: 1,
			imageProfile: 'standard',
			memory: '1G',
		},
	},
} satisfies SystemConfig;

const loadedSystemConfig = {
	...systemConfig,
	systemConfigPath: path.join(managedGatewayZoneRuntimeTestRoot, 'config', 'system.json'),
} satisfies LoadedSystemConfig;

const testManagedGatewayRuntimeRecordTarget = resolveControllerGatewayRecordTargets({
	gatewayStateRoot: resolveControllerGatewayStateRoot({
		controllerStateRoot: createControllerStateRoot({
			controllerStateDirectoryPath: loadedSystemConfig.controllerStateDir,
		}),
		zoneId: 'shravan',
	}),
}).managedGatewayRuntimeRecord;

let nextOwnedDirectoryInode = 20_000;
const testManagedVmOwnedDirectories = {
	openHostDirectory(hostPath: string): OwnedHostDirectory {
		let state: OwnedHostDirectory['state'] = 'acquired';
		const identity = {
			canonicalPath: path.resolve(hostPath),
			device: 1,
			inode: nextOwnedDirectoryInode,
		};
		nextOwnedDirectoryInode += 1;
		return {
			close(): void {
				state = 'closed';
			},
			consume() {
				if (state !== 'acquired') {
					throw new Error(`Test owned directory '${identity.canonicalPath}' was consumed twice.`);
				}
				state = 'adapter-owned';
				return {
					close(): void {
						state = 'closed';
					},
					identity,
					get state(): 'adapter-owned' | 'closed' {
						return state === 'closed' ? 'closed' : 'adapter-owned';
					},
				};
			},
			identity,
			get state() {
				return state;
			},
		};
	},
} satisfies ManagedVmOwnedDirectoryCapability;

const testGatewayRuntimeArtifactLimits = Object.freeze({
	maximumArtifactBytes: 1_024 * 1_024,
	maximumArtifactCount: 32,
	maximumLifetimeMs: 5 * 60 * 1_000,
	maximumTotalBytes: 8 * 1_024 * 1_024,
}) satisfies GatewayRuntimeArtifactLimits;

afterEach(async () => {
	await rm(managedGatewayZoneRuntimeTestRoot, { force: true, recursive: true });
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
	readonly gatewayIdentity?: GatewayEpochIdentity;
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
	readonly runtimeRecordTarget?: ManagedGatewayZoneRuntimeOptions['runtimeRecordTarget'];
};

function createTestVmOwnership(
	options: {
		readonly destroyLive?: GatewayVmLifecycleAuthority['destroyLive'];
		readonly gatewayIdentity?: GatewayEpochIdentity;
		readonly vmId?: string;
	} = {},
): GatewayVmLifecycleAuthority {
	const vmId = options.vmId ?? 'gateway-vm-test';
	const gatewayIdentity =
		options.gatewayIdentity ??
		({
			bootId: `${vmId}-boot`,
			controllerEpoch: 'controller-epoch-1',
			gatewayEpochId: `${vmId}-epoch`,
			gatewayVmId: vmId,
			generationId: `${vmId}-generation`,
			zoneId: 'shravan',
		} satisfies GatewayEpochIdentity);
	return {
		attachGatewayVm: (attachedVmId) => {
			if (attachedVmId !== vmId) {
				throw new Error(`Expected Gateway VM '${vmId}', received '${attachedVmId}'.`);
			}
			return structuredClone(gatewayIdentity);
		},
		containPendingCreate: async ({ closeLateCreatedVm, pendingCreate }) => {
			await closeLateCreatedVm(await pendingCreate);
		},
		abandonUnattachedGatewaySeedAfter: async (cleanupOwnedResources) => {
			await cleanupOwnedResources();
		},
		destroyLive:
			options.destroyLive ??
			(async (terminateVm) => {
				await terminateVm();
			}),
		gatewayIdentity: structuredClone(gatewayIdentity),
		gatewaySeed: structuredClone(gatewayIdentity),
	};
}

function createTestGatewayIdentity(vmId: string): GatewayEpochIdentity {
	return {
		bootId: `${vmId}-boot`,
		controllerEpoch: 'controller-epoch-1',
		gatewayEpochId: `${vmId}-epoch`,
		gatewayVmId: vmId,
		generationId: `${vmId}-generation`,
		zoneId: 'shravan',
	};
}

function createManagedGatewayZoneRuntime(
	options: TestManagedGatewayZoneRuntimeOptions,
): ReturnType<typeof createManagedGatewayZoneRuntimeImpl> {
	const { createVmOwnership, restartGatewayZone, runtimeRecordTarget, ...runtimeOptions } = options;
	const runtimeOptionsWithTestDefaults = {
		...runtimeOptions,
		gatewayRuntimeArtifactLimits: testGatewayRuntimeArtifactLimits,
		runtimeRecordTarget: runtimeRecordTarget ?? testManagedGatewayRuntimeRecordTarget,
	};
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
		managedVmImages: { prepareImage: async () => preflightedGatewayImage },
		managedVmOwnedDirectories: testManagedVmOwnedDirectories,
		preflightGatewayZoneStart: async (startOptions) => {
			const secretResolver = startOptions.secretResolver ?? options.secretResolver;
			const gatewaySecretRefs = {
				OPENCLAW_GATEWAY_TOKEN: { ref: 'OPENCLAW_GATEWAY_TOKEN', source: 'environment' },
			} as const;
			const resolvedGatewaySecrets = await secretResolver.resolveAll(gatewaySecretRefs);
			return {
				image: preflightedGatewayImage,
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
		...runtimeOptionsWithTestDefaults,
		createVmOwnership:
			createVmOwnership ?? (async () => createTestVmOwnership({ vmId: 'gateway-vm-created' })),
		...(restartGatewayZone
			? {
					restartGatewayZone: async (...args: Parameters<ManagedGatewayRestartGatewayZone>) => {
						const result = await restartGatewayZone(...args);
						return {
							...result,
							bootContract: testManagedGatewayBootContract,
							destroyGateway: result.destroyGateway ?? (async () => ({ kind: 'destroyed-clean' })),
							executionModel: 'managed-gateway',
							expectedCohort: testExpectedAdmissionCohort,
							gatewayIdentity: result.gatewayIdentity ?? createTestGatewayIdentity(result.vm.id),
							vm: {
								...result.vm,
								enableSsh: async (enableSshOptions) => {
									const access = await result.vm.enableSsh(enableSshOptions);
									return {
										command: access.command ?? 'ssh sandbox@127.0.0.1',
										identityFile: access.identityFile ?? '/tmp/test-identity',
										user: access.user ?? 'sandbox',
										...access,
									};
								},
							},
						};
					},
				}
			: {}),
	});
}

function createResolvingSecretResolver(): SecretResolver {
	return {
		resolve: async () => 'resolved-secret',
		resolveAll: async (secretRefs) =>
			Object.fromEntries(
				Object.keys(secretRefs).map((secretName) => [secretName, `resolved:${secretName}`]),
			),
	};
}

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
	const relativePath = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function getOpenClawZone(): GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'openclaw' }>;
} {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === 'shravan');
	if (zone?.gateway.type !== 'openclaw') {
		throw new Error('Expected shravan OpenClaw test zone.');
	}
	return zone;
}

function getHermesZone(): GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'hermes' }>;
} {
	const openClawZone = getOpenClawZone();
	return {
		...openClawZone,
		agents: [{ id: 'main' }],
		gateway: {
			config: './hermes/config.yaml',
			cpus: openClawZone.gateway.cpus,
			imageProfile: 'hermes',
			memory: openClawZone.gateway.memory,
			port: openClawZone.gateway.port,
			profilesByAgent: { main: 'main' },
			profileSecretProjectionsByAgent: {
				main: { DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN' },
			},
			stateDir: openClawZone.gateway.stateDir,
			type: 'hermes',
			zoneFilesDir: openClawZone.gateway.zoneFilesDir,
			zoneRuntimeDir: openClawZone.gateway.zoneRuntimeDir,
		},
		id: 'hermes-zone',
		secrets: {},
	};
}

describe('Managed Gateway zone runtime test fixture paths', () => {
	it.each([
		{ gatewayType: 'hermes', zone: getHermesZone() },
		{ gatewayType: 'openclaw', zone: getOpenClawZone() },
	] as const)(
		'derives the exact $gatewayType runtime discriminant from its zone',
		({ gatewayType, zone }) => {
			const runtime = createManagedGatewayZoneRuntime({
				now: () => 1_000,
				secretResolver: createResolvingSecretResolver(),
				systemConfig: loadedSystemConfig,
				zone,
			});

			expect(runtime.gatewayType).toBe(gatewayType);
		},
	);

	it('contains and rejects a direct-process result at the OpenClaw lifecycle boundary', async () => {
		const destroyGateway = vi.fn(async () => ({ kind: 'destroyed-clean' }) as const);
		const unexpectedDirectProcessResult = {
			destroyGateway,
			executionModel: 'direct-process',
			gatewayIdentity: createTestGatewayIdentity('unexpected-direct-process-vm'),
			image: preflightedGatewayImage,
			ingress: { host: '127.0.0.1', port: 18_791 },
			processSpec: {
				bootstrapCommand: 'bootstrap-worker',
				guestListenPort: 18_789,
				healthCheck: { type: 'http', port: 18_789, path: '/health' },
				logPath: '/tmp/agent-vm-worker.log',
				startCommand: 'start-worker',
			},
			processTarget: {
				hostPid: 48_000,
				processIdentity: {
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				},
				vmId: 'unexpected-direct-process-vm',
			},
			vm: {
				enableSsh: vi.fn(async () => ({
					close: vi.fn(async () => undefined),
					command: 'ssh sandbox@127.0.0.1',
					host: '127.0.0.1',
					identityFile: '/tmp/test-identity',
					port: 19_000,
					serverHostKey: TEST_SSH_SERVER_HOST_KEY,
					user: 'sandbox',
				})),
				exec: vi.fn(() => createManagedExecProcessStub()),
				getHostProcessId: () => 48_000,
				id: 'unexpected-direct-process-vm',
			},
			zone: getOpenClawZone(),
		} satisfies DirectProcessGatewayZoneStartResult;

		await expect(requireManagedGatewayStartResult(unexpectedDirectProcessResult)).rejects.toThrow(
			"Managed Gateway zone runtime rejected direct-process Gateway result for VM 'unexpected-direct-process-vm'",
		);

		expect(destroyGateway).toHaveBeenCalledOnce();
	});

	it('reports bounded cleanup debt after containing a rejected direct-process result', async () => {
		const destroyGateway = vi.fn(
			async () =>
				({
					cleanupFailures: [
						{ error: new Error('secret-bearing cleanup detail'), stage: 'runtime-record-deletion' },
					] as const,
					kind: 'destroyed-cleanup-incomplete',
				}) as const,
		);
		const directProcessResult = {
			destroyGateway,
			executionModel: 'direct-process',
			gatewayIdentity: createTestGatewayIdentity('cleanup-debt-direct-process-vm'),
			image: preflightedGatewayImage,
			ingress: { host: '127.0.0.1', port: 18_791 },
			processSpec: {
				bootstrapCommand: 'bootstrap-worker',
				guestListenPort: 18_789,
				healthCheck: { type: 'http', port: 18_789, path: '/health' },
				logPath: '/tmp/agent-vm-worker.log',
				startCommand: 'start-worker',
			},
			processTarget: {
				hostPid: 48_000,
				processIdentity: {
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				},
				vmId: 'cleanup-debt-direct-process-vm',
			},
			vm: {
				enableSsh: vi.fn(async () => ({
					close: vi.fn(async () => undefined),
					command: 'ssh sandbox@127.0.0.1',
					host: '127.0.0.1',
					identityFile: '/tmp/test-identity',
					port: 19_000,
					serverHostKey: TEST_SSH_SERVER_HOST_KEY,
					user: 'sandbox',
				})),
				exec: vi.fn(() => createManagedExecProcessStub()),
				getHostProcessId: () => 48_000,
				id: 'cleanup-debt-direct-process-vm',
			},
			zone: getOpenClawZone(),
		} satisfies DirectProcessGatewayZoneStartResult;

		const rejection = await requireManagedGatewayStartResult(directProcessResult).catch(
			(error: unknown) => error,
		);
		if (!(rejection instanceof Error)) {
			throw new Error('Expected direct-process rejection to be an Error.');
		}
		expect(rejection.message).toMatch(/runtime-record-deletion/u);
		expect(rejection.message).not.toMatch(/secret-bearing cleanup detail/u);
		expect(destroyGateway).toHaveBeenCalledOnce();
	});

	it('models only the managed sibling-service runtime handle', () => {
		expectTypeOf<GatewayZoneRuntimeHandle['executionModel']>().toEqualTypeOf<'managed-gateway'>();
		expectTypeOf<GatewayZoneRuntimeHandle>().toHaveProperty('bootContract');
		expectTypeOf<GatewayZoneRuntimeHandle>().toHaveProperty('expectedCohort');
		expectTypeOf<GatewayZoneRuntimeHandle>().not.toHaveProperty('processSpec');
		expectTypeOf<GatewayZoneRuntimeHandle>().not.toHaveProperty('processEpoch');
		expectTypeOf<GatewayZoneRuntimeHandle>().not.toHaveProperty('openClawProcessSupervisor');
		expectTypeOf<GatewayZoneRuntimeHandle>().not.toHaveProperty('openClawProcessEpochOwner');
	});

	it('keeps generated lifecycle records outside the repository checkout', () => {
		const generatedPaths = [
			systemConfig.cacheDir,
			systemConfig.controllerRuntimeDir,
			getOpenClawZone().gateway.stateDir,
			getOpenClawZone().gateway.zoneFilesDir,
		];

		expect(
			generatedPaths.filter((generatedPath) =>
				isPathInsideDirectory(path.resolve(generatedPath), process.cwd()),
			),
		).toEqual([]);
	});
});

describe('createManagedGatewayZoneRuntime host process liveness', () => {
	it('normalizes managed VM exec processes into command results', async () => {
		const gatewayExec = vi.fn((_command: string) =>
			createManagedExecProcessStub({
				exitCode: 7,
				stderr: 'command stderr',
				stdout: 'command stdout',
			}),
		);
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: vi.fn(async () => undefined),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: gatewayExec,
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-exec-normalized',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();

		await expect(runtime.exec('echo hello')).resolves.toEqual({
			exitCode: 7,
			stderr: 'command stderr',
			stdout: 'command stdout',
		});
		await expect(runtime.getLogs()).resolves.toEqual({
			output: 'command stdout',
			zoneId: 'shravan',
		});
		const logCommand = gatewayExec.mock.calls.at(-1)?.[0];
		expect(logCommand).toContain('/var/log/agent-vm/openclaw-service.log');
		expect(logCommand).toContain('/var/log/agent-vm/tool-portal-service.log');
		expect(logCommand).not.toContain('gateway-boot-latest.log');
	});

	it('does not project a started gateway as running when its host pid is missing', async () => {
		const runtime = createManagedGatewayZoneRuntime({
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: vi.fn(async () => undefined),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => null,
					id: 'gateway-vm-missing-pid',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();

		expect(runtime.getSnapshot()).toEqual({
			lastError: "vm-process-missing: Gateway VM host pid is unavailable for zone 'shravan'.",
			lifecycleState: 'failed',
		});
	});

	it('classifies a started gateway as vm-process-missing when its host pid is dead', async () => {
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => false,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: vi.fn(async () => undefined),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-dead-pid',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();

		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'vm-process-missing' },
			kind: 'failed',
		});
		expect(runtime.getSnapshot()).toEqual({
			lastError: "vm-process-missing: Gateway VM host pid 48284 is not alive for zone 'shravan'.",
			lifecycleState: 'failed',
		});
	});

	it('projects gateway ownership preflight failures as owner-unsafe', async () => {
		const ownershipError = new GatewayOwnershipUnsafeError({
			evidence: {
				kind: 'missing-record-port-owned',
				ownerCommand: 'qemu-system-aarch64 -m 4G',
				ownerPid: 98_765,
				port: 18_791,
			},
			message:
				'Gateway runtime record is missing but configured ingress port 18791 is owned by pid 98765.',
		});
		const runtime = createManagedGatewayZoneRuntime({
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				throw ownershipError;
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.start()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'owner-unsafe',
		});

		expect(runtime.getLifecycleState()).toEqual({
			evidence: ownershipError.evidence,
			kind: 'owner-unsafe',
		});
		expect(runtime.getSnapshot()).toEqual({
			lastError: ownershipError.message,
			lifecycleState: 'failed',
		});
	});
});

describe('createManagedGatewayZoneRuntime credentials refresh', () => {
	it('keeps a running gateway active when refresh secret preflight fails', async () => {
		const closeGatewayVm = vi.fn(async () => undefined);
		const runtime = createManagedGatewayZoneRuntime({
			createFreshSecretResolver: vi.fn(async () => ({
				resolve: async () => {
					throw new Error('fresh resolver should not resolve single secrets');
				},
				resolveAll: async () => {
					throw new Error('1Password SDK resolveAll failed');
				},
			})),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: closeGatewayVm,
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-live-before-refresh',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});
		await runtime.start();

		await expect(runtime.refreshCredentials()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'secret-resolution-failed',
		});

		expect(closeGatewayVm).not.toHaveBeenCalled();
		expect(runtime.getLifecycleState()).toMatchObject({
			gateway: expect.objectContaining({
				vm: expect.objectContaining({ id: 'gateway-vm-live-before-refresh' }),
			}),
			kind: 'running',
		});
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-live-before-refresh' } },
			lastError: expect.stringContaining('1Password SDK resolveAll failed'),
			lifecycleState: 'running',
		});
	});

	it('resolves gateway secrets once and restarts with a preflighted controller-side resolver', async () => {
		const staleResolveAll = vi.fn(async () => {
			throw new Error('stale resolver should not resolve during credentials refresh');
		});
		const freshResolveAll = vi.fn(async (refs: Parameters<SecretResolver['resolveAll']>[0]) =>
			Object.fromEntries(
				Object.keys(refs).map((secretName) => [secretName, `fresh:${secretName}`]),
			),
		);
		const staleResolver: SecretResolver = {
			resolve: async () => {
				throw new Error('stale resolver should not resolve during credentials refresh');
			},
			resolveAll: staleResolveAll,
		};
		const freshResolver: SecretResolver = {
			resolve: async () => 'fresh-single-secret',
			resolveAll: freshResolveAll,
		};
		const restartResolverRefs: unknown[] = [];
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createManagedGatewayZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			createFreshSecretResolver: vi.fn(async () => freshResolver),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async (_zoneId, startOptions) => {
				if (!startOptions?.secretResolver) {
					throw new Error('restart did not receive a fresh resolver');
				}
				restartResolverRefs.push(
					await startOptions.secretResolver.resolveAll({
						OPENCLAW_GATEWAY_TOKEN: {
							ref: 'OPENCLAW_GATEWAY_TOKEN',
							source: 'environment',
						},
					}),
				);
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						close: vi.fn(async () => undefined),
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => 48_284,
						id: 'gateway-vm-fresh-resolver',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					zone: getOpenClawZone(),
				};
			},
			secretResolver: staleResolver,
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.refreshCredentials()).resolves.toEqual({ ok: true, zoneId: 'shravan' });

		expect(staleResolveAll).not.toHaveBeenCalled();
		expect(freshResolveAll).toHaveBeenCalledTimes(1);
		expect(restartResolverRefs).toEqual([
			{ OPENCLAW_GATEWAY_TOKEN: 'fresh:OPENCLAW_GATEWAY_TOKEN' },
		]);
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-fresh-resolver' } },
			lifecycleState: 'running',
		});
		expect(operationRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'credentials-refresh-requested',
					operationTrigger: 'credentials-refresh',
				}),
				expect.objectContaining({
					kind: 'cold-start-requested',
					operationTrigger: 'credentials-refresh',
				}),
			]),
		);
		const refreshOperationId = operationRecords.find(
			(record) => record.kind === 'credentials-refresh-requested',
		)?.operationId;
		expect(
			operationRecords.filter((record) => record.operationId === refreshOperationId).length,
		).toBeGreaterThanOrEqual(2);
	});

	it('records credentials-refresh operation failure when fresh resolver construction fails', async () => {
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createManagedGatewayZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			createFreshSecretResolver: vi.fn(async () => {
				throw new Error('1Password SDK failed to create client');
			}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				throw new Error('start should not run');
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.refreshCredentials()).rejects.toThrow('1Password SDK failed');

		const refreshRequested = operationRecords.find(
			(record) => record.kind === 'credentials-refresh-requested',
		);
		expect(refreshRequested).toMatchObject({
			kind: 'credentials-refresh-requested',
			operationTrigger: 'credentials-refresh',
		});
		expect(operationRecords).toContainEqual(
			expect.objectContaining({
				errorCode: 'secret-resolution-failed',
				kind: 'operation-failed',
				operationId: refreshRequested?.operationId,
				operationTrigger: 'credentials-refresh',
			}),
		);
	});

	it('keeps a live gateway running when credentials-refresh resolver construction fails', async () => {
		const closeGatewayVm = vi.fn(async () => undefined);
		const runtime = createManagedGatewayZoneRuntime({
			createFreshSecretResolver: async () => {
				throw new Error('1Password SDK failed');
			},
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: closeGatewayVm,
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-live-refresh-preflight',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();

		await expect(runtime.refreshCredentials()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'secret-resolution-failed',
		});

		expect(closeGatewayVm).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-live-refresh-preflight' } },
			lastError: '1Password SDK failed',
			lifecycleState: 'running',
		});
		expect(runtime.getDiagnosis()).toMatchObject({
			currentRecoveryBlocker: 'none',
			originalOutageCause: { kind: 'unknown' },
			selectedZoneReadiness: 'running',
		});
	});

	it('records credentials-refresh operation failure when fresh resolver cannot resolve zone secrets', async () => {
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createManagedGatewayZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			createFreshSecretResolver: vi.fn(async () => ({
				resolve: async () => '',
				resolveAll: async () => {
					throw new Error('1Password SDK resolveAll failed: op failed');
				},
			})),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				throw new Error('start should not run');
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.refreshCredentials()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'secret-resolution-failed',
		});

		const refreshRequested = operationRecords.find(
			(record) => record.kind === 'credentials-refresh-requested',
		);
		expect(refreshRequested).toMatchObject({
			kind: 'credentials-refresh-requested',
			operationTrigger: 'credentials-refresh',
		});
		expect(operationRecords).toContainEqual(
			expect.objectContaining({
				errorCode: 'secret-resolution-failed',
				kind: 'operation-failed',
				operationId: refreshRequested?.operationId,
				operationTrigger: 'credentials-refresh',
			}),
		);
		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'secret-resolution-failed' },
			kind: 'failed',
		});
	});

	it('does not overwrite a proven VM-process outage with a later secret refresh blocker', async () => {
		const runtime = createManagedGatewayZoneRuntime({
			createFreshSecretResolver: vi.fn(async () => ({
				resolve: async () => '',
				resolveAll: async () => {
					throw new Error('1Password SDK resolveAll failed: op failed');
				},
			})),
			isProcessAlive: () => false,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: vi.fn(async () => undefined),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-dead-before-refresh',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'vm-process-missing' },
			kind: 'failed',
		});

		await expect(runtime.refreshCredentials()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'secret-resolution-failed',
		});

		expect(runtime.getDiagnosis()).toMatchObject({
			currentRecoveryBlocker: 'secret-resolution-failed',
			originalOutageCause: {
				errorCode: 'vm-process-missing',
				eventKind: 'gateway-lifecycle-operation',
				kind: 'proven',
			},
		});
	});
});

describe('createManagedGatewayZoneRuntime cold-start recovery', () => {
	it('closes a stale in-memory gateway handle before cold-starting after VM process death', async () => {
		const liveHostPids = new Set([48_284, 48_285]);
		const callOrder: string[] = [];
		const firstGatewayDestroy = vi.fn(async () => {
			callOrder.push('close-gateway-1');
			return { kind: 'destroyed-clean' } as const;
		});
		let gatewayStartCount = 0;
		const restartGatewayZone = vi.fn(async (): Promise<TestGatewayZoneStartResult> => {
			gatewayStartCount += 1;
			callOrder.push(`start-gateway-${String(gatewayStartCount)}`);
			const hostPid = 48_283 + gatewayStartCount;
			return {
				destroyGateway:
					gatewayStartCount === 1
						? firstGatewayDestroy
						: vi.fn(async () => ({ kind: 'destroyed-clean' }) as const),
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => hostPid,
					id: `gateway-vm-${String(gatewayStartCount)}`,
				},
				zone: getOpenClawZone(),
			};
		});
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: (pid) => liveHostPids.has(pid),
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone,
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		liveHostPids.delete(48_284);
		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'vm-process-missing' },
			kind: 'failed',
		});

		await expect(runtime.coldStart()).resolves.toMatchObject({ leaseReleaseFailureCount: 0 });

		expect(firstGatewayDestroy).toHaveBeenCalledOnce();
		expect(callOrder).toEqual(['start-gateway-1', 'close-gateway-1', 'start-gateway-2']);
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { hostPid: 48_285, id: 'gateway-vm-2' } },
			lifecycleState: 'running',
		});
	});

	it('starts a failed gateway without running a predecessor destruction transaction', async () => {
		const restartGatewayZone = vi
			.fn()
			.mockRejectedValueOnce(new Error("Failed to resolve zone secrets for zone 'shravan'."))
			.mockResolvedValueOnce({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: vi.fn(async () => undefined),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-cold-start',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				zone: getOpenClawZone(),
			});
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone,
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.start()).rejects.toThrow('Failed to start zone');
		const coldStartResult = await runtime.coldStart();
		expect(coldStartResult).toMatchObject({ leaseReleaseFailureCount: 0 });
		expect(coldStartResult.operationId).toMatch(/^shravan-cold-start-/u);

		expect(restartGatewayZone).toHaveBeenCalledTimes(2);
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-cold-start' } },
			lifecycleState: 'running',
		});
	});
});

describe('createManagedGatewayZoneRuntime stop and restart safety', () => {
	it('does not expose legacy PID cleanup as Gateway successor authority', () => {
		type RuntimeOptions = Parameters<typeof createManagedGatewayZoneRuntimeImpl>[0];

		expectTypeOf<RuntimeOptions>().toMatchTypeOf<{
			readonly createVmOwnership: unknown;
		}>();
		expectTypeOf<RuntimeOptions>().not.toMatchTypeOf<{
			readonly cleanupOrphanedGatewayIfPresent: unknown;
		}>();
		expectTypeOf<RuntimeOptions>().not.toMatchTypeOf<{
			readonly leaseManager: unknown;
		}>();
		expectTypeOf<GatewayZoneRuntimeHandle>().not.toHaveProperty('terminateVm');
		expectTypeOf<GatewayZoneRuntimeHandle>().not.toHaveProperty('vmOwnership');
		expectTypeOf<GatewayZoneRuntimeHandle>().toMatchTypeOf<{
			destroyGateway(): ReturnType<GatewayZoneRuntimeHandle['destroyGateway']>;
			readonly gatewayIdentity: GatewayEpochIdentity;
		}>();
	});

	it('admits a preflighted successor after proven destruction with bounded cleanup debt', async () => {
		const closeGateway = vi.fn(async () => undefined);
		const destroyGateway = vi.fn(async () => {
			await closeGateway();
			return {
				cleanupFailures: [
					{
						error: new Error('secret-bearing boot-input cleanup detail'),
						stage: 'managed-boot-input-release',
					},
				] as const,
				kind: 'destroyed-cleanup-incomplete',
			} as const;
		});
		let startCount = 0;
		let underlyingResolveAllCount = 0;
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const replacementStartImages: unknown[] = [];
		const secretResolver: SecretResolver = {
			resolve: async () => 'resolved-auth-profile',
			resolveAll: async (secretRefs) => {
				underlyingResolveAllCount += 1;
				if (underlyingResolveAllCount > 1) {
					throw new Error('post-close 1Password lookup should not run');
				}
				return Object.fromEntries(
					Object.keys(secretRefs).map((secretName) => [secretName, `resolved:${secretName}`]),
				);
			},
		};
		const runtime = createManagedGatewayZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async (_zoneId, startOptions = {}) => {
				startCount += 1;
				if (startCount > 1) {
					replacementStartImages.push(startOptions.prebuiltImage);
					await (startOptions.secretResolver ?? secretResolver).resolveAll({
						OPENCLAW_GATEWAY_TOKEN: {
							ref: 'OPENCLAW_GATEWAY_TOKEN',
							source: 'environment',
						},
					});
				}
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						close: closeGateway,
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => 48_284,
						id: startCount === 1 ? 'gateway-vm-live' : 'gateway-vm-replacement',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					destroyGateway,
					zone: getOpenClawZone(),
				};
			},
			secretResolver,
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.restart()).resolves.toMatchObject({ leaseReleaseFailureCount: 0 });

		expect(underlyingResolveAllCount).toBe(1);
		expect(replacementStartImages).toEqual([preflightedGatewayImage]);
		expect(closeGateway).toHaveBeenCalledTimes(1);
		expect(destroyGateway).toHaveBeenCalledTimes(1);
		expect(operationRecords).toContainEqual(
			expect.objectContaining({
				errorMessage: expect.stringContaining('managed-boot-input-release'),
				kind: 'operation-failed',
			}),
		);
		expect(operationRecords.map(({ errorMessage }) => errorMessage).join('\n')).not.toContain(
			'secret-bearing boot-input cleanup detail',
		);
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-replacement' } },
			lifecycleState: 'running',
		});
	});

	it('blocks Gateway replacement when any child lease disposition is incomplete', async () => {
		const closeGateway = vi.fn(async () => undefined);
		const destroyGateway = vi.fn(async () => {
			throw new Error('child lease disposition is incomplete');
		});
		let startCount = 0;
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				startCount += 1;
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						close: closeGateway,
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => 48_284,
						id: `gateway-vm-${String(startCount)}`,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					destroyGateway,
					zone: getOpenClawZone(),
				};
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.restart()).rejects.toThrow(/child lease disposition.*incomplete/u);

		expect(destroyGateway).toHaveBeenCalledOnce();
		expect(closeGateway).not.toHaveBeenCalled();
		expect(startCount).toBe(1);
		expect(runtime.getLifecycleState()).toMatchObject({
			coldStartEligible: false,
			error: { code: 'owner-unsafe' },
			kind: 'failed',
		});
		expect(runtime.getSnapshot()).toMatchObject({ lifecycleState: 'failed' });
	});

	it('blocks cold-start G2 when stale G1 ownership cannot destroy its retained child', async () => {
		const destroyGateway = vi.fn(async () => {
			throw new Error('cold-start child destruction incomplete');
		});
		let gatewayStartCount = 0;
		let gatewayProcessAlive = true;
		const restartGatewayZone = vi.fn(async () => {
			gatewayStartCount += 1;
			const gatewayVmId = `gateway-vm-${String(gatewayStartCount)}`;
			return {
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: vi.fn(async () => undefined),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => 48_284,
					id: gatewayVmId,
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				destroyGateway,
				zone: getOpenClawZone(),
			};
		});
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => gatewayProcessAlive,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone,
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		gatewayProcessAlive = false;
		expect(runtime.getSnapshot()).toMatchObject({ lifecycleState: 'failed' });
		await expect(runtime.coldStart()).rejects.toThrow('cold-start child destruction incomplete');

		expect(destroyGateway).toHaveBeenCalledOnce();
		expect(restartGatewayZone).toHaveBeenCalledOnce();
		expect(runtime.getLifecycleState()).toMatchObject({
			coldStartEligible: false,
			error: { code: 'owner-unsafe' },
			kind: 'failed',
		});
	});

	it('refuses gateway replacement when exact termination remains incomplete', async () => {
		const destroyGateway = vi.fn(async () => {
			throw new Error('exact Gateway termination incomplete');
		});
		let startCount = 0;
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				startCount += 1;
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						close: vi.fn(async () => undefined),
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => 48_284,
						id: 'gateway-vm-incomplete-close',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					destroyGateway,
					zone: getOpenClawZone(),
				};
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.restart()).rejects.toThrow(/incomplete/u);

		expect(destroyGateway).toHaveBeenCalledOnce();
		expect(startCount).toBe(1);
		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'owner-unsafe' },
			kind: 'failed',
		});
	});

	it('preflights gateway secrets before closing a running gateway for restart', async () => {
		const closeGateway = vi.fn(async () => undefined);
		const destroyGateway = vi.fn(async () => {
			await closeGateway();
			return { kind: 'destroyed-clean' } as const;
		});
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: closeGateway,
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-live-before-preflight-failure',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				destroyGateway,
				zone: getOpenClawZone(),
			}),
			secretResolver: {
				resolve: async () => '',
				resolveAll: async () => {
					throw new Error('1Password SDK resolveAll failed before op CLI fallback');
				},
			},
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.restart()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'secret-resolution-failed',
		});

		expect(closeGateway).not.toHaveBeenCalled();
		expect(destroyGateway).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-live-before-preflight-failure' } },
			lifecycleState: 'running',
		});
		expect(runtime.getDiagnosis().originalOutageCause).toEqual({ kind: 'unknown' });
	});

	it('preflights replacement image before closing a running gateway for restart', async () => {
		const closeGateway = vi.fn(async () => undefined);
		const destroyGateway = vi.fn(async () => {
			await closeGateway();
			return { kind: 'destroyed-clean' } as const;
		});
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			preflightGatewayZoneStart: async () => {
				throw new Error('gateway image build failed before replacement close');
			},
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: closeGateway,
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-live-before-image-preflight-failure',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				destroyGateway,
				zone: getOpenClawZone(),
			}),
			secretResolver: {
				resolve: async () => 'resolved',
				resolveAll: async (secretRefs) =>
					Object.fromEntries(
						Object.keys(secretRefs).map((secretName) => [secretName, `resolved:${secretName}`]),
					),
			},
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.restart()).rejects.toThrow(
			'gateway image build failed before replacement close',
		);

		expect(closeGateway).not.toHaveBeenCalled();
		expect(destroyGateway).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-live-before-image-preflight-failure' } },
			lifecycleState: 'running',
		});
	});

	it('uses command-free managed boot readiness metadata for health probes', async () => {
		const executedCommands: string[] = [];
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: vi.fn(async () => undefined),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn((command: string) => {
						executedCommands.push(command);
						return createManagedExecProcessStub({ stdout: '200' });
					}),
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-liveness',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();

		await expect(runtime.getHealth()).resolves.toMatchObject({
			ok: true,
			path: '/readyz',
			statusCode: 200,
		});
		await expect(runtime.getServiceHealth()).resolves.toMatchObject({
			ok: true,
			path: '/readyz',
			statusCode: 200,
		});
		expect(executedCommands).toHaveLength(2);
		expect(executedCommands.every((command) => command.includes('/readyz'))).toBe(true);
		expect(executedCommands.every((command) => !command.includes('/health'))).toBe(true);
	});

	it('exposes stopping state and blocks gateway commands while stop is pending', async () => {
		const closeDeferred = createDeferredPromise<void>();
		const terminationOrder: string[] = [];
		const destroyGateway = vi.fn(async () => {
			terminationOrder.push('terminate-started');
			await closeDeferred.promise;
			terminationOrder.push('terminate-complete');
			terminationOrder.push('runtime-record-deleted');
			return { kind: 'destroyed-clean' } as const;
		});
		const gatewayExec = vi.fn(() => createManagedExecProcessStub({ stdout: 'unexpected' }));
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: gatewayExec,
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-stopping',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				destroyGateway,
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const stopPromise = runtime.stop();
		await vi.waitFor(() => {
			expect(runtime.getLifecycleState()).toMatchObject({
				kind: 'stopping',
				next: 'stopped',
				previousGateway: { vm: { id: 'gateway-vm-stopping' } },
			});
		});

		await expect(runtime.exec('echo should-not-run')).rejects.toThrow(
			"Gateway runtime for zone 'shravan' is unavailable.",
		);
		expect(gatewayExec).not.toHaveBeenCalled();
		expect(destroyGateway).toHaveBeenCalledOnce();

		closeDeferred.resolve();
		await expect(stopPromise).resolves.toBeUndefined();
		expect(terminationOrder).toEqual([
			'terminate-started',
			'terminate-complete',
			'runtime-record-deleted',
		]);
		expect(runtime.getLifecycleState()).toEqual({ kind: 'stopped' });
	});

	it('classifies a stop failure as owner-unsafe failed instead of remaining stuck in stopping', async () => {
		const destroyGateway = vi.fn(async () => {
			throw new Error('gateway close timed out');
		});
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: vi.fn(async () => undefined),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-retained-after-stop-failure',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				destroyGateway,
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.stop()).rejects.toThrow('gateway close timed out');

		expect(destroyGateway).toHaveBeenCalledOnce();
		expect(runtime.getLifecycleState()).toEqual({
			coldStartEligible: false,
			error: {
				code: 'owner-unsafe',
				message: 'gateway close timed out',
			},
			kind: 'failed',
		});
		expect(runtime.getSnapshot()).toEqual({
			lastError: 'gateway close timed out',
			lifecycleState: 'failed',
		});
	});

	it('refuses auto-recovery replacement when exact Gateway destruction is unproven', async () => {
		let gatewayStartCount = 0;
		const oldGatewayDestroy = vi.fn(async (): Promise<GatewayZoneDestroyResult> => {
			throw new Error('gateway close timed out');
		});
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const hostPid = 48_284 + gatewayStartCount;
				return {
					destroyGateway:
						gatewayStartCount === 1
							? oldGatewayDestroy
							: vi.fn(async () => ({ kind: 'destroyed-clean' }) as const),
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18_791 },
					vm: {
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18_791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => hostPid,
						id: `gateway-vm-${String(gatewayStartCount)}`,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					zone: getOpenClawZone(),
				};
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.restart({ operationTrigger: 'auto-recovery' })).rejects.toThrow(
			'gateway close timed out',
		);

		expect(oldGatewayDestroy).toHaveBeenCalledOnce();
		expect(gatewayStartCount).toBe(1);
		expect(runtime.getSnapshot()).toMatchObject({
			lifecycleState: 'failed',
		});
	});

	it('rejects normal gateway access while restart is closing the old gateway', async () => {
		let gatewayStartCount = 0;
		const oldGatewayDestroyDeferred = createDeferredPromise<void>();
		const oldGatewayDestroy = vi.fn(async (): Promise<GatewayZoneDestroyResult> => {
			await oldGatewayDestroyDeferred.promise;
			return { kind: 'destroyed-clean' };
		});
		const oldGatewayExec = vi.fn(() => createManagedExecProcessStub({ stdout: 'unexpected' }));
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createManagedGatewayZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				return {
					destroyGateway:
						gatewayStartCount === 1
							? oldGatewayDestroy
							: vi.fn(async () => ({ kind: 'destroyed-clean' }) as const),
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
							host: '127.0.0.1',
							port: 22,
						})),
						exec:
							gatewayStartCount === 1
								? oldGatewayExec
								: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => 48_284 + gatewayStartCount,
						id: `gateway-vm-${String(gatewayStartCount)}`,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					zone: getOpenClawZone(),
				};
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart();
		await vi.waitFor(() => {
			expect(runtime.getLifecycleState()).toMatchObject({
				kind: 'stopping',
				next: 'starting',
				previousGateway: { vm: { id: 'gateway-vm-1' } },
			});
		});

		await expect(runtime.exec('date')).rejects.toThrow(
			"Gateway runtime for zone 'shravan' is unavailable.",
		);
		expect(oldGatewayExec).not.toHaveBeenCalled();

		oldGatewayDestroyDeferred.resolve();
		const restartResult = await restartPromise;
		expect(restartResult).toMatchObject({ leaseReleaseFailureCount: 0 });
		expect(restartResult.operationId).toBe(
			operationRecords.find((record) => record.kind === 'restart-requested')?.operationId,
		);
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-2' } },
			lifecycleState: 'running',
		});
	});

	it('records stale-generation-closed when a timed-out restart later starts a stale gateway', async () => {
		let gatewayStartCount = 0;
		let resolveStaleGatewayStart: ((value: TestGatewayZoneStartResult) => void) | undefined;
		const staleGatewayDestroy = vi.fn(async () => ({ kind: 'destroyed-clean' }) as const);
		const restartTimeoutCallbacks: (() => void)[] = [];
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const gatewayStartResult: TestGatewayZoneStartResult = {
					destroyGateway:
						gatewayStartCount === 2
							? staleGatewayDestroy
							: vi.fn(async () => ({ kind: 'destroyed-clean' }) as const),
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => 48_284 + gatewayStartCount,
						id: `gateway-vm-${gatewayStartCount}`,
					},
					zone: getOpenClawZone(),
				};
				if (gatewayStartCount === 2) {
					return await new Promise<typeof gatewayStartResult>((resolve) => {
						resolveStaleGatewayStart = resolve;
					});
				}
				return gatewayStartResult;
			},
			secretResolver: createResolvingSecretResolver(),
			setTimeoutImpl: (callback, delayMs) => {
				if (delayMs === 5_000) {
					restartTimeoutCallbacks.push(callback);
				}
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart({ timeoutMs: 5_000 });
		await vi.waitFor(() => {
			expect(restartTimeoutCallbacks).toHaveLength(1);
		});
		await vi.waitFor(() => {
			expect(resolveStaleGatewayStart).toBeDefined();
		});
		restartTimeoutCallbacks[0]?.();
		await expect(restartPromise).rejects.toThrow('restart timed out');
		if (!resolveStaleGatewayStart) {
			throw new Error('Expected stale gateway start to be pending.');
		}
		let shutdownSettled = false;
		const shutdownPromise = runtime.shutdown().then(() => {
			shutdownSettled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(shutdownSettled).toBe(false);
		resolveStaleGatewayStart({
			destroyGateway: staleGatewayDestroy,
			image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			vm: {
				enableSsh: vi.fn(async () => ({
					close: async () => {},
					serverHostKey: TEST_SSH_SERVER_HOST_KEY,
					host: '127.0.0.1',
					port: 22,
				})),
				exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
				getHostProcessId: () => 48_286,
				id: 'gateway-vm-stale',
			},
			zone: getOpenClawZone(),
		});
		await vi.waitFor(() => {
			expect(staleGatewayDestroy).toHaveBeenCalledOnce();
		});
		await expect(shutdownPromise).resolves.toBeUndefined();
		expect(shutdownSettled).toBe(true);

		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });
	});

	it('does not close the live gateway when restart preflight resolves after timeout', async () => {
		let gatewayStartCount = 0;
		const closeGateway = vi.fn(async () => undefined);
		const destroyGateway = vi.fn(async () => {
			await closeGateway();
			return { kind: 'destroyed-clean' } as const;
		});
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const restartTimeoutCallbacks: (() => void)[] = [];
		const preflightDeferred = createDeferredPromise<{
			readonly image: ManagedVmImageBuildResult;
			readonly secretResolver: ReturnType<typeof createResolvingSecretResolver>;
		}>();
		const runtime = createManagedGatewayZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			preflightGatewayZoneStart: async () => await preflightDeferred.promise,
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						close: closeGateway,
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => 48_284,
						id: `gateway-vm-${String(gatewayStartCount)}`,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					destroyGateway,
					zone: getOpenClawZone(),
				};
			},
			secretResolver: createResolvingSecretResolver(),
			setTimeoutImpl: (callback, delayMs) => {
				if (delayMs === 5_000) {
					restartTimeoutCallbacks.push(callback);
				}
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart({ timeoutMs: 5_000 });
		await vi.waitFor(() => {
			expect(restartTimeoutCallbacks).toHaveLength(1);
		});
		restartTimeoutCallbacks[0]?.();
		await expect(restartPromise).rejects.toThrow('restart timed out');

		preflightDeferred.resolve({
			image: { built: false, fingerprint: 'preflighted', imageReference: '/tmp/preflighted-image' },
			secretResolver: createResolvingSecretResolver(),
		});
		await vi.waitFor(() => {
			expect(operationRecords).toContainEqual(
				expect.objectContaining({
					errorCode: 'stale-generation-closed',
					kind: 'operation-failed',
				}),
			);
		});

		expect(closeGateway).not.toHaveBeenCalled();
		expect(destroyGateway).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-1' } },
			lifecycleState: 'running',
		});
	});

	it('destroys a timed-out replacement gateway through its typed transaction', async () => {
		let gatewayStartCount = 0;
		let resolveStaleGatewayStart: ((value: TestGatewayZoneStartResult) => void) | undefined;
		const staleGatewayDestroy = vi.fn(async () => ({ kind: 'destroyed-clean' }) as const);
		const restartTimeoutCallbacks: (() => void)[] = [];
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const gatewayStartResult: TestGatewayZoneStartResult = {
					destroyGateway:
						gatewayStartCount === 2
							? staleGatewayDestroy
							: vi.fn(async () => ({ kind: 'destroyed-clean' }) as const),
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => 48_284 + gatewayStartCount,
						id: `gateway-vm-${gatewayStartCount}`,
					},
					zone: getOpenClawZone(),
				};
				if (gatewayStartCount === 2) {
					return await new Promise<typeof gatewayStartResult>((resolve) => {
						resolveStaleGatewayStart = resolve;
					});
				}
				return gatewayStartResult;
			},
			secretResolver: createResolvingSecretResolver(),
			setTimeoutImpl: (callback, delayMs) => {
				if (delayMs === 5_000) {
					restartTimeoutCallbacks.push(callback);
				}
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart({ timeoutMs: 5_000 });
		await vi.waitFor(() => {
			expect(resolveStaleGatewayStart).toBeDefined();
		});
		restartTimeoutCallbacks[0]?.();
		await expect(restartPromise).rejects.toThrow('restart timed out');
		if (!resolveStaleGatewayStart) {
			throw new Error('Expected stale gateway start to be pending.');
		}
		resolveStaleGatewayStart({
			destroyGateway: staleGatewayDestroy,
			image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			vm: {
				enableSsh: vi.fn(async () => ({
					close: async () => {},
					serverHostKey: TEST_SSH_SERVER_HOST_KEY,
					host: '127.0.0.1',
					port: 22,
				})),
				exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
				getHostProcessId: () => 48_286,
				id: 'gateway-vm-stale',
			},
			zone: getOpenClawZone(),
		});
		await vi.waitFor(() => {
			expect(staleGatewayDestroy).toHaveBeenCalledOnce();
		});
	});

	it('keeps lifecycle operations serialized until a timed-out replacement gateway settles', async () => {
		let gatewayStartCount = 0;
		let resolveStaleGatewayStart: ((value: TestGatewayZoneStartResult) => void) | undefined;
		const staleGatewayDestroy = vi.fn(async () => ({ kind: 'destroyed-clean' }) as const);
		const containPendingCreate = vi.fn(async () => undefined);
		const restartTimeoutCallbacks: (() => void)[] = [];
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async (_zoneId, startOptions) => {
				gatewayStartCount += 1;
				const gatewayStartResult: TestGatewayZoneStartResult = {
					destroyGateway:
						gatewayStartCount === 2
							? staleGatewayDestroy
							: vi.fn(async () => ({ kind: 'destroyed-clean' }) as const),
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => 48_284 + gatewayStartCount,
						id: `gateway-vm-${gatewayStartCount}`,
					},
					zone: getOpenClawZone(),
				};
				if (gatewayStartCount === 2) {
					startOptions?.onPendingVmCreation?.({ contain: containPendingCreate });
					return await new Promise<typeof gatewayStartResult>((resolve) => {
						resolveStaleGatewayStart = resolve;
					});
				}
				return gatewayStartResult;
			},
			secretResolver: createResolvingSecretResolver(),
			setTimeoutImpl: (callback, delayMs) => {
				if (delayMs === 5_000) {
					restartTimeoutCallbacks.push(callback);
				}
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart({ timeoutMs: 5_000 });
		await vi.waitFor(() => {
			expect(resolveStaleGatewayStart).toBeDefined();
		});
		restartTimeoutCallbacks[0]?.();
		await expect(restartPromise).rejects.toThrow('restart timed out');
		expect(containPendingCreate).toHaveBeenCalledOnce();

		let stopSettled = false;
		const stopPromise = runtime.stop().then(() => {
			stopSettled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(stopSettled).toBe(false);

		resolveStaleGatewayStart?.({
			destroyGateway: staleGatewayDestroy,
			image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			vm: {
				enableSsh: vi.fn(async () => ({
					close: async () => {},
					serverHostKey: TEST_SSH_SERVER_HOST_KEY,
					host: '127.0.0.1',
					port: 22,
				})),
				exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
				getHostProcessId: () => 48_286,
				id: 'gateway-vm-stale',
			},
			zone: getOpenClawZone(),
		});
		await expect(stopPromise).resolves.toBeUndefined();
		expect(stopSettled).toBe(true);
	});

	it.each([
		['restart', 'shutdown'],
		['cold start', 'stop'],
	] as const)(
		'releases %s lifecycle serialization after terminal pending-create containment so %s can finish without admitting a successor',
		async (timedOperationKind, terminalOperationKind) => {
			// Arrange
			let gatewayStartCount = 0;
			const pendingGatewayCreate = createDeferredPromise<TestGatewayZoneStartResult>();
			const pendingCreateContainment = createDeferredPromise<void>();
			const containPendingCreate = vi.fn(
				async (): Promise<void> => await pendingCreateContainment.promise,
			);
			const restartTimeoutCallbacks: (() => void)[] = [];
			const pendingGatewayStartOrdinal = timedOperationKind === 'restart' ? 2 : 1;
			const runtime = createManagedGatewayZoneRuntime({
				isProcessAlive: () => true,
				now: () => Date.parse('2026-06-07T14:00:00.000Z'),
				restartGatewayZone: async (_zoneId, startOptions) => {
					gatewayStartCount += 1;
					if (gatewayStartCount === pendingGatewayStartOrdinal) {
						startOptions?.onPendingVmCreation?.({ contain: containPendingCreate });
						return await pendingGatewayCreate.promise;
					}
					return {
						image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
						ingress: { host: '127.0.0.1', port: 18791 },
						vm: {
							close: vi.fn(async () => undefined),
							enableIngress: vi.fn(async () => ({
								close: vi.fn(async () => {}),
								host: '127.0.0.1',
								port: 18791,
							})),
							enableSsh: vi.fn(async () => ({
								close: async () => {},
								serverHostKey: TEST_SSH_SERVER_HOST_KEY,
								host: '127.0.0.1',
								port: 22,
							})),
							exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
							getHostProcessId: () => 48_284 + gatewayStartCount,
							id: `gateway-vm-${String(gatewayStartCount)}`,
							configureIngressRoutes: vi.fn(),
							start: async () => {},
						},
						zone: getOpenClawZone(),
					};
				},
				secretResolver: createResolvingSecretResolver(),
				setTimeoutImpl: (callback, delayMs) => {
					if (delayMs === 5_000) {
						restartTimeoutCallbacks.push(callback);
					}
					return { unref: vi.fn() } as unknown as NodeJS.Timeout;
				},
				systemConfig: loadedSystemConfig,
				zone: getOpenClawZone(),
			});

			if (timedOperationKind === 'restart') {
				await runtime.start();
			}
			const timedOperation =
				timedOperationKind === 'restart'
					? runtime.restart({ timeoutMs: 5_000 })
					: runtime.coldStart({ timeoutMs: 5_000 });
			await vi.waitFor(() => {
				expect(restartTimeoutCallbacks).toHaveLength(1);
				expect(containPendingCreate).not.toHaveBeenCalled();
			});

			// Act
			restartTimeoutCallbacks[0]?.();
			await expect(timedOperation).rejects.toThrow('restart timed out');
			expect(containPendingCreate).toHaveBeenCalledOnce();
			const terminalOperation =
				terminalOperationKind === 'shutdown' ? runtime.shutdown() : runtime.stop();
			const successorStart = runtime.start();
			let terminalOperationSettled = false;
			let successorStartSettled = false;
			const terminalOperationOutcome = terminalOperation.then(
				() => {
					terminalOperationSettled = true;
					return { kind: 'resolved' as const };
				},
				(error: unknown) => {
					terminalOperationSettled = true;
					return { error, kind: 'rejected' as const };
				},
			);
			const successorStartOutcome = successorStart.then(
				() => {
					successorStartSettled = true;
					return { kind: 'resolved' as const };
				},
				(error: unknown) => {
					successorStartSettled = true;
					return { error, kind: 'rejected' as const };
				},
			);
			pendingCreateContainment.reject(
				Object.assign(new Error('Pending Gateway create containment budget expired'), {
					code: 'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT' as const,
				}),
			);
			await drainMicrotasks(20);

			// Assert
			expect(terminalOperationSettled).toBe(true);
			expect(successorStartSettled).toBe(true);
			await expect(terminalOperationOutcome).resolves.toEqual({ kind: 'resolved' });
			await expect(successorStartOutcome).resolves.toMatchObject({ kind: 'rejected' });
			expect(gatewayStartCount).toBe(pendingGatewayStartOrdinal);
			expect(runtime.getLifecycleState()).toMatchObject({
				coldStartEligible: false,
				error: { code: 'owner-unsafe' },
				kind: 'failed',
			});
		},
	);

	it('treats restart on a stopped runtime as a cold start without destroying a predecessor', async () => {
		const runtime = createManagedGatewayZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: {
					close: vi.fn(async () => undefined),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						port: 22,
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => 48_284,
					id: 'gateway-vm-cold-start-from-restart',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.restart()).resolves.toMatchObject({
			leaseReleaseFailureCount: 0,
		});

		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-cold-start-from-restart' } },
			lifecycleState: 'running',
		});
	});

	it('records restart operation evidence with one operation id when replacement start fails', async () => {
		let gatewayStartCount = 0;
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createManagedGatewayZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				if (gatewayStartCount === 2) {
					throw new Error('Failed to resolve zone secrets for zone shravan');
				}
				const hostPid = 48_284 + gatewayStartCount;
				const vmId = `gateway-vm-${String(gatewayStartCount)}`;
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					vm: {
						close: vi.fn(async () => undefined),
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						getHostProcessId: () => hostPid,
						id: vmId,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					zone: getOpenClawZone(),
				};
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.restart()).rejects.toThrow('Failed to resolve zone secrets');

		const restartRequested = operationRecords.find((record) => record.kind === 'restart-requested');
		const operationFailed = operationRecords.find((record) => record.kind === 'operation-failed');
		expect(restartRequested).toMatchObject({
			kind: 'restart-requested',
			operationTrigger: 'operator-restart',
			previousGateway: { hostPid: 48_285, vmId: 'gateway-vm-1' },
		});
		expect(operationFailed).toMatchObject({
			errorCode: 'secret-resolution-failed',
			kind: 'operation-failed',
			operationId: restartRequested?.operationId,
			operationTrigger: 'operator-restart',
			previousGateway: { hostPid: 48_285, vmId: 'gateway-vm-1' },
		});
		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'secret-resolution-failed' },
			kind: 'failed',
		});
	});
});

function createDeferredPromise<TResult>(): {
	readonly promise: Promise<TResult>;
	readonly reject: (reason?: unknown) => void;
	readonly resolve: (value: TResult | PromiseLike<TResult>) => void;
} {
	let rejectDeferred: ((reason?: unknown) => void) | undefined;
	let resolveDeferred: ((value: TResult | PromiseLike<TResult>) => void) | undefined;
	const promise = new Promise<TResult>((resolve, reject) => {
		resolveDeferred = resolve;
		rejectDeferred = reject;
	});
	if (!resolveDeferred || !rejectDeferred) {
		throw new Error('Failed to create deferred promise.');
	}
	return {
		promise,
		reject: rejectDeferred,
		resolve: resolveDeferred,
	};
}

async function drainMicrotasks(remainingIterations: number): Promise<void> {
	if (remainingIterations <= 0) {
		return;
	}
	await Promise.resolve();
	await drainMicrotasks(remainingIterations - 1);
}
