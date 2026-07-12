import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { workerConfigSchema } from '@agent-vm/agent-vm-worker';
import { CONTROL_SESSION_TIMING_MS } from '@agent-vm/control-protocol-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import type { ManagedVm } from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { ControllerTelemetry } from '../observability/controller-telemetry.js';
import { stableTelemetryHash } from '../observability/health-event-telemetry.js';
import type { CheckObservabilityStackReadinessOptions } from '../observability/observability-readiness.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../testing/managed-vm-test-helpers.js';
import type { GatewayControlTrustedCallerContext } from './control-session/gateway-control-caller-context.js';
import type { GatewayControlPreparedLeaseSemanticMutation } from './control-session/gateway-control-domain-handler.js';
import type { GatewaySemanticExecutionProof } from './control-session/gateway-semantic-result-ledger.js';
import { createStopControllerOperation } from './controller-runtime-operations.js';
import type {
	ControllerRuntime,
	ControllerRuntimeDependencies,
} from './controller-runtime-types.js';
import {
	classifyGatewayRecoveryRestartError,
	startControllerRuntime as startControllerRuntimeProduction,
} from './controller-runtime.js';
import type { HealthEventSink, HealthEventStore } from './health/health-event-store.js';
import type { OpenClawRuntimeStatusStore } from './openclaw-runtime-status.js';
import { ControllerOwnershipLockError } from './vm-ownership/controller-ownership-lock.js';
import { GatewayDestructionTimeoutError } from './vm-ownership/gateway-destruction-budget.js';
import { createGatewayOwnershipCoordinator } from './vm-ownership/gateway-ownership-coordinator.js';
import { GatewayOwnershipCoordinatorError } from './vm-ownership/gateway-ownership-errors.js';
import type { GatewayVmLifecycleAuthority } from './vm-ownership/gateway-vm-lifecycle-authority.js';
import type { GatewayEpochIdentity } from './vm-ownership/vm-ownership-contracts.js';
import type {
	ExecuteWorkerTaskOptions,
	PreparedWorkerTask,
	PrepareWorkerTaskOptions,
} from './worker-task-runner.js';

let previousOnePasswordServiceAccountToken: string | undefined;
let previousOpenClawGatewayToken: string | undefined;
let previousObservabilityMarker: string | undefined;
let previousObservabilityQueryStart: string | undefined;
const controllerRuntimeTestRoot = path.join(
	tmpdir(),
	`agent-vm-controller-runtime-test-${process.pid}`,
);

async function executePreparedGatewayLeaseMutation(options: {
	readonly gateway: GatewayEpochIdentity;
	readonly operation: string;
	readonly preparedMutation: GatewayControlPreparedLeaseSemanticMutation;
	readonly semanticOperationId: string;
}): Promise<Awaited<ReturnType<GatewayControlPreparedLeaseSemanticMutation['execute']>>> {
	const proof = {
		identity: {
			commandId: `${options.semanticOperationId}-command`,
			gateway: options.gateway,
			idempotencyKey: `${options.semanticOperationId}-idempotency`,
			operation: options.operation,
			profile: options.preparedMutation.profile,
			target: options.preparedMutation.target,
			validUntilMs: 60_000,
		},
		operationPayloadDigest: {
			algorithm: 'sha256',
			canonicalVersion: 1,
			digest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
		},
		semanticOperationId: options.semanticOperationId,
	} satisfies GatewaySemanticExecutionProof;
	return await options.preparedMutation.execute(proof);
}

function createManagedVmStub(
	vmId: string,
	hostPid: number,
	options: { readonly detachAfterFirstPidRead?: boolean } = {},
): ManagedVm {
	let hasReportedHostPid = false;
	return {
		close: async () => {},
		enableIngress: async () => ({ close: async () => {}, host: '127.0.0.1', port: 18_791 }),
		enableSsh: async () => ({
			close: async () => {},
			serverHostKey: TEST_SSH_SERVER_HOST_KEY,
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19_000,
			user: 'sandbox',
		}),
		exec: () => createManagedExecProcessStub(),
		getHostProcessId: () => {
			if (options.detachAfterFirstPidRead === true && hasReportedHostPid) {
				return null;
			}
			hasReportedHostPid = true;
			return hostPid;
		},
		id: vmId,
		configureIngressRoutes: () => {},
		start: async () => {},
	};
}

async function createAttachedGatewayVmLifecycleAuthority(options: {
	readonly bootId?: string;
	readonly generationId?: string;
	readonly startOptions: {
		readonly createVmOwnership: (ownershipOptions: {
			readonly controlIdentity?: { readonly bootId: string; readonly generationId: string };
			readonly kind: 'gateway-epoch' | 'standalone';
			readonly sessionLabel: string;
			readonly zoneId: string;
		}) => Promise<GatewayVmLifecycleAuthority>;
		readonly zoneId: string;
	};
	readonly vmId: string;
}): Promise<GatewayVmLifecycleAuthority> {
	const vmOwnership = await options.startOptions.createVmOwnership({
		controlIdentity: {
			bootId: options.bootId ?? `${options.vmId}-boot`,
			generationId: options.generationId ?? `${options.vmId}-generation`,
		},
		kind: 'gateway-epoch',
		sessionLabel: `${options.vmId}-session`,
		zoneId: options.startOptions.zoneId,
	});
	vmOwnership.attachGatewayVm(options.vmId);
	return vmOwnership;
}

function createGatewayVmLifecycleAuthorityStub(vmId: string): GatewayVmLifecycleAuthority {
	const gatewayIdentity = {
		bootId: `${vmId}-boot`,
		controllerEpoch: 'controller-runtime-test-epoch',
		gatewayEpochId: `${vmId}-epoch`,
		gatewayVmId: vmId,
		generationId: `${vmId}-generation`,
		zoneId: 'shravan',
	} satisfies GatewayEpochIdentity;
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
		destroyLive: async (destroyGatewayVm) => {
			await destroyGatewayVm();
		},
		gatewayIdentity: structuredClone(gatewayIdentity),
		gatewaySeed: structuredClone(gatewayIdentity),
	};
}

const defaultGatewayServiceAutoRestart = {
	channelProviderHealth: {
		consecutiveFailureThreshold: 3,
		enabled: true,
		restartGatewayOnRecoverable: true,
		restartGatewayOnUnrecoverable: false,
		transitioningTimeoutMs: 120_000,
	},
	cooldownMs: 61 * 60 * 1000,
	consecutiveFailureThreshold: 10,
	enabled: true,
	failedRecoveryResetMs: 24 * 60 * 60 * 1000,
	maxConsecutiveFailedRecoveries: 3,
	restartTimeoutMs: 10 * 60 * 1000,
} as const;

const preflightedGatewayImage = {
	built: false,
	fingerprint: 'preflighted-fingerprint',
	imageReference: '/tmp/preflighted-gateway-image',
} as const;

const preflightGatewayZoneStart: NonNullable<
	ControllerRuntimeDependencies['preflightGatewayZoneStart']
> = async (startOptions) => ({
	image: preflightedGatewayImage,
	secretResolver: startOptions.secretResolver,
});

describe('controller private OpenClaw reliability composition', () => {
	it('keeps the optional registry factory private from ControllerRuntime', () => {
		expectTypeOf<'createOpenClawProcessReliabilityFaultTargetRegistry'>().toMatchTypeOf<
			keyof ControllerRuntimeDependencies
		>();
		expectTypeOf<ControllerRuntime>().not.toMatchTypeOf<{
			readonly openClawProcessReliabilityFaultTargetRegistries: unknown;
		}>();
	});
});

const acquireControllerOwnershipLockForUnitTest: NonNullable<
	ControllerRuntimeDependencies['acquireControllerOwnershipLock']
> = async () => ({ release: async () => {} });

function startControllerRuntime(
	options: Parameters<typeof startControllerRuntimeProduction>[0],
	dependencies: Omit<
		ControllerRuntimeDependencies,
		| 'configureManagedVmHostNetworkDefaults'
		| 'managedVmFactory'
		| 'managedVmImages'
		| 'managedVmOwnedDirectories'
	> &
		Partial<
			Pick<
				ControllerRuntimeDependencies,
				| 'configureManagedVmHostNetworkDefaults'
				| 'managedVmFactory'
				| 'managedVmImages'
				| 'managedVmOwnedDirectories'
			>
		>,
): ReturnType<typeof startControllerRuntimeProduction> {
	return startControllerRuntimeProduction(options, {
		acquireControllerOwnershipLock: acquireControllerOwnershipLockForUnitTest,
		configureManagedVmHostNetworkDefaults: () => ({
			autoSelectFamily: false,
			dnsResultOrder: 'ipv4first',
		}),
		managedVmFactory: {
			createManagedVm: async () => createManagedVmStub('controller-test-vm', 48_282),
		},
		managedVmImages: {
			prepareImage: async () => preflightedGatewayImage,
		},
		managedVmOwnedDirectories: {
			openHostDirectory: (hostPath) => ({
				close: () => {},
				consume: () => ({
					close: () => {},
					identity: { canonicalPath: hostPath, device: 1, inode: 1 },
					state: 'adapter-owned',
				}),
				identity: { canonicalPath: hostPath, device: 1, inode: 1 },
				state: 'acquired',
			}),
		},
		...dependencies,
	});
}

function recordControllerHealthEvent(
	store: HealthEventStore | undefined,
	event: AgentVmHealthEvent,
): void {
	if (store === undefined) {
		throw new Error('Expected controller health event store to be captured.');
	}
	store.record(event);
}

function recordOpenClawRuntimeStatus(
	store: OpenClawRuntimeStatusStore | undefined,
	report: Parameters<OpenClawRuntimeStatusStore['record']>[0],
): void {
	if (store === undefined) {
		throw new Error('Expected OpenClaw runtime status store to be captured.');
	}
	store.record(report);
}

async function writeDefaultOpenClawConfigFixture(): Promise<void> {
	const zone = systemConfig.zones[0];
	if (zone === undefined || zone.gateway.type !== 'openclaw') {
		throw new Error('Expected OpenClaw test zone.');
	}
	await mkdir(path.dirname(zone.gateway.config), { recursive: true });
	await writeFile(
		zone.gateway.config,
		JSON.stringify({
			agents: {
				defaults: {
					sandbox: {
						backend: 'gondolin',
						mode: 'all',
						scope: 'agent',
						workspaceAccess: 'rw',
					},
					workspace: '/zone/agents/default',
				},
				list: [],
			},
			gateway: {
				auth: { mode: 'token' },
				bind: 'loopback',
			},
		}),
		'utf8',
	);
}

beforeEach(async () => {
	previousOnePasswordServiceAccountToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
	previousOpenClawGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
	previousObservabilityMarker = process.env.AGENT_VM_OBSERVABILITY_MARKER;
	previousObservabilityQueryStart = process.env.AGENT_VM_OBSERVABILITY_QUERY_START;
	process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-op-service-account-token';
	process.env.OPENCLAW_GATEWAY_TOKEN = 'test-openclaw-gateway-token';
	await writeDefaultOpenClawConfigFixture();
});

afterEach(async () => {
	if (previousOnePasswordServiceAccountToken === undefined) {
		delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
	} else {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = previousOnePasswordServiceAccountToken;
	}
	if (previousOpenClawGatewayToken === undefined) {
		delete process.env.OPENCLAW_GATEWAY_TOKEN;
	} else {
		process.env.OPENCLAW_GATEWAY_TOKEN = previousOpenClawGatewayToken;
	}
	if (previousObservabilityMarker === undefined) {
		delete process.env.AGENT_VM_OBSERVABILITY_MARKER;
	} else {
		process.env.AGENT_VM_OBSERVABILITY_MARKER = previousObservabilityMarker;
	}
	if (previousObservabilityQueryStart === undefined) {
		delete process.env.AGENT_VM_OBSERVABILITY_QUERY_START;
	} else {
		process.env.AGENT_VM_OBSERVABILITY_QUERY_START = previousObservabilityQueryStart;
	}
	await rm(controllerRuntimeTestRoot, { force: true, recursive: true });
});

describe('classifyGatewayRecoveryRestartError', () => {
	it('separates disk, secret, and VM creation restart failures for health triage', () => {
		expect(
			classifyGatewayRecoveryRestartError(
				Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
			),
		).toBe('restart-disk-failure');
		expect(
			classifyGatewayRecoveryRestartError(new Error('Failed to resolve secret from 1Password')),
		).toBe('restart-secret-failure');
		expect(classifyGatewayRecoveryRestartError(new Error('Gondolin VM.create failed'))).toBe(
			'restart-vm-create-failed',
		);
		expect(
			classifyGatewayRecoveryRestartError(
				Object.assign(new Error('restart timed out'), {
					code: 'OPENCLAW_GATEWAY_RESTART_TIMEOUT',
				}),
			),
		).toBe('recovery-timeout');
		expect(classifyGatewayRecoveryRestartError(new Error('unexpected'))).toBe('restart-threw');
	});
});

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
	const relativePath = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

