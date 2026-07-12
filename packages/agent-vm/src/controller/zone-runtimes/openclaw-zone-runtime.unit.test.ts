import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	ManagedVmEnableSshOptions,
	ManagedVmImageBuildResult,
	ManagedVmSshAccess,
} from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, expectTypeOf, it, vi, type Mock } from 'vitest';

import type { LoadedSystemConfig, SystemConfig } from '../../config/system-config.js';
import { GatewayOwnershipUnsafeError } from '../../gateway/gateway-ownership-evidence.js';
import type {
	GatewayControlSessionReconnectExhausted,
	GatewayZone,
	GatewayZoneStartResult,
} from '../../gateway/gateway-zone-support.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import { createGatewayControlSessionMaterial } from '../control-session/gateway-control-session.js';
import type { GatewayDisposableControlSessionClient } from '../control-session/gateway-disposable-control-session-client.js';
import { openClawProcessSupervisorReceiptSchema } from '../process-supervisor/openclaw-process-supervisor-contracts.js';
import type { OpenClawProcessSupervisor } from '../process-supervisor/openclaw-process-supervisor.js';
import {
	createOpenClawProcessReliabilityFaultTargetRegistry,
	type OpenClawProcessReliabilityFaultTargetRegistry,
} from '../reliability/testing/openclaw-process-reliability-fault-target-registry.js';
import type { GatewayVmLifecycleAuthority } from '../vm-ownership/gateway-vm-lifecycle-authority.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import type { GatewayLifecycleOperationRecord } from './gateway-lifecycle-operation-record.js';
import { createOpenClawZoneRuntime as createOpenClawZoneRuntimeImpl } from './openclaw-zone-runtime.js';

const openClawZoneRuntimeTestRoot = path.join(
	tmpdir(),
	`agent-vm-openclaw-zone-runtime-test-${process.pid}`,
);

const preflightedGatewayImage = {
	built: false,
	fingerprint: 'preflighted-fingerprint',
	imageReference: '/tmp/preflighted-gateway-image',
} satisfies ManagedVmImageBuildResult;

const systemConfig = {
	schemaVersion: 1,
	cacheDir: path.join(openClawZoneRuntimeTestRoot, 'cache'),
	runtimeDir: path.join(openClawZoneRuntimeTestRoot, 'runtime'),
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
				stateDir: path.join(openClawZoneRuntimeTestRoot, 'state', 'shravan'),
				zoneFilesDir: path.join(openClawZoneRuntimeTestRoot, 'zone-files', 'shravan'),
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
	systemConfigPath: path.join(openClawZoneRuntimeTestRoot, 'config', 'system.json'),
} satisfies LoadedSystemConfig;

afterEach(async () => {
	await rm(openClawZoneRuntimeTestRoot, { force: true, recursive: true });
});

type OpenClawZoneRuntimeOptions = Parameters<typeof createOpenClawZoneRuntimeImpl>[0];
type OpenClawRestartGatewayZone = NonNullable<OpenClawZoneRuntimeOptions['restartGatewayZone']>;
type TestManagedVm = Omit<GatewayZoneStartResult['vm'], 'enableSsh'> & {
	enableSsh(
		options?: ManagedVmEnableSshOptions,
	): Promise<
		Partial<ManagedVmSshAccess> &
			Pick<ManagedVmSshAccess, 'close' | 'host' | 'port' | 'serverHostKey'>
	>;
};
type TestGatewayZoneStartResult = Omit<
	GatewayZoneStartResult,
	'terminateVm' | 'vm' | 'vmOwnership'
> & {
	readonly terminateVm?: GatewayZoneStartResult['terminateVm'];
	readonly vm: TestManagedVm;
	readonly vmOwnership?: GatewayVmLifecycleAuthority;
};
type TestOpenClawZoneRuntimeOptions = Omit<
	OpenClawZoneRuntimeOptions,
	'createVmOwnership' | 'restartGatewayZone'
> & {
	readonly createVmOwnership?: OpenClawZoneRuntimeOptions['createVmOwnership'];
	readonly restartGatewayZone?: (
		...args: Parameters<OpenClawRestartGatewayZone>
	) => Promise<TestGatewayZoneStartResult>;
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
		destroyLive:
			options.destroyLive ??
			(async (terminateVm) => {
				await terminateVm();
			}),
		gatewayIdentity: structuredClone(gatewayIdentity),
		gatewaySeed: structuredClone(gatewayIdentity),
	};
}

function createTestGatewayControlSession(label: string): GatewayDisposableControlSessionClient {
	return {
		close: vi.fn(),
		emitApplicationMessage: vi.fn(async () => ({ ok: true })),
		fenceCurrentSession: vi.fn(() => ({ status: 'not-current' as const })),
		getDiagnostics: vi.fn(() => ({
			accepted: true,
			attachmentGeneration: 1,
			connected: true,
			endpointPath: '/__agent-vm/gateway-control',
			helloCount: 1,
			ready: true,
			reconnectAttempts: 0,
			reconnectExhausted: false,
			transportName: 'websocket',
		})),
		ready: Promise.resolve({
			attachmentGeneration: 1,
			connectionId: `${label}-connection`,
			controllerEpoch: 'controller-epoch-1',
			outcome: 'accepted',
			sessionId: `${label}-session`,
		}),
	};
}

function createProcessObservationReceipt(
	processEpoch: string,
	populated: boolean,
): ReturnType<typeof openClawProcessSupervisorReceiptSchema.parse> {
	return openClawProcessSupervisorReceiptSchema.parse({
		actionId: 'process-observation-action',
		cgroup: { name: `agent-vm-${processEpoch}`, populated },
		contractVersion: 1,
		expectedProcessEpoch: processEpoch,
		gateway: {
			controllerEpoch: 'controller-epoch-1',
			gatewayEpochId: 'gateway-observer-epoch-1',
			gatewayVmId: 'gateway-observer-vm-1',
		},
		kind: 'observe',
		observedProcessEpoch: processEpoch,
		status: 'completed',
	});
}