const systemConfig = {
	schemaVersion: 1,
	cacheDir: path.join(controllerRuntimeTestRoot, 'cache'),
	runtimeDir: path.join(controllerRuntimeTestRoot, 'runtime'),
	systemConfigPath: path.join(controllerRuntimeTestRoot, 'config', 'system.json'),
	host: {
		controllerPort: 18_800,
		projectNamespace: 'claw-tests-a1b2c3d4',
		secretsProvider: {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
		},
	},
	controller: {
		health: {
			controlSessionDeathGraceMs: CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace,
			enabled: true,
			eventHistoryLimit: 500,
			gatewayServiceAutoRestart: defaultGatewayServiceAutoRestart,
			gatewayServiceIntervalMs: 10_000,
			staleAfterMs: 30_000,
		},
	},
	imageProfiles: {
		gateways: {
			openclaw: {
				type: 'openclaw',
				buildConfig: './vm-images/gateways/openclaw/build-config.json',
			},
			worker: {
				type: 'worker',
				buildConfig: './vm-images/gateways/worker/build-config.json',
			},
		},
		toolVms: {
			default: {
				type: 'toolVm',
				buildConfig: './vm-images/tool-vms/default/build-config.json',
			},
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
				config: path.join(controllerRuntimeTestRoot, 'config', 'shravan', 'openclaw.json'),
				stateDir: path.join(controllerRuntimeTestRoot, 'state', 'shravan'),
				zoneFilesDir: path.join(controllerRuntimeTestRoot, 'zone-files', 'shravan'),
			},
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
	toolVmProfiles: {
		standard: {
			memory: '1G',
			cpus: 1,
			imageProfile: 'default',
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies LoadedSystemConfig;

function createObservabilitySystemConfig(
	controllerStartPolicy: 'degraded' | 'require-ready' | 'off',
	stackMode: 'external' | 'managed' = 'managed',
): LoadedSystemConfig {
	const zone = systemConfig.zones[0];
	if (!zone) {
		throw new Error('Expected test zone.');
	}
	const observabilityZone = {
		...zone,
		observability: {
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
				traces: true,
				metrics: true,
				logs: true,
				sampleRate: 1,
				flushIntervalMs: 10_000,
				captureContent: { enabled: false },
				diagnosticsFlags: [],
			},
		},
	} satisfies LoadedSystemConfig['zones'][number];
	const hostObservability =
		stackMode === 'managed'
			? {
					enabled: true as const,
					stack: {
						mode: 'managed' as const,
						scrubbing: { responsibility: 'agent-vm-managed-collector' as const },
					},
					mode: 'collector' as const,
					bindAddress: '127.0.0.1' as const,
					prepareOnBuild: true,
					waitOnBuild: true,
					startupCheckTimeoutMs: 500,
					controllerStartPolicy,
					ports: {
						collectorGrpc: 4317,
						collectorHttp: 4318,
						collectorHealth: 13_133,
						metrics: 8428,
						logs: 9428,
						traces: 10_428,
					},
					runner: 'docker-compose' as const,
					dataDir: path.join(controllerRuntimeTestRoot, 'observability'),
					retention: {
						metrics: { period: '30d' },
						logs: { period: '14d' },
						traces: { period: '7d' },
					},
				}
			: {
					enabled: true as const,
					stack: {
						mode: 'external' as const,
						scrubbing: { responsibility: 'external-collector' as const },
					},
					mode: 'collector' as const,
					bindAddress: '127.0.0.1' as const,
					prepareOnBuild: true,
					waitOnBuild: true,
					startupCheckTimeoutMs: 500,
					controllerStartPolicy,
					ports: {
						collectorGrpc: 4317,
						collectorHttp: 4318,
						collectorHealth: 13_133,
						metrics: 8428,
						logs: 9428,
						traces: 10_428,
					},
				};
	return {
		...systemConfig,
		host: {
			...systemConfig.host,
			observability: hostObservability,
		},
		zones: [
			observabilityZone,
			...systemConfig.zones.filter((candidateZone) => candidateZone.id !== zone.id),
		],
	};
}

describe('controller runtime test fixture paths', () => {
	it('keeps generated runtime, state, and zone files outside the repository checkout', () => {
		const repositoryRoot = process.cwd();
		const generatedPaths = [
			systemConfig.cacheDir,
			systemConfig.runtimeDir,
			...systemConfig.zones.flatMap((zone) => [
				zone.gateway.stateDir,
				...(zone.gateway.type === 'openclaw' ? [zone.gateway.zoneFilesDir] : []),
			]),
		];

		expect(
			generatedPaths.filter((generatedPath) =>
				isPathInsideDirectory(path.resolve(generatedPath), repositoryRoot),
			),
		).toEqual([]);
	});
});

const openClawProcessSpec = {
	bootstrapCommand: 'bootstrap-openclaw',
	guestListenPort: 18789,
	healthCheck: { type: 'http', port: 18789, path: '/' } as const,
	logPath: '/agent-vm/logs/gateway-boot-latest.log',
	startCommand: 'start-openclaw',
};

const workerProcessSpec = {
	bootstrapCommand: 'bootstrap-worker',
	guestListenPort: 18789,
	healthCheck: { type: 'http', port: 18789, path: '/health' } as const,
	logPath: '/tmp/agent-vm-worker.log',
	startCommand: 'start-worker',
};

function createPreparedWorkerTaskStub(
	taskId: string,
	requestTaskId: string = `request-${taskId}`,
): PreparedWorkerTask {
	const sourceZone = systemConfig.zones[0];
	if (!sourceZone) {
		throw new Error('Expected worker zone.');
	}
	const workerZone = {
		...sourceZone,
		gateway: {
			...sourceZone.gateway,
			type: 'worker' as const,
		},
	};
	return {
		taskId,
		taskRoot: `/tmp/${taskId}`,
		zoneId: 'shravan',
		input: {
			requestTaskId,
			prompt: 'test',
			repos: [],
			context: {},
			resources: { externalResources: {} },
		},
		preStartResult: {
			taskId,
			input: {
				requestTaskId,
				prompt: 'test',
				repos: [],
				context: {},
				resources: { externalResources: {} },
			},
			taskRoot: `/tmp/${taskId}`,
			taskRuntimeRoot: `/tmp/runtime/worker-tasks/shravan/${taskId}`,
			workDir: `/tmp/${taskId}/work`,
			stateDir: `/tmp/${taskId}/state`,
			environment: {},
			startedResourceProviders: [],
			tcpHosts: {},
			vfsMounts: {},
			repos: [],
			effectiveConfig: workerConfigSchema.parse({
				runtimeInstructions: 'Generated runtime instructions.',
				commonAgentInstructions: null,
				defaults: { provider: 'codex', model: 'latest-medium' },
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
						skills: [],
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
						skills: [],
					},
					wrapup: { instructions: null, skills: [] },
				},
			}),
		},
		taskZoneConfig: workerZone,
		zone: workerZone,
		eventLogPath: `/tmp/${taskId}/state/tasks/${taskId}.jsonl`,
		recordEvent: async () => {},
	};
}

describe('createStopControllerOperation', () => {
	it('stops zone-owned VM trees before closing the controller server', async () => {
		const operationOrder: string[] = [];
		const stopController = createStopControllerOperation({
			clearReaperTimer: () => {
				operationOrder.push('clear-reaper');
			},
			closeControllerServer: async () => {
				operationOrder.push('close-server');
			},
			stopAllZones: async () => {
				operationOrder.push('stop-zone-owned-vm-trees');
			},
		});

		await expect(stopController()).resolves.toEqual({ ok: true });
		expect(operationOrder).toEqual(['clear-reaper', 'stop-zone-owned-vm-trees', 'close-server']);
	});
});

describe('startControllerRuntime', () => {
	it('refuses an active deployment ownership lock before secret resolution', async () => {
		const lockConflict = new ControllerOwnershipLockError('controller-already-active');
		const createSecretResolver = vi.fn(
			async (): Promise<SecretResolver> => ({
				resolve: async () => '',
				resolveAll: async () => ({}),
			}),
		);

		await expect(
			startControllerRuntime(
				{
					systemConfig,
					zoneIds: ['shravan'],
				},
				{
					acquireControllerOwnershipLock: vi.fn(async () => {
						throw lockConflict;
					}),
					createSecretResolver,
				},
			),
		).rejects.toBe(lockConflict);

		expect(createSecretResolver).not.toHaveBeenCalled();
	});

	it('reconciles the selected recorded VM tree after locking and fails closed before Gateway start', async () => {
		// Arrange
		const startupEvents: string[] = [];
		const releaseControllerOwnershipLock = vi.fn(async () => {});
		const reconciliationFailure = new GatewayOwnershipCoordinatorError('owner-unsafe', {
			cause: new Error('recorded VM tree reconciliation refused unsafe ownership evidence'),
		});
		const reconcileRecordedVmTree: NonNullable<
			ControllerRuntimeDependencies['reconcileRecordedVmTree']
		> = vi.fn(async ({ systemConfig: reconciledSystemConfig, zoneId }) => {
			startupEvents.push(`reconcile:${zoneId}`);
			expect(reconciledSystemConfig).toBe(systemConfig);
			throw reconciliationFailure;
		});
		const startGatewayZone: NonNullable<ControllerRuntimeDependencies['startGatewayZone']> = vi.fn(
			async () => {
				startupEvents.push('gateway-start');
				throw new Error('Gateway start must not run after reconciliation rejection.');
			},
		);

		// Act
		const startupError = await startControllerRuntime(
			{ systemConfig, zoneIds: ['shravan'] },
			{
				acquireControllerOwnershipLock: vi.fn(async () => {
					startupEvents.push('ownership-lock-acquired');
					return { release: releaseControllerOwnershipLock };
				}),
				createSecretResolver: vi.fn(async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				})),
				preflightGatewayZoneStart,
				reconcileRecordedVmTree,
				startGatewayZone,
				startHttpServer: vi.fn(async () => ({ close: async () => {} })),
			},
		).catch((error: unknown) => error);

		// Assert
		expect(startupError).toBe(reconciliationFailure);
		expect(reconcileRecordedVmTree).toHaveBeenCalledExactlyOnceWith({
			systemConfig,
			zoneId: 'shravan',
		});
		expect(startupEvents).toEqual(['ownership-lock-acquired', 'reconcile:shravan']);
		expect(startGatewayZone).not.toHaveBeenCalled();
		expect(releaseControllerOwnershipLock).not.toHaveBeenCalled();
	});

	it('creates controller-owned Gateway authority before secret resolution even when startup fails', async () => {
		const sourceZone = systemConfig.zones[0];
		if (!sourceZone || sourceZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const secondaryZone = {
			...sourceZone,
			id: 'secondary',
			gateway: {
				...sourceZone.gateway,
				config: path.join(controllerRuntimeTestRoot, 'config', 'secondary', 'openclaw.json'),
				stateDir: path.join(controllerRuntimeTestRoot, 'state', 'secondary'),
				zoneFilesDir: path.join(controllerRuntimeTestRoot, 'zone-files', 'secondary'),
			},
		} satisfies LoadedSystemConfig['zones'][number];
		const multiZoneSystemConfig = {
			...systemConfig,
			zones: [sourceZone, secondaryZone],
		} satisfies LoadedSystemConfig;
		const startupEvents: string[] = [];
		const secretFailure = new Error('secret resolver unavailable');
		const releaseControllerOwnershipLock = vi.fn(async () => {});

		await expect(
			startControllerRuntime(
				{
					systemConfig: multiZoneSystemConfig,
					zoneIds: ['shravan'],
				},
				{
					acquireControllerOwnershipLock: vi.fn(async () => ({
						release: releaseControllerOwnershipLock,
					})),
					createGatewayOwnershipCoordinator: (coordinatorOptions) => {
						startupEvents.push('ownership-coordinator-created');
						return createGatewayOwnershipCoordinator(coordinatorOptions);
					},
					createSecretResolver: vi.fn(async () => {
						startupEvents.push('secret-resolution');
						throw secretFailure;
					}),
				},
			),
		).rejects.toBe(secretFailure);

		expect(startupEvents).toEqual(['ownership-coordinator-created', 'secret-resolution']);
		expect(releaseControllerOwnershipLock).toHaveBeenCalledOnce();
	});

	it('retains the deployment ownership lock when controller-owned startup is owner-unsafe', async () => {
		// Arrange
		const lockConflict = new ControllerOwnershipLockError('controller-already-active');
		const unexpectedSecondAcquisition = new Error(
			'second controller acquired the ownership lock during post-timeout cleanup',
		);
		let ownershipLockHeld = false;
		let acquisitionCount = 0;
		const releaseControllerOwnershipLock = vi.fn(async () => {
			ownershipLockHeld = false;
		});
		const acquireControllerOwnershipLock = vi.fn(async () => {
			acquisitionCount += 1;
			if (ownershipLockHeld) {
				throw lockConflict;
			}
			if (acquisitionCount > 1) {
				throw unexpectedSecondAcquisition;
			}
			ownershipLockHeld = true;
			return { release: releaseControllerOwnershipLock };
		});
		const timeoutError = new GatewayDestructionTimeoutError(
			'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
			'Gateway subtree',
			300_000,
		);
		const ownerUnsafeStartup = new GatewayOwnershipCoordinatorError('owner-unsafe', {
			cause: timeoutError,
		});
		// Act
		const startupError = await startControllerRuntime(
			{ systemConfig, zoneIds: ['shravan'] },
			{
				acquireControllerOwnershipLock,
				createSecretResolver: vi.fn(async () => {
					throw ownerUnsafeStartup;
				}),
			},
		).catch((error: unknown) => error);
		const secondControllerError = await startControllerRuntime(
			{ systemConfig, zoneIds: [] },
			{ acquireControllerOwnershipLock },
		).catch((error: unknown) => error);

		// Assert
		expect(startupError).toBe(ownerUnsafeStartup);
		expect(ownerUnsafeStartup.cause).toBe(timeoutError);
		expect({
			releaseCount: releaseControllerOwnershipLock.mock.calls.length,
			secondControllerError,
		}).toEqual({
			releaseCount: 0,
			secondControllerError: lockConflict,
		});
	});

	it('builds a fresh resolver for controller credentials refresh and replacement gateway start', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const onePasswordGatewayZone = {
			...zone,
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					audience: 'gateway',
					injection: 'env',
					ref: 'op://agent-vm/shravan-gateway-auth/password',
					source: '1password',
				},
			},
		} satisfies LoadedSystemConfig['zones'][number];
		const onePasswordGatewaySystemConfig = {
			...systemConfig,
			zones: [
				onePasswordGatewayZone,
				...systemConfig.zones.filter((candidateZone) => candidateZone.id !== zone.id),
			],
		} satisfies LoadedSystemConfig;
		const createdResolvers: SecretResolver[] = [];
		const resolveAllCallCounts: number[] = [];
		const createSecretResolver = vi.fn(async () => {
			const resolverIndex = createdResolvers.length + 1;
			const resolver: SecretResolver = {
				resolve: async () => `resolver-${resolverIndex}:single`,
				resolveAll: async (refs) => {
					resolveAllCallCounts[resolverIndex - 1] =
						(resolveAllCallCounts[resolverIndex - 1] ?? 0) + 1;
					return Object.fromEntries(
						Object.keys(refs).map((secretName) => [
							secretName,
							`resolver-${resolverIndex}:${secretName}`,
						]),
					);
				},
			};
			createdResolvers.push(resolver);
			return resolver;
		});
		const startGatewayZone = vi.fn(async (startOptions) => {
			await startOptions.secretResolver.resolveAll({
				OPENCLAW_GATEWAY_TOKEN: {
					ref: 'op://agent-vm/shravan-gateway-auth/password',
					source: '1password',
				},
			});
			const gatewayVmId = `gateway-vm-${startGatewayZone.mock.calls.length}`;
			return {
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				controlSessionRecoverySourceKey: {
					bootId: 'gateway-boot-static',
					domain: 'gateway_control' as const,
					gatewayVmId: 'gateway-vm-same',
					generationId: 'gateway-generation-static',
					zoneId: 'shravan',
				},
				processSpec: openClawProcessSpec,
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
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: () => 48_284,
					id: gatewayVmId,
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				terminateVm: async () => {},
				vmOwnership: createGatewayVmLifecycleAuthorityStub(gatewayVmId),
				zone: onePasswordGatewayZone,
			};
		});
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const runtime = await startControllerRuntime(
			{
				systemConfig: onePasswordGatewaySystemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: () => 12_345,
					id: 'tool-vm-1',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				})),
				createSecretResolver,
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				preflightGatewayZoneStart,
				startGatewayZone,
				startHttpServer: vi.fn(async (options) => {
					startHttpServerArgs = options;
					return {
						close: async () => {},
					};
				}),
			},
		);
		if (!startHttpServerArgs) {
			throw new Error('Expected start HTTP server args.');
		}

		const refreshResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/credentials/refresh',
			{ method: 'POST' },
		);

		expect(refreshResponse.status).toBe(200);
		expect(createSecretResolver).toHaveBeenCalledTimes(2);
		expect(startGatewayZone).toHaveBeenCalledTimes(2);
		expect(startGatewayZone.mock.calls[0]?.[0]).toMatchObject({ zoneId: 'shravan' });
		expect(startGatewayZone.mock.calls[1]?.[0]).toMatchObject({ zoneId: 'shravan' });
		expect(startGatewayZone.mock.calls[1]?.[0].gatewayControlProcessAdmissionCoordinator).toBe(
			startGatewayZone.mock.calls[0]?.[0].gatewayControlProcessAdmissionCoordinator,
		);
		expect(resolveAllCallCounts).toEqual([1, 1]);
		await expect(runtime.close()).resolves.toBeUndefined();
	});

	it('starts the gateway, creates the controller app, and opens the controller port', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const taskTitles: string[] = [];
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const absoluteLeaseRoot = await mkdtemp(
			path.join(tmpdir(), 'agent-vm-controller-runtime-test-'),
		);
		await mkdir(path.join(absoluteLeaseRoot, 'state', zone.id, 'sandboxes', 'agent', 'work'), {
			recursive: true,
		});
		await mkdir(path.join(absoluteLeaseRoot, 'state', zone.id, 'sandboxes', 'main', 'work'), {
			recursive: true,
		});
		const absoluteLeaseZone = {
			...zone,
			agents: [{ id: 'main' }],
			gateway: {
				...zone.gateway,
				stateDir: path.join(absoluteLeaseRoot, 'state', zone.id),
				zoneFilesDir: path.join(absoluteLeaseRoot, 'zone-files', zone.id),
			},
		} satisfies LoadedSystemConfig['zones'][number];
		const absoluteLeaseSystemConfig = {
			...systemConfig,
			zones: [
				absoluteLeaseZone,
				...systemConfig.zones.filter((candidateZone) => candidateZone.id !== zone.id),
			],
		} satisfies LoadedSystemConfig;
		const closeGatewayVm = vi.fn(async () => {});
		let capturedHealthEventStore: HealthEventStore | undefined;
		let capturedOpenClawRuntimeStatusStore: OpenClawRuntimeStatusStore | undefined;
		let capturedGatewayIdentity: GatewayEpochIdentity | undefined;
		const startGatewayZone = vi.fn(async (startOptions) => {
			capturedHealthEventStore = startOptions.healthEventStore;
			capturedOpenClawRuntimeStatusStore = startOptions.openClawRuntimeStatusStore;
			const startOrdinal = startGatewayZone.mock.calls.length;
			const managedGatewayVm = createManagedVmStub(`gateway-vm-${startOrdinal}`, 48_282);
			const vmOwnership = await createAttachedGatewayVmLifecycleAuthority({
				bootId: startOrdinal === 1 ? 'gateway-boot-a' : `gateway-boot-${startOrdinal}`,
				generationId:
					startOrdinal === 1 ? 'gateway-generation-a' : `gateway-generation-${startOrdinal}`,
				startOptions,
				vmId: managedGatewayVm.id,
			});
			capturedGatewayIdentity = vmOwnership.gatewayIdentity;
			return {
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
				vm: {
					...managedGatewayVm,
					close: closeGatewayVm,
				},
				terminateVm: closeGatewayVm,
				vmOwnership,
				zone: absoluteLeaseZone,
			};
		});
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const startHttpServer = vi.fn(
			async (options: {
				app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
				port: number;
			}) => {
				startHttpServerArgs = options;
				return {
					close: async () => {},
				};
			},
		);
		const clearIntervalMock = vi.fn();
		const fakeInterval = setTimeout(() => undefined, 0);
		clearTimeout(fakeInterval);
		const setIntervalMock = vi.fn(() => fakeInterval);
		const startupEvents: string[] = [];
		const releaseControllerOwnershipLock = vi.fn(async () => {
			startupEvents.push('ownership-lock-released');
		});
		const acquireControllerOwnershipLock = vi.fn(async () => {
			startupEvents.push('ownership-lock-acquired');
			return { release: releaseControllerOwnershipLock };
		});
		let statusNowMs = 10_000;
		const createManagedToolVm = vi.fn(async () =>
			createManagedVmStub(`tool-vm-${createManagedToolVm.mock.calls.length}`, 12_345, {
				detachAfterFirstPidRead: true,
			}),
		);
		const configureManagedVmHostNetworkDefaults = vi.fn(() => {
			startupEvents.push('host-network-defaults');
			return {
				autoSelectFamily: false,
				dnsResultOrder: 'ipv4first',
			} as const;
		});
		let ownershipIdentityOrdinal = 0;
		const runtime = await startControllerRuntime(
			{
				systemConfig: absoluteLeaseSystemConfig,
				zoneIds: ['shravan'],
			},
			{
				acquireControllerOwnershipLock,
				controllerEpoch: 'controller-epoch-a',
				createGatewayOwnershipCoordinator: (coordinatorOptions) => {
					startupEvents.push('ownership-coordinator-created');
					return createGatewayOwnershipCoordinator({
						...coordinatorOptions,
						createGatewayEpochId: () => `gateway-epoch-${String((ownershipIdentityOrdinal += 1))}`,
					});
				},
				createManagedToolVm,
				configureManagedVmHostNetworkDefaults,
				createSecretResolver: async () => {
					startupEvents.push('secrets');
					return {
						resolve: async () => '',
						resolveAll: async () => ({}),
					};
				},
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				readIdentityPem: async () => '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n',
				clearIntervalImpl: clearIntervalMock,
				runTask: async (title, fn) => {
					taskTitles.push(title);
					await fn();
				},
				now: () => statusNowMs,
				preflightGatewayZoneStart,
				startGatewayZone,
				startHttpServer,
				setIntervalImpl: setIntervalMock,
			},
		);

		expect(startGatewayZone).toHaveBeenCalledWith(
			expect.objectContaining({
				runTask: expect.any(Function),
				runtimeEnvironment: {},
				runtimePluginConfigs: {},
				gatewayControlProcessAdmissionCoordinator: expect.objectContaining({
					registerSession: expect.any(Function),
					submit: expect.any(Function),
				}),
				zoneId: 'shravan',
			}),
			expect.objectContaining({
				managedVmFactory: expect.any(Object),
				managedVmImages: expect.any(Object),
			}),
		);
		expect(taskTitles).toEqual([
			'Resolving 1Password secrets',
			'Controller API on :18800',
			'Starting selected gateway zones',
		]);
		expect(startHttpServer).toHaveBeenCalledWith(
			expect.objectContaining({
				port: 18800,
			}),
		);
		expect(configureManagedVmHostNetworkDefaults).toHaveBeenCalledOnce();
		expect(acquireControllerOwnershipLock).toHaveBeenCalledWith({
			runtimeDirectory: absoluteLeaseSystemConfig.runtimeDir,
		});
		expect(startupEvents.indexOf('ownership-lock-acquired')).toBeLessThan(
			startupEvents.indexOf('secrets'),
		);
		expect(startupEvents.indexOf('ownership-lock-acquired')).toBeLessThan(
			startupEvents.indexOf('ownership-coordinator-created'),
		);
		expect(startupEvents.indexOf('ownership-coordinator-created')).toBeLessThan(
			startupEvents.indexOf('host-network-defaults'),
		);
		expect(startupEvents.indexOf('ownership-coordinator-created')).toBeLessThan(
			startupEvents.indexOf('secrets'),
		);
		expect(releaseControllerOwnershipLock).not.toHaveBeenCalled();
		if (!startHttpServerArgs) {
			throw new Error('Expected startHttpServer to be called.');
		}
		const statusResponse = await startHttpServerArgs.app.request('/controller-status');
		expect(statusResponse.status).toBe(200);
		await expect(statusResponse.json()).resolves.toMatchObject({
			zones: expect.arrayContaining([
				expect.objectContaining({
					activeLeaseCount: 0,
					bootedAt: expect.any(String),
					id: 'shravan',
					running: true,
					vmId: 'gateway-vm-1',
				}),
			]),
		});
		const zoneStatusResponse = await startHttpServerArgs.app.request('/zones/shravan/status');
		expect(zoneStatusResponse.status).toBe(200);
		await expect(zoneStatusResponse.json()).resolves.toMatchObject({
			bootedAt: expect.any(String),
			diagnosis: {
				toolVmLeaseState: 'none',
				toolVmPlane: 'ok',
			},
			id: 'shravan',
			running: true,
			vmId: 'gateway-vm-1',
		});
		recordOpenClawRuntimeStatus(capturedOpenClawRuntimeStatusStore, {
			bootId: 'gateway-boot-a',
			connectionId: '11111111-1111-4111-8111-111111111111',
			controllerEpoch: 'controller-epoch-a',
			pluginId: 'gondolin',
			peerId: 'gateway-zone-a',
			sessionId: '33333333-3333-4333-8333-333333333333',
			zoneId: 'shravan',
			findings: [
				{
					id: 'openclaw-tool-vm-agents-defaults-sandbox-backend-shravan-defaults',
					ok: true,
					hint: 'agents.defaults.sandbox.backend=gondolin',
				},
			],
		});
		const gatewayControlLeaseRpc = startGatewayZone.mock.calls[0]?.[0].gatewayControlLeaseRpc;
		if (gatewayControlLeaseRpc === undefined) {
			throw new Error('Expected gateway control lease RPC to be passed to gateway startup.');
		}
		const controllerLeaseCallerContext = {
			agentId: 'main',
			agentWorkspaceDir: '/zone/agents/main',
			bootId: 'gateway-boot-a',
			callerContextId: '44444444-4444-4444-8444-444444444444',
			connectionId: '11111111-1111-4111-8111-111111111111',
			controllerEpoch: 'controller-epoch-a',
			peerId: 'gateway-zone-a',
			purpose: 'tool_vm_lease',
			sessionId: '33333333-3333-4333-8333-333333333333',
			sessionKeyDigest: '0123456789abcdef0123456789abcdef',
			stablePrincipal: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
			zoneId: 'shravan',
		} satisfies GatewayControlTrustedCallerContext;
		if (capturedGatewayIdentity === undefined) {
			throw new Error('Expected exact Gateway identity to be captured during gateway startup.');
		}
		const createLeasePayload = {
			callerContext: {
				callerContextId: controllerLeaseCallerContext.callerContextId,
			},
		};
		const preparedCreateLease = await gatewayControlLeaseRpc.prepareSemanticMutation({
			attachmentGeneration: 1,
			callerContext: controllerLeaseCallerContext,
			gateway: capturedGatewayIdentity,
			operation: 'lease_create',
			payload: createLeasePayload,
			processEpoch: 'controller-runtime-test-process-epoch',
		});
		const oldLease = await executePreparedGatewayLeaseMutation({
			gateway: capturedGatewayIdentity,
			operation: 'lease_create',
			preparedMutation: preparedCreateLease,
			semanticOperationId: 'controller-runtime-test-lease-create',
		});
		if (oldLease === undefined || 'result' in oldLease || !('leaseId' in oldLease)) {
			throw new Error(`Expected created lease, got ${JSON.stringify(oldLease)}.`);
		}
		expect(createManagedToolVm).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'main',
				tcpSlot: expect.any(Number),
				zoneId: 'shravan',
			}),
		);
		const refreshedControllerLeaseCallerContext = {
			...controllerLeaseCallerContext,
			callerContextId: '99999999-9999-4999-8999-999999999999',
		} satisfies GatewayControlTrustedCallerContext;
		const reacquireLeasePayload = {
			callerContext: {
				callerContextId: refreshedControllerLeaseCallerContext.callerContextId,
			},
			oldLeaseId: oldLease.leaseId,
			staleEvidence: {
				kind: 'tool-vm-ssh',
				observedAtMs: statusNowMs,
				operation: 'finalize',
			},
		};
		const preparedReacquireLease = await gatewayControlLeaseRpc.prepareSemanticMutation({
			attachmentGeneration: 1,
			callerContext: refreshedControllerLeaseCallerContext,
			gateway: capturedGatewayIdentity,
			operation: 'lease_reacquire',
			payload: reacquireLeasePayload,
			processEpoch: 'controller-runtime-test-process-epoch',
		});
		const replacementLease = await executePreparedGatewayLeaseMutation({
			gateway: capturedGatewayIdentity,
			operation: 'lease_reacquire',
			preparedMutation: preparedReacquireLease,
			semanticOperationId: 'controller-runtime-test-lease-reacquire',
		});
		if (
			replacementLease === undefined ||
			'result' in replacementLease ||
			replacementLease.leaseId === undefined
		) {
			throw new Error(`Expected replacement lease, got ${JSON.stringify(replacementLease)}.`);
		}
		expect(replacementLease.leaseId).not.toBe(oldLease.leaseId);
		const lifecycleSnapshotResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/health-snapshot',
		);
		expect(lifecycleSnapshotResponse.status).toBe(200);
		await expect(lifecycleSnapshotResponse.json()).resolves.toMatchObject({
			latestEvents: expect.arrayContaining([
				expect.objectContaining({
					agentId: 'main',
					kind: 'tool-vm-ssh',
					leaseIdHash: stableTelemetryHash(replacementLease.leaseId),
					lifecycleEventRole: 'controller_final',
					lifecycleTransition: 'stale_to_reacquired',
					oldLeaseIdHash: stableTelemetryHash(oldLease.leaseId),
					operation: 'finalize',
					replacementLeaseIdHash: stableTelemetryHash(replacementLease.leaseId),
					result: 'ok',
					transitionIdHash: stableTelemetryHash(`lease_reacquire:${oldLease.leaseId}`),
					zoneId: 'shravan',
				}),
			]),
		});
		const preparedReleaseReplacementLease = await gatewayControlLeaseRpc.prepareSemanticMutation({
			attachmentGeneration: 1,
			callerContext: refreshedControllerLeaseCallerContext,
			gateway: capturedGatewayIdentity,
			operation: 'lease_release',
			payload: {
				callerContext: {
					callerContextId: refreshedControllerLeaseCallerContext.callerContextId,
				},
				leaseId: replacementLease.leaseId,
			},
			processEpoch: 'controller-runtime-test-process-epoch',
		});
		await executePreparedGatewayLeaseMutation({
			gateway: capturedGatewayIdentity,
			operation: 'lease_release',
			preparedMutation: preparedReleaseReplacementLease,
			semanticOperationId: 'controller-runtime-test-lease-release',
		});
		recordControllerHealthEvent(capturedHealthEventStore, {
			channelProviderId: 'primary-channel',
			health: 'transitioning',
			kind: 'agent-channel-provider-health',
			observedAtMs: 10_000,
			result: 'ok',
			transitionStartedAtMs: 9_000,
			zoneId: 'shravan',
		} satisfies AgentVmHealthEvent);
		statusNowMs = 11_000;
		const transitioningZoneStatusResponse =
			await startHttpServerArgs.app.request('/zones/shravan/status');
		expect(transitioningZoneStatusResponse.status).toBe(200);
		await expect(transitioningZoneStatusResponse.json()).resolves.toMatchObject({
			diagnosis: {
				channelProviderPlane: 'transitioning',
				currentRecoveryBlocker: 'none',
				originalOutageCause: { kind: 'unknown' },
				selectedZoneReadiness: 'degraded',
			},
			readiness: 'degraded',
		});
		recordControllerHealthEvent(capturedHealthEventStore, {
			channelProviderId: 'primary-channel',
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 20_000,
			result: 'failed',
			zoneId: 'shravan',
		} satisfies AgentVmHealthEvent);
		recordControllerHealthEvent(capturedHealthEventStore, {
			channelProviderId: 'secondary-channel',
			health: 'healthy',
			kind: 'agent-channel-provider-health',
			observedAtMs: 30_000,
			result: 'ok',
			zoneId: 'shravan',
		} satisfies AgentVmHealthEvent);
		statusNowMs = 31_000;
		const multiProviderZoneStatusResponse =
			await startHttpServerArgs.app.request('/zones/shravan/status');
		expect(multiProviderZoneStatusResponse.status).toBe(200);
		await expect(multiProviderZoneStatusResponse.json()).resolves.toMatchObject({
			diagnosis: {
				channelProviderPlane: 'degraded',
				originalOutageCause: { kind: 'unknown' },
				selectedZoneReadiness: 'degraded',
			},
			readiness: 'degraded',
		});
		const refreshResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/credentials/refresh',
			{ method: 'POST' },
		);
		expect(refreshResponse.status).toBe(200);
		const wrongZoneLogsResponse = await startHttpServerArgs.app.request('/zones/alevtina/logs');
		expect(wrongZoneLogsResponse.status).toBe(404);
		const upgradeResponse = await startHttpServerArgs.app.request('/zones/shravan/upgrade', {
			method: 'POST',
		});
		expect(upgradeResponse.status).toBe(200);
		expect(startGatewayZone).toHaveBeenCalledTimes(3);
		expect(zone.gateway.port).toBe(18791);
		expect(closeGatewayVm).toHaveBeenCalledTimes(2);
		expect(setIntervalMock).toHaveBeenCalledTimes(2);
		expect(runtime.controllerPort).toBe(18800);
		expect(runtime.zones).toEqual([
			expect.objectContaining({
				gateway: {
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					vm: {
						hostPid: 48282,
						id: 'gateway-vm-1',
					},
				},
				lifecycleState: 'running',
				zoneId: 'shravan',
			}),
		]);
		await runtime.close();
		expect(releaseControllerOwnershipLock).toHaveBeenCalledOnce();
		expect(startupEvents.at(-1)).toBe('ownership-lock-released');
		await rm(absoluteLeaseRoot, { force: true, recursive: true });
		expect(clearIntervalMock).toHaveBeenCalledTimes(2);
	});

	it('does not block controller startup on default degraded host observability readiness', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const startupEvents: string[] = [];
		const observabilitySystemConfig = createObservabilitySystemConfig('degraded');
		const observabilityZone = observabilitySystemConfig.zones[0];
		if (!observabilityZone) {
			throw new Error('Expected observability test zone.');
		}
		const closeGatewayVm = vi.fn(async () => {});
		const startGatewayZone = vi.fn(async () => {
			startupEvents.push('gateway-start');
			return {
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
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
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: vi.fn(() => 48_282),
					id: 'gateway-vm-1',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				terminateVm: closeGatewayVm,
				vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-1'),
				zone: observabilityZone,
			};
		});
		const checkObservabilityStackReadiness = vi.fn(async () => {
			startupEvents.push('observability-check');
			await new Promise(() => {});
			return { ok: true, status: 'ready' } as const;
		});

		const runtime = await startControllerRuntime(
			{
				systemConfig: observabilitySystemConfig,
				zoneIds: ['shravan'],
			},
			{
				checkObservabilityStackReadiness,
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				startGatewayZone,
				startHttpServer: vi.fn(async () => ({
					close: async () => {},
				})),
			},
		);

		expect(checkObservabilityStackReadiness).toHaveBeenCalledOnce();
		expect(startGatewayZone).toHaveBeenCalledOnce();
		expect(startupEvents).toEqual(['observability-check', 'gateway-start']);
		await expect(runtime.close()).resolves.toBeUndefined();
	});

	it('checks external host observability readiness without managed stack fields', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const observabilitySystemConfig = createObservabilitySystemConfig('degraded', 'external');
		const observabilityZone = observabilitySystemConfig.zones[0];
		if (!observabilityZone) {
			throw new Error('Expected observability test zone.');
		}
		const startGatewayZone = vi.fn(async () => ({
			image: {
				built: true,
				fingerprint: 'gateway-image',
				imageReference: '/tmp/gateway-image',
			},
			ingress: {
				host: '127.0.0.1',
				port: 18791,
			},
			processSpec: openClawProcessSpec,
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
					command: 'ssh ...',
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 19000,
					user: 'sandbox',
				})),
				exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
				getHostProcessId: vi.fn(() => 48_282),
				id: 'gateway-vm-1',
				configureIngressRoutes: vi.fn(),
				start: async () => {},
			},
			terminateVm: async () => {},
			vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-1'),
			zone: observabilityZone,
		}));
		const checkObservabilityStackReadiness = vi.fn(
			async (_options: CheckObservabilityStackReadinessOptions) =>
				({ ok: true, status: 'ready' }) as const,
		);

		const runtime = await startControllerRuntime(
			{
				systemConfig: observabilitySystemConfig,
				zoneIds: ['shravan'],
			},
			{
				checkObservabilityStackReadiness,
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				startGatewayZone,
				startHttpServer: vi.fn(async () => ({
					close: async () => {},
				})),
			},
		);

		expect(checkObservabilityStackReadiness).toHaveBeenCalledOnce();
		const readinessCall = checkObservabilityStackReadiness.mock.calls[0];
		if (!readinessCall) {
			throw new Error('Expected host observability readiness check.');
		}
		const runtimeConfig = readinessCall[0].config;
		expect(runtimeConfig.stackMode).toBe('external');
		expect('dataDir' in runtimeConfig).toBe(false);
		expect('retention' in runtimeConfig).toBe(false);
		expect('projectName' in runtimeConfig).toBe(false);
		expect(startGatewayZone).toHaveBeenCalledOnce();
		await expect(runtime.close()).resolves.toBeUndefined();
	});

	it('starts controller telemetry and flushes gateway health events for observability-enabled runtimes', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		process.env.AGENT_VM_OBSERVABILITY_MARKER = 'controller-runtime-proof-marker';
		process.env.AGENT_VM_OBSERVABILITY_QUERY_START = '2026-06-14T14:55:00.000Z';
		const baseObservabilitySystemConfig = createObservabilitySystemConfig('degraded');
		const observabilitySystemConfig = {
			...baseObservabilitySystemConfig,
			host: {
				...baseObservabilitySystemConfig.host,
				githubToken: {
					ref: 'op://agent-vm-testing/controller-github-token/credential',
					source: '1password',
				},
			},
		} satisfies LoadedSystemConfig;
		const observabilityZone = observabilitySystemConfig.zones[0];
		if (!observabilityZone) {
			throw new Error('Expected observability test zone.');
		}
		let nowMs = 1_781_445_300_000;
		const startupEvents: string[] = [];
		const telemetryHealthEvents: AgentVmHealthEvent[] = [];
		const telemetryLifecycleEvents: string[] = [];
		const telemetryCloseOrder: string[] = [];
		let stallTelemetrySink = false;
		let releaseStalledTelemetrySink: (() => void) | undefined;
		const stalledTelemetrySink = new Promise<void>((resolve) => {
			releaseStalledTelemetrySink = resolve;
		});
		const telemetryHealthEventSink: HealthEventSink = {
			record: vi.fn(async (event) => {
				telemetryHealthEvents.push(event);
				if (stallTelemetrySink) {
					await stalledTelemetrySink;
				}
			}),
		};
		const telemetry: ControllerTelemetry = {
			forceFlush: vi.fn(async () => {
				telemetryCloseOrder.push('forceFlush');
			}),
			healthEventSink: telemetryHealthEventSink,
			getDiagnostics: () => ({
				emissionFailures: 0,
				operationFailures: 0,
				operationTimeouts: 0,
			}),
			recordControllerLifecycleEvent: vi.fn((event) => {
				telemetryLifecycleEvents.push(event.eventName);
			}),
			shutdown: vi.fn(async () => {
				telemetryCloseOrder.push('shutdown');
			}),
		};
		const startControllerTelemetry = vi.fn(() => {
			startupEvents.push('telemetry-start');
			return telemetry;
		});
		const intervalCallbacks: {
			readonly callback: () => void | Promise<void>;
			readonly delayMs: number;
		}[] = [];
		const fakeInterval = setTimeout(() => undefined, 0);
		clearTimeout(fakeInterval);
		let capturedHealthEventStore: HealthEventStore | undefined;
		const startGatewayZone = vi.fn(async (startOptions) => {
			capturedHealthEventStore = startOptions.healthEventStore;
			return {
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
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
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() =>
						createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '200' }),
					),
					getHostProcessId: vi.fn(() => 48_282),
					id: 'gateway-vm-telemetry',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				terminateVm: async () => {},
				vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-telemetry'),
				zone: observabilityZone,
			};
		});
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
			  }
			| undefined;

		const runtime = await startControllerRuntime(
			{
				systemConfig: observabilitySystemConfig,
				zoneIds: ['shravan'],
			},
			{
				checkObservabilityStackReadiness: vi.fn(
					async () => ({ ok: true, status: 'ready' }) as const,
				),
				createGatewayOwnershipCoordinator: (coordinatorOptions) => {
					startupEvents.push('ownership-coordinator-created');
					return createGatewayOwnershipCoordinator(coordinatorOptions);
				},
				createSecretResolver: async () => {
					startupEvents.push('secret-resolver');
					return {
						resolve: async () => {
							startupEvents.push('github-token');
							return 'controller-github-token';
						},
						resolveAll: async () => ({}),
					};
				},
				isProcessAlive: () => true,
				now: () => nowMs,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				resolveControllerTelemetryIdentity: async () => {
					startupEvents.push('telemetry-identity');
					return {
						branchName: 'main',
						releaseChannel: 'beta',
						repositoryIdentity: 'repo',
						runtimeFlavor: 'beta',
						serviceVersion: '0.0.99',
						worktreeIdentity: 'worktree',
					};
				},
				resolveControllerTelemetryServiceVersion: async () => {
					startupEvents.push('telemetry-version');
					return '0.0.99';
				},
				runTask: async (_title, fn) => {
					await fn();
				},
				setIntervalImpl: (callback, delayMs) => {
					intervalCallbacks.push({ callback, delayMs });
					return fakeInterval;
				},
				startControllerTelemetry,
				startGatewayZone,
				startHttpServer: vi.fn(async (serverOptions) => {
					startHttpServerArgs = serverOptions;
					return { close: async () => {} };
				}),
			},
		);
		const gatewayServiceIntervalMs =
			observabilitySystemConfig.controller?.health.gatewayServiceIntervalMs;
		if (gatewayServiceIntervalMs === undefined) {
			throw new Error('Expected controller health config.');
		}
		const monitorTick = intervalCallbacks.find(
			(interval) => interval.delayMs === gatewayServiceIntervalMs,
		)?.callback;
		if (!monitorTick) {
			throw new Error('Expected gateway-service monitor interval callback.');
		}

		await monitorTick();
		nowMs += 100;
		if (capturedHealthEventStore === undefined || startHttpServerArgs === undefined) {
			throw new Error('Expected health store and controller HTTP app.');
		}
		stallTelemetrySink = true;
		recordControllerHealthEvent(capturedHealthEventStore, {
			domain: 'gateway_control',
			elapsedMs: 1,
			kind: 'gateway-control-session',
			observedAtMs: nowMs,
			operation: 'control-session-disconnect',
			peerId: 'gateway-shravan',
			result: 'failed',
			zoneId: 'shravan',
		});
		await Promise.resolve();
		await Promise.resolve();
		for (let eventIndex = 0; eventIndex < 257; eventIndex += 1) {
			recordControllerHealthEvent(capturedHealthEventStore, {
				domain: 'gateway_control',
				elapsedMs: 1,
				kind: 'gateway-control-session',
				observedAtMs: nowMs + eventIndex + 1,
				operation: 'control-session-disconnect',
				peerId: 'gateway-shravan',
				result: 'failed',
				zoneId: 'shravan',
			});
		}
		const controllerStatusMicrotaskDeadline = 10;
		const controllerStatusDeadline = Array.from(
			{ length: controllerStatusMicrotaskDeadline },
			() => undefined,
		)
			.reduce<Promise<void>>((deadline) => deadline.then(() => undefined), Promise.resolve())
			.then((): never => {
				throw new Error('Controller status exceeded its 10-microtask product deadline.');
			});
		const statusResponse = await Promise.race([
			Promise.resolve(startHttpServerArgs.app.request('/controller-status')),
			controllerStatusDeadline,
		]);
		expect(statusResponse.status).toBe(200);
		const controllerStatus = await statusResponse.json();
		expect(controllerStatus).toMatchObject({
			observability: {
				evidence: {
					healthEventSinks: {
						activeOperations: 1,
						droppedRecords: 1,
						highWaterPendingRecords: 256,
						pendingRecords: 256,
					},
				},
				telemetry: {
					emissionFailures: 0,
					operationFailures: 0,
					operationTimeouts: 0,
				},
			},
		});
		expect(JSON.stringify(controllerStatus)).not.toContain('controller-github-token');
		expect(JSON.stringify(controllerStatus)).not.toContain('op://');
		stallTelemetrySink = false;
		releaseStalledTelemetrySink?.();
		await runtime.close();

		expect(startControllerTelemetry).toHaveBeenCalledWith(
			expect.objectContaining({
				observabilityConfig: expect.objectContaining({
					enabled: true,
					stackMode: 'managed',
				}),
				projectNamespace: 'claw-tests-a1b2c3d4',
				proof: {
					marker: 'controller-runtime-proof-marker',
					startedAt: '2026-06-14T14:55:00.000Z',
				},
			}),
		);
		for (const dependentStartupEvent of [
			'secret-resolver',
			'github-token',
			'telemetry-version',
			'telemetry-identity',
			'telemetry-start',
		]) {
			expect(startupEvents.indexOf('ownership-coordinator-created')).toBeLessThan(
				startupEvents.indexOf(dependentStartupEvent),
			);
		}
		expect(telemetryLifecycleEvents).toEqual(['controller-started', 'controller-stopping']);
		expect(telemetryHealthEvents).toHaveLength(258);
		expect(telemetryHealthEvents[0]).toEqual(
			expect.objectContaining({
				kind: 'gateway-service-health',
				result: 'ok',
				zoneId: 'shravan',
			}),
		);
		expect(telemetryCloseOrder).toEqual(['forceFlush', 'shutdown']);
	});

	it('closes the controller server when required host observability readiness fails', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const closeHttpServer = vi.fn(async () => {});
		const releaseControllerOwnershipLock = vi.fn(async () => {});
		const startGatewayZone = vi.fn(async () => {
			throw new Error('gateway start should not run');
		});

		await expect(
			startControllerRuntime(
				{
					systemConfig: createObservabilitySystemConfig('require-ready'),
					zoneIds: ['shravan'],
				},
				{
					acquireControllerOwnershipLock: vi.fn(async () => ({
						release: releaseControllerOwnershipLock,
					})),
					checkObservabilityStackReadiness: vi.fn(
						async () =>
							({
								ok: false,
								reason: 'collector health check returned HTTP 503',
								status: 'unavailable',
							}) as const,
					),
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					isProcessAlive: () => true,
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					startGatewayZone,
					startHttpServer: vi.fn(async () => ({
						close: closeHttpServer,
					})),
				},
			),
		).rejects.toThrow(/Host observability stack is not ready/u);

		expect(closeHttpServer).toHaveBeenCalledOnce();
		expect(releaseControllerOwnershipLock).toHaveBeenCalledOnce();
		expect(startGatewayZone).not.toHaveBeenCalled();
	});

	it('keeps May 30-shaped channel-provider outage separate from later secret recovery blockers', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		let startGatewayCallCount = 0;
		let capturedHealthEventStore: HealthEventStore | undefined;
		const startGatewayZone = vi.fn(async (startOptions) => {
			capturedHealthEventStore = startOptions.healthEventStore;
			startGatewayCallCount += 1;
			if (startGatewayCallCount > 1) {
				throw new Error("Failed to resolve zone secrets for zone 'shravan': op failed");
			}
			return {
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
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
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: () => 48_282,
					id: 'gateway-vm-1',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				terminateVm: async () => {},
				vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-1'),
				zone,
			};
		});
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		let nowMs = 1_780_164_850_000;
		const runtime = await startControllerRuntime(
			{ systemConfig, zoneIds: ['shravan'] },
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: () => 12_345,
					id: 'tool-vm-1',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				now: () => nowMs,
				preflightGatewayZoneStart,
				startGatewayZone,
				startHttpServer: vi.fn(async (options) => {
					startHttpServerArgs = options;
					return { close: async () => {} };
				}),
			},
		);
		try {
			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}

			recordControllerHealthEvent(capturedHealthEventStore, {
				domain: 'gateway_control',
				elapsedMs: 1,
				kind: 'gateway-control-session',
				observedAtMs: nowMs - 30_001,
				operation: 'control-session-heartbeat',
				peerId: 'gateway-shravan',
				result: 'ok',
				zoneId: 'shravan',
			} satisfies AgentVmHealthEvent);
			nowMs += 30_001;
			const staleControlLinkStatusResponse =
				await startHttpServerArgs.app.request('/zones/shravan/status');
			expect(staleControlLinkStatusResponse.status).toBe(200);
			await expect(staleControlLinkStatusResponse.json()).resolves.toMatchObject({
				diagnosis: {
					selectedZoneReadiness: 'degraded',
				},
				readiness: 'degraded',
			});

			recordControllerHealthEvent(capturedHealthEventStore, {
				channelProviderId: 'primary-channel',
				details: { closeCode: 1006, providerType: 'discord', reconnecting: true },
				health: 'unhealthy-recoverable',
				kind: 'agent-channel-provider-health',
				observedAtMs: 1_780_164_840_000,
				result: 'failed',
				unhealthySinceMs: 1_780_164_840_000,
				zoneId: 'shravan',
			} satisfies AgentVmHealthEvent);

			const degradedStatusResponse = await startHttpServerArgs.app.request('/zones/shravan/status');
			expect(degradedStatusResponse.status).toBe(200);
			await expect(degradedStatusResponse.json()).resolves.toMatchObject({
				diagnosis: {
					channelProviderPlane: 'degraded',
					currentRecoveryBlocker: 'none',
					gatewayInfrastructure: 'running',
					originalOutageCause: { kind: 'unknown' },
					selectedZoneReadiness: 'degraded',
				},
				readiness: 'degraded',
				running: true,
			});

			recordControllerHealthEvent(capturedHealthEventStore, {
				channelProviderId: 'primary-channel',
				health: 'healthy',
				kind: 'agent-channel-provider-health',
				observedAtMs: nowMs - 30_001,
				result: 'ok',
				zoneId: 'shravan',
			} satisfies AgentVmHealthEvent);
			nowMs += 30_001;
			const staleProviderStatusResponse =
				await startHttpServerArgs.app.request('/zones/shravan/status');
			expect(staleProviderStatusResponse.status).toBe(200);
			await expect(staleProviderStatusResponse.json()).resolves.toMatchObject({
				diagnosis: {
					channelProviderPlane: 'degraded',
					selectedZoneReadiness: 'degraded',
				},
				readiness: 'degraded',
			});

			recordControllerHealthEvent(capturedHealthEventStore, {
				channelProviderId: 'primary-channel',
				details: { providerType: 'discord', statusCode: 403 },
				health: 'unhealthy-unrecoverable',
				kind: 'agent-channel-provider-health',
				observedAtMs: 1_780_164_900_000,
				result: 'failed',
				unhealthySinceMs: 1_780_164_900_000,
				zoneId: 'shravan',
			} satisfies AgentVmHealthEvent);
			const failedChannelStatusResponse =
				await startHttpServerArgs.app.request('/zones/shravan/status');
			expect(failedChannelStatusResponse.status).toBe(200);
			await expect(failedChannelStatusResponse.json()).resolves.toMatchObject({
				diagnosis: {
					channelProviderPlane: 'failed',
					currentRecoveryBlocker: 'none',
					gatewayInfrastructure: 'running',
					originalOutageCause: { kind: 'unknown' },
				},
				running: true,
			});

			const refreshResponse = await startHttpServerArgs.app.request(
				'/zones/shravan/credentials/refresh',
				{ method: 'POST' },
			);
			expect(refreshResponse.status).toBe(503);
			const blockedStatusResponse = await startHttpServerArgs.app.request('/zones/shravan/status');
			expect(blockedStatusResponse.status).toBe(200);
			await expect(blockedStatusResponse.json()).resolves.toMatchObject({
				diagnosis: {
					channelProviderPlane: 'failed',
					currentRecoveryBlocker: 'secret-resolution-failed',
					gatewayInfrastructure: 'failed',
					originalOutageCause: { kind: 'unknown' },
					selectedZoneReadiness: 'failed',
				},
				lastError: expect.stringContaining('Failed to resolve zone secrets'),
				readiness: 'failed',
				running: false,
			});
		} finally {
			await runtime.close();
		}
	});

	it('persists posted controller health events to the configured runtime directory', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-controller-health-'));
		const runtimeDir = path.join(tempRoot, 'runtime');
		const runtimeSystemConfig = {
			...systemConfig,
			runtimeDir,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					stateDir: path.join(tempRoot, 'state', zone.id),
					zoneFilesDir: path.join(tempRoot, 'zone-files', zone.id),
				},
			})),
		} satisfies LoadedSystemConfig;
		const zone = runtimeSystemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		let capturedHealthEventStore: HealthEventStore | undefined;
		const startGatewayZone = vi.fn(async (startOptions) => {
			capturedHealthEventStore = startOptions.healthEventStore;
			return {
				image: { built: true, fingerprint: 'gateway-image', imageReference: '/tmp/gateway-image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: openClawProcessSpec,
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
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: () => 48_282,
					id: 'gateway-vm-1',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				terminateVm: async () => {},
				vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-1'),
				zone,
			};
		});
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		let runtime: Awaited<ReturnType<typeof startControllerRuntime>> | undefined;
		try {
			runtime = await startControllerRuntime(
				{ systemConfig: runtimeSystemConfig, zoneIds: ['shravan'] },
				{
					createManagedToolVm: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						getHostProcessId: () => 12_345,
						id: 'tool-vm-1',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
					})),
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					isProcessAlive: () => true,
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					runTask: async (_title, fn) => {
						await fn();
					},
					preflightGatewayZoneStart,
					startGatewayZone,
					startHttpServer: vi.fn(async (options) => {
						startHttpServerArgs = options;
						return { close: async () => {} };
					}),
				},
			);
			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}

			recordControllerHealthEvent(capturedHealthEventStore, {
				domain: 'gateway_control',
				elapsedMs: 1,
				kind: 'gateway-control-session',
				observedAtMs: 1_780_000_000_000,
				operation: 'control-session-heartbeat',
				peerId: 'gateway-shravan',
				result: 'ok',
				zoneId: 'shravan',
			} satisfies AgentVmHealthEvent);
			await vi.waitFor(async () => {
				const logText = await readFile(
					path.join(runtimeDir, 'controller-health', 'events.jsonl'),
					'utf8',
				);
				expect(logText).toContain('"eventKind":"gateway-control-session"');
				expect(logText).toContain('"zoneId":"shravan"');
			});
		} finally {
			await runtime?.close();
			await rm(tempRoot, { force: true, recursive: true });
		}
	});

	it('auto restarts a running OpenClaw gateway VM after service failures corroborate a stale control session past death grace', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const runtimeSystemConfig = {
			...systemConfig,
			controller: {
				health: {
					...systemConfig.controller.health,
					gatewayServiceAutoRestart: {
						...defaultGatewayServiceAutoRestart,
						consecutiveFailureThreshold: 2,
					},
				},
			},
		} satisfies LoadedSystemConfig;
		const zone = runtimeSystemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		let nowMs = Date.parse('2026-05-27T13:00:00.000Z');
		let gatewayStartCount = 0;
		const firstGatewayClose = vi.fn(async () => {});
		const healthProbeCommands: string[] = [];
		const intervalCallbacks: {
			readonly callback: () => void | Promise<void>;
			readonly delayMs: number;
		}[] = [];
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const fakeInterval = setTimeout(() => undefined, 0);
		clearTimeout(fakeInterval);
		const preflightGatewayZoneStartMock = vi.fn(preflightGatewayZoneStart);
		let capturedHealthEventStore: HealthEventStore | undefined;
		const startGatewayZone = vi.fn(async (startOptions) => {
			capturedHealthEventStore = startOptions.healthEventStore;
			gatewayStartCount += 1;
			const gatewayVmId = `gateway-vm-${gatewayStartCount}`;
			const gatewayHostPid = 48_000 + gatewayStartCount;
			return {
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				controlSessionRecoverySourceKey: {
					bootId: `gateway-boot-${gatewayStartCount}`,
					domain: 'gateway_control' as const,
					gatewayVmId: `gateway-vm-${gatewayStartCount}`,
					generationId: `gateway-generation-${gatewayStartCount}`,
					zoneId: zone.id,
				},
				processSpec: openClawProcessSpec,
				vm: {
					close: gatewayStartCount === 1 ? firstGatewayClose : vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn((command: string) => {
						healthProbeCommands.push(command);
						return createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '502' });
					}),
					getHostProcessId: vi.fn(() => gatewayHostPid),
					id: gatewayVmId,
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				terminateVm: gatewayStartCount === 1 ? firstGatewayClose : async (): Promise<void> => {},
				vmOwnership: createGatewayVmLifecycleAuthorityStub(gatewayVmId),
				zone,
			};
		});
		const runtime = await startControllerRuntime(
			{
				systemConfig: runtimeSystemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: () => 12345,
					id: 'tool-vm-auto-recovery',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				now: () => nowMs,
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				runTask: async (_title, fn) => {
					await fn();
				},
				setIntervalImpl: (callback, delayMs) => {
					intervalCallbacks.push({ callback, delayMs });
					return fakeInterval;
				},
				preflightGatewayZoneStart: preflightGatewayZoneStartMock,
				startGatewayZone,
				startHttpServer: async (options) => {
					startHttpServerArgs = options;
					return { close: async () => {} };
				},
			},
		);
		const monitorTick = intervalCallbacks.find(
			(interval) =>
				interval.delayMs === runtimeSystemConfig.controller.health.gatewayServiceIntervalMs,
		)?.callback;
		if (!monitorTick) {
			throw new Error('Expected gateway-service monitor interval callback.');
		}
		if (!startHttpServerArgs) {
			throw new Error('Expected startHttpServer to be called.');
		}
		recordControllerHealthEvent(capturedHealthEventStore, {
			domain: 'gateway_control',
			elapsedMs: 1,
			kind: 'gateway-control-session',
			observedAtMs: nowMs,
			operation: 'control-session-heartbeat',
			peerId: 'gateway-shravan',
			result: 'ok',
			zoneId: 'shravan',
		} satisfies AgentVmHealthEvent);

		await monitorTick();
		expect(healthProbeCommands).toHaveLength(1);
		expect(startGatewayZone).toHaveBeenCalledTimes(1);
		expect(firstGatewayClose).not.toHaveBeenCalled();
		nowMs += runtimeSystemConfig.controller.health.staleAfterMs + 1;
		await monitorTick();
		expect(healthProbeCommands).toHaveLength(2);
		expect(startGatewayZone).toHaveBeenCalledTimes(1);
		expect(firstGatewayClose).not.toHaveBeenCalled();
		nowMs += 610_000;
		await monitorTick();

		expect(healthProbeCommands).toHaveLength(3);
		expect(startGatewayZone).toHaveBeenCalledTimes(2);
		expect(startGatewayZone.mock.calls[1]?.[0].onPendingVmCreation).toEqual(expect.any(Function));
		expect(firstGatewayClose).toHaveBeenCalledOnce();
		const snapshotResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/health-snapshot',
		);
		expect(snapshotResponse.status).toBe(200);
		await expect(snapshotResponse.json()).resolves.toMatchObject({
			latestEvents: expect.arrayContaining([
				expect.objectContaining({
					kind: 'gateway-recovery',
					newVmId: 'gateway-vm-2',
					oldVmId: 'gateway-vm-1',
					result: 'ok',
					zoneId: 'shravan',
				}),
			]),
		});

		await runtime.close();
	});

	it('does not auto restart when OpenClaw readiness is red but service liveness is healthy', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const runtimeSystemConfig = {
			...systemConfig,
			controller: {
				health: {
					...systemConfig.controller.health,
					gatewayServiceAutoRestart: {
						...defaultGatewayServiceAutoRestart,
						consecutiveFailureThreshold: 2,
					},
				},
			},
		} satisfies LoadedSystemConfig;
		const zone = runtimeSystemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		let nowMs = Date.parse('2026-05-27T13:00:00.000Z');
		const closeGatewayVm = vi.fn(async () => {});
		const healthProbeCommands: string[] = [];
		const intervalCallbacks: {
			readonly callback: () => void | Promise<void>;
			readonly delayMs: number;
		}[] = [];
		const fakeInterval = setTimeout(() => undefined, 0);
		clearTimeout(fakeInterval);
		const startGatewayZone = vi.fn(async () => ({
			image: {
				built: true,
				fingerprint: 'gateway-image',
				imageReference: '/tmp/gateway-image',
			},
			ingress: {
				host: '127.0.0.1',
				port: 18791,
			},
			processSpec: {
				...openClawProcessSpec,
				healthCheck: { type: 'http', port: 18789, path: '/readyz' } as const,
				serviceHealthCheck: { type: 'http', port: 18789, path: '/health' } as const,
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
					command: 'ssh ...',
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 19000,
					user: 'sandbox',
				})),
				exec: vi.fn((command: string) => {
					healthProbeCommands.push(command);
					return createManagedExecProcessStub({
						exitCode: 0,
						stderr: '',
						stdout: command.includes('/health') ? '200' : '503',
					});
				}),
				getHostProcessId: vi.fn(() => 48_000),
				id: 'gateway-vm-readiness-red-service-green',
				configureIngressRoutes: vi.fn(),
				start: async () => {},
			},
			terminateVm: closeGatewayVm,
			vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-readiness-red-service-green'),
			zone,
		}));
		const runtime = await startControllerRuntime(
			{
				systemConfig: runtimeSystemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: () => 12345,
					id: 'tool-vm-readiness-red-service-green',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				now: () => nowMs,
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				runTask: async (_title, fn) => {
					await fn();
				},
				setIntervalImpl: (callback, delayMs) => {
					intervalCallbacks.push({ callback, delayMs });
					return fakeInterval;
				},
				preflightGatewayZoneStart,
				startGatewayZone,
				startHttpServer: async () => ({ close: async () => {} }),
			},
		);
		const monitorTick = intervalCallbacks.find(
			(interval) =>
				interval.delayMs === runtimeSystemConfig.controller.health.gatewayServiceIntervalMs,
		)?.callback;
		if (!monitorTick) {
			throw new Error('Expected gateway-service monitor interval callback.');
		}

		await monitorTick();
		nowMs += 10_000;
		await monitorTick();

		expect(startGatewayZone).toHaveBeenCalledTimes(1);
		expect(closeGatewayVm).not.toHaveBeenCalled();
		expect(healthProbeCommands).toHaveLength(2);
		expect(healthProbeCommands.every((command) => command.includes('/health'))).toBe(true);
		expect(healthProbeCommands.some((command) => command.includes('/readyz'))).toBe(false);

		await runtime.close();
	});

	it('cold-starts recovery when the gateway runtime is already missing its host process', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const runtimeSystemConfig = {
			...systemConfig,
			controller: {
				health: {
					...systemConfig.controller.health,
					gatewayServiceAutoRestart: {
						...defaultGatewayServiceAutoRestart,
						consecutiveFailureThreshold: 1,
					},
				},
			},
		} satisfies LoadedSystemConfig;
		const zone = runtimeSystemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		let nowMs = Date.parse('2026-05-27T13:00:00.000Z');
		let gatewayStartCount = 0;
		const intervalCallbacks: {
			readonly callback: () => void | Promise<void>;
			readonly delayMs: number;
		}[] = [];
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const fakeInterval = setTimeout(() => undefined, 0);
		clearTimeout(fakeInterval);
		const preflightGatewayZoneStartMock = vi.fn(preflightGatewayZoneStart);
		const startGatewayZone = vi.fn(async () => {
			gatewayStartCount += 1;
			const gatewayVmId = `gateway-vm-${gatewayStartCount}`;
			const gatewayHostPid = gatewayStartCount === 1 ? null : 48_000 + gatewayStartCount;
			return {
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
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
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() =>
						createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '502' }),
					),
					getHostProcessId: vi.fn(() => gatewayHostPid),
					id: gatewayVmId,
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				terminateVm: async () => {},
				vmOwnership: createGatewayVmLifecycleAuthorityStub(gatewayVmId),
				zone,
			};
		});
		const runtime = await startControllerRuntime(
			{
				systemConfig: runtimeSystemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: () => 12_345,
					id: 'tool-vm-auto-cold-start',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				now: () => nowMs,
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				runTask: async (_title, fn) => {
					await fn();
				},
				setIntervalImpl: (callback, delayMs) => {
					intervalCallbacks.push({ callback, delayMs });
					return fakeInterval;
				},
				preflightGatewayZoneStart: preflightGatewayZoneStartMock,
				startGatewayZone,
				startHttpServer: async (options) => {
					startHttpServerArgs = options;
					return { close: async () => {} };
				},
			},
		);
		const monitorTick = intervalCallbacks.find(
			(interval) =>
				interval.delayMs === runtimeSystemConfig.controller.health.gatewayServiceIntervalMs,
		)?.callback;
		if (!monitorTick) {
			throw new Error('Expected gateway-service monitor interval callback.');
		}

		nowMs += 10_000;
		await monitorTick();

		expect(preflightGatewayZoneStartMock).toHaveBeenCalledWith(
			expect.objectContaining({
				runtimeEnvironment: {},
				runtimePluginConfigs: {},
				zoneId: 'shravan',
			}),
			expect.objectContaining({ managedVmImages: expect.any(Object) }),
		);
		expect(startGatewayZone).toHaveBeenCalledTimes(2);
		if (!startHttpServerArgs) {
			throw new Error('Expected startHttpServer to be called.');
		}
		const snapshotResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/health-snapshot',
		);
		expect(snapshotResponse.status).toBe(200);
		await expect(snapshotResponse.json()).resolves.toMatchObject({
			latestEvents: expect.arrayContaining([
				expect.objectContaining({
					action: 'gateway-vm-cold-start',
					kind: 'gateway-recovery',
					newVmId: 'gateway-vm-2',
					result: 'ok',
					zoneId: 'shravan',
				}),
			]),
		});

		await runtime.close();
	});

	it('refreshes the resolver and cold-starts recovery when the failed runtime is secret-blocked', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const runtimeSystemConfig = {
			...systemConfig,
			controller: {
				health: {
					...systemConfig.controller.health,
					gatewayServiceAutoRestart: {
						...defaultGatewayServiceAutoRestart,
						consecutiveFailureThreshold: 1,
					},
				},
			},
		} satisfies LoadedSystemConfig;
		const zone = runtimeSystemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		let nowMs = Date.parse('2026-05-27T13:00:00.000Z');
		const intervalCallbacks: {
			readonly callback: () => void | Promise<void>;
			readonly delayMs: number;
		}[] = [];
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const fakeInterval = setTimeout(() => undefined, 0);
		clearTimeout(fakeInterval);
		const createSecretResolver = vi.fn(async () => ({
			resolve: async () => 'resolved-single-secret',
			resolveAll: async () => ({}),
		}));
		const startGatewayZone = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("Failed to resolve zone secrets for zone 'shravan': op failed"),
			)
			.mockResolvedValueOnce({
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
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
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() =>
						createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '200' }),
					),
					getHostProcessId: () => 48_002,
					id: 'gateway-vm-secret-refresh',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				terminateVm: async () => {},
				vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-secret-refresh'),
				zone,
			});
		const runtime = await startControllerRuntime(
			{
				systemConfig: runtimeSystemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: () => 12_345,
					id: 'tool-vm-secret-refresh',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				})),
				createSecretResolver,
				now: () => nowMs,
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				runTask: async (_title, fn) => {
					await fn();
				},
				setIntervalImpl: (callback, delayMs) => {
					intervalCallbacks.push({ callback, delayMs });
					return fakeInterval;
				},
				preflightGatewayZoneStart,
				startGatewayZone,
				startHttpServer: async (options) => {
					startHttpServerArgs = options;
					return { close: async () => {} };
				},
			},
		);
		const monitorTick = intervalCallbacks.find(
			(interval) =>
				interval.delayMs === runtimeSystemConfig.controller.health.gatewayServiceIntervalMs,
		)?.callback;
		if (!monitorTick) {
			throw new Error('Expected gateway-service monitor interval callback.');
		}

		nowMs += 10_000;
		await monitorTick();

		expect(createSecretResolver).toHaveBeenCalledTimes(2);
		expect(startGatewayZone).toHaveBeenCalledTimes(2);
		if (!startHttpServerArgs) {
			throw new Error('Expected startHttpServer to be called.');
		}
		const snapshotResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/health-snapshot',
		);
		expect(snapshotResponse.status).toBe(200);
		await expect(snapshotResponse.json()).resolves.toMatchObject({
			latestEvents: expect.arrayContaining([
				expect.objectContaining({
					action: 'gateway-vm-cold-start',
					kind: 'gateway-recovery',
					newVmId: 'gateway-vm-secret-refresh',
					result: 'ok',
					zoneId: 'shravan',
				}),
			]),
		});

		await runtime.close();
	});

	it('records failed gateway recovery when restart does not replace the VM identity', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const runtimeSystemConfig = {
			...systemConfig,
			controller: {
				health: {
					...systemConfig.controller.health,
					gatewayServiceAutoRestart: {
						...defaultGatewayServiceAutoRestart,
						consecutiveFailureThreshold: 1,
					},
				},
			},
		} satisfies LoadedSystemConfig;
		const zone = runtimeSystemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		let nowMs = Date.parse('2026-05-27T13:00:00.000Z');
		let gatewayStartCount = 0;
		const intervalCallbacks: {
			readonly callback: () => void | Promise<void>;
			readonly delayMs: number;
		}[] = [];
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const fakeInterval = setTimeout(() => undefined, 0);
		clearTimeout(fakeInterval);
		let capturedHealthEventStore: HealthEventStore | undefined;
		const startGatewayZone = vi.fn(async (startOptions) => {
			capturedHealthEventStore = startOptions.healthEventStore;
			gatewayStartCount += 1;
			const gatewayHostPid = 48_000 + gatewayStartCount;
			return {
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
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
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() =>
						createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '502' }),
					),
					getHostProcessId: vi.fn(() => gatewayHostPid),
					id: 'gateway-vm-same',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				},
				controlSessionRecoverySourceKey: {
					bootId: `gateway-boot-${gatewayStartCount}`,
					domain: 'gateway_control' as const,
					gatewayVmId: 'gateway-vm-same',
					generationId: `gateway-generation-${gatewayStartCount}`,
					zoneId: zone.id,
				},
				terminateVm: async () => {},
				vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-same'),
				zone,
			};
		});
		const runtime = await startControllerRuntime(
			{
				systemConfig: runtimeSystemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					getHostProcessId: () => 12345,
					id: 'tool-vm-auto-recovery',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				now: () => nowMs,
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				runTask: async (_title, fn) => {
					await fn();
				},
				setIntervalImpl: (callback, delayMs) => {
					intervalCallbacks.push({ callback, delayMs });
					return fakeInterval;
				},
				preflightGatewayZoneStart,
				startGatewayZone,
				startHttpServer: async (options) => {
					startHttpServerArgs = options;
					return { close: async () => {} };
				},
			},
		);
		const monitorTick = intervalCallbacks.find(
			(interval) =>
				interval.delayMs === runtimeSystemConfig.controller.health.gatewayServiceIntervalMs,
		)?.callback;
		if (!monitorTick) {
			throw new Error('Expected gateway-service monitor interval callback.');
		}
		if (!startHttpServerArgs) {
			throw new Error('Expected startHttpServer to be called.');
		}
		recordControllerHealthEvent(capturedHealthEventStore, {
			domain: 'gateway_control',
			elapsedMs: 1,
			kind: 'gateway-control-session',
			observedAtMs: nowMs,
			operation: 'control-session-heartbeat',
			peerId: 'gateway-shravan',
			result: 'ok',
			zoneId: 'shravan',
		} satisfies AgentVmHealthEvent);

		nowMs += 10_000;
		await monitorTick();
		expect(startGatewayZone).toHaveBeenCalledTimes(1);
		nowMs += runtimeSystemConfig.controller.health.staleAfterMs + 1;
		await monitorTick();
		expect(startGatewayZone).toHaveBeenCalledTimes(1);
		nowMs += 610_000;
		await monitorTick();

		expect(startGatewayZone).toHaveBeenCalledTimes(2);
		const snapshotResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/health-snapshot',
		);
		expect(snapshotResponse.status).toBe(200);
		await expect(snapshotResponse.json()).resolves.toMatchObject({
			latestEvents: expect.arrayContaining([
				expect.objectContaining({
					errorCode: 'restart-verification-failed',
					kind: 'gateway-recovery',
					oldVmId: 'gateway-vm-same',
					result: 'failed',
					zoneId: 'shravan',
				}),
			]),
		});

		await runtime.close();
	});

	it('keeps the controller inspectable when a selected gateway fails to boot', async () => {
		const startHttpServer = vi.fn(async () => ({
			close: async () => {},
		}));

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-boot-fail',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
					getHostProcessId: () => 12345,
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				startGatewayZone: vi.fn(async () => {
					throw new Error('gateway boot failed');
				}),
				startHttpServer,
			},
		);

		expect(runtime.zones).toEqual([
			{
				lastError: 'gateway boot failed',
				lifecycleState: 'failed',
				zoneId: 'shravan',
			},
		]);
		expect(startHttpServer).toHaveBeenCalledTimes(1);
		await runtime.close();
	});

	it('registers stop-controller for worker runtimes', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
			})),
		};
		const workerZone = workerSystemConfig.zones[0];
		if (!workerZone) {
			throw new Error('Expected worker test zone.');
		}
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const startHttpServer = vi.fn(
			async (options: {
				app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
				port: number;
			}) => {
				startHttpServerArgs = options;
				return {
					close: async () => {},
				};
			},
		);

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-worker-stop',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
					getHostProcessId: () => 12345,
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				startGatewayZone: vi.fn(async () => ({
					image: {
						built: true,
						fingerprint: 'gateway-image',
						imageReference: '/tmp/gateway-image',
					},
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					processSpec: workerProcessSpec,
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
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						id: 'gateway-vm-worker',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
						getHostProcessId: () => 12345,
					},
					terminateVm: async () => {},
					vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-worker'),
					zone: workerZone,
				})),
				startHttpServer,
			},
		);

		if (!startHttpServerArgs) {
			throw new Error('Expected startHttpServer to be called.');
		}
		const stopResponse = await startHttpServerArgs.app.request('/stop-controller', {
			method: 'POST',
		});
		expect(stopResponse.status).toBe(200);
		await expect(stopResponse.json()).resolves.toMatchObject({ ok: true });
		await runtime.close();
	});

	it('passes the controller GitHub token to worker task cloning', async () => {
		const previousGithubToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'controller-token';
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			host: {
				...systemConfig.host,
				githubToken: {
					source: 'environment',
					envVar: 'GITHUB_TOKEN',
				},
			},
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
			})),
		};
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const prepareWorkerTask = vi.fn(async () => createPreparedWorkerTaskStub('worker-task-1'));
		const executeWorkerTask = vi.fn(async () => ({
			taskId: 'worker-task-1',
			finalState: { status: 'completed' },
			taskRoot: '/tmp/worker-task-1',
		}));
		const startHttpServer = vi.fn(
			async (options: {
				app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
				port: number;
			}) => {
				startHttpServerArgs = options;
				return {
					close: async () => {},
				};
			},
		);

		try {
			const runtime = await startControllerRuntime(
				{
					systemConfig: workerSystemConfig,
					zoneIds: ['shravan'],
				},
				{
					createManagedToolVm: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({
							close: vi.fn(async () => {}),
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							close: async () => {},
							serverHostKey: TEST_SSH_SERVER_HOST_KEY,
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						id: 'tool-vm-worker-task',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
						getHostProcessId: () => 12345,
					})),
					createSecretResolver: async () => ({
						resolve: async () => 'controller-token',
						resolveAll: async () => ({}),
					}),
					isProcessAlive: () => true,
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					prepareWorkerTask,
					executeWorkerTask,
					startGatewayZone: vi.fn(async () => {
						throw new Error('worker runtime should not start persistent gateway');
					}),
					startHttpServer,
				},
			);

			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}
			const response = await startHttpServerArgs.app.request('/zones/shravan/worker-tasks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					requestTaskId: 'request-task-1',
					prompt: 'fix private repo task',
					repos: [{ repoUrl: 'https://github.com/org/private.git', baseBranch: 'main' }],
					context: {},
				}),
			});

			expect(response.status).toBe(202);
			expect(prepareWorkerTask).toHaveBeenCalledWith(
				expect.objectContaining({
					githubToken: 'controller-token',
				}),
			);
			await expect(runtime.close()).rejects.toThrow(/worker task reservation/u);
		} finally {
			if (previousGithubToken === undefined) {
				delete process.env.GITHUB_TOKEN;
			} else {
				process.env.GITHUB_TOKEN = previousGithubToken;
			}
		}
	});

	it('exposes zone Git status through the controller using the host GitHub token', async () => {
		const previousGithubToken = process.env.GITHUB_TOKEN;
		const previousOpToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
		process.env.GITHUB_TOKEN = 'controller-token';
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'op-token';
		const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-vm-zone-git-runtime-'));
		const zoneFilesDir = path.join(tempDir, 'zone-files', 'shravan');
		await mkdir(zoneFilesDir, { recursive: true });
		const zoneGitSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			runtimeDir: path.join(tempDir, 'runtime'),
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					stateDir: path.join(tempDir, 'state', zone.id),
					zoneFilesDir,
					zoneGit: {
						remote: {
							repoUrl: 'https://github.com/shravansunder/zone-files.git',
							branch: 'agent/zone-files',
							defaultBranch: 'main',
							protectedBranches: ['main'],
							protectedBranchPatterns: ['release/*'],
						},
					},
				},
			})),
		};
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const startHttpServer = vi.fn(
			async (options: {
				app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
				port: number;
			}) => {
				startHttpServerArgs = options;
				return {
					close: async () => {},
				};
			},
		);

		try {
			const runtime = await startControllerRuntime(
				{
					systemConfig: zoneGitSystemConfig,
					zoneIds: [],
				},
				{
					createSecretResolver: async () => ({
						resolve: async () => 'controller-token',
						resolveAll: async () => ({}),
					}),
					isProcessAlive: () => true,
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					startGatewayZone: vi.fn(async () => {
						throw new Error('zone git status should not require a booted gateway');
					}),
					startHttpServer,
				},
			);

			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}
			const response = await startHttpServerArgs.app.request('/zones/shravan/zone-git/status');

			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				branch: 'agent/zone-files',
				initialized: false,
				localHead: null,
				remoteHead: null,
			});
			await runtime.close();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
			if (previousGithubToken === undefined) {
				delete process.env.GITHUB_TOKEN;
			} else {
				process.env.GITHUB_TOKEN = previousGithubToken;
			}
			if (previousOpToken === undefined) {
				delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
			} else {
				process.env.OP_SERVICE_ACCOUNT_TOKEN = previousOpToken;
			}
		}
	});

	it('reports a configuration error when zone Git is configured without a controller GitHub token', async () => {
		const previousGithubToken = process.env.GITHUB_TOKEN;
		const previousOpToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
		delete process.env.GITHUB_TOKEN;
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'op-token';
		const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-vm-zone-git-runtime-'));
		const zoneGitSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			runtimeDir: path.join(tempDir, 'runtime'),
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					stateDir: path.join(tempDir, 'state', zone.id),
					zoneFilesDir: path.join(tempDir, 'zone-files', zone.id),
					zoneGit: {
						remote: {
							repoUrl: 'https://github.com/shravansunder/zone-files.git',
							branch: 'agent/zone-files',
							defaultBranch: 'main',
							protectedBranches: ['main'],
							protectedBranchPatterns: ['release/*'],
						},
					},
				},
			})),
		};
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const startHttpServer = vi.fn(
			async (options: {
				app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
				port: number;
			}) => {
				startHttpServerArgs = options;
				return {
					close: async () => {},
				};
			},
		);

		try {
			const runtime = await startControllerRuntime(
				{
					systemConfig: zoneGitSystemConfig,
					zoneIds: [],
				},
				{
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					isProcessAlive: () => true,
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					startGatewayZone: vi.fn(async () => {
						throw new Error('zone git status should not require a booted gateway');
					}),
					startHttpServer,
				},
			);

			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}
			const response = await startHttpServerArgs.app.request('/zones/shravan/zone-git/status');

			expect(response.status).toBe(412);
			await expect(response.json()).resolves.toEqual({
				error:
					"zoneGit for zone 'shravan' requires host.githubToken so the controller can push without exposing credentials to VMs.",
			});
			await runtime.close();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
			if (previousGithubToken !== undefined) {
				process.env.GITHUB_TOKEN = previousGithubToken;
			}
			if (previousOpToken === undefined) {
				delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
			} else {
				process.env.OP_SERVICE_ACCOUNT_TOKEN = previousOpToken;
			}
		}
	});

	it('rejects a second worker task while the pod is already occupied', async () => {
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
			})),
		};
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		let resolveExecute: (() => Promise<void>) | undefined;
		let taskCounter = 0;
		const prepareWorkerTask = vi.fn(async (options: PrepareWorkerTaskOptions) => {
			taskCounter += 1;
			const prepared = createPreparedWorkerTaskStub(
				`worker-task-${String(taskCounter)}`,
				options.input.requestTaskId,
			);
			await options.onTaskPrepared?.({
				taskId: prepared.taskId,
				zoneId: prepared.zoneId,
				taskRoot: prepared.taskRoot,
				eventLogPath: prepared.eventLogPath,
				branchPrefix: prepared.preStartResult.effectiveConfig.branchPrefix,
				repos: [],
				workerIngress: null,
			});
			return prepared;
		});
		const executeWorkerTask = vi.fn(
			async (prepared, options: ExecuteWorkerTaskOptions) =>
				await new Promise<{
					taskId: string;
					finalState: { status: 'completed' };
					taskRoot: string;
				}>((resolve) => {
					resolveExecute = async () => {
						await options.onTaskFinished?.(prepared.zoneId, prepared.taskId);
						resolve({
							taskId: prepared.taskId,
							finalState: { status: 'completed' },
							taskRoot: prepared.taskRoot,
						});
					};
				}),
		);

		const runtime = await startControllerRuntime(
			{
				systemConfig: workerSystemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-worker-capacity',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
					getHostProcessId: () => 12345,
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				prepareWorkerTask,
				executeWorkerTask,
				startGatewayZone: vi.fn(async () => {
					throw new Error('worker runtime should not start persistent gateway');
				}),
				startHttpServer: vi.fn(async (options) => {
					startHttpServerArgs = options;
					return {
						close: async () => {},
					};
				}),
			},
		);

		try {
			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}

			const firstResponse = await startHttpServerArgs.app.request('/zones/shravan/worker-tasks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					requestTaskId: 'request-task-1',
					prompt: 'first task',
					repos: [],
					context: {},
				}),
			});
			expect(firstResponse.status).toBe(202);

			const secondResponse = await startHttpServerArgs.app.request('/zones/shravan/worker-tasks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					requestTaskId: 'request-task-2',
					prompt: 'second task',
					repos: [],
					context: {},
				}),
			});

			expect(secondResponse.status).toBe(409);
			await expect(secondResponse.json()).resolves.toMatchObject({
				status: 'at-capacity',
				error: expect.stringContaining('at capacity'),
			});
			expect(prepareWorkerTask).toHaveBeenCalledTimes(1);

			await resolveExecute?.();
		} finally {
			await runtime.close();
		}
	});

	it('deletes the runtime record on close after the gateway stops', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const callOrder: string[] = [];
		const deleteGatewayRuntimeRecord = vi.fn(async () => {
			callOrder.push('delete-record');
		});
		const closeGatewayVm = vi.fn(async () => {
			callOrder.push('close-gateway');
		});
		const startGatewayZone = vi.fn(async () => {
			callOrder.push('start-gateway');
			return {
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
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
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'gateway-vm-cleanup-test',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
					getHostProcessId: () => 12345,
				},
				terminateVm: closeGatewayVm,
				vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-cleanup-test'),
				zone,
			};
		});

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-cleanup-test',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
					getHostProcessId: () => 12345,
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				deleteGatewayRuntimeRecord,
				preflightGatewayZoneStart,
				startGatewayZone,
				startHttpServer: vi.fn(async () => ({
					close: async () => {},
				})),
			},
		);

		expect(callOrder).toEqual(['start-gateway']);

		await runtime.close();

		expect(closeGatewayVm).toHaveBeenCalledTimes(1);
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith(zone.gateway.stateDir);
		expect(callOrder.slice(-2)).toEqual(['close-gateway', 'delete-record']);
	});

	it('retains the controller ownership lock when shutdown leaves Gateway ownership incomplete', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const lockConflict = new ControllerOwnershipLockError('controller-already-active');
		const unexpectedSecondAcquisition = new Error(
			'second controller acquired the ownership lock after owner-unsafe shutdown',
		);
		let ownershipLockHeld = false;
		let acquisitionCount = 0;
		const releaseControllerOwnershipLock = vi.fn(async () => {
			ownershipLockHeld = false;
		});
		const acquireControllerOwnershipLock = vi.fn(async () => {
			acquisitionCount += 1;
			if (ownershipLockHeld) {
				throw lockConflict;
			}
			if (acquisitionCount > 1) {
				throw unexpectedSecondAcquisition;
			}
			ownershipLockHeld = true;
			return { release: releaseControllerOwnershipLock };
		});
		const childDestructionFailure = new Error('Tool VM destruction remained incomplete');
		const gatewayTerminationProofFailure = new Error(
			'recorded Gateway process identity did not match during termination',
		);
		const ownershipIncomplete = new GatewayOwnershipCoordinatorError('owner-unsafe', {
			cause: gatewayTerminationProofFailure,
		});
		const gatewayDestructionFailure = new AggregateError(
			[childDestructionFailure, ownershipIncomplete],
			'Gateway VM close failed and its exact disposition is owner-unsafe.',
			{ cause: childDestructionFailure },
		);
		const closeGatewayVm = vi.fn(async () => {});
		const destroyGatewayLive = vi.fn(async (): Promise<void> => {
			throw gatewayDestructionFailure;
		});
		const gatewayVmOwnership = {
			...createGatewayVmLifecycleAuthorityStub('gateway-vm-owner-unsafe'),
			destroyLive: destroyGatewayLive,
		} satisfies GatewayVmLifecycleAuthority;
		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				acquireControllerOwnershipLock,
				createManagedToolVm: vi.fn(async () => {
					throw new Error('Tool VM creation should not run.');
				}),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				startGatewayZone: vi.fn(async () => ({
					image: {
						built: true,
						fingerprint: 'gateway-image',
						imageReference: '/tmp/gateway-image',
					},
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					processSpec: openClawProcessSpec,
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
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						id: 'gateway-vm-owner-unsafe',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
						getHostProcessId: () => 12345,
					},
					terminateVm: async () => {},
					vmOwnership: gatewayVmOwnership,
					zone,
				})),
				startHttpServer: vi.fn(async () => ({
					close: async () => {},
				})),
			},
		);

		const shutdownError = await runtime.close().catch((error: unknown) => error);
		let secondControllerError: unknown;
		try {
			await startControllerRuntime(
				{ systemConfig, zoneIds: [] },
				{ acquireControllerOwnershipLock },
			);
		} catch (error) {
			secondControllerError = error;
		}

		expect(shutdownError).toBeInstanceOf(AggregateError);
		expect(shutdownError).toMatchObject({ errors: [gatewayDestructionFailure] });
		expect(ownershipIncomplete.cause).toBe(gatewayTerminationProofFailure);
		expect(secondControllerError).toBe(lockConflict);
		expect(destroyGatewayLive).toHaveBeenCalledOnce();
		expect(closeGatewayVm).not.toHaveBeenCalled();
		expect(releaseControllerOwnershipLock).not.toHaveBeenCalled();
	});

	it('releases the controller ownership lock after proven destruction despite runtime record cleanup failure', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const lockConflict = new ControllerOwnershipLockError('controller-already-active');
		const secondControllerAcquired = new Error(
			'second controller acquired the released ownership lock',
		);
		let ownershipLockHeld = false;
		let acquisitionCount = 0;
		const releaseControllerOwnershipLock = vi.fn(async () => {
			ownershipLockHeld = false;
		});
		const acquireControllerOwnershipLock = vi.fn(async () => {
			acquisitionCount += 1;
			if (ownershipLockHeld) {
				throw lockConflict;
			}
			if (acquisitionCount > 1) {
				throw secondControllerAcquired;
			}
			ownershipLockHeld = true;
			return { release: releaseControllerOwnershipLock };
		});
		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				acquireControllerOwnershipLock,
				createManagedToolVm: vi.fn(async () => {
					throw new Error('Tool VM creation should not run.');
				}),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				deleteGatewayRuntimeRecord: async () => {
					throw new Error('runtime record cleanup failed');
				},
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				startGatewayZone: vi.fn(async () => ({
					image: {
						built: true,
						fingerprint: 'gateway-image',
						imageReference: '/tmp/gateway-image',
					},
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					processSpec: openClawProcessSpec,
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
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						id: 'gateway-vm-cleanup-failure',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
						getHostProcessId: () => 12345,
					},
					terminateVm: async () => {},
					vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-cleanup-failure'),
					zone,
				})),
				startHttpServer: vi.fn(async () => ({
					close: async () => {},
				})),
			},
		);

		await expect(runtime.close()).rejects.toThrow('runtime record cleanup failed');
		await expect(
			startControllerRuntime({ systemConfig, zoneIds: [] }, { acquireControllerOwnershipLock }),
		).rejects.toBe(secondControllerAcquired);
		expect(releaseControllerOwnershipLock).toHaveBeenCalledOnce();
	});

	it('surfaces runtime record deletion failures during shutdown', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const closeGatewayVm = vi.fn(async () => {});
		const releaseControllerOwnershipLock = vi.fn(async () => {
			throw new Error('ownership lock release failed');
		});

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				acquireControllerOwnershipLock: vi.fn(async () => ({
					release: releaseControllerOwnershipLock,
				})),
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-clean',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
					getHostProcessId: () => 12345,
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				deleteGatewayRuntimeRecord: async () => {
					throw new Error('permission denied');
				},
				startGatewayZone: vi.fn(async () => ({
					image: {
						built: true,
						fingerprint: 'gateway-image',
						imageReference: '/tmp/gateway-image',
					},
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					processSpec: openClawProcessSpec,
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
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						id: 'gateway-vm-clean',
						configureIngressRoutes: vi.fn(),
						start: async () => {},
						getHostProcessId: () => 12345,
					},
					terminateVm: closeGatewayVm,
					vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-clean'),
					zone,
				})),
				startHttpServer: vi.fn(async () => ({
					close: async () => {},
				})),
			},
		);

		let thrownError: unknown;
		try {
			await runtime.close();
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		expect((thrownError as AggregateError).errors).toEqual([
			expect.objectContaining({ message: expect.stringContaining('permission denied') }),
			expect.objectContaining({ message: 'ownership lock release failed' }),
		]);
		expect(closeGatewayVm).toHaveBeenCalledTimes(1);
		expect(releaseControllerOwnershipLock).toHaveBeenCalledOnce();
	});

	it('still closes the HTTP server when gateway restart fails before runtime.close', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const closeGatewayVm = vi.fn(async () => {});
		const closeHttpServer = vi.fn(async () => {});
		const startGatewayZone = vi
			.fn()
			.mockResolvedValueOnce({
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imageReference: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
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
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'gateway-vm-close-after-failed-restart',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
					getHostProcessId: () => 12345,
				},
				terminateVm: closeGatewayVm,
				vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-close-after-failed-restart'),
				zone,
			})
			.mockRejectedValueOnce(new Error('restart failed'));
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-close-after-failed-restart',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
					getHostProcessId: () => 12345,
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				preflightGatewayZoneStart,
				startGatewayZone,
				startHttpServer: vi.fn(async (options) => {
					startHttpServerArgs = options;
					return {
						close: closeHttpServer,
					};
				}),
			},
		);

		if (!startHttpServerArgs) {
			throw new Error('Expected runtime HTTP server args');
		}

		const refreshResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/credentials/refresh',
			{ method: 'POST' },
		);
		expect(refreshResponse.status).toBe(503);
		await expect(runtime.close()).resolves.toBeUndefined();
		expect(closeHttpServer).toHaveBeenCalledTimes(1);
		expect(closeGatewayVm).toHaveBeenCalledTimes(1);
	});

	it('flushes queued durable health events before close resolves', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		let resolveDurableAppend: (() => void) | undefined;
		let closeSettled = false;
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		let capturedHealthEventStore: HealthEventStore | undefined;
		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				appendDurableHealthEvent: vi.fn(
					async () =>
						await new Promise<void>((resolve) => {
							resolveDurableAppend = resolve;
						}),
				),
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						host: '127.0.0.1',
						port: 18791,
					})),
					enableSsh: vi.fn(async () => ({
						close: async () => {},
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-close-flush',
					configureIngressRoutes: vi.fn(),
					start: async () => {},
					getHostProcessId: () => 12345,
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				isProcessAlive: () => true,
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				startGatewayZone: vi.fn(async (startOptions) => {
					capturedHealthEventStore = startOptions.healthEventStore;
					return {
						image: {
							built: true,
							fingerprint: 'gateway-image',
							imageReference: '/tmp/gateway-image',
						},
						ingress: {
							host: '127.0.0.1',
							port: 18791,
						},
						processSpec: openClawProcessSpec,
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
								command: 'ssh ...',
								host: '127.0.0.1',
								identityFile: '/tmp/key',
								port: 19000,
								user: 'sandbox',
							})),
							exec: vi.fn(() =>
								createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
							),
							id: 'gateway-vm-close-flush',
							configureIngressRoutes: vi.fn(),
							start: async () => {},
							getHostProcessId: () => 12345,
						},
						terminateVm: async () => {},
						vmOwnership: createGatewayVmLifecycleAuthorityStub('gateway-vm-close-flush'),
						zone,
					};
				}),
				startHttpServer: vi.fn(async (options) => {
					startHttpServerArgs = options;
					return {
						close: async () => {},
					};
				}),
			},
		);
		if (!startHttpServerArgs) {
			throw new Error('Expected runtime HTTP server args');
		}

		recordControllerHealthEvent(capturedHealthEventStore, {
			domain: 'gateway_control',
			elapsedMs: 1,
			kind: 'gateway-control-session',
			observedAtMs: 1_000,
			operation: 'control-session-heartbeat',
			peerId: 'gateway-shravan',
			result: 'ok',
			zoneId: 'shravan',
		} satisfies AgentVmHealthEvent);

		const closePromise = runtime.close().then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		resolveDurableAppend?.();
		await closePromise;
		expect(closeSettled).toBe(true);
	});
});