function createProcessObservationRuntimeHarness(
	options: {
		readonly gatewayClose?: () => Promise<void>;
		readonly hostPid?: number | null;
		readonly setIntervalError?: Error;
	} = {},
): {
	readonly clearIntervalImpl: ReturnType<typeof vi.fn>;
	readonly gatewayClose: Mock<() => Promise<void>>;
	readonly getCurrentReliabilityTarget: Mock<
		OpenClawProcessReliabilityFaultTargetRegistry['getCurrent']
	>;
	readonly observationCallback: () => void | Promise<void>;
	readonly observationTimer: NodeJS.Timeout;
	readonly publishReliabilityTarget: Mock<OpenClawProcessReliabilityFaultTargetRegistry['publish']>;
	readonly replaceCurrentProcess: ReturnType<typeof vi.fn>;
	readonly revokeReliabilityTarget: Mock<OpenClawProcessReliabilityFaultTargetRegistry['revoke']>;
	readonly restartGatewayZone: ReturnType<typeof vi.fn>;
	readonly processOneControlSession: GatewayDisposableControlSessionClient;
	readonly processOneControlSessionClose: Mock<() => void>;
	readonly runtime: ReturnType<typeof createOpenClawZoneRuntimeImpl>;
	readonly supervisorObserve: ReturnType<typeof vi.fn<OpenClawProcessSupervisor['observe']>>;
} {
	const gatewayIdentity = {
		bootId: 'gateway-observer-boot-1',
		controllerEpoch: 'controller-epoch-1',
		gatewayEpochId: 'gateway-observer-epoch-1',
		gatewayVmId: 'gateway-observer-vm-1',
		generationId: 'gateway-observer-generation-1',
		zoneId: 'shravan',
	} satisfies GatewayEpochIdentity;
	const processOneMaterial = createGatewayControlSessionMaterial({
		bootId: gatewayIdentity.bootId,
		controllerEpoch: gatewayIdentity.controllerEpoch,
		generationId: gatewayIdentity.generationId,
		processEpoch: 'process-observed-1',
		zoneId: gatewayIdentity.zoneId,
	});
	const processSpec = {
		bootstrapCommand: 'bootstrap',
		guestListenPort: 18_789,
		healthCheck: { path: '/readyz', port: 18_789, type: 'http' as const },
		logPath: '/agent-vm/logs/gateway-boot-latest.log',
		startCommand: 'start',
	};
	const processOneControlSessionClose = vi.fn();
	const processOneControlSession = {
		...createTestGatewayControlSession('process-observed-1'),
		close: processOneControlSessionClose,
	} satisfies GatewayDisposableControlSessionClient;
	let currentProcessBinding: {
		readonly controlSession: GatewayDisposableControlSessionClient;
		readonly material: typeof processOneMaterial;
		readonly processSpec: typeof processSpec;
	} = {
		controlSession: processOneControlSession,
		material: processOneMaterial,
		processSpec,
	};
	const replaceCurrentProcess = vi.fn(
		async (replacement: {
			readonly expectedProcessEpoch: string;
			readonly selectSuccessorProcessEpoch: () => string | undefined;
		}) => {
			const selectedProcessEpoch = replacement.selectSuccessorProcessEpoch();
			if (selectedProcessEpoch === undefined) {
				throw new Error('Expected process observation recovery to select a successor.');
			}
			currentProcessBinding = {
				controlSession: createTestGatewayControlSession('process-observed-successor'),
				material: {
					...processOneMaterial,
					processEpoch: selectedProcessEpoch,
				},
				processSpec,
			};
			return currentProcessBinding;
		},
	);
	const supervisorObserve = vi.fn<OpenClawProcessSupervisor['observe']>();
	const supervisor = {
		contain: vi.fn(async () => {
			throw new Error('process observation test did not expect containment');
		}),
		observe: supervisorObserve,
		start: vi.fn(async () => {
			throw new Error('process observation test did not expect start');
		}),
	} satisfies OpenClawProcessSupervisor;
	const observationCallbacks: (() => void | Promise<void>)[] = [];
	const observationTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
	const setIntervalImpl = vi.fn(
		(callback: () => void | Promise<void>, _delayMs: number): NodeJS.Timeout => {
			if (options.setIntervalError !== undefined) {
				throw options.setIntervalError;
			}
			observationCallbacks.push(callback);
			return observationTimer;
		},
	);
	const clearIntervalImpl = vi.fn();
	const reliabilityTargetRegistry = createOpenClawProcessReliabilityFaultTargetRegistry({
		controllerGeneration: { generation: 1, id: gatewayIdentity.controllerEpoch },
	});
	const publishReliabilityTarget = vi.fn<OpenClawProcessReliabilityFaultTargetRegistry['publish']>(
		(publication) => reliabilityTargetRegistry.publish(publication),
	);
	const revokeReliabilityTarget = vi.fn<OpenClawProcessReliabilityFaultTargetRegistry['revoke']>(
		(revocation) => reliabilityTargetRegistry.revoke(revocation),
	);
	const getCurrentReliabilityTarget = vi.fn<
		OpenClawProcessReliabilityFaultTargetRegistry['getCurrent']
	>(() => reliabilityTargetRegistry.getCurrent());
	const openClawProcessReliabilityFaultTargetRegistry = {
		getCurrent: getCurrentReliabilityTarget,
		isCurrent: (snapshot) => reliabilityTargetRegistry.isCurrent(snapshot),
		publish: publishReliabilityTarget,
		revoke: revokeReliabilityTarget,
	} satisfies OpenClawProcessReliabilityFaultTargetRegistry;
	let gatewayClose: Mock<() => Promise<void>> | undefined;
	const restartGatewayZone = vi.fn(
		async (
			_zoneId: string,
			startOptions?: Parameters<OpenClawRestartGatewayZone>[1],
		): Promise<TestGatewayZoneStartResult> => {
			startOptions?.onOpenClawProcessReliabilityFaultTarget?.({
				gateway: gatewayIdentity,
				processEpoch: currentProcessBinding.material.processEpoch,
				reliabilityFaultActuator: {
					terminateOwnedProcess: vi.fn(async () => {
						throw new Error('runtime composition test must not actuate a fault');
					}),
				},
			});
			gatewayClose = vi.fn<() => Promise<void>>(options.gatewayClose ?? (async () => {}));
			return {
				controlSession: currentProcessBinding.controlSession,
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18_791 },
				openClawProcessEpochOwner: {
					getCurrentBinding: () => currentProcessBinding,
					replaceCurrentProcess,
				},
				openClawProcessSupervisor: supervisor,
				processEpoch: currentProcessBinding.material.processEpoch,
				processSpec,
				vm: {
					close: gatewayClose,
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18_791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						command: 'ssh ...',
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 22,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					getHostProcessId: () => (options.hostPid === undefined ? 48_284 : options.hostPid),
					id: gatewayIdentity.gatewayVmId,
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				terminateVm: gatewayClose,
				vmOwnership: createTestVmOwnership({
					gatewayIdentity,
					vmId: gatewayIdentity.gatewayVmId,
				}),
				zone: getOpenClawZone(),
			};
		},
	);
	const runtime = createOpenClawZoneRuntime({
		clearIntervalImpl,
		isProcessAlive: () => true,
		now: () => Date.parse('2026-07-11T12:00:00.000Z'),
		openClawProcessReliabilityFaultTargetRegistry,
		restartGatewayZone,
		secretResolver: createResolvingSecretResolver(),
		setIntervalImpl,
		systemConfig: loadedSystemConfig,
		zone: getOpenClawZone(),
	});

	return {
		clearIntervalImpl,
		get gatewayClose() {
			if (gatewayClose === undefined) {
				throw new Error('Expected Gateway start before reading its close spy.');
			}
			return gatewayClose;
		},
		getCurrentReliabilityTarget,
		get observationCallback() {
			const callback = observationCallbacks[0];
			if (callback === undefined) {
				throw new Error('Expected runtime start to register process observation interval.');
			}
			return callback;
		},
		observationTimer,
		publishReliabilityTarget,
		replaceCurrentProcess,
		revokeReliabilityTarget,
		restartGatewayZone,
		processOneControlSession,
		processOneControlSessionClose,
		runtime,
		supervisorObserve,
	};
}

function createOpenClawZoneRuntime(
	options: TestOpenClawZoneRuntimeOptions,
): ReturnType<typeof createOpenClawZoneRuntimeImpl> {
	const { createVmOwnership, restartGatewayZone, ...runtimeOptions } = options;
	return createOpenClawZoneRuntimeImpl({
		managedVmFactory: {
			createManagedVm: async () => {
				throw new Error('unit test must inject restartGatewayZone');
			},
		},
		managedVmImages: { prepareImage: async () => preflightedGatewayImage },
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
		...runtimeOptions,
		createVmOwnership:
			createVmOwnership ?? (async () => createTestVmOwnership({ vmId: 'gateway-vm-created' })),
		...(restartGatewayZone
			? {
					restartGatewayZone: async (...args: Parameters<OpenClawRestartGatewayZone>) => {
						const result = await restartGatewayZone(...args);
						return {
							...result,
							terminateVm: result.terminateVm ?? (async () => await result.vm.close()),
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
							vmOwnership: result.vmOwnership ?? createTestVmOwnership({ vmId: result.vm.id }),
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

describe('OpenClaw zone runtime test fixture paths', () => {
	it('keeps generated lifecycle records outside the repository checkout', () => {
		const generatedPaths = [
			systemConfig.cacheDir,
			systemConfig.runtimeDir,
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

describe('createOpenClawZoneRuntime host process liveness', () => {
	it('normalizes managed VM exec processes into command results', async () => {
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
					exec: vi.fn(() =>
						createManagedExecProcessStub({
							exitCode: 7,
							stderr: 'command stderr',
							stdout: 'command stdout',
						}),
					),
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
	});

	it('does not project a started gateway as running when its host pid is missing', async () => {
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => false,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
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

describe('createOpenClawZoneRuntime credentials refresh', () => {
	it('keeps a running gateway active when refresh secret preflight fails', async () => {
		const closeGatewayVm = vi.fn(async () => undefined);
		const runtime = createOpenClawZoneRuntime({
			createFreshSecretResolver: vi.fn(async () => ({
				resolve: async () => {
					throw new Error('fresh resolver should not resolve single secrets');
				},
				resolveAll: async () => {
					throw new Error('1Password SDK resolveAll failed');
				},
			})),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			createFreshSecretResolver: vi.fn(async () => freshResolver),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
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
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
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
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			createFreshSecretResolver: vi.fn(async () => {
				throw new Error('1Password SDK failed to create client');
			}),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
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
		const runtime = createOpenClawZoneRuntime({
			createFreshSecretResolver: async () => {
				throw new Error('1Password SDK failed');
			},
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			createFreshSecretResolver: vi.fn(async () => ({
				resolve: async () => '',
				resolveAll: async () => {
					throw new Error('1Password SDK resolveAll failed: op failed');
				},
			})),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
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
		const runtime = createOpenClawZoneRuntime({
			createFreshSecretResolver: vi.fn(async () => ({
				resolve: async () => '',
				resolveAll: async () => {
					throw new Error('1Password SDK resolveAll failed: op failed');
				},
			})),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => false,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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

describe('createOpenClawZoneRuntime process recovery wiring', () => {
	it('routes exact reconnect exhaustion once to same-G P2 and ignores stale callbacks', async () => {
		const gatewayIdentity = {
			bootId: 'gateway-boot-1',
			controllerEpoch: 'controller-epoch-1',
			gatewayEpochId: 'gateway-epoch-1',
			gatewayVmId: 'gateway-vm-1',
			generationId: 'gateway-generation-1',
			zoneId: 'shravan',
		} satisfies GatewayEpochIdentity;
		const staleGatewayIdentity = {
			...gatewayIdentity,
			gatewayEpochId: 'gateway-epoch-stale',
			gatewayVmId: 'gateway-vm-stale',
			generationId: 'gateway-generation-stale',
		} satisfies GatewayEpochIdentity;
		const processOneMaterial = createGatewayControlSessionMaterial({
			bootId: gatewayIdentity.bootId,
			controllerEpoch: gatewayIdentity.controllerEpoch,
			generationId: gatewayIdentity.generationId,
			processEpoch: 'process-1',
			zoneId: gatewayIdentity.zoneId,
		});
		const processOneControlSession = createTestGatewayControlSession('process-1');
		const processTwoControlSession = createTestGatewayControlSession('process-2');
		const processSpec = {
			bootstrapCommand: 'bootstrap',
			guestListenPort: 18_789,
			healthCheck: { path: '/readyz', port: 18_789, type: 'http' as const },
			logPath: '/agent-vm/logs/gateway-boot-latest.log',
			startCommand: 'start',
		};
		let currentProcessBinding = {
			controlSession: processOneControlSession,
			material: processOneMaterial,
			processSpec,
		};
		const replaceCurrentProcess = vi.fn(
			async (replacement: {
				readonly expectedProcessEpoch: string;
				readonly selectSuccessorProcessEpoch: () => string | undefined;
			}) => {
				const selectedProcessEpoch = replacement.selectSuccessorProcessEpoch();
				if (selectedProcessEpoch === undefined) {
					throw new Error('Expected reconnect recovery to select a successor.');
				}
				currentProcessBinding = {
					controlSession: processTwoControlSession,
					material: {
						...processOneMaterial,
						processEpoch: selectedProcessEpoch,
					},
					processSpec,
				};
				return currentProcessBinding;
			},
		);
		const openClawProcessEpochOwner = {
			getCurrentBinding: () => currentProcessBinding,
			replaceCurrentProcess,
		};
		let reconnectExhausted:
			| ((transition: GatewayControlSessionReconnectExhausted) => void)
			| undefined;
		const restartGatewayZone = vi.fn(
			async (
				_zoneId: string,
				startOptions?: Parameters<OpenClawRestartGatewayZone>[1],
			): Promise<TestGatewayZoneStartResult> => {
				reconnectExhausted = startOptions?.onControlSessionReconnectExhausted;
				return {
					controlSession: processOneControlSession,
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18_791 },
					openClawProcessEpochOwner,
					processEpoch: 'process-1',
					processSpec,
					vm: {
						close: vi.fn(async () => {}),
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
						getHostProcessId: () => 48_284,
						id: 'gateway-vm-1',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					vmOwnership: createTestVmOwnership({
						gatewayIdentity,
						vmId: 'gateway-vm-1',
					}),
					zone: getOpenClawZone(),
				};
			},
		);
		const runtime = createOpenClawZoneRuntime({
			isProcessAlive: () => true,
			now: () => Date.parse('2026-07-11T12:00:00.000Z'),
			restartGatewayZone,
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		if (reconnectExhausted === undefined) {
			throw new Error('Expected runtime start to install reconnect exhaustion callback.');
		}
		const processOneTransition = {
			attempts: 16,
			exhaustionReason: 'attempt_limit',
			gapReason: 'transport disconnected',
			gateway: gatewayIdentity,
			gatewayEpoch: gatewayIdentity.generationId,
			kind: 'reconnect_exhausted',
			processEpoch: 'process-1',
			zoneId: gatewayIdentity.zoneId,
		} satisfies GatewayControlSessionReconnectExhausted;

		reconnectExhausted(processOneTransition);
		reconnectExhausted(processOneTransition);
		await vi.waitFor(() => {
			expect(replaceCurrentProcess).toHaveBeenCalledOnce();
			expect(runtime.getLifecycleState()).toMatchObject({
				gateway: {
					controlSession: processTwoControlSession,
					processEpoch: expect.not.stringMatching(/^process-1$/u),
					vm: { id: gatewayIdentity.gatewayVmId },
					vmOwnership: { gatewayIdentity },
				},
				kind: 'running',
			});
		});
		expect(restartGatewayZone).toHaveBeenCalledOnce();
		expect(replaceCurrentProcess).toHaveBeenCalledWith({
			action: { signal: expect.any(AbortSignal) },
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch: expect.any(Function),
		});

		reconnectExhausted(processOneTransition);
		reconnectExhausted({
			...processOneTransition,
			gateway: staleGatewayIdentity,
			gatewayEpoch: staleGatewayIdentity.generationId,
		});
		reconnectExhausted({
			...processOneTransition,
			processEpoch: 'process-stale',
		});
		await Promise.resolve();

		expect(replaceCurrentProcess).toHaveBeenCalledOnce();
		expect(restartGatewayZone).toHaveBeenCalledOnce();
	});

	it('times out same-G recovery publicly but retains the lifecycle lock through cleanup before whole-G escalation', async () => {
		const gatewayIdentity = {
			bootId: 'gateway-timeout-boot-1',
			controllerEpoch: 'controller-epoch-1',
			gatewayEpochId: 'gateway-timeout-epoch-1',
			gatewayVmId: 'gateway-timeout-vm-1',
			generationId: 'gateway-timeout-generation-1',
			zoneId: 'shravan',
		} satisfies GatewayEpochIdentity;
		const staleGatewayIdentity = {
			...gatewayIdentity,
			gatewayEpochId: 'gateway-timeout-stale-epoch',
			gatewayVmId: 'gateway-timeout-stale-vm',
			generationId: 'gateway-timeout-stale-generation',
		} satisfies GatewayEpochIdentity;
		const processOneMaterial = createGatewayControlSessionMaterial({
			bootId: gatewayIdentity.bootId,
			controllerEpoch: gatewayIdentity.controllerEpoch,
			generationId: gatewayIdentity.generationId,
			processEpoch: 'process-timeout-1',
			zoneId: gatewayIdentity.zoneId,
		});
		const processOneControlSession = createTestGatewayControlSession('process-timeout-1');
		const processSpec = {
			bootstrapCommand: 'bootstrap',
			guestListenPort: 18_789,
			healthCheck: { path: '/readyz', port: 18_789, type: 'http' as const },
			logPath: '/agent-vm/logs/gateway-boot-latest.log',
			startCommand: 'start',
		};
		const pendingReplacement = createDeferredPromise<{
			readonly controlSession: GatewayDisposableControlSessionClient;
			readonly material: typeof processOneMaterial;
			readonly processSpec: typeof processSpec;
		}>();
		const replaceCurrentProcess = vi.fn(
			async (_replacement: {
				readonly action?: { readonly signal: AbortSignal };
				readonly expectedProcessEpoch: string;
				readonly selectSuccessorProcessEpoch: () => string | undefined;
			}) => await pendingReplacement.promise,
		);
		const supervisorObserve = vi.fn<OpenClawProcessSupervisor['observe']>();
		const supervisor = {
			contain: vi.fn(async () => {
				throw new Error('runtime timeout test did not expect direct supervisor containment');
			}),
			observe: supervisorObserve,
			start: vi.fn(async () => {
				throw new Error('runtime timeout test did not expect direct supervisor start');
			}),
		} satisfies OpenClawProcessSupervisor;
		let reconnectExhausted:
			| ((transition: GatewayControlSessionReconnectExhausted) => void)
			| undefined;
		const observationCallbacks: (() => void | Promise<void>)[] = [];
		const recoveryTimeoutCallbacks: (() => void)[] = [];
		const restartGatewayZone = vi.fn(
			async (
				_zoneId: string,
				startOptions?: Parameters<OpenClawRestartGatewayZone>[1],
			): Promise<TestGatewayZoneStartResult> => {
				reconnectExhausted = startOptions?.onControlSessionReconnectExhausted;
				return {
					controlSession: processOneControlSession,
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18_791 },
					openClawProcessEpochOwner: {
						getCurrentBinding: () => ({
							controlSession: processOneControlSession,
							material: processOneMaterial,
							processSpec,
						}),
						replaceCurrentProcess,
					},
					openClawProcessSupervisor: supervisor,
					processEpoch: processOneMaterial.processEpoch,
					processSpec,
					vm: {
						close: vi.fn(async () => {}),
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
						getHostProcessId: () => 48_284,
						id: gatewayIdentity.gatewayVmId,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					},
					vmOwnership: createTestVmOwnership({
						gatewayIdentity,
						vmId: gatewayIdentity.gatewayVmId,
					}),
					zone: getOpenClawZone(),
				};
			},
		);
		const runtime = createOpenClawZoneRuntime({
			clearIntervalImpl: vi.fn(),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-07-11T12:00:00.000Z'),
			restartGatewayZone,
			secretResolver: createResolvingSecretResolver(),
			setIntervalImpl: (callback) => {
				observationCallbacks.push(callback);
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			setTimeoutImpl: (callback, delayMs) => {
				if (delayMs === 90_000) {
					recoveryTimeoutCallbacks.push(callback);
				}
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		if (reconnectExhausted === undefined) {
			throw new Error('Expected runtime start to install reconnect exhaustion callback.');
		}
		const processOneTransition = {
			attempts: 16,
			exhaustionReason: 'attempt_limit',
			gapReason: 'transport disconnected',
			gateway: gatewayIdentity,
			gatewayEpoch: gatewayIdentity.generationId,
			kind: 'reconnect_exhausted',
			processEpoch: processOneMaterial.processEpoch,
			zoneId: gatewayIdentity.zoneId,
		} satisfies GatewayControlSessionReconnectExhausted;

		reconnectExhausted(processOneTransition);
		reconnectExhausted(processOneTransition);
		reconnectExhausted({ ...processOneTransition, gateway: staleGatewayIdentity });
		await vi.waitFor(() => {
			expect(replaceCurrentProcess).toHaveBeenCalledOnce();
			expect(recoveryTimeoutCallbacks).toHaveLength(1);
		});
		const replacement = replaceCurrentProcess.mock.calls[0]?.[0];
		expect(replacement?.action?.signal).toBeInstanceOf(AbortSignal);
		expect(replacement?.action?.signal.aborted).toBe(false);

		const observationCallback = observationCallbacks[0];
		if (observationCallback === undefined) {
			throw new Error('Expected runtime start to register process observation interval.');
		}
		void observationCallback();
		void observationCallback();
		await drainMicrotasks(4);
		expect(supervisorObserve).not.toHaveBeenCalled();

		recoveryTimeoutCallbacks[0]?.();
		await drainMicrotasks(8);
		expect(replacement?.action?.signal.aborted).toBe(true);
		expect(restartGatewayZone).toHaveBeenCalledOnce();

		reconnectExhausted(processOneTransition);
		void observationCallback();
		await drainMicrotasks(4);
		expect(replaceCurrentProcess).toHaveBeenCalledOnce();
		expect(supervisorObserve).not.toHaveBeenCalled();
		expect(restartGatewayZone).toHaveBeenCalledOnce();

		pendingReplacement.reject(new Error('same-G replacement cleanup settled after abort'));
		await vi.waitFor(() => {
			expect(restartGatewayZone).toHaveBeenCalledTimes(2);
		});
	});

	it('keeps the current process after a positive populated observation', async () => {
		const harness = createProcessObservationRuntimeHarness();
		harness.supervisorObserve.mockResolvedValueOnce(
			createProcessObservationReceipt('process-observed-1', true),
		);

		await harness.runtime.start();
		void harness.observationCallback();
		await vi.waitFor(() => {
			expect(harness.supervisorObserve).toHaveBeenCalledOnce();
		});

		expect(harness.replaceCurrentProcess).not.toHaveBeenCalled();
		expect(harness.restartGatewayZone).toHaveBeenCalledOnce();
	});

	it.each(['unpopulated', 'thrown'] as const)(
		'requests one same-G process replacement after a %s observation',
		async (failureKind) => {
			const harness = createProcessObservationRuntimeHarness();
			if (failureKind === 'thrown') {
				harness.supervisorObserve.mockRejectedValueOnce(new Error('process observation failed'));
			} else {
				harness.supervisorObserve.mockResolvedValueOnce(
					createProcessObservationReceipt('process-observed-1', false),
				);
			}

			await harness.runtime.start();
			void harness.observationCallback();
			await vi.waitFor(() => {
				expect(harness.replaceCurrentProcess).toHaveBeenCalledOnce();
			});

			expect(harness.replaceCurrentProcess).toHaveBeenCalledWith({
				action: { signal: expect.any(AbortSignal) },
				expectedProcessEpoch: 'process-observed-1',
				selectSuccessorProcessEpoch: expect.any(Function),
			});
			expect(harness.restartGatewayZone).toHaveBeenCalledOnce();
		},
	);

	it('revokes exact G/P1 before same-G replacement and publishes G/P2 only after success', async () => {
		const harness = createProcessObservationRuntimeHarness();
		harness.supervisorObserve.mockResolvedValueOnce(
			createProcessObservationReceipt('process-observed-1', false),
		);

		await harness.runtime.start();
		expect(harness.publishReliabilityTarget).toHaveBeenCalledWith(
			expect.objectContaining({ processEpoch: 'process-observed-1' }),
		);
		void harness.observationCallback();
		await vi.waitFor(() => expect(harness.replaceCurrentProcess).toHaveBeenCalledOnce());

		expect(harness.revokeReliabilityTarget).toHaveBeenCalledWith({
			gateway: expect.objectContaining({ gatewayEpochId: 'gateway-observer-epoch-1' }),
			processEpoch: 'process-observed-1',
		});
		expect(harness.revokeReliabilityTarget.mock.invocationCallOrder[0]).toBeLessThan(
			harness.replaceCurrentProcess.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(harness.publishReliabilityTarget).toHaveBeenLastCalledWith(
			expect.objectContaining({ processEpoch: expect.not.stringContaining('process-observed-1') }),
		);
	});

	it('revokes the exact target synchronously when lifecycle inspection finds a missing host PID', async () => {
		const harness = createProcessObservationRuntimeHarness({ hostPid: null });

		await harness.runtime.start();
		expect(harness.getCurrentReliabilityTarget()).toMatchObject({
			processEpoch: 'process-observed-1',
		});

		expect(harness.runtime.getLifecycleState()).toMatchObject({
			error: { code: 'vm-process-missing' },
			kind: 'failed',
		});
		expect(harness.revokeReliabilityTarget).toHaveBeenCalledWith({
			gateway: expect.objectContaining({ gatewayEpochId: 'gateway-observer-epoch-1' }),
			processEpoch: 'process-observed-1',
		});
		expect(harness.getCurrentReliabilityTarget()).toBeUndefined();
		expect(harness.runtime.getSnapshot()).not.toHaveProperty('gateway');
	});

	it('revokes before control-session close even when Gateway close fails', async () => {
		const closeError = new Error('Gateway close failed');
		const harness = createProcessObservationRuntimeHarness({
			gatewayClose: async () => {
				throw closeError;
			},
		});

		await harness.runtime.start();
		await expect(harness.runtime.stop()).rejects.toBe(closeError);

		expect(harness.revokeReliabilityTarget.mock.invocationCallOrder[0]).toBeLessThan(
			harness.processOneControlSessionClose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(harness.processOneControlSessionClose).toHaveBeenCalledOnce();
		expect(harness.gatewayClose).toHaveBeenCalledOnce();
		expect(harness.getCurrentReliabilityTarget()).toBeUndefined();
	});

	it('revokes a published target when post-accept observation startup fails', async () => {
		const intervalError = new Error('process observation interval failed to start');
		const harness = createProcessObservationRuntimeHarness({ setIntervalError: intervalError });

		await expect(harness.runtime.start()).rejects.toThrow(intervalError.message);

		expect(harness.publishReliabilityTarget).toHaveBeenCalledOnce();
		expect(harness.revokeReliabilityTarget).toHaveBeenCalledOnce();
		expect(harness.getCurrentReliabilityTarget()).toBeUndefined();
		expect(harness.runtime.getLifecycleState()).toMatchObject({ kind: 'failed' });
	});

	it('does not overlap process observations while one tick is pending', async () => {
		const harness = createProcessObservationRuntimeHarness();
		let resolveObservation!: (receipt: ReturnType<typeof createProcessObservationReceipt>) => void;
		const pendingObservation = new Promise<ReturnType<typeof createProcessObservationReceipt>>(
			(resolve) => {
				resolveObservation = resolve;
			},
		);
		harness.supervisorObserve.mockReturnValueOnce(pendingObservation);

		await harness.runtime.start();
		void harness.observationCallback();
		void harness.observationCallback();

		expect(harness.supervisorObserve).toHaveBeenCalledOnce();
		resolveObservation(createProcessObservationReceipt('process-observed-1', true));
		await pendingObservation;
		expect(harness.replaceCurrentProcess).not.toHaveBeenCalled();
	});

	it.each(['stop', 'shutdown'] as const)('clears process observation on %s', async (operation) => {
		const harness = createProcessObservationRuntimeHarness();
		await harness.runtime.start();

		await harness.runtime[operation]();

		expect(harness.clearIntervalImpl).toHaveBeenCalledWith(harness.observationTimer);
	});
});

describe('createOpenClawZoneRuntime cold-start recovery', () => {
	it('closes a stale in-memory gateway handle before cold-starting after VM process death', async () => {
		const liveHostPids = new Set([48_284, 48_285]);
		const callOrder: string[] = [];
		const firstGatewayClose = vi.fn(async () => {
			callOrder.push('close-gateway-1');
			return undefined;
		});
		let gatewayStartCount = 0;
		const restartGatewayZone = vi.fn(async (): Promise<TestGatewayZoneStartResult> => {
			gatewayStartCount += 1;
			callOrder.push(`start-gateway-${String(gatewayStartCount)}`);
			const hostPid = 48_283 + gatewayStartCount;
			return {
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: gatewayStartCount === 1 ? firstGatewayClose : vi.fn(async () => undefined),
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
					id: `gateway-vm-${String(gatewayStartCount)}`,
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				zone: getOpenClawZone(),
			};
		});
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
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

		expect(firstGatewayClose).toHaveBeenCalledOnce();
		expect(callOrder).toEqual(['start-gateway-1', 'close-gateway-1', 'start-gateway-2']);
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { hostPid: 48_285, id: 'gateway-vm-2' } },
			lifecycleState: 'running',
		});
	});

	it('starts a failed gateway without deleting the runtime record before ownership preflight', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const restartGatewayZone = vi
			.fn()
			.mockRejectedValueOnce(new Error("Failed to resolve zone secrets for zone 'shravan'."))
			.mockResolvedValueOnce({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
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
		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-cold-start' } },
			lifecycleState: 'running',
		});
	});
});

describe('createOpenClawZoneRuntime stop and restart safety', () => {
	it('does not expose legacy PID cleanup as Gateway successor authority', () => {
		type RuntimeOptions = Parameters<typeof createOpenClawZoneRuntimeImpl>[0];

		expectTypeOf<RuntimeOptions>().toMatchTypeOf<{
			readonly createVmOwnership: unknown;
		}>();
		expectTypeOf<RuntimeOptions>().not.toMatchTypeOf<{
			readonly cleanupOrphanedGatewayIfPresent: unknown;
		}>();
		expectTypeOf<RuntimeOptions>().not.toMatchTypeOf<{
			readonly leaseManager: unknown;
		}>();
		expectTypeOf<GatewayZoneStartResult>().toMatchTypeOf<{
			readonly vmOwnership: GatewayVmLifecycleAuthority;
		}>();
	});

	it('uses preflighted secret values for replacement start before closing a running gateway', async () => {
		const closeGateway = vi.fn(async () => undefined);
		const destroyGatewayOwnership = vi.fn(
			async (closeLiveVm: () => Promise<void>) => await closeLiveVm(),
		);
		let startCount = 0;
		let underlyingResolveAllCount = 0;
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
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
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
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
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
					vmOwnership: createTestVmOwnership({
						destroyLive: destroyGatewayOwnership,
						vmId: startCount === 1 ? 'gateway-vm-live' : 'gateway-vm-replacement',
					}),
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
		expect(destroyGatewayOwnership).toHaveBeenCalledTimes(1);
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-replacement' } },
			lifecycleState: 'running',
		});
	});

	it('blocks Gateway replacement when any child lease disposition is incomplete', async () => {
		const closeGateway = vi.fn(async () => undefined);
		const destroyGatewayOwnership = vi.fn(async () => {
			throw new Error('child lease disposition is incomplete');
		});
		let startCount = 0;
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				startCount += 1;
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
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
					vmOwnership: createTestVmOwnership({
						destroyLive: destroyGatewayOwnership,
						vmId: `gateway-vm-${String(startCount)}`,
					}),
					zone: getOpenClawZone(),
				};
			},
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.restart()).rejects.toThrow(/child lease disposition.*incomplete/u);

		expect(destroyGatewayOwnership).toHaveBeenCalledOnce();
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
		const destroyGatewayOwnership = vi.fn(async () => {
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
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http' as const, port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
				vmOwnership: createTestVmOwnership({
					destroyLive: destroyGatewayOwnership,
					vmId: gatewayVmId,
				}),
				zone: getOpenClawZone(),
			};
		});
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
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

		expect(destroyGatewayOwnership).toHaveBeenCalledOnce();
		expect(restartGatewayZone).toHaveBeenCalledOnce();
		expect(runtime.getLifecycleState()).toMatchObject({
			coldStartEligible: false,
			error: { code: 'owner-unsafe' },
			kind: 'failed',
		});
	});

	it('refuses gateway replacement when exact termination remains incomplete', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const closeGateway = vi.fn(async () => {
			throw new Error('exact Gateway termination incomplete');
		});
		let startCount = 0;
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				startCount += 1;
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
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
						id: 'gateway-vm-incomplete-close',
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
		await expect(runtime.restart()).rejects.toThrow(/incomplete/u);

		expect(closeGateway).toHaveBeenCalledOnce();
		expect(startCount).toBe(1);
		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'owner-unsafe' },
			kind: 'failed',
		});
	});

	it('preflights gateway secrets before closing a running gateway for restart', async () => {
		const closeGateway = vi.fn(async () => undefined);
		const destroyGatewayOwnership = vi.fn(
			async (closeLiveVm: () => Promise<void>) => await closeLiveVm(),
		);
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
				vmOwnership: createTestVmOwnership({
					destroyLive: destroyGatewayOwnership,
					vmId: 'gateway-vm-live-before-preflight-failure',
				}),
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
		expect(destroyGatewayOwnership).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-live-before-preflight-failure' } },
			lifecycleState: 'running',
		});
		expect(runtime.getDiagnosis().originalOutageCause).toEqual({ kind: 'unknown' });
	});

	it('preflights replacement image before closing a running gateway for restart', async () => {
		const closeGateway = vi.fn(async () => undefined);
		const destroyGatewayOwnership = vi.fn(
			async (closeLiveVm: () => Promise<void>) => await closeLiveVm(),
		);
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			preflightGatewayZoneStart: async () => {
				throw new Error('gateway image build failed before replacement close');
			},
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
				vmOwnership: createTestVmOwnership({
					destroyLive: destroyGatewayOwnership,
					vmId: 'gateway-vm-live-before-image-preflight-failure',
				}),
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
		expect(destroyGatewayOwnership).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-live-before-image-preflight-failure' } },
			lifecycleState: 'running',
		});
	});

	it('uses service health check for runtime liveness without changing readiness health', async () => {
		const executedCommands: string[] = [];
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					serviceHealthCheck: { type: 'http', port: 18789, path: '/health' },
					startCommand: 'start',
				},
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
			path: '/health',
			statusCode: 200,
		});
		expect(executedCommands.some((command) => command.includes('/readyz'))).toBe(true);
		expect(executedCommands.some((command) => command.includes('/health'))).toBe(true);
	});

	it('exposes stopping state and blocks gateway commands while stop is pending', async () => {
		const closeDeferred = createDeferredPromise<void>();
		const terminationOrder: string[] = [];
		const terminateVm = vi.fn(async () => {
			terminationOrder.push('terminate-started');
			await closeDeferred.promise;
			terminationOrder.push('terminate-complete');
		});
		const destroyLive = vi.fn(async (exactTerminateVm: () => Promise<void>) => {
			await exactTerminateVm();
		});
		const deleteGatewayRuntimeRecord = vi.fn(async () => {
			terminationOrder.push('runtime-record-deleted');
		});
		const gatewayExec = vi.fn(() => createManagedExecProcessStub({ stdout: 'unexpected' }));
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
				terminateVm,
				vmOwnership: createTestVmOwnership({
					destroyLive,
					vmId: 'gateway-vm-stopping',
				}),
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
		expect(destroyLive).toHaveBeenCalledWith(terminateVm);
		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();

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
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const closeGateway = vi.fn(async () => {
			throw new Error('gateway close timed out');
		});
		const destroyLive = vi.fn(async (exactTerminateVm: () => Promise<void>) => {
			await exactTerminateVm();
		});
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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
					id: 'gateway-vm-retained-after-stop-failure',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				terminateVm: closeGateway,
				vmOwnership: createTestVmOwnership({
					destroyLive,
					vmId: 'gateway-vm-retained-after-stop-failure',
				}),
				zone: getOpenClawZone(),
			}),
			secretResolver: createResolvingSecretResolver(),
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.stop()).rejects.toThrow('gateway close timed out');

		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
		expect(destroyLive).toHaveBeenCalledWith(closeGateway);
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
		const oldGatewayClose = vi.fn(async () => {
			throw new Error('gateway close timed out');
		});
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const hostPid = 48_284 + gatewayStartCount;
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18_791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18_789,
						healthCheck: { type: 'http', port: 18_789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close: gatewayStartCount === 1 ? oldGatewayClose : vi.fn(async () => undefined),
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

		expect(oldGatewayClose).toHaveBeenCalledOnce();
		expect(gatewayStartCount).toBe(1);
		expect(runtime.getSnapshot()).toMatchObject({
			lifecycleState: 'failed',
		});
	});

	it('rejects normal gateway access while restart is closing the old gateway', async () => {
		let gatewayStartCount = 0;
		const oldGatewayCloseDeferred = createDeferredPromise<void>();
		const oldGatewayExec = vi.fn(() => createManagedExecProcessStub({ stdout: 'unexpected' }));
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close:
							gatewayStartCount === 1
								? vi.fn(async () => {
										await oldGatewayCloseDeferred.promise;
										return undefined;
									})
								: vi.fn(async () => undefined),
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

		oldGatewayCloseDeferred.resolve();
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
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const staleGatewayClose = vi.fn(async () => undefined);
		const restartTimeoutCallbacks: (() => void)[] = [];
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const gatewayStartResult: TestGatewayZoneStartResult = {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close: gatewayStartCount === 2 ? staleGatewayClose : vi.fn(async () => undefined),
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
						id: `gateway-vm-${gatewayStartCount}`,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
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
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledOnce();
		expect(shutdownSettled).toBe(false);
		resolveStaleGatewayStart({
			image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			processSpec: {
				bootstrapCommand: 'bootstrap',
				guestListenPort: 18789,
				healthCheck: { type: 'http', port: 18789, path: '/readyz' },
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
				startCommand: 'start',
			},
			vm: {
				close: staleGatewayClose,
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
				getHostProcessId: () => 48_286,
				id: 'gateway-vm-stale',
				configureIngressRoutes: vi.fn(),
				start: async () => {},
			},
			zone: getOpenClawZone(),
		});
		await vi.waitFor(() => {
			expect(staleGatewayClose).toHaveBeenCalledOnce();
		});
		await expect(shutdownPromise).resolves.toBeUndefined();
		expect(shutdownSettled).toBe(true);

		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });
	});

	it('does not close the live gateway when restart preflight resolves after timeout', async () => {
		let gatewayStartCount = 0;
		const closeGateway = vi.fn(async () => undefined);
		const destroyGatewayOwnership = vi.fn(
			async (closeLiveVm: () => Promise<void>) => await closeLiveVm(),
		);
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const restartTimeoutCallbacks: (() => void)[] = [];
		const preflightDeferred = createDeferredPromise<{
			readonly image: GatewayZoneStartResult['image'];
			readonly secretResolver: ReturnType<typeof createResolvingSecretResolver>;
		}>();
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			preflightGatewayZoneStart: async () => await preflightDeferred.promise,
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				return {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
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
					vmOwnership: createTestVmOwnership({
						destroyLive: destroyGatewayOwnership,
						vmId: `gateway-vm-${String(gatewayStartCount)}`,
					}),
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
		expect(destroyGatewayOwnership).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-1' } },
			lifecycleState: 'running',
		});
	});

	it('deletes the stale runtime record after closing a timed-out replacement gateway', async () => {
		let gatewayStartCount = 0;
		let resolveStaleGatewayStart: ((value: TestGatewayZoneStartResult) => void) | undefined;
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const staleGatewayClose = vi.fn(async () => undefined);
		const restartTimeoutCallbacks: (() => void)[] = [];
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const gatewayStartResult: TestGatewayZoneStartResult = {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close: gatewayStartCount === 2 ? staleGatewayClose : vi.fn(async () => undefined),
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
						id: `gateway-vm-${gatewayStartCount}`,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
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
			image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			processSpec: {
				bootstrapCommand: 'bootstrap',
				guestListenPort: 18789,
				healthCheck: { type: 'http', port: 18789, path: '/readyz' },
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
				startCommand: 'start',
			},
			vm: {
				close: staleGatewayClose,
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
				getHostProcessId: () => 48_286,
				id: 'gateway-vm-stale',
				configureIngressRoutes: vi.fn(),
				start: async () => {},
			},
			zone: getOpenClawZone(),
		});
		await vi.waitFor(() => {
			expect(staleGatewayClose).toHaveBeenCalledOnce();
		});

		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledTimes(2);
	});

	it('keeps lifecycle operations serialized until a timed-out replacement gateway settles', async () => {
		let gatewayStartCount = 0;
		let resolveStaleGatewayStart: ((value: TestGatewayZoneStartResult) => void) | undefined;
		const staleGatewayClose = vi.fn(async () => undefined);
		const containPendingCreate = vi.fn(async () => undefined);
		const restartTimeoutCallbacks: (() => void)[] = [];
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async (_zoneId, startOptions) => {
				gatewayStartCount += 1;
				const gatewayStartResult: TestGatewayZoneStartResult = {
					image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close: gatewayStartCount === 2 ? staleGatewayClose : vi.fn(async () => undefined),
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
						id: `gateway-vm-${gatewayStartCount}`,
						configureIngressRoutes: vi.fn(),
						start: async () => {},
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
			image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			processSpec: {
				bootstrapCommand: 'bootstrap',
				guestListenPort: 18789,
				healthCheck: { type: 'http', port: 18789, path: '/readyz' },
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
				startCommand: 'start',
			},
			vm: {
				close: staleGatewayClose,
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
				getHostProcessId: () => 48_286,
				id: 'gateway-vm-stale',
				configureIngressRoutes: vi.fn(),
				start: async () => {},
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
			const runtime = createOpenClawZoneRuntime({
				deleteGatewayRuntimeRecord: vi.fn(async () => {}),
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
						processSpec: {
							bootstrapCommand: 'bootstrap',
							guestListenPort: 18789,
							healthCheck: { type: 'http', port: 18789, path: '/readyz' },
							logPath: '/agent-vm/logs/gateway-boot-latest.log',
							startCommand: 'start',
						},
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

	it('treats restart on a stopped runtime as a cold start without deleting ownership records first', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
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

		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-cold-start-from-restart' } },
			lifecycleState: 'running',
		});
	});

	it('records restart operation evidence with one operation id when replacement start fails', async () => {
		let gatewayStartCount = 0;
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
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
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
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
