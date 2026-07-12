import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayControlCallerContextRegisterPayload,
	type GatewayControlCallerContextProof,
	type GatewayControlLeaseSnapshot,
	GatewayControlRpcCommandResultMessageSchema,
	type GatewayControlCallerContextProofPayloadInput,
} from '@agent-vm/gateway-control-contracts';
import type { GatewayZoneConfig } from '@agent-vm/gateway-lifecycle';
import type {
	BuildConfig,
	BuildImageResult,
	ManagedVm,
	ManagedVmInstance,
} from '@agent-vm/gondolin-adapter';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import type {
	GatewayControlLeaseRpcOperations,
	GatewayDisposableControlSessionClient,
	GatewayControlSessionMaterial,
} from '../controller/control-session/index.js';
import {
	createGatewayControlProcessAdmissionCoordinator,
	createGatewayControlSessionMaterial,
	resolveGatewayControlSessionMaterialPath,
} from '../controller/control-session/index.js';
import { HealthEventStore } from '../controller/health/health-event-store.js';
import {
	openClawProcessSupervisorReceiptSchema,
	type OpenClawProcessSupervisorGateway,
} from '../controller/process-supervisor/openclaw-process-supervisor-contracts.js';
import type { OpenClawProcessSupervisor } from '../controller/process-supervisor/openclaw-process-supervisor.js';
import type { GatewayVmLifecycleAuthority } from '../controller/vm-ownership/gateway-vm-lifecycle-authority.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';
import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';
import { loadGatewayRuntimeRecord } from './gateway-runtime-record.js';
import {
	preflightGatewayZoneStart,
	resolveOpenClawProcessSupervisorStateMount,
	startGatewayZone as startGatewayZonePublicProduction,
	startGatewayZoneForController as startGatewayZoneProduction,
	validateGatewayControlCallerContextRegistration,
	waitForGatewayServiceHealth,
	type GatewayManagerDependencies,
} from './gateway-zone-orchestrator.js';
import type {
	GatewayControlSessionConnector,
	GatewayManagedVmFactoryOptions,
	GatewayZoneStartResult,
	PendingGatewayVmCreationContainment,
	StartGatewayZoneOptions,
} from './gateway-zone-support.js';

interface DeferredPromise<TResult> {
	readonly promise: Promise<TResult>;
	readonly resolve: (result: TResult) => void;
}

type ControllerStartGatewayZoneOptions = Parameters<typeof startGatewayZoneProduction>[0];
type TestStartGatewayZoneOptions = Omit<ControllerStartGatewayZoneOptions, 'createVmOwnership'> &
	Partial<Pick<ControllerStartGatewayZoneOptions, 'createVmOwnership'>>;

interface TestVmOwnershipHarness {
	readonly createVmOwnership: Mock<StartGatewayZoneOptions['createVmOwnership']>;
	readonly attachGatewayVm: Mock<GatewayVmLifecycleAuthority['attachGatewayVm']>;
	readonly containPendingCreate: Mock<GatewayVmLifecycleAuthority['containPendingCreate']>;
	readonly destroyLive: Mock<GatewayVmLifecycleAuthority['destroyLive']>;
	readonly vmOwnership: GatewayVmLifecycleAuthority;
}

const testGatewayBootId = 'gateway-boot-exact';
const testGatewayGenerationId = 'gateway-generation-exact';

function createTestGatewayEpochIdentity(
	vmId: string,
	controllerEpoch = 'controller-epoch-test',
): GatewayEpochIdentity {
	return {
		bootId: testGatewayBootId,
		controllerEpoch,
		gatewayEpochId: `gateway-epoch-${vmId}`,
		gatewayVmId: vmId,
		generationId: testGatewayGenerationId,
		zoneId: 'shravan',
	};
}

const createExactTestGatewayControlSessionMaterial: GatewayManagerDependencies['createGatewayControlSessionMaterial'] =
	({ controllerEpoch, zoneId }) =>
		createGatewayControlSessionMaterial({
			agentIds: ['main'],
			bootId: testGatewayBootId,
			controllerEpoch,
			generationId: testGatewayGenerationId,
			zoneId,
		});

function createTestVmOwnershipHarness(
	vmId = 'gateway-vm-ownership-test',
	gatewayIdentity?: GatewayEpochIdentity,
): TestVmOwnershipHarness {
	const gatewaySeed = {
		bootId: gatewayIdentity?.bootId ?? testGatewayBootId,
		controllerEpoch: gatewayIdentity?.controllerEpoch ?? 'controller-epoch-test',
		gatewayEpochId: gatewayIdentity?.gatewayEpochId ?? `gateway-epoch-${vmId}`,
		generationId: gatewayIdentity?.generationId ?? testGatewayGenerationId,
		zoneId: gatewayIdentity?.zoneId ?? 'shravan',
	};
	let attachedGatewayIdentity = gatewayIdentity;
	const attachGatewayVm = vi.fn((attachedVmId: string): GatewayEpochIdentity => {
		attachedGatewayIdentity = { ...gatewaySeed, gatewayVmId: attachedVmId };
		return attachedGatewayIdentity;
	});
	const containPendingCreate = vi.fn(
		async (options: {
			readonly closeLateCreatedVm: (createdVm: ManagedVm) => Promise<void>;
			readonly pendingCreate: Promise<ManagedVm>;
		}): Promise<void> => {
			await options.closeLateCreatedVm(await options.pendingCreate);
		},
	);
	const destroyLive = vi.fn(async (destroyGatewayVm: () => Promise<void>): Promise<void> => {
		await destroyGatewayVm();
	});
	const vmOwnership: GatewayVmLifecycleAuthority = {
		attachGatewayVm,
		containPendingCreate,
		destroyLive,
		get gatewayIdentity(): GatewayEpochIdentity | undefined {
			return attachedGatewayIdentity;
		},
		gatewaySeed,
	};
	return {
		createVmOwnership: vi.fn(async () => vmOwnership),
		attachGatewayVm,
		containPendingCreate,
		destroyLive,
		vmOwnership,
	};
}

async function createDefaultTestVmOwnership(
	options: Parameters<StartGatewayZoneOptions['createVmOwnership']>[0],
	controllerEpoch: string,
	resolveCreatedVmId: () => string | undefined,
): Promise<GatewayVmLifecycleAuthority> {
	const reservedGatewayVmId = `test-gateway-vm-${options.zoneId}`;
	// The real adapter derives its VM id from the ownership reservation. Older
	// test factories choose an arbitrary fake id internally, so the shared test
	// fixture binds that id when the fake factory returns. Focused ownership
	// tests below use fixed identities and do not take this compatibility path.
	const gatewayIdentity: GatewayEpochIdentity | undefined =
		options.kind === 'gateway-epoch' && options.controlIdentity !== undefined
			? {
					bootId: options.controlIdentity.bootId,
					controllerEpoch,
					gatewayEpochId: `test-gateway-epoch-${options.zoneId}`,
					gatewayVmId: resolveCreatedVmId() ?? reservedGatewayVmId,
					generationId: options.controlIdentity.generationId,
					zoneId: options.zoneId,
				}
			: undefined;
	return createTestVmOwnershipHarness(
		options.kind === 'gateway-epoch' ? reservedGatewayVmId : 'test-standalone-vm',
		gatewayIdentity,
	).vmOwnership;
}

function withTestVmOwnership(
	options: TestStartGatewayZoneOptions,
	resolveCreatedVmId: () => string | undefined = () => undefined,
): ControllerStartGatewayZoneOptions {
	const controllerEpoch = options.controlSession?.controllerEpoch ?? 'controller-epoch-test';
	return {
		createVmOwnership: async (createOptions) =>
			await createDefaultTestVmOwnership(createOptions, controllerEpoch, resolveCreatedVmId),
		...options,
	};
}

const connectTestGatewayControlSession: GatewayControlSessionConnector = async () => ({
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
		connectionId: '55555555-5555-4555-8555-555555555555',
		controllerEpoch: 'controller-epoch-test',
		outcome: 'accepted',
		sessionId: '33333333-3333-4333-8333-333333333333',
	}),
});

function createTestOpenClawProcessSupervisor(
	gateway: OpenClawProcessSupervisorGateway,
): OpenClawProcessSupervisor {
	let currentProcessEpoch: string | undefined;
	return {
		contain: async () => {
			throw new Error('test process supervisor containment was not expected');
		},
		observe: async (request) => {
			if (request.expectedProcessEpoch === null) {
				return {
					actionId: request.actionId,
					cgroup: { name: null, populated: false },
					contractVersion: 1,
					expectedProcessEpoch: null,
					gateway,
					kind: 'observe',
					observedProcessEpoch: null,
					status: 'completed',
				};
			}
			if (currentProcessEpoch !== request.expectedProcessEpoch) {
				throw new Error('test process supervisor observed the wrong process epoch');
			}
			return {
				actionId: request.actionId,
				cgroup: { name: 'test-openclaw-cgroup', populated: true },
				contractVersion: 1,
				expectedProcessEpoch: request.expectedProcessEpoch,
				gateway,
				kind: 'observe',
				observedProcessEpoch: request.expectedProcessEpoch,
				status: 'completed',
			};
		},
		start: async (request) => {
			currentProcessEpoch = request.selectedProcessEpoch;
			return {
				actionId: request.actionId,
				cgroup: { name: 'test-openclaw-cgroup', populated: true },
				contractVersion: 1,
				expectedProcessEpoch: request.expectedProcessEpoch,
				gateway,
				kind: 'start',
				observedProcessEpoch: request.selectedProcessEpoch,
				status: 'completed',
			};
		},
	};
}

function startGatewayZone(
	options: TestStartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies = {},
	entrypoint: 'controller-internal' | 'public' = 'controller-internal',
): Promise<GatewayZoneStartResult> {
	let createdVmId: string | undefined;
	let runnerDetached = false;
	const createManagedVm = dependencies.createManagedVm;
	const startOptions = withTestVmOwnership(
		{
			controlSession: { controllerEpoch: 'controller-epoch-test' },
			...options,
		},
		() => createdVmId,
	);
	const effectiveDependencies: GatewayManagerDependencies = {
		connectGatewayControlSession: connectTestGatewayControlSession,
		createOpenClawProcessSupervisorPorts: ({ gateway }) => ({
			reliabilityFaultActuator: {
				terminateOwnedProcess: vi.fn(async () => {
					throw new Error('Gateway orchestrator test did not expect reliability actuation.');
				}),
			},
			supervisor: createTestOpenClawProcessSupervisor(gateway),
		}),
		managedVmKillDependencies: {
			isProcessAlive: () => !runnerDetached,
			killProcess: () => {
				runnerDetached = true;
			},
			readProcessCommand: async () => 'qemu-system-x86_64 -m 4G',
			readProcessIdentity: async () => ({
				command: 'qemu-system-x86_64 -m 4G',
				lstart: 'Fri May 22 10:00:00 2026',
			}),
			sleep: async () => {},
		},
		...dependencies,
		...(createManagedVm === undefined
			? {}
			: {
					createManagedVm: async (createOptions: GatewayManagedVmFactoryOptions) => {
						const managedVm = await createManagedVm(createOptions);
						const getHostPid = managedVm.getHostPid.bind(managedVm);
						Object.defineProperty(managedVm, 'getHostPid', {
							configurable: true,
							value: (): number | null => (runnerDetached ? null : getHostPid()),
						});
						createdVmId = managedVm.id;
						return managedVm;
					},
				}),
	};
	return entrypoint === 'public'
		? startGatewayZonePublicProduction(startOptions, effectiveDependencies)
		: startGatewayZoneProduction(startOptions, effectiveDependencies);
}

const testCallerContextProofKey = 'test-caller-context-proof-key';
const testAgentAuthorityKeys: Readonly<Record<string, string>> = {
	main: 'test-main-agent-authority-key-with-enough-length',
	second: 'test-second-agent-authority-key-with-enough-length',
};

function signTestCallerContextProof(
	input: GatewayControlCallerContextProofPayloadInput,
	proofKey = testCallerContextProofKey,
): GatewayControlCallerContextProof {
	return {
		algorithm: 'hmac-sha256',
		digest: createHmac('sha256', proofKey)
			.update(buildGatewayControlCallerContextProofPayload(input), 'utf8')
			.digest('base64url'),
	};
}

function signTestCallerContextAgentAuthority(
	input: GatewayControlCallerContextProofPayloadInput,
	key = testAgentAuthorityKeys[input.agentId] ?? 'missing',
): {
	readonly algorithm: 'hmac-sha256';
	readonly digest: string;
	readonly keyId: string;
} {
	return {
		algorithm: 'hmac-sha256',
		digest: createHmac('sha256', key)
			.update(buildGatewayControlCallerContextAgentAuthorityPayload(input), 'utf8')
			.digest('base64url'),
		keyId: input.agentId,
	};
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(rawJson: string): Record<string, unknown> {
	const parsedJson = JSON.parse(rawJson) as unknown;
	if (!isJsonRecord(parsedJson)) {
		throw new Error('Expected JSON object.');
	}
	return parsedJson;
}

function requireObjectProperty(
	record: Record<string, unknown>,
	propertyName: string,
): Record<string, unknown> {
	const property = record[propertyName];
	if (!isJsonRecord(property)) {
		throw new Error(`Expected JSON object property '${propertyName}'.`);
	}
	return property;
}

const {
	cleanupOrphanedGatewayIfPresentMock,
	cleanupOrphanedToolVmsIfPresentMock,
	preflightOrphanedGatewayCleanupIfPresentMock,
} = vi.hoisted(() => ({
	cleanupOrphanedGatewayIfPresentMock: vi.fn(async () => ({
		cleanedUp: false,
		killedPid: null,
	})),
	cleanupOrphanedToolVmsIfPresentMock: vi.fn(async () => ({
		cleanedCount: 0,
		killedPids: [] as readonly number[],
		quarantinedCount: 0,
		warnings: [] as readonly string[],
	})),
	preflightOrphanedGatewayCleanupIfPresentMock: vi.fn(async () => ({})),
}));

// Stub the ps shell-out so buildGatewayRuntimeRecord doesn't try to query a
// real pid in the test environment. Production uses the real implementation.
vi.mock('../shared/managed-vm-process.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../shared/managed-vm-process.js')>();
	return {
		...actual,
		readProcessIdentity: vi.fn(async () => ({
			command: 'qemu-system-x86_64 -m 4G',
			lstart: 'Fri May 22 10:00:00 2026',
		})),
	};
});

vi.mock('./gateway-recovery.js', () => ({
	cleanupOrphanedGatewayIfPresent: cleanupOrphanedGatewayIfPresentMock,
	preflightOrphanedGatewayCleanupIfPresent: preflightOrphanedGatewayCleanupIfPresentMock,
}));

vi.mock('../controller/leases/tool-vm-recovery.js', () => ({
	cleanupOrphanedToolVmsIfPresent: cleanupOrphanedToolVmsIfPresentMock,
}));

const createdDirectories: string[] = [];

const openClawToolVmSandbox = {
	backend: 'gondolin',
	mode: 'all',
	scope: 'agent',
	workspaceAccess: 'rw',
} satisfies Record<string, string>;

function buildExpectedOpenClawGatewayStartCommandForTest(): string {
	return [
		'{ printf \'gateway-boot: NODE_OPTIONS=%s\\n\' "$NODE_OPTIONS" > /agent-vm/logs/gateway-boot-latest.log; }',
		"printf 'gateway-supervisor: controller-owned helper ready; awaiting typed request\\n' >> /agent-vm/logs/gateway-boot-latest.log",
	].join(' && ');
}

function createDeferredPromise<TResult>(): DeferredPromise<TResult> {
	let resolveDeferred: ((result: TResult) => void) | null = null;
	const promise = new Promise<TResult>((resolve) => {
		resolveDeferred = resolve;
	});
	return {
		promise,
		resolve: (result: TResult): void => {
			if (resolveDeferred === null) {
				throw new Error('Deferred promise resolve callback was not initialized.');
			}
			resolveDeferred(result);
		},
	};
}

async function flushPendingEventLoopWork(): Promise<void> {
	for (let iterationIndex = 0; iterationIndex < 20; iterationIndex += 1) {
		// oxlint-disable-next-line no-await-in-loop -- sequential event-loop turns are intentional.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

afterEach(async () => {
	cleanupOrphanedGatewayIfPresentMock.mockClear();
	cleanupOrphanedToolVmsIfPresentMock.mockClear();
	preflightOrphanedGatewayCleanupIfPresentMock.mockClear();
	vi.unstubAllEnvs();
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
	);
});

async function createGatewayConfigPath(): Promise<string> {
	const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-gateway-zone-'));
	createdDirectories.push(workingDirectoryPath);
	const configDirectory = path.join(workingDirectoryPath, 'config', 'shravan');
	await mkdir(configDirectory, { recursive: true });
	const configPath = path.join(configDirectory, 'openclaw.json');
	await writeFile(
		configPath,
		JSON.stringify({
			agents: {
				defaults: {
					sandbox: openClawToolVmSandbox,
					workspace: '/zone/agents/default',
				},
			},
			gateway: {
				auth: { mode: 'token' },
				bind: 'loopback',
				controlUi: {
					allowedOrigins: ['http://127.0.0.1:18791', 'http://localhost:18791'],
				},
			},
			tools: {
				sandbox: {
					tools: {
						alsoAllow: ['group:plugins'],
					},
				},
			},
		}),
		'utf8',
	);
	return configPath;
}

async function writeMinimalMcpPortalConfigs(
	configDir: string,
	mcpConfig: unknown = {
		providers: {},
		schemaVersion: 1,
	},
	options: {
		readonly portalAgentId?: string;
	} = {},
): Promise<void> {
	const portalAgentId = options.portalAgentId ?? 'main';
	await writeFile(path.join(configDir, 'mcp.config.jsonc'), JSON.stringify(mcpConfig), 'utf8');
	await writeFile(
		path.join(configDir, 'mcp-portal.config.jsonc'),
		JSON.stringify({
			agents: { [portalAgentId]: { profile: 'default' } },
			profiles: { default: { namespaces: {} } },
			schemaVersion: 1,
		}),
		'utf8',
	);
}

async function createSystemConfigPath(): Promise<string> {
	const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-gateway-cache-id-'));
	createdDirectories.push(workingDirectoryPath);
	const configDirectory = path.join(workingDirectoryPath, 'config');
	await mkdir(configDirectory, { recursive: true });
	return path.join(configDirectory, 'system.json');
}

function createHttpHealthGatewayLifecycle(): {
	readonly buildProcessSpec: () => {
		readonly bootstrapCommand: string;
		readonly guestListenPort: number;
		readonly healthCheck: { readonly type: 'http'; readonly port: number; readonly path: string };
		readonly logPath: string;
		readonly startCommand: string;
	};
	readonly buildVmRequirements: () => {
		readonly allowedHosts: readonly string[];
		readonly environment: Record<string, never>;
		readonly mediatedSecrets: Record<string, never>;
		readonly rootfsMode: 'cow';
		readonly sessionLabel: string;
		readonly tcpHosts: Record<string, never>;
		readonly mounts: Record<string, never>;
	};
} {
	return {
		buildProcessSpec: () => ({
			bootstrapCommand: 'bootstrap-http-gateway',
			guestListenPort: 18789,
			healthCheck: { type: 'http', port: 18789, path: '/' },
			logPath: '/tmp/http-gateway.log',
			startCommand: 'start-http-gateway',
		}),
		buildVmRequirements: () => ({
			allowedHosts: [],
			environment: {},
			mediatedSecrets: {},
			rootfsMode: 'cow',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			tcpHosts: {},
			mounts: {},
		}),
	};
}

async function createSystemConfig(): Promise<LoadedSystemConfig> {
	const workingDirectoryPath = await mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-gateway-zone-state-'),
	);
	createdDirectories.push(workingDirectoryPath);
	return createLoadedSystemConfig(
		{
			cacheDir: path.join(workingDirectoryPath, 'cache'),
			runtimeDir: path.join(workingDirectoryPath, 'runtime'),
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
						config: await createGatewayConfigPath(),
						rawEnvSecrets: ['DISCORD_BOT_TOKEN'],
						runtimeRootfsSize: '12G',
						stateDir: path.join(workingDirectoryPath, 'state', 'shravan'),
						zoneFilesDir: path.join(workingDirectoryPath, 'zone-files', 'shravan'),
						zoneGit: {
							remote: {
								repoUrl: 'ShravanSunder/zone-files',
								branch: 'agent/main',
							},
						},
					},
					secrets: {
						PERPLEXITY_API_KEY: {
							source: '1password',
							ref: 'op://agent-vm/shravan-perplexity/credential',
							injection: 'http-mediation',
							audience: 'gateway',
							hosts: ['api.perplexity.ai'],
						},
						DISCORD_BOT_TOKEN: {
							source: '1password',
							ref: 'op://agent-vm/shravan-discord/bot-token',
							injection: 'env',
							audience: 'gateway',
						},
						OPENCLAW_GATEWAY_TOKEN: {
							source: '1password',
							ref: 'op://agent-vm/shravan-gateway-auth/password',
							injection: 'env',
							audience: 'gateway',
						},
					},
					egressHosts: ['api.anthropic.com', 'api.openai.com', 'api.perplexity.ai'].map((host) => ({
						host,
						audience: 'gateway' as const,
					})),
					agents: [{ id: 'main' }],
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
		},
		{ systemConfigPath: await createSystemConfigPath() },
	);
}

function createObservabilitySystemConfig(
	systemConfig: LoadedSystemConfig,
	options: {
		readonly controllerStartPolicy?: 'degraded' | 'require-ready' | 'off';
		readonly zoneEnabled?: boolean;
	} = {},
): LoadedSystemConfig {
	const { systemConfigPath, ...baseConfig } = systemConfig;
	const zoneEnabled = options.zoneEnabled ?? false;
	return createLoadedSystemConfig(
		{
			...baseConfig,
			host: {
				...baseConfig.host,
				observability: {
					enabled: true,
					stack: {
						mode: 'managed',
						scrubbing: { responsibility: 'agent-vm-managed-collector' },
					},
					runner: 'docker-compose',
					mode: 'collector',
					dataDir: path.join(path.dirname(systemConfig.cacheDir), 'observability-data'),
					...(options.controllerStartPolicy === undefined
						? {}
						: { controllerStartPolicy: options.controllerStartPolicy }),
					retention: {
						metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
						logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
						traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
					},
				},
			},
			zones: baseConfig.zones.map((zone) => ({
				...zone,
				...(zoneEnabled
					? {
							observability: {
								enabled: true,
								openclaw: {
									serviceName: `agent-vm-openclaw-${zone.id}`,
									traces: true,
									metrics: true,
									logs: true,
								},
							},
						}
					: {}),
			})),
		},
		{ systemConfigPath },
	);
}

const minimalBuildConfig: BuildConfig = {
	arch: 'aarch64',
	distro: 'alpine',
};

function completeGatewayVmClose(_vmId: string): void {}

function createTestSshAccess(port = 2222): Awaited<ReturnType<ManagedVm['enableSsh']>> {
	return {
		close: vi.fn(async () => {}),
		command: `ssh -i /tmp/key sandbox@127.0.0.1 -p ${String(port)}`,
		host: '127.0.0.1',
		identityFile: '/tmp/key',
		port,
		serverHostKey: TEST_SSH_SERVER_HOST_KEY,
		user: 'sandbox',
	};
}

function createTestIngressAccess(port = 18791): Awaited<ReturnType<ManagedVm['enableIngress']>> {
	return {
		close: vi.fn(async () => {}),
		host: '127.0.0.1',
		port,
	};
}

function createTestManagedVmSshAccess(
	port = 2222,
): Awaited<ReturnType<ManagedVmInstance['enableSsh']>> {
	return {
		close: vi.fn(async () => {}),
		command: `ssh -i /tmp/key sandbox@127.0.0.1 -p ${String(port)}`,
		host: '127.0.0.1',
		identityFile: '/tmp/key',
		port,
		user: 'sandbox',
	};
}

function createVmInstanceStub(pid: number = 28282): ManagedVmInstance {
	const vmId = `vm-instance-${pid}`;
	return {
		close: async () => {},
		enableIngress: async () => createTestIngressAccess(),
		enableSsh: async () => createTestManagedVmSshAccess(19000),
		exec: () => createManagedExecProcessStub(),
		fs: createManagedVmFsStub(),
		getHostPid: () => pid,
		id: vmId,
		setIngressRoutes: () => {},
		start: async () => {},
	};
}

function createHealthyGatewayVmStub(
	vmId: string,
	pid: number,
): {
	readonly close: Mock<ManagedVm['close']>;
	readonly enableIngress: Mock<ManagedVm['enableIngress']>;
	readonly exec: Mock<ManagedVm['exec']>;
	readonly managedVm: ManagedVm;
} {
	const close = vi.fn(async () => {});
	const enableIngress = vi.fn(async () => createTestIngressAccess());
	const exec = vi.fn(() => createManagedExecProcessStub({ stdout: '200' }));
	const vmInstance = createVmInstanceStub(pid);
	return {
		close,
		enableIngress,
		exec,
		managedVm: {
			id: vmId,
			start: vi.fn(async () => {}),
			close,
			enableIngress,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec,
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => pid),
			getVmInstance: vi.fn(() => vmInstance),
			setIngressRoutes: vi.fn(),
		},
	};
}

function createOpenClawSecretResolver(resolvedSecrets: Record<string, string>): SecretResolver {
	const resolveKnownSecretRef = (secretRef: SecretRef): string => {
		if (secretRef.source === 'config') {
			return secretRef.value;
		}

		if (secretRef.ref === 'op://agent-vm/shravan-discord/bot-token') {
			return resolvedSecrets.DISCORD_BOT_TOKEN ?? 'resolved-discord-token';
		}

		if (secretRef.ref === 'op://agent-vm/shravan-perplexity/credential') {
			return resolvedSecrets.PERPLEXITY_API_KEY ?? 'resolved-perplexity-key';
		}

		if (secretRef.ref === 'op://agent-vm/shravan-gateway-auth/password') {
			return resolvedSecrets.OPENCLAW_GATEWAY_TOKEN ?? 'resolved-gateway-token';
		}

		const resolvedSecret = resolvedSecrets[secretRef.ref];
		if (resolvedSecret !== undefined) {
			return resolvedSecret;
		}

		throw new Error(`Unexpected secret ref: ${secretRef.ref}`);
	};
	return {
		resolve: async (secretRef): Promise<string> => resolveKnownSecretRef(secretRef),
		resolveAll: async (secretRefs): Promise<Record<string, string>> =>
			Object.fromEntries(
				Object.entries(secretRefs).map(([secretName, secretRef]) => [
					secretName,
					resolveKnownSecretRef(secretRef),
				]),
			),
	};
}

describe('startGatewayZone', () => {
	it('scopes OpenClaw process supervisor state to the exact Gateway epoch', () => {
		const runtimeDirectory = '/runtime';
		const firstGateway = createTestGatewayEpochIdentity('gateway-vm-first');
		const secondGateway = createTestGatewayEpochIdentity('gateway-vm-second');

		const firstMount = resolveOpenClawProcessSupervisorStateMount({
			gatewaySeed: firstGateway,
			runtimeDirectory,
		});
		const repeatedFirstMount = resolveOpenClawProcessSupervisorStateMount({
			gatewaySeed: firstGateway,
			runtimeDirectory,
		});
		const secondMount = resolveOpenClawProcessSupervisorStateMount({
			gatewaySeed: secondGateway,
			runtimeDirectory,
		});

		expect(repeatedFirstMount).toEqual(firstMount);
		expect(secondMount.hostPath).not.toBe(firstMount.hostPath);
		expect(firstMount).toMatchObject({
			guestPath: '/run/agent-vm/openclaw-process-supervisor',
			hostPath: expect.stringMatching(
				/^\/runtime\/zones\/shravan\/openclaw-process-supervisor\/[a-f0-9]{64}$/u,
			),
		});
	});

	it('builds the image, resolves secrets, creates the vm, and enables ingress', async () => {
		const taskTitles: string[] = [];
		const closeMock = vi.fn(async () => {});
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const enableSshMock = vi.fn(async () => createTestSshAccess());
		const execMock = vi.fn((command: string) =>
			createManagedExecProcessStub({
				stdout: command.includes('curl -sS -o /dev/null -w "%{http_code}"') ? '200' : '',
			}),
		);
		const startMock = vi.fn(async () => {});
		const setIngressRoutesMock = vi.fn();
		const writeGatewayRuntimeRecord = vi.fn<
			NonNullable<GatewayManagerDependencies['writeGatewayRuntimeRecord']>
		>(async () => {});
		const managedVm: ManagedVm = {
			id: 'vm-123',
			start: startMock,
			close: closeMock,
			enableIngress: enableIngressMock,
			enableSsh: enableSshMock,
			exec: execMock,
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28282),
			getVmInstance: vi.fn(() => createVmInstanceStub(28282)),
			setIngressRoutes: setIngressRoutesMock,
		};
		const secretResolver = createOpenClawSecretResolver({
			PERPLEXITY_API_KEY: 'resolved-key',
			DISCORD_BOT_TOKEN: 'resolved-key',
			OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
		});
		const buildImage = vi.fn(
			async (_options: unknown): Promise<BuildImageResult> => ({
				built: true,
				fingerprint: 'fingerprint-123',
				imagePath: '/tmp/gateway-image',
			}),
		);
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);
		const processStart = vi.fn<OpenClawProcessSupervisor['start']>();
		const createOpenClawProcessSupervisorPorts = vi.fn(
			({ gateway }: { readonly gateway: OpenClawProcessSupervisorGateway }) => {
				const supervisor = createTestOpenClawProcessSupervisor(gateway);
				processStart.mockImplementation(async (request) => await supervisor.start(request));
				return {
					reliabilityFaultActuator: {
						terminateOwnedProcess: vi.fn(async () => {
							throw new Error('Gateway startup test did not expect reliability actuation.');
						}),
					},
					supervisor: { ...supervisor, start: processStart },
				};
			},
		);
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			rootfs: {
				label: 'gateway-root',
			},
		};
		const loadBuildConfig = vi.fn(async (): Promise<BuildConfig> => buildConfig);
		vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent-vm-test-agent.sock');

		const systemConfig = await createSystemConfig();
		const ownership = createTestVmOwnershipHarness(
			'vm-123',
			createTestGatewayEpochIdentity('vm-123'),
		);
		const result = await startGatewayZone(
			{
				createVmOwnership: ownership.createVmOwnership,
				runTask: async (title, fn) => {
					taskTitles.push(title);
					await fn();
				},
				secretResolver,
				systemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage,
				createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
				createManagedVm,
				createOpenClawProcessSupervisorPorts,
				loadBuildConfig,
				writeGatewayRuntimeRecord,
			},
		);

		expect(loadBuildConfig).toHaveBeenCalledWith('./vm-images/gateways/openclaw/build-config.json');
		const logDirectoryPath = path.join(systemConfig.runtimeDir, 'zones', 'shravan', 'logs');
		expect((await stat(logDirectoryPath)).mode & 0o777).toBe(0o700);
		expect(buildImage).toHaveBeenCalled();
		expect(ownership.createVmOwnership.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			createManagedVm.mock.invocationCallOrder[0] ?? 0,
		);
		expect(ownership.attachGatewayVm).toHaveBeenCalledWith('vm-123');
		expect(ownership.attachGatewayVm.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			startMock.mock.invocationCallOrder[0] ?? 0,
		);
		expect(startMock).toHaveBeenCalledOnce();
		expect(startMock.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			execMock.mock.invocationCallOrder[0] ?? 0,
		);
		expect(writeGatewayRuntimeRecord).toHaveBeenCalledTimes(2);
		expect(writeGatewayRuntimeRecord.mock.calls[0]?.[1]).toMatchObject({
			gateway: expect.objectContaining({ gatewayVmId: 'vm-123' }),
			schemaVersion: 2,
			vmId: 'vm-123',
		});
		expect(writeGatewayRuntimeRecord.mock.calls[0]?.[1]).not.toHaveProperty('ingressPort');
		expect(writeGatewayRuntimeRecord.mock.calls[1]?.[1]).toMatchObject({
			ingressPort: 18791,
			schemaVersion: 2,
			vmId: 'vm-123',
		});
		expect(writeGatewayRuntimeRecord.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			execMock.mock.invocationCallOrder[0] ?? 0,
		);
		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.arrayContaining([
					'api.anthropic.com',
					'api.openai.com',
					'api.perplexity.ai',
				]),
				cpus: 2,
				env: expect.objectContaining({
					HOME: '/home/openclaw',
					NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
					OPENCLAW_HOME: '/home/openclaw',
					OPENCLAW_CONFIG_PATH: '/home/openclaw/.openclaw/state/effective-openclaw.json',
					OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
					DISCORD_BOT_TOKEN: 'resolved-key',
				}),
				imagePath: '/tmp/gateway-image',
				memory: '2G',
				rootfsMode: 'cow',
				runtimeRootfsSize: '12G',
				sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
				secrets: {
					PERPLEXITY_API_KEY: {
						hosts: ['api.perplexity.ai'],
						value: 'resolved-key',
					},
				},
				sshEgress: expect.objectContaining({
					agent: '/tmp/agent-vm-test-agent.sock',
					allowedHosts: ['github.com'],
					execPolicy: expect.any(Function),
				}),
				tcpHosts: expect.not.objectContaining({
					'controller.vm.host:18800': expect.any(String),
				}),
				vfsMounts: expect.objectContaining({
					'/agent-vm/logs': {
						hostPath: path.join(systemConfig.runtimeDir, 'zones', 'shravan', 'logs'),
						kind: 'realfs',
					},
					'/home/openclaw/.openclaw/cache': {
						hostPath: path.join(systemConfig.cacheDir, 'gateways', 'shravan'),
						kind: 'realfs',
					},
				}),
			}),
		);
		const createdVmOptions = createManagedVm.mock.calls[0]?.[0] as
			| {
					readonly allowedHosts: readonly string[];
					readonly sshEgress?: {
						readonly agent?: string;
						readonly execPolicy?: (request: {
							readonly command: string;
							readonly guestUsername: string;
							readonly hostname: string;
							readonly port: number;
							readonly src: { readonly ip: string; readonly port: number };
						}) => unknown;
					};
					readonly tcpHosts: Record<string, string>;
					readonly vfsMounts: Record<string, { readonly hostPath: string; readonly kind: string }>;
			  }
			| undefined;
		if (createdVmOptions === undefined) {
			throw new Error('Expected gateway VM creation call');
		}
		expect(createdVmOptions.allowedHosts).not.toContain('controller.vm.host');
		expect(createdVmOptions.sshEgress?.agent).toBe('/tmp/agent-vm-test-agent.sock');
		const expectedSupervisorMount = resolveOpenClawProcessSupervisorStateMount({
			gatewaySeed: ownership.vmOwnership.gatewaySeed,
			runtimeDirectory: systemConfig.runtimeDir,
		});
		expect(createdVmOptions.vfsMounts[expectedSupervisorMount.guestPath]).toEqual({
			hostPath: expectedSupervisorMount.hostPath,
			kind: 'realfs',
		});
		expect((await stat(expectedSupervisorMount.hostPath)).mode & 0o777).toBe(0o700);
		await expect(
			Promise.resolve(
				createdVmOptions.sshEgress?.execPolicy?.({
					command: "git-receive-pack 'shravan/zone-files.git'",
					guestUsername: 'git',
					hostname: 'github.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_001 },
				}),
			),
		).resolves.toMatchObject({ allow: false });
		expect(createdVmOptions.tcpHosts).not.toHaveProperty('controller.vm.host:18800');
		expect(execMock).toHaveBeenCalledWith(buildExpectedOpenClawGatewayStartCommandForTest());
		expect(createOpenClawProcessSupervisorPorts).toHaveBeenCalledWith(
			expect.objectContaining({
				gateway: {
					controllerEpoch: 'controller-epoch-test',
					gatewayEpochId: ownership.vmOwnership.gatewaySeed.gatewayEpochId,
					gatewayVmId: 'vm-123',
				},
				vm: managedVm,
			}),
		);
		expect(processStart).toHaveBeenCalledWith({
			actionId: expect.stringMatching(/^process-start-/u),
			expectedProcessEpoch: null,
			selectedProcessEpoch: result.processEpoch,
		});
		expect(setIngressRoutesMock).toHaveBeenCalledWith([
			{
				port: 18789,
				prefix: '/',
				stripPrefix: true,
			},
		]);
		expect(enableIngressMock).toHaveBeenCalledWith({
			bufferResponseBody: false,
			listenPort: 18791,
		});
		// OpenClaw ownership reconciliation is controller-start work, not
		// gateway-zone startup work. The mcpPortalMaterialization branch does
		// not push a title.
		expect(taskTitles).toEqual([
			'Preflighting gateway start',
			'Validating OpenClaw Tool VM requirements',
			'Resolving zone secrets',
			'Building gateway image',
			'Preparing host state',
			'Reserving gateway VM ownership',
			'Booting gateway VM',
			'Configuring gateway',
			'Starting gateway',
			'Starting OpenClaw process',
			'Observing OpenClaw process',
			'Waiting for service health',
			'Connecting gateway control session',
			'Recording gateway runtime',
		]);
		expect(cleanupOrphanedToolVmsIfPresentMock).not.toHaveBeenCalled();
		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			image: {
				fingerprint: 'fingerprint-123',
				imagePath: '/tmp/gateway-image',
			},
			ingress: {
				host: '127.0.0.1',
				port: 18791,
			},
			processSpec: {
				guestListenPort: 18789,
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
			},
		});
	});

	it('starts ingress draining after control closure without blocking Gateway runner termination', async () => {
		const teardownEvents: string[] = [];
		let runnerAlive = true;
		const ingressCloseRelease = createDeferredPromise<void>();
		const controlSessionClose = vi.fn(() => {
			teardownEvents.push('control-session-close');
		});
		const ingressClose = vi.fn(async () => {
			teardownEvents.push('ingress-close-start');
			await ingressCloseRelease.promise;
			teardownEvents.push('ingress-close-complete');
		});
		const vmClose = vi.fn(async () => {
			teardownEvents.push('vm-close');
		});
		const { managedVm } = createHealthyGatewayVmStub('vm-ingress-close-order', 28_294);
		managedVm.close = vmClose;
		managedVm.enableIngress = vi.fn(async () => ({
			close: ingressClose,
			host: '127.0.0.1',
			port: 18791,
		}));
		managedVm.getHostPid = vi.fn(() => (runnerAlive ? 28_294 : null));
		const connectGatewayControlSession = vi.fn<GatewayControlSessionConnector>(
			async (connectOptions) => ({
				...(await connectTestGatewayControlSession(connectOptions)),
				close: controlSessionClose,
			}),
		);

		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				connectGatewayControlSession,
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				managedVmKillDependencies: {
					isProcessAlive: () => runnerAlive,
					killProcess: () => {
						teardownEvents.push('runner-termination');
						runnerAlive = false;
					},
					readProcessCommand: async () => 'qemu-system-x86_64 -m 4G',
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 4G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					sleep: async () => {},
				},
			},
		);

		result.controlSession?.close();
		const gatewayTermination = result.terminateVm();
		await flushPendingEventLoopWork();
		expect(teardownEvents).toContain('runner-termination');
		ingressCloseRelease.resolve();
		await gatewayTermination;
		await result.terminateVm();

		expect(teardownEvents[0]).toBe('control-session-close');
		expect(teardownEvents.indexOf('ingress-close-start')).toBeLessThan(
			teardownEvents.indexOf('runner-termination'),
		);
		expect(teardownEvents.indexOf('runner-termination')).toBeLessThan(
			teardownEvents.indexOf('ingress-close-complete'),
		);
		expect(teardownEvents).toContain('vm-close');
		expect(ingressClose).toHaveBeenCalledOnce();
		expect(vmClose).toHaveBeenCalledOnce();
	});

	it('passes configured gateway ingress timeouts to Gondolin', async () => {
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const managedVm: ManagedVm = {
			id: 'vm-123',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-123')),
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn((command: string) =>
				createManagedExecProcessStub({
					stdout: command.includes('curl -sS -o /dev/null -w "%{http_code}"') ? '200' : '',
				}),
			),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28282),
			getVmInstance: vi.fn(() => createVmInstanceStub(28282)),
			setIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('expected OpenClaw test zone');
		}
		const systemConfigWithIngressTimeouts: LoadedSystemConfig = {
			...systemConfig,
			zones: [
				{
					...zone,
					gateway: {
						...zone.gateway,
						ingress: {
							upstreamHeaderTimeoutMs: 5_000,
							upstreamResponseTimeoutMs: 120_000,
						},
					},
				},
			],
		};

		await startGatewayZone(
			{
				runTask: async (_title, fn) => {
					await fn();
				},
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: systemConfigWithIngressTimeouts,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fingerprint-123',
					imagePath: '/tmp/gateway-image',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(enableIngressMock).toHaveBeenCalledWith({
			bufferResponseBody: false,
			listenPort: 18791,
			upstreamHeaderTimeoutMs: 5_000,
			upstreamResponseTimeoutMs: 120_000,
		});
	});

	it('omits unset gateway ingress response timeout when only header timeout is configured', async () => {
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const managedVm: ManagedVm = {
			id: 'vm-123',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-123')),
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn((command: string) =>
				createManagedExecProcessStub({
					stdout: command.includes('curl -sS -o /dev/null -w "%{http_code}"') ? '200' : '',
				}),
			),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28282),
			getVmInstance: vi.fn(() => createVmInstanceStub(28282)),
			setIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('expected OpenClaw test zone');
		}
		const systemConfigWithHeaderTimeout: LoadedSystemConfig = {
			...systemConfig,
			zones: [
				{
					...zone,
					gateway: {
						...zone.gateway,
						ingress: {
							upstreamHeaderTimeoutMs: 5_000,
						},
					},
				},
			],
		};

		await startGatewayZone(
			{
				runTask: async (_title, fn) => {
					await fn();
				},
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: systemConfigWithHeaderTimeout,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fingerprint-123',
					imagePath: '/tmp/gateway-image',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(enableIngressMock).toHaveBeenCalledWith({
			bufferResponseBody: false,
			listenPort: 18791,
			upstreamHeaderTimeoutMs: 5_000,
		});
	});

	it('omits unset gateway ingress header timeout when only response timeout is configured', async () => {
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const managedVm: ManagedVm = {
			id: 'vm-123',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-123')),
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn((command: string) =>
				createManagedExecProcessStub({
					stdout: command.includes('curl -sS -o /dev/null -w "%{http_code}"') ? '200' : '',
				}),
			),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28282),
			getVmInstance: vi.fn(() => createVmInstanceStub(28282)),
			setIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('expected OpenClaw test zone');
		}
		const systemConfigWithResponseTimeout: LoadedSystemConfig = {
			...systemConfig,
			zones: [
				{
					...zone,
					gateway: {
						...zone.gateway,
						ingress: {
							upstreamResponseTimeoutMs: 120_000,
						},
					},
				},
			],
		};

		await startGatewayZone(
			{
				runTask: async (_title, fn) => {
					await fn();
				},
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: systemConfigWithResponseTimeout,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fingerprint-123',
					imagePath: '/tmp/gateway-image',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(enableIngressMock).toHaveBeenCalledWith({
			bufferResponseBody: false,
			listenPort: 18791,
			upstreamResponseTimeoutMs: 120_000,
		});
	});

	it('does not clean orphaned gateway runtime before rejecting invalid OpenClaw Tool VM requirements', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		await writeFile(
			zone.gateway.config,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: {
							backend: 'host',
							mode: 'all',
							scope: 'agent',
							workspaceAccess: 'rw',
						},
						workspace: '/zone/agents/default',
					},
					list: [],
				},
			}),
			'utf8',
		);
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imagePath: '/tmp/img',
		}));

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({}),
					systemConfig,
					zoneId: 'shravan',
				},
				{
					buildImage,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow("OpenClaw zone 'shravan' Tool VM requirements failed");

		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(buildImage).not.toHaveBeenCalled();
	});

	it('does not build the gateway image when secret preflight fails', async () => {
		const systemConfig = await createSystemConfig();
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imagePath: '/tmp/img',
		}));
		const secretResolver: SecretResolver = {
			resolve: async () => {
				throw new Error('Failed to resolve zone secrets: op failed');
			},
			resolveAll: async () => {
				throw new Error('Failed to resolve zone secrets: op failed');
			},
		};

		await expect(
			startGatewayZone(
				{
					secretResolver,
					systemConfig,
					zoneId: 'shravan',
				},
				{
					buildImage,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow('Failed to resolve zone secrets: op failed');

		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(buildImage).not.toHaveBeenCalled();
	});

	it('rejects invalid OpenClaw Tool VM requirements during protected restart preflight', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		await writeFile(
			zone.gateway.config,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: {
							backend: 'host',
							mode: 'all',
							scope: 'agent',
							workspaceAccess: 'rw',
						},
						workspace: '/zone/agents/default',
					},
					list: [],
				},
			}),
			'utf8',
		);

		await expect(
			preflightGatewayZoneStart({
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'resolved-discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					PERPLEXITY_API_KEY: 'resolved-perplexity-key',
				}),
				systemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow("OpenClaw zone 'shravan' Tool VM requirements failed");
	});

	it('does not consult legacy cleanup or create a gateway VM when OpenClaw image build fails', async () => {
		const systemConfig = await createSystemConfig();
		const buildError = new Error('gateway image build failed');
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => {
			throw new Error('createManagedVm should not run after image build fails');
		});
		const buildImage = vi.fn(async (): Promise<BuildImageResult> => {
			throw buildError;
		});

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'resolved-discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
						PERPLEXITY_API_KEY: 'resolved-perplexity-key',
					}),
					systemConfig,
					zoneId: 'shravan',
				},
				{
					buildImage,
					createManagedVm,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toBe(buildError);

		expect(buildImage).toHaveBeenCalledOnce();
		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('surfaces OpenClaw secret failure before image build', async () => {
		const systemConfig = await createSystemConfig();
		const secretResolver: SecretResolver = {
			resolve: async () => {
				throw new Error('Failed to resolve zone secrets: op failed');
			},
			resolveAll: async () => {
				throw new Error('Failed to resolve zone secrets: op failed');
			},
		};
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imagePath: '/tmp/img',
		}));

		await expect(
			startGatewayZone(
				{
					secretResolver,
					systemConfig,
					zoneId: 'shravan',
				},
				{
					buildImage,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow(
			"Failed to resolve zone secrets for zone 'shravan': Failed to resolve zone secrets: op failed",
		);

		expect(preflightOrphanedGatewayCleanupIfPresentMock).not.toHaveBeenCalled();
		expect(buildImage).not.toHaveBeenCalled();
	});

	it('skips host observability readiness before gateway startup when no OpenClaw zone opted in', async () => {
		const systemConfig = createObservabilitySystemConfig(await createSystemConfig(), {
			controllerStartPolicy: 'require-ready',
		});
		const taskTitles: string[] = [];
		const checkObservabilityStackReadiness = vi.fn(async () => ({
			ok: false as const,
			reason: 'collector health check failed: connection refused',
			status: 'unavailable' as const,
		}));
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imagePath: '/tmp/img',
		}));
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => {
			throw new Error('createManagedVm should not be called');
		});

		await expect(
			startGatewayZone(
				{
					runTask: async (title, fn) => {
						taskTitles.push(title);
						await fn();
					},
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'resolved-discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
						PERPLEXITY_API_KEY: 'resolved-perplexity-key',
					}),
					systemConfig,
					zoneId: 'shravan',
				},
				{
					buildImage,
					checkObservabilityStackReadiness,
					createManagedVm,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow('createManagedVm should not be called');

		expect(taskTitles).not.toContain('Preflighting gateway runtime ownership');
		expect(taskTitles).not.toContain('Cleaning orphaned gateway runtime');
		expect(taskTitles).not.toContain('Checking host observability stack');
		expect(checkObservabilityStackReadiness).not.toHaveBeenCalled();
		expect(buildImage).toHaveBeenCalled();
		expect(createManagedVm).toHaveBeenCalled();
	});

	it('routes OpenClaw zone observability through mediated HTTP without collector tcpHosts', async () => {
		const systemConfig = createObservabilitySystemConfig(await createSystemConfig(), {
			controllerStartPolicy: 'off',
			zoneEnabled: true,
		});
		const createManagedVm = vi.fn(
			async (_options: GatewayManagedVmFactoryOptions): Promise<ManagedVm> => {
				throw new Error('stop after vm options');
			},
		);

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'resolved-discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
						PERPLEXITY_API_KEY: 'resolved-perplexity-key',
					}),
					systemConfig,
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow('stop after vm options');

		const vmOptions = createManagedVm.mock.calls[0]?.[0];
		if (vmOptions === undefined) {
			throw new Error('Expected gateway VM creation call.');
		}
		expect(vmOptions.allowedHosts).toContain('otel-collector.observability.vm.host');
		expect(vmOptions.tcpHosts).toEqual({
			'tool-0.vm.host:22': '127.0.0.1:19000',
			'tool-1.vm.host:22': '127.0.0.1:19001',
			'tool-2.vm.host:22': '127.0.0.1:19002',
			'tool-3.vm.host:22': '127.0.0.1:19003',
			'tool-4.vm.host:22': '127.0.0.1:19004',
		});
		expect(vmOptions.onRequest).toEqual(expect.any(Function));
		const rewrittenRequest = await vmOptions.onRequest?.(
			new Request('http://otel-collector.observability.vm.host:4318/v1/traces', {
				body: 'trace-payload',
				headers: { 'content-type': 'application/x-protobuf' },
				method: 'POST',
			}),
		);
		expect(rewrittenRequest).toBeInstanceOf(Request);
		expect((rewrittenRequest as Request).url).toBe('http://127.0.0.1:4318/v1/traces');
		expect(await (rewrittenRequest as Request).text()).toBe('trace-payload');
	});

	it('rejects OpenClaw collector tcpHosts overrides that bypass mediated observability', async () => {
		const systemConfig = createObservabilitySystemConfig(await createSystemConfig(), {
			controllerStartPolicy: 'off',
			zoneEnabled: true,
		});
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => {
			throw new Error('createManagedVm should not be called');
		});

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'resolved-discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
						PERPLEXITY_API_KEY: 'resolved-perplexity-key',
					}),
					systemConfig,
					tcpHostsOverride: {
						'otel-collector.observability.vm.host:4318': '127.0.0.1:4318',
					},
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow(
			"OpenClaw tcpHostsOverride cannot map observability collector host 'otel-collector.observability.vm.host'",
		);
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('preflights lifecycle host state without OpenClaw observability before protected restart image work', async () => {
		const systemConfig = createObservabilitySystemConfig(await createSystemConfig(), {
			controllerStartPolicy: 'require-ready',
		});
		const preflightHostState = vi.fn(async () => {});
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imagePath: '/tmp/img',
		}));

		await preflightGatewayZoneStart(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'resolved-discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					PERPLEXITY_API_KEY: 'resolved-perplexity-key',
				}),
				systemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage,
				checkObservabilityStackReadiness: vi.fn(async () => ({
					ok: true as const,
					status: 'ready' as const,
				})),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				loadGatewayLifecycle: () => ({
					...createHttpHealthGatewayLifecycle(),
					preflightHostState,
				}),
			},
		);

		expect(preflightHostState).toHaveBeenCalledWith(
			expect.not.objectContaining({ observability: expect.anything() }),
			expect.any(Object),
		);
		expect(buildImage).toHaveBeenCalled();
	});

	it('does not invoke legacy PID cleanup for OpenClaw zones after ownership reconciliation', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-tool-cleanup',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-tool-cleanup')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28301),
			getVmInstance: vi.fn(() => createVmInstanceStub(28301)),
			setIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
	});

	it('does not preflight or mutate legacy OpenClaw runtime records before exact ownership boot', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-ordered-recovery',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-ordered-recovery')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28303),
			getVmInstance: vi.fn(() => createVmInstanceStub(28303)),
			setIngressRoutes: vi.fn(),
		};
		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(preflightOrphanedGatewayCleanupIfPresentMock).not.toHaveBeenCalled();
		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
	});

	it('starts one Worker gateway VM without legacy cleanup phases', async () => {
		const systemConfig = await createSystemConfig();
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
				secrets: {
					OPENAI_API_KEY: {
						source: '1password' as const,
						ref: 'op://agent-vm/shravan-openai/credential',
						injection: 'http-mediation' as const,
						audience: 'gateway' as const,
						hosts: ['api.openai.com'],
					},
				},
			})),
		};
		const secretResolver: SecretResolver = {
			resolve: async () => 'openai-key',
			resolveAll: async () => ({ OPENAI_API_KEY: 'openai-key' }),
		};
		const taskTitles: string[] = [];
		const managedVm: ManagedVm = {
			close: vi.fn(async () => completeGatewayVmClose('worker-vm-no-legacy-cleanup')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 12346),
			getVmInstance: vi.fn(() => createVmInstanceStub(12346)),
			id: 'worker-vm-no-legacy-cleanup',
			start: vi.fn(async () => {}),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async () => managedVm);

		const result = await startGatewayZone(
			{
				runTask: async (title, run) => {
					taskTitles.push(title);
					await run();
				},
				secretResolver,
				systemConfig: workerSystemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp-worker',
					imagePath: '/tmp/worker-image',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				writeGatewayRuntimeRecord: vi.fn(async () => {}),
			},
		);

		expect(result.vm).toBe(managedVm);
		expect(result.processSpec.startCommand).toContain('agent-vm-worker');
		expect(createManagedVm).toHaveBeenCalledOnce();
		expect(taskTitles).not.toContain('Preflighting gateway runtime ownership');
		expect(taskTitles).not.toContain('Cleaning orphaned gateway runtime');
		expect(cleanupOrphanedToolVmsIfPresentMock).not.toHaveBeenCalled();
		expect(preflightOrphanedGatewayCleanupIfPresentMock).not.toHaveBeenCalled();
		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
	});

	it('resolves only gateway audience secrets while starting the gateway VM', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-gateway-only',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-gateway-only')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28286),
			getVmInstance: vi.fn(() => createVmInstanceStub(28286)),
			setIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected gateway test system config to include a zone.');
		}
		zone.secrets.LINEAR_API_KEY = {
			source: '1password',
			ref: 'op://agent-vm/shravan-linear/credential',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.linear.app'],
			agentAccess: 'all',
		};
		zone.egressHosts = [...zone.egressHosts, { host: 'api.linear.app', audience: 'tool-vm' }];
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'pplx-key',
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.not.arrayContaining(['api.linear.app']),
				env: expect.not.objectContaining({
					LINEAR_API_KEY: expect.any(String),
				}),
				secrets: expect.not.objectContaining({
					LINEAR_API_KEY: expect.anything(),
				}),
			}),
		);
	});

	it('materializes MCP Portal runtime plugin config from zone MCP config', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, undefined, { portalAgentId: 'shravan' });
		const lifecycleZones: GatewayZoneConfig[] = [];
		const managedVm: ManagedVm = {
			id: 'vm-mcp',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28290),
			getVmInstance: vi.fn(() => createVmInstanceStub(28290)),
			setIngressRoutes: vi.fn(),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					agents: [{ id: 'shravan' }],
					toolPortal: { configDir },
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				loadGatewayLifecycle: () => ({
					buildProcessSpec: () => ({
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/' } as const,
						logPath: '/tmp/gateway.log',
						startCommand: 'start',
					}),
					buildVmRequirements: (options) => {
						lifecycleZones.push(options.zone);
						return {
							allowedHosts: [],
							environment: {},
							mediatedSecrets: {},
							rootfsMode: 'cow' as const,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							tcpHosts: {},
							mounts: {},
						};
					},
				}),
			},
		);

		expect(lifecycleZones[0]?.runtimePluginConfigs).toMatchObject({
			gondolin: {
				controlSession: {
					controllerEpoch: 'controller-epoch-test',
					peerId: 'gateway-shravan',
				},
				toolPortal: { configDir: '/home/openclaw/.openclaw/cache/tool-portal-effective' },
			},
		});
		expect(lifecycleZones[0]?.runtimeMcpServers).toBeUndefined();
	});

	it('does not write MCP Portal effective config files during protected restart preflight', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, undefined, { portalAgentId: 'shravan' });
		const effectiveConfigDir = path.join(
			systemConfig.cacheDir,
			'gateways',
			baseZone.id,
			'tool-portal-effective',
		);

		await preflightGatewayZoneStart({
			prebuiltImage: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/gateway-image' },
			secretResolver: createOpenClawSecretResolver({
				DISCORD_BOT_TOKEN: 'resolved-discord-token',
				OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				PERPLEXITY_API_KEY: 'resolved-perplexity-key',
			}),
			systemConfig,
			zoneId: 'shravan',
			zoneOverride: {
				...baseZone,
				agents: [{ id: 'shravan' }],
				toolPortal: { configDir },
			},
		});

		await expect(readdir(effectiveConfigDir)).resolves.toEqual([]);
	});

	it('deduplicates overlapping MCP Portal and zone secret refs during protected restart preflight', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const overlappingRef = 'op://agent-vm/shravan-perplexity/credential';
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(
			configDir,
			{
				providers: {
					perplexity: {
						kind: 'mcp',
						namespace: 'perplexity',
						secretPolicies: {
							PERPLEXITY_API_KEY: {
								hosts: ['api.perplexity.ai'],
								injection: 'http-mediation',
							},
						},
						transport: {
							args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
							command: 'npx',
							env: {
								PERPLEXITY_API_KEY: {
									ref: overlappingRef,
									source: '1password',
								},
							},
							kind: 'stdio',
							networkAccess: 'declared',
							requiredEgressHosts: ['api.perplexity.ai'],
						},
					},
				},
				schemaVersion: 1,
			},
			{ portalAgentId: 'shravan' },
		);
		const firstResolveAllStarted = createDeferredPromise<void>();
		const releaseFirstResolveAll = createDeferredPromise<void>();
		const resolveSecretRef = (secretRef: SecretRef): string => {
			if (secretRef.source === 'config') {
				return secretRef.value;
			}
			switch (secretRef.ref) {
				case 'op://agent-vm/shravan-discord/bot-token':
					return 'resolved-discord-token';
				case 'op://agent-vm/shravan-gateway-auth/password':
					return 'resolved-gateway-token';
				case overlappingRef:
					return 'resolved-shared-perplexity-key';
				default:
					throw new Error(`Unexpected secret ref: ${secretRef.ref}`);
			}
		};
		const resolveAllMock = vi.fn(async (secretRefs: Record<string, SecretRef>) => {
			if (resolveAllMock.mock.calls.length === 1) {
				firstResolveAllStarted.resolve(undefined);
				await releaseFirstResolveAll.promise;
			}
			return Object.fromEntries(
				Object.entries(secretRefs).map(([secretName, secretRef]) => [
					secretName,
					resolveSecretRef(secretRef),
				]),
			);
		});
		const secretResolver: SecretResolver = {
			resolve: async (secretRef) => resolveSecretRef(secretRef),
			resolveAll: resolveAllMock,
		};

		const preflightPromise = preflightGatewayZoneStart({
			prebuiltImage: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/gateway-image' },
			secretResolver,
			systemConfig,
			zoneId: 'shravan',
			zoneOverride: {
				...baseZone,
				agents: [{ id: 'shravan' }],
				toolPortal: { configDir },
			},
		});
		await firstResolveAllStarted.promise;
		await flushPendingEventLoopWork();
		releaseFirstResolveAll.resolve(undefined);
		await preflightPromise;

		const overlappingResolveCount = resolveAllMock.mock.calls
			.flatMap(([secretRefs]) => Object.values(secretRefs))
			.filter(
				(secretRef) => secretRef.source === '1password' && secretRef.ref === overlappingRef,
			).length;
		expect(overlappingResolveCount).toBe(1);
	});

	it('does not generate OpenClaw mcp.servers entries for managed MCP Portal', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, undefined, { portalAgentId: 'shravan' });
		const lifecycleZones: GatewayZoneConfig[] = [];
		const managedVm: ManagedVm = {
			id: 'vm-mcp-native',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp-native')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28290),
			getVmInstance: vi.fn(() => createVmInstanceStub(28290)),
			setIngressRoutes: vi.fn(),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					agents: [{ id: 'shravan' }],
					toolPortal: { configDir },
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				loadGatewayLifecycle: () => ({
					buildProcessSpec: () => ({
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/' } as const,
						logPath: '/tmp/gateway.log',
						startCommand: 'start',
					}),
					buildVmRequirements: (options) => {
						lifecycleZones.push(options.zone);
						return {
							allowedHosts: [],
							environment: {},
							mediatedSecrets: {},
							rootfsMode: 'cow' as const,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							tcpHosts: {},
							mounts: {},
						};
					},
				}),
			},
		);

		expect(lifecycleZones[0]?.runtimeMcpServers).toBeUndefined();
	});

	it('adds MCP Portal upstream hosts to effective gateway egress', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				deepwiki: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://mcp.deepwiki.com/mcp' },
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-generated-egress',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp-generated-egress')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28291),
			getVmInstance: vi.fn(() => createVmInstanceStub(28291)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					toolPortal: { configDir },
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.arrayContaining(['mcp.deepwiki.com']),
			}),
		);
	});

	it('does not duplicate MCP Portal upstream hosts declared for gateway egress', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				deepwiki: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://mcp.deepwiki.com/mcp' },
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-egress',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp-egress')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28291),
			getVmInstance: vi.fn(() => createVmInstanceStub(28291)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					egressHosts: [...baseZone.egressHosts, { audience: 'gateway', host: 'mcp.deepwiki.com' }],
					toolPortal: { configDir },
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.arrayContaining(['mcp.deepwiki.com']),
			}),
		);
		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall as [{ readonly allowedHosts: readonly string[] }];
		expect(vmOptions.allowedHosts.filter((host) => host === 'mcp.deepwiki.com')).toHaveLength(1);
	});

	it('passes websocket upgrade URL policy to the gateway VM request hook', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const managedVm: ManagedVm = {
			id: 'vm-websocket-policy',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-websocket-policy')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28291),
			getVmInstance: vi.fn(() => createVmInstanceStub(28291)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					egressHosts: [
						...baseZone.egressHosts,
						{ audience: 'both', host: 'discord.gg' },
						{ audience: 'both', host: '*.discord.gg' },
					],
					websocketUpgrades: [
						{
							audience: 'gateway',
							scheme: 'wss',
							host: 'gateway.discord.gg',
							port: 443,
							path: '/',
						},
						{
							audience: 'gateway',
							scheme: 'wss',
							host: 'gateway-*.discord.gg',
							port: 443,
							path: '/',
						},
					],
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall as [
			{
				readonly onRequest?: (request: Request) => Promise<Request | Response | void>;
			},
		];
		expect(vmOptions.onRequest).toEqual(expect.any(Function));
		const allowedResult = await vmOptions.onRequest?.(
			new Request('https://gateway-us-east1-c.discord.gg/?v=10&encoding=json', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		expect(allowedResult).toBeUndefined();
		const blockedResult = await vmOptions.onRequest?.(
			new Request('https://unapproved.discord.gg/?v=10&encoding=json', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		expect(blockedResult).toBeInstanceOf(Response);
		expect((blockedResult as Response).status).toBe(403);
	});

	it('blocks gateway websocket requests when only Tool VM websocket policy exists', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const managedVm: ManagedVm = {
			id: 'vm-tool-websocket-policy',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-tool-websocket-policy')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28292),
			getVmInstance: vi.fn(() => createVmInstanceStub(28292)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					egressHosts: [
						...baseZone.egressHosts,
						{ audience: 'tool-vm', host: 'tool-websocket.example.com' },
					],
					websocketUpgrades: [
						{
							audience: 'tool-vm',
							scheme: 'wss',
							host: 'tool-websocket.example.com',
						},
					],
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall as [
			{
				readonly onRequest?: (request: Request) => Promise<Request | Response | void>;
			},
		];
		expect(vmOptions.onRequest).toEqual(expect.any(Function));
		const blockedResult = await vmOptions.onRequest?.(
			new Request('https://tool-websocket.example.com/socket', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		expect(blockedResult).toBeInstanceOf(Response);
		expect((blockedResult as Response).status).toBe(403);
	});

	it('blocks gateway websocket requests when no websocket policy exists', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const managedVm: ManagedVm = {
			id: 'vm-no-websocket-policy',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-no-websocket-policy')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28293),
			getVmInstance: vi.fn(() => createVmInstanceStub(28293)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					egressHosts: [
						...baseZone.egressHosts,
						{ audience: 'gateway', host: 'ordinary-websocket.example.com' },
					],
					websocketUpgrades: [],
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall as [
			{
				readonly onRequest?: (request: Request) => Promise<Request | Response | void>;
			},
		];
		expect(vmOptions.onRequest).toEqual(expect.any(Function));
		const blockedResult = await vmOptions.onRequest?.(
			new Request('https://ordinary-websocket.example.com/socket', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		expect(blockedResult).toBeInstanceOf(Response);
		expect((blockedResult as Response).status).toBe(403);
	});

	it('passes stdio MCP Portal http-mediation secrets to the gateway VM as generated mediated secrets', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				perplexity: {
					kind: 'mcp',
					namespace: 'perplexity',
					secretPolicies: {
						PERPLEXITY_API_KEY: {
							hosts: ['api.perplexity.ai'],
							injection: 'http-mediation',
						},
					},
					transport: {
						args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
						command: 'npx',
						env: {
							PERPLEXITY_API_KEY: {
								ref: 'op://agent-vm/sunfam-perplexity/credential',
								source: '1password',
							},
						},
						kind: 'stdio',
						networkAccess: 'declared',
						requiredEgressHosts: ['api.perplexity.ai'],
					},
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-mediated-stdio',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp-mediated-stdio')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28293),
			getVmInstance: vi.fn(() => createVmInstanceStub(28293)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: {
					resolve: async (secretRef) => {
						if (secretRef.ref === 'op://agent-vm/shravan-discord/bot-token') {
							return 'discord-token';
						}
						if (secretRef.ref === 'op://agent-vm/shravan-gateway-auth/password') {
							return 'resolved-gateway-token';
						}
						if (secretRef.ref === 'op://agent-vm/sunfam-perplexity/credential') {
							return 'resolved-pplx-key';
						}
						if (secretRef.ref === 'op://agent-vm/shravan-perplexity/credential') {
							return 'zone-pplx-key';
						}
						throw new Error(`Unexpected secret ref: ${secretRef.ref}`);
					},
					resolveAll: async (secretRefs) =>
						Object.fromEntries(
							Object.entries(secretRefs).map(([secretName, secretRef]) => {
								if (secretRef.ref === 'op://agent-vm/shravan-discord/bot-token') {
									return [secretName, 'discord-token'];
								}
								if (secretRef.ref === 'op://agent-vm/shravan-gateway-auth/password') {
									return [secretName, 'resolved-gateway-token'];
								}
								if (secretRef.ref === 'op://agent-vm/sunfam-perplexity/credential') {
									return [secretName, 'resolved-pplx-key'];
								}
								if (secretRef.ref === 'op://agent-vm/shravan-perplexity/credential') {
									return [secretName, 'zone-pplx-key'];
								}
								throw new Error(`Unexpected secret ref: ${secretRef.ref}`);
							}),
						),
				},
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					toolPortal: { configDir },
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall as [
			{ readonly env: Record<string, string>; readonly secrets: Record<string, unknown> },
		];
		expect(vmOptions.secrets).toMatchObject({
			AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY: {
				hosts: ['api.perplexity.ai'],
				value: 'resolved-pplx-key',
			},
		});
		expect(vmOptions.env).not.toHaveProperty('AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY');
	});

	it('keeps loopback MCP Portal provider URLs out of gateway egress', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				local_proxy: {
					kind: 'mcp',
					namespace: 'local_proxy',
					transport: { kind: 'streamable-http', url: 'http://127.0.0.1:18791/mcp' },
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-loopback',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp-loopback')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28292),
			getVmInstance: vi.fn(() => createVmInstanceStub(28292)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async () => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					toolPortal: { configDir },
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.not.arrayContaining(['127.0.0.1', 'localhost']),
			}),
		);
	});

	it('merges environmentOverride into vm environment before boot', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-override',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-override')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28286),
			getVmInstance: vi.fn(() => createVmInstanceStub(28286)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				environmentOverride: {
					DATABASE_URL: 'postgres://app:secret@postgres.local:5432/app',
				},
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp-env-override',
					imagePath: '/tmp/gateway-image',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				env: expect.objectContaining({
					DATABASE_URL: 'postgres://app:secret@postgres.local:5432/app',
				}),
			}),
		);
	});

	it('throws for an unknown zone id', async () => {
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('not used');
			},
			resolveAll: async () => ({}),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver,
					systemConfig: await createSystemConfig(),
					zoneId: 'does-not-exist',
				},
				{
					buildImage: vi.fn(),
					createManagedVm: vi.fn(),
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow("Unknown zone 'does-not-exist'.");
	});

	it('loads the worker lifecycle for worker gateway zones', async () => {
		const systemConfig = await createSystemConfig();
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
				secrets: {
					OPENAI_API_KEY: {
						source: '1password' as const,
						ref: 'op://agent-vm/shravan-openai/credential',
						injection: 'http-mediation' as const,
						audience: 'gateway' as const,
						hosts: ['api.openai.com'],
					},
				},
			})),
		};
		const secretResolver: SecretResolver = {
			resolve: async () => 'openai-key',
			resolveAll: async () => ({ OPENAI_API_KEY: 'openai-key' }),
		};
		const execMock = vi.fn(() => createManagedExecProcessStub({ stdout: '200' }));
		const setIngressRoutesMock = vi.fn();
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());

		const result = await startGatewayZone(
			{
				secretResolver,
				systemConfig: workerSystemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp-worker',
					imagePath: '/tmp/worker-image',
				})),
				createManagedVm: vi.fn(async () => ({
					close: vi.fn(async () => completeGatewayVmClose('worker-vm-123')),
					enableIngress: enableIngressMock,
					enableSsh: vi.fn(),
					exec: execMock,
					fs: createManagedVmFsStub(),
					getHostPid: vi.fn(() => 12345),
					getVmInstance: vi.fn(() => createVmInstanceStub(12345)),
					id: 'worker-vm-123',
					start: vi.fn(async () => {}),
					setIngressRoutes: setIngressRoutesMock,
				})),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				writeGatewayRuntimeRecord: vi.fn(async () => {}),
			},
		);

		expect(result.processSpec.startCommand).toContain('agent-vm-worker');
		expect(result.processSpec.healthCheck).toEqual({ type: 'http', port: 18789, path: '/health' });
	});

	it('waits for service health instead of OpenClaw readiness during startup', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-openclaw-live-not-ready'));
		const executedCommands: string[] = [];
		const execMock = vi.fn((command: string) => {
			executedCommands.push(command);
			if (command.includes('http://127.0.0.1:18789/readyz')) {
				return createManagedExecProcessStub({ stdout: '503' });
			}
			if (command.includes('http://127.0.0.1:18789/health')) {
				return createManagedExecProcessStub({ stdout: '200' });
			}
			return createManagedExecProcessStub();
		});
		const managedVm: ManagedVm = {
			id: 'vm-openclaw-live-not-ready',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28285),
			getVmInstance: vi.fn(() => createVmInstanceStub(28285)),
		};

		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(result.processSpec.healthCheck).toEqual({ type: 'http', port: 18789, path: '/readyz' });
		expect(result.processSpec.serviceHealthCheck).toEqual({
			type: 'http',
			port: 18789,
			path: '/health',
		});
		expect(executedCommands.some((command) => command.includes('/health'))).toBe(true);
		expect(executedCommands.some((command) => command.includes('/readyz'))).toBe(false);
		expect(closeMock).not.toHaveBeenCalled();
	});

	it('splits env secrets from http-mediation secrets based on injection config', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-456'));
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const execMock = vi.fn(() => createManagedExecProcessStub({ stdout: '200' }));
		const setIngressRoutesMock = vi.fn();
		const managedVm: ManagedVm = {
			id: 'vm-456',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28283),
			getVmInstance: vi.fn(() => createVmInstanceStub(28283)),
			setIngressRoutes: setIngressRoutesMock,
		};
		const secretResolver = createOpenClawSecretResolver({
			PERPLEXITY_API_KEY: 'pplx-key',
			DISCORD_BOT_TOKEN: 'discord-token',
			OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
		});
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver,
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall as [Record<string, unknown>];

		// PERPLEXITY_API_KEY should be in secrets (http-mediation) with hosts
		expect(vmOptions.secrets).toEqual({
			PERPLEXITY_API_KEY: {
				hosts: ['api.perplexity.ai'],
				value: 'pplx-key',
			},
		});

		// DISCORD_BOT_TOKEN should be in env (env injection)
		expect(vmOptions.env).toMatchObject({
			DISCORD_BOT_TOKEN: 'discord-token',
		});

		// PERPLEXITY_API_KEY should NOT be in env
		expect(vmOptions.env).not.toHaveProperty('PERPLEXITY_API_KEY');
	});

	it('builds tcp hosts with Tool VM SSH entries only', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-789'));
		const execMock = vi.fn(() => createManagedExecProcessStub({ stdout: '200' }));
		const managedVm: ManagedVm = {
			id: 'vm-789',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28284),
			getVmInstance: vi.fn(() => createVmInstanceStub(28284)),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'key',
					DISCORD_BOT_TOKEN: 'token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall as [Record<string, unknown>];
		expect(vmOptions.tcpHosts).toEqual({
			'tool-0.vm.host:22': '127.0.0.1:19000',
			'tool-1.vm.host:22': '127.0.0.1:19001',
			'tool-2.vm.host:22': '127.0.0.1:19002',
			'tool-3.vm.host:22': '127.0.0.1:19003',
			'tool-4.vm.host:22': '127.0.0.1:19004',
		});
	});

	it('throws with the gateway log tail and closes the vm when service health polling exhausts all attempts', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-timeout'));
		const execMock = vi.fn((command: string) => {
			if (command.includes('tail -n 80')) {
				return createManagedExecProcessStub({
					stdout: 'OpenClaw failed to parse config: unknown thinkingDefault\n',
				});
			}
			if (command.includes('http://127.0.0.1:18789/health')) {
				return createManagedExecProcessStub({ exitCode: 1 });
			}
			return createManagedExecProcessStub({ stdout: '000' });
		});
		const managedVm: ManagedVm = {
			id: 'vm-timeout',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28285),
			getVmInstance: vi.fn(() => createVmInstanceStub(28285)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					gatewayReadinessMaxAttempts: 2,
					gatewayReadinessRetryDelayMs: 0,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow(
			/Gateway service health check failed after 2 attempts.*Last probe: http \(empty\).*Gateway process may still be booting, or it may have crashed before opening its health port.*OpenClaw failed to parse config/su,
		);
		expect(execMock).toHaveBeenCalledWith(
			'tail -n 80 /agent-vm/logs/gateway-boot-latest.log 2>/dev/null || true',
		);
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('defaults gateway service health polling to about 60 seconds', async () => {
		const execMock = vi.fn((command: string) => {
			if (command.includes('tail -n 80')) {
				return createManagedExecProcessStub();
			}
			if (command.includes('http://127.0.0.1:18789/health')) {
				return createManagedExecProcessStub({ exitCode: 1 });
			}
			return createManagedExecProcessStub({ stdout: '000' });
		});
		const managedVm: ManagedVm = {
			id: 'vm-default-timeout',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-default-timeout')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28285),
			getVmInstance: vi.fn(() => createVmInstanceStub(28285)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					gatewayReadinessRetryDelayMs: 0,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow(/Gateway service health check failed after 120 attempts/su);
	});

	it('throws command stdout and stderr and closes the vm when gateway configuration fails', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-config-failed'));
		const managedVm: ManagedVm = {
			id: 'vm-config-failed',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn((command: string) =>
				command.includes('cat > /etc/profile.d/openclaw-env.sh')
					? createManagedExecProcessStub({
							exitCode: 42,
							stdout: 'bootstrap stdout',
							stderr: 'bootstrap stderr',
						})
					: createManagedExecProcessStub({ stdout: '200' }),
			),
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28285),
			getVmInstance: vi.fn(() => createVmInstanceStub(28285)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					gatewayReadinessMaxAttempts: 5,
					gatewayReadinessRetryDelayMs: 0,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow(/Configuring gateway failed.*exit 42.*bootstrap stdout.*bootstrap stderr/su);
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('does not treat non-2xx http responses as ready', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-not-ready-500',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-not-ready-500')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi
				.fn()
				.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '500' }))
				.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '500' }))
				.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '500' }))
				.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '500' }))
				.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '500' }))
				.mockReturnValue(createManagedExecProcessStub({ stdout: '500' })),
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28286),
			getVmInstance: vi.fn(() => createVmInstanceStub(28286)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					gatewayReadinessMaxAttempts: 5,
					gatewayReadinessRetryDelayMs: 0,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
					loadGatewayLifecycle: createHttpHealthGatewayLifecycle,
				},
			),
		).rejects.toThrow(/500/u);
	});

	it('supports command-based health checks', async () => {
		const execMock = vi.fn((_command: string) => createManagedExecProcessStub());
		const managedVm: ManagedVm = {
			id: 'vm-command-health',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-command-health')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28287),
			getVmInstance: vi.fn(() => createVmInstanceStub(28287)),
		};

		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				loadGatewayLifecycle: () => ({
					buildProcessSpec: () => ({
						bootstrapCommand: 'bootstrap-worker',
						guestListenPort: 18789,
						healthCheck: { type: 'command', command: 'check-health' } as const,
						logPath: '/tmp/worker.log',
						startCommand: 'start-worker',
					}),
					buildVmRequirements: () => ({
						allowedHosts: [],
						environment: {},
						mediatedSecrets: {},
						rootfsMode: 'cow' as const,
						sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
						tcpHosts: {},
						mounts: {},
					}),
				}),
			},
		);

		expect(execMock).toHaveBeenCalledWith('check-health');
		expect(result.processSpec.logPath).toBe('/tmp/worker.log');
	});

	it('omits full gateway commands from command failure messages', async () => {
		const secretBearingBootstrapCommand =
			"export FUTURE_SECRET='do-not-leak-command-material' && false";
		const managedVm: ManagedVm = {
			id: 'vm-failed-bootstrap',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-failed-bootstrap')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn((command: string) =>
				command === secretBearingBootstrapCommand
					? createManagedExecProcessStub({
							exitCode: 1,
							stdout: 'bootstrap stdout',
							stderr: 'bootstrap stderr',
						})
					: createManagedExecProcessStub({ stdout: '200' }),
			),
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28287),
			getVmInstance: vi.fn(() => createVmInstanceStub(28287)),
		};
		const systemConfig = await createSystemConfig();

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig,
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
					loadGatewayLifecycle: () => ({
						buildProcessSpec: () => ({
							bootstrapCommand: secretBearingBootstrapCommand,
							guestListenPort: 18789,
							healthCheck: { type: 'http', port: 18789, path: '/' } as const,
							logPath: '/tmp/worker.log',
							startCommand: 'start-worker',
						}),
						buildVmRequirements: () => ({
							allowedHosts: [],
							environment: {},
							mediatedSecrets: {},
							rootfsMode: 'cow' as const,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							tcpHosts: {},
							mounts: {},
						}),
					}),
				},
			),
		).rejects.toThrow(
			/^(?!.*(?:do-not-leak-command-material|Command:))Configuring gateway failed with exit 1/u,
		);
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected Gateway test zone.');
		}
		await expect(loadGatewayRuntimeRecord(zone.gateway.stateDir)).resolves.toBeNull();
	});

	it('retries health checks until a 2xx response is returned', async () => {
		const execMock = vi.fn((command: string) => {
			if (!command.includes('curl -sS -o /dev/null -w "%{http_code}"')) {
				return createManagedExecProcessStub();
			}
			healthProbeCount += 1;
			return createManagedExecProcessStub({
				stdout: healthProbeCount === 1 ? '000' : '200',
			});
		});
		let healthProbeCount = 0;
		const managedVm: ManagedVm = {
			id: 'vm-retry-health',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-retry-health')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28288),
			getVmInstance: vi.fn(() => createVmInstanceStub(28288)),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				loadGatewayLifecycle: createHttpHealthGatewayLifecycle,
			},
		);

		expect(execMock).toHaveBeenNthCalledWith(
			3,
			expect.stringContaining('curl -sS -o /dev/null -w "%{http_code}"'),
		);
		expect(execMock).toHaveBeenNthCalledWith(
			4,
			expect.stringContaining('curl -sS -o /dev/null -w "%{http_code}"'),
		);
		expect(healthProbeCount).toBe(2);
	});

	it('aborts a pending gateway service-health retry without starting another probe', async () => {
		vi.useFakeTimers();
		try {
			const { exec, managedVm } = createHealthyGatewayVmStub('vm-successor-health-abort', 28_399);
			exec.mockImplementation(() => createManagedExecProcessStub({ stdout: '000' }));
			const healthAbortController = new AbortController();
			const exactDeadlineReason = new Error(
				"OpenClaw successor process 'process-2' exceeded its 45000ms phase deadline.",
			);
			const healthWait = waitForGatewayServiceHealth({
				healthCheck: { path: '/health', port: 18_789, type: 'http' },
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
				managedVm,
				maxAttempts: 5,
				retryDelayMs: 60_000,
				signal: healthAbortController.signal,
			});

			for (
				let microtaskFlush = 0;
				microtaskFlush < 10 && vi.getTimerCount() === 0;
				microtaskFlush += 1
			) {
				// oxlint-disable-next-line no-await-in-loop -- bounded fake-timer microtask flushing is intentionally sequential
				await Promise.resolve();
			}
			expect(exec).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(1);

			healthAbortController.abort(exactDeadlineReason);

			await expect(healthWait).rejects.toBe(exactDeadlineReason);
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(120_000);
			expect(exec).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('configures the gateway to use the generated effective OpenClaw config path', async () => {
		const execMock = vi.fn(() => createManagedExecProcessStub({ stdout: '200' }));
		const managedVm: ManagedVm = {
			id: 'vm-token',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-token')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28289),
			getVmInstance: vi.fn(() => createVmInstanceStub(28289)),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(execMock).toHaveBeenCalledWith(
			expect.stringContaining("cat > /etc/profile.d/openclaw-env.sh << 'ENVEOF'"),
		);
		expect(execMock).toHaveBeenCalledWith(
			expect.stringContaining('chmod 644 /etc/profile.d/openclaw-env.sh'),
		);
		expect(execMock).toHaveBeenCalledWith(expect.stringContaining('source /root/.bashrc'));
		expect(execMock).toHaveBeenCalledWith(
			expect.stringContaining(
				'export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/state/effective-openclaw.json',
			),
		);
	});

	it('reserves exact ownership immediately before VM creation and returns the same ownership handle', async () => {
		const taskTitles: string[] = [];
		const ownership = createTestVmOwnershipHarness(
			'vm-owned-start',
			createTestGatewayEpochIdentity('vm-owned-start'),
		);
		const { managedVm } = createHealthyGatewayVmStub('vm-owned-start', 28_294);
		const createManagedVm = vi.fn(async () => managedVm);

		const result = await startGatewayZone(
			{
				createVmOwnership: ownership.createVmOwnership,
				runTask: async (title, run) => {
					taskTitles.push(title);
					await run();
				},
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		const reservationTaskIndex = taskTitles.indexOf('Reserving gateway VM ownership');
		expect(taskTitles.slice(reservationTaskIndex, reservationTaskIndex + 2)).toEqual([
			'Reserving gateway VM ownership',
			'Booting gateway VM',
		]);
		expect(ownership.createVmOwnership.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			createManagedVm.mock.invocationCallOrder[0] ?? 0,
		);
		expect(ownership.createVmOwnership).toHaveBeenCalledWith({
			controlIdentity: {
				bootId: testGatewayBootId,
				generationId: testGatewayGenerationId,
			},
			kind: 'gateway-epoch',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			zoneId: 'shravan',
		});
		expect(result.vmOwnership).toBe(ownership.vmOwnership);
		expect(ownership.attachGatewayVm).toHaveBeenCalledWith(result.vm.id);
		expect(ownership.destroyLive).not.toHaveBeenCalled();
	});

	it('publishes pending VM containment and never configures a late Gateway create after containment starts', async () => {
		const pendingManagedVm = createDeferredPromise<ManagedVm>();
		const containmentPublished = createDeferredPromise<void>();
		const { close, exec, managedVm } = createHealthyGatewayVmStub(
			'vm-late-after-containment',
			28_394,
		);
		let pendingContainment: PendingGatewayVmCreationContainment | undefined;
		const gatewayIdentity = createTestGatewayEpochIdentity('vm-late-after-containment');
		const vmOwnership: GatewayVmLifecycleAuthority = {
			attachGatewayVm: vi.fn(() => gatewayIdentity),
			containPendingCreate: async (containmentOptions) => {
				const lateCreatedVm = await containmentOptions.pendingCreate;
				return await containmentOptions.closeLateCreatedVm(lateCreatedVm);
			},
			destroyLive: vi.fn(async (destroyGatewayVm) => await destroyGatewayVm()),
			gatewayIdentity: undefined,
			gatewaySeed: gatewayIdentity,
		};

		const startPromise = startGatewayZone(
			{
				createVmOwnership: vi.fn(async () => vmOwnership),
				onPendingVmCreation: (containment) => {
					pendingContainment = containment;
					containmentPublished.resolve();
				},
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
				createManagedVm: vi.fn(async () => await pendingManagedVm.promise),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);
		await containmentPublished.promise;
		if (pendingContainment === undefined) {
			throw new Error('Expected pending Gateway VM containment to be published.');
		}
		const containmentPromise = pendingContainment.contain();

		pendingManagedVm.resolve(managedVm);

		await expect(containmentPromise).resolves.toBeUndefined();
		await expect(startPromise).rejects.toThrow('Pending Gateway VM creation was contained');
		expect(close).toHaveBeenCalledOnce();
		expect(exec).not.toHaveBeenCalled();
	});

	it('passes exact control identity to ownership without inventing a VM when creation rejects', async () => {
		const ownership = createTestVmOwnershipHarness(
			'vm-create-reject',
			createTestGatewayEpochIdentity('vm-create-reject', 'controller-epoch-exact'),
		);
		const createError = new Error('gateway VM create rejected');
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => {
			throw createError;
		});

		await expect(
			startGatewayZone(
				{
					controlSession: { controllerEpoch: 'controller-epoch-exact' },
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					createManagedVm,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toBe(createError);

		expect(ownership.createVmOwnership).toHaveBeenCalledWith({
			controlIdentity: {
				bootId: testGatewayBootId,
				generationId: testGatewayGenerationId,
			},
			kind: 'gateway-epoch',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			zoneId: 'shravan',
		});
		expect(ownership.attachGatewayVm).not.toHaveBeenCalled();
		expect(ownership.destroyLive).not.toHaveBeenCalled();
	});

	it('uses live ownership destruction for startup rollback after VM creation succeeds', async () => {
		const ownership = createTestVmOwnershipHarness(
			'vm-owned-rollback',
			createTestGatewayEpochIdentity('vm-owned-rollback'),
		);
		const { close, managedVm } = createHealthyGatewayVmStub('vm-owned-rollback', 28_295);
		const recordError = new Error('runtime record write failed');

		await expect(
			startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					createManagedVm: vi.fn(async () => managedVm),
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
					writeGatewayRuntimeRecord: vi.fn(async () => {
						throw recordError;
					}),
				},
			),
		).rejects.toBe(recordError);

		expect(ownership.destroyLive).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('rolls back the exact Gateway when P1 is not positively observed before health and S1', async () => {
		const ownership = createTestVmOwnershipHarness(
			'vm-process-observe-failed',
			createTestGatewayEpochIdentity('vm-process-observe-failed'),
		);
		const { close, enableIngress, exec, managedVm } = createHealthyGatewayVmStub(
			'vm-process-observe-failed',
			28_296,
		);
		const omittedLogPrefix = 'omitted-sensitive-prefix';
		const retainedLogSuffix = 'retained-openclaw-exit-suffix';
		exec.mockImplementation((command) =>
			createManagedExecProcessStub({
				stdout:
					typeof command === 'string' && command.startsWith('tail -n 80 ')
						? `${omittedLogPrefix}${'x'.repeat(20_000)}${retainedLogSuffix}\n`
						: '200',
			}),
		);
		const connectGatewayControlSession = vi.fn(connectTestGatewayControlSession);
		const writeGatewayRuntimeRecord = vi.fn<
			NonNullable<GatewayManagerDependencies['writeGatewayRuntimeRecord']>
		>(async () => undefined);
		const processStart = vi.fn<OpenClawProcessSupervisor['start']>();
		const processObserve = vi.fn<OpenClawProcessSupervisor['observe']>();

		const startup = startGatewayZone(
			{
				controlSession: { controllerEpoch: 'controller-epoch-test' },
				createVmOwnership: ownership.createVmOwnership,
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				connectGatewayControlSession,
				createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
				createManagedVm: vi.fn(async () => managedVm),
				createOpenClawProcessSupervisorPorts: ({ gateway }) => {
					const supervisor = createTestOpenClawProcessSupervisor(gateway);
					processStart.mockImplementation(async (request) => await supervisor.start(request));
					processObserve.mockImplementation(async (request) => ({
						actionId: request.actionId,
						cgroup: { name: 'test-openclaw-cgroup', populated: false },
						contractVersion: 1,
						expectedProcessEpoch: request.expectedProcessEpoch ?? 'missing-process',
						gateway,
						kind: 'observe',
						observedProcessEpoch: request.expectedProcessEpoch ?? 'missing-process',
						status: 'completed',
					}));
					return {
						reliabilityFaultActuator: {
							terminateOwnedProcess: vi.fn(async () => {
								throw new Error('Gateway startup test did not expect reliability actuation.');
							}),
						},
						supervisor: { ...supervisor, observe: processObserve, start: processStart },
					};
				},
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				writeGatewayRuntimeRecord,
			},
		);

		await expect(startup).rejects.toThrow(
			/was not positively observed in its exact cgroup.*Gateway log tail.*gateway log tail truncated.*retained-openclaw-exit-suffix/su,
		);
		await expect(startup).rejects.not.toThrow(omittedLogPrefix);

		expect(processStart).toHaveBeenCalledOnce();
		expect(processObserve).toHaveBeenCalledOnce();
		expect(enableIngress).not.toHaveBeenCalled();
		expect(connectGatewayControlSession).not.toHaveBeenCalled();
		expect(writeGatewayRuntimeRecord).toHaveBeenCalledOnce();
		expect(writeGatewayRuntimeRecord.mock.calls[0]?.[1]).toMatchObject({
			schemaVersion: 2,
			vmId: 'vm-process-observe-failed',
		});
		expect(writeGatewayRuntimeRecord.mock.calls[0]?.[1]).not.toHaveProperty('ingressPort');
		expect(ownership.destroyLive).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('closes the booted gateway VM if writing the runtime record fails', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-record-fail'));
		const managedVm: ManagedVm = {
			id: 'vm-record-fail',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28290),
			getVmInstance: vi.fn(() => createVmInstanceStub(28290)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
					writeGatewayRuntimeRecord: vi.fn(async () => {
						throw new Error('disk full');
					}),
				},
			),
		).rejects.toThrow(/disk full/u);

		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('surfaces failed stock close during startup rollback', async () => {
		const closeError = new Error('stock close failed after runner termination');
		const closeMock = vi.fn(async () => {
			throw closeError;
		});
		const managedVm: ManagedVm = {
			id: 'vm-record-fail-incomplete-close',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: vi.fn(() => 28290),
			getVmInstance: vi.fn(() => createVmInstanceStub(28290)),
		};

		let thrownError: unknown;
		try {
			await startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
					writeGatewayRuntimeRecord: vi.fn(async () => {
						throw new Error('disk full');
					}),
				},
			);
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		const aggregateError = thrownError as AggregateError;
		expect(aggregateError.errors).toEqual([
			expect.objectContaining({ message: 'disk full' }),
			expect.objectContaining({
				cause: closeError,
				message: expect.stringMatching(/not proven complete/u),
			}),
		]);
		expect(closeMock).toHaveBeenCalledOnce();
	});

	it('preserves startup, ingress-close, and stock-close failures during rollback', async () => {
		const startupError = new Error('control session connect failed');
		const ingressCloseError = new Error('ingress close failed');
		const stockCloseError = new Error('stock close failed');
		const ingressClose = vi.fn(async () => {
			throw ingressCloseError;
		});
		const stockVmClose = vi.fn(async () => {
			throw stockCloseError;
		});
		const { managedVm } = createHealthyGatewayVmStub('vm-ingress-rollback-errors', 28_297);
		managedVm.enableIngress = vi.fn(async () => ({
			close: ingressClose,
			host: '127.0.0.1',
			port: 18791,
		}));
		managedVm.close = stockVmClose;

		let thrownError: unknown;
		try {
			await startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					connectGatewayControlSession: vi.fn(async () => {
						throw startupError;
					}),
					createManagedVm: vi.fn(async () => managedVm),
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			);
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		const startupAggregate = thrownError as AggregateError;
		expect(startupAggregate.errors[0]).toBe(startupError);
		expect(startupAggregate.errors[1]).toBeInstanceOf(AggregateError);
		const cleanupAggregate = startupAggregate.errors[1] as AggregateError;
		expect(cleanupAggregate.errors[0]).toBe(ingressCloseError);
		expect(cleanupAggregate.errors[1]).toMatchObject({ cause: stockCloseError });
		expect(ingressClose).toHaveBeenCalledOnce();
		expect(stockVmClose).toHaveBeenCalledOnce();
	});

	it('does not create a gateway VM when final host-state preparation fails', async () => {
		const prepError = new Error('prep failed: disk full');
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => {
			throw new Error('createManagedVm should not run after prepareHostState fails');
		});
		const prepareHostState = vi.fn(async () => {
			throw prepError;
		});

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
					loadGatewayLifecycle: () => ({
						...createHttpHealthGatewayLifecycle(),
						prepareHostState,
					}),
				},
			),
		).rejects.toThrow(prepError.message);

		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(prepareHostState).toHaveBeenCalledOnce();
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('prepares host state before booting a gateway VM', async () => {
		const prepareHostState = vi.fn(async () => {});
		const managedVm: ManagedVm = {
			id: 'vm-prep-before-boot',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-prep-before-boot')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(() => createVmInstanceStub(28291)),
			getHostPid: vi.fn(() => 28291),
		};
		const createManagedVm = vi.fn(async () => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				loadGatewayLifecycle: () => ({
					...createHttpHealthGatewayLifecycle(),
					prepareHostState,
				}),
			},
		);

		expect(prepareHostState.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			createManagedVm.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it('starts OpenClaw without consulting legacy foreign-runtime cleanup authority', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-quarantine',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-quarantine')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28293),
			getVmInstance: vi.fn(() => createVmInstanceStub(28293)),
			setIngressRoutes: vi.fn(),
		};

		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(result.vm).toBe(managedVm);
		expect(result.ingress).toEqual({ host: '127.0.0.1', port: 18791 });
	});

	it('provisions plugin verifier config and connects the gateway control session after ingress', async () => {
		const taskTitles: string[] = [];
		const controlSessionClose = vi.fn();
		const controlSessionClient: GatewayDisposableControlSessionClient = {
			ready: Promise.resolve({
				attachmentGeneration: 1,
				connectionId: '55555555-5555-4555-8555-555555555555',
				controllerEpoch: 'controller-epoch-test',
				outcome: 'accepted',
				sessionId: '33333333-3333-4333-8333-333333333333',
			}),
			close: controlSessionClose,
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
		};
		const leaseSnapshot = {
			agentId: 'main',
			idleTtlMs: 120_000,
			leaseId: 'lease-main',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'identity-pem',
				knownHostsLine: `tool-0.vm.host ${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}`,
				port: 22,
				user: 'root',
			},
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'shravan',
		} satisfies GatewayControlLeaseSnapshot;
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const prepareSemanticMutation = vi.fn(async () => ({
			execute: vi.fn(async () => leaseSnapshot),
			profile: {
				compatibilityId: 'compatibility-main',
				currentLeafTargetId: null,
				kind: 'lease_authority' as const,
				stablePrincipal: 'shravan/main',
			},
			target: 'agent:main',
		}));
		const gatewayControlLeaseRpc = {
			getLease: vi.fn(async () => undefined),
			prepareSemanticMutation,
		} satisfies GatewayControlLeaseRpcOperations;
		const pushZoneGit = vi.fn(async () => ({
			branch: 'agent/main',
			localHead: 'abc123',
			pushedCommits: [{ sha: 'abc123', subject: 'docs: update memory' }],
			remoteHead: 'abc123',
		}));
		const managedVm: ManagedVm = {
			id: 'vm-control-session',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-control-session')),
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			fs: createManagedVmFsStub(),
			getHostPid: vi.fn(() => 28283),
			getVmInstance: vi.fn(() => createVmInstanceStub(28283)),
			setIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const configuredZone = systemConfig.zones[0];
		if (configuredZone === undefined || configuredZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const toolPortalConfigDir = path.dirname(configuredZone.gateway.config);
		await writeMinimalMcpPortalConfigs(toolPortalConfigDir);
		const systemConfigWithToolPortal: LoadedSystemConfig = {
			...systemConfig,
			zones: [
				{
					...configuredZone,
					toolPortal: { configDir: toolPortalConfigDir },
				},
			],
		};
		let connectedGatewayControlSessionOptions:
			| Parameters<GatewayControlSessionConnector>[0]
			| undefined;
		const connectGatewayControlSession = vi.fn<GatewayControlSessionConnector>(
			async (connectOptions) => {
				connectedGatewayControlSessionOptions = connectOptions;
				return controlSessionClient;
			},
		);
		const gatewayControlProcessAdmissionCoordinator =
			createGatewayControlProcessAdmissionCoordinator();
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 16,
			staleAfterMs: 30_000,
		});
		const onControlSessionAttachmentGap = vi.fn();
		const onControlSessionHeartbeat = vi.fn();
		const onControlSessionReconnectExhausted = vi.fn();

		const result = await startGatewayZone(
			{
				controlSession: { controllerEpoch: 'controller-epoch-test' },
				gatewayControlControllerHostActions: {
					authorizeControllerHostAction: vi.fn(async () => ({ authorized: true }) as const),
					pushZoneGit,
					runControllerHostProbe: vi.fn(async () => ({
						entryNames: ['agent-vm-host-probe.txt'],
						probeKind: 'controller_cache_dir_listing' as const,
					})),
				},
				gatewayControlLeaseRpc,
				gatewayControlProcessAdmissionCoordinator,
				healthEventStore,
				onControlSessionAttachmentGap,
				onControlSessionHeartbeat,
				onControlSessionReconnectExhausted,
				runTask: async (title, fn) => {
					taskTitles.push(title);
					await fn();
				},
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: systemConfigWithToolPortal,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				connectGatewayControlSession,
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(connectGatewayControlSession).toHaveBeenCalledWith({
			dispatcher: expect.objectContaining({
				dispatch: expect.any(Function),
				register: expect.any(Function),
			}),
			endpoint: {
				host: '127.0.0.1',
				path: '/__agent-vm/gateway-control',
				port: 18791,
			},
			material: expect.objectContaining({
				controllerEpoch: 'controller-epoch-test',
				peerId: 'gateway-shravan',
				zoneId: 'shravan',
			}),
			onAttachmentGap: expect.any(Function),
			onAttemptOutcome: expect.any(Function),
			onReconnectExhausted: expect.any(Function),
			processAdmissionCoordinator: gatewayControlProcessAdmissionCoordinator,
			recordHealthEvent: expect.any(Function),
			resolveInboundStablePrincipal: expect.any(Function),
			sessionFenceRegistry: expect.objectContaining({
				acceptSession: expect.any(Function),
				assertEnvelopeAccepted: expect.any(Function),
			}),
		});
		const connectedOptions = connectedGatewayControlSessionOptions;
		const connectedDispatcher = connectedOptions?.dispatcher;
		if (connectedOptions === undefined || connectedDispatcher === undefined) {
			throw new Error('Expected gateway control dispatcher.');
		}
		connectedOptions.recordHealthEvent?.({
			kind: 'caller-context-rejection',
			observedAtMs: 1_234,
			operation: 'lease_renew',
			reason: 'caller_context_stale',
			result: 'failed',
			zoneId: 'shravan',
		});
		expect(healthEventStore.listHistory()).toContainEqual({
			kind: 'caller-context-rejection',
			observedAtMs: 1_234,
			operation: 'lease_renew',
			reason: 'caller_context_stale',
			result: 'failed',
			zoneId: 'shravan',
		});
		const gatewayIdentity = result.vmOwnership.gatewayIdentity;
		if (gatewayIdentity === undefined) {
			throw new Error('Expected exact Gateway identity.');
		}
		connectedOptions.onAttachmentGap?.({
			attachmentGeneration: 7,
			gapReason: 'transport close',
			gatewayEpoch: connectedOptions.material.generationId,
			kind: 'attachment_gap',
			observedAtMs: 123_456,
			processEpoch: connectedOptions.material.processEpoch,
			zoneId: connectedOptions.material.zoneId,
		});
		expect(onControlSessionAttachmentGap).toHaveBeenCalledExactlyOnceWith({
			attachmentGeneration: 7,
			gapReason: 'transport close',
			gateway: gatewayIdentity,
			gatewayEpoch: connectedOptions.material.generationId,
			kind: 'attachment_gap',
			observedAtMs: 123_456,
			processEpoch: connectedOptions.material.processEpoch,
			zoneId: connectedOptions.material.zoneId,
		});
		expect(() =>
			connectedOptions.onAttachmentGap?.({
				attachmentGeneration: 8,
				gapReason: 'stale process',
				gatewayEpoch: connectedOptions.material.generationId,
				kind: 'attachment_gap',
				observedAtMs: 123_457,
				processEpoch: 'stale-process',
				zoneId: connectedOptions.material.zoneId,
			}),
		).toThrow('does not match the current zone/process material');
		expect(onControlSessionAttachmentGap).toHaveBeenCalledTimes(1);
		connectedOptions.sessionFenceRegistry?.acceptSession({
			bootId: connectedOptions.material.bootId,
			connectionId: '55555555-5555-4555-8555-555555555555',
			controllerEpoch: 'controller-epoch-test',
			domain: 'gateway_control',
			peerId: 'gateway-shravan',
			sessionId: '33333333-3333-4333-8333-333333333333',
			zoneId: 'shravan',
		});
		await connectedDispatcher.dispatch({
			envelope: {
				bootId: connectedOptions.material.bootId,
				connectionId: '55555555-5555-4555-8555-555555555555',
				controllerEpoch: 'controller-epoch-test',
				createdAtMs: 1,
				deliveryPolicy: 'critical_idempotent',
				domain: 'gateway_control',
				kind: 'heartbeat',
				messageId: '11111111-1111-4111-8111-111111111111',
				peerId: 'gateway-shravan',
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				sequence: 1,
				sessionId: '33333333-3333-4333-8333-333333333333',
				zoneId: 'shravan',
			},
			payload: {
				kind: 'heartbeat',
				payload: { elapsedMs: 3, observedAtMs: 123_458 },
			},
		});
		expect(onControlSessionHeartbeat).toHaveBeenCalledExactlyOnceWith({
			gateway: gatewayIdentity,
			observedAtMs: 123_458,
			processEpoch: connectedOptions.material.processEpoch,
		});
		const semanticCommandCreatedAtMs = Date.now();
		const createEnvelope = (input: {
			readonly commandId: string;
			readonly deliveryPolicy: 'critical_idempotent' | 'single_use_critical';
			readonly idempotencyKey: string;
			readonly messageId: string;
			readonly operation:
				| 'caller_context_register'
				| 'lease_create'
				| 'tool_portal_controller_host_action';
			readonly sequence: number;
		}): ControlEnvelope => ({
			bootId: connectedOptions.material.bootId,
			commandId: input.commandId,
			connectionId: '55555555-5555-4555-8555-555555555555',
			controllerEpoch: 'controller-epoch-test',
			createdAtMs: semanticCommandCreatedAtMs,
			deliveryPolicy: input.deliveryPolicy,
			domain: 'gateway_control',
			expiresAtMs: semanticCommandCreatedAtMs + 60_000,
			idempotencyKey: input.idempotencyKey,
			kind: 'command',
			messageId: input.messageId,
			operation: input.operation,
			peerId: 'gateway-shravan',
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			sequence: input.sequence,
			sessionId: '33333333-3333-4333-8333-333333333333',
			zoneId: 'shravan',
		});
		const registerResult = GatewayControlRpcCommandResultMessageSchema.parse(
			await connectedDispatcher.dispatch({
				envelope: createEnvelope({
					commandId: '44444444-4444-4444-8444-444444444444',
					deliveryPolicy: 'critical_idempotent',
					idempotencyKey: 'register-context',
					messageId: '22222222-2222-4222-8222-222222222222',
					operation: 'caller_context_register',
					sequence: 1,
				}),
				payload: {
					kind: 'command',
					operation: 'caller_context_register',
					payload: {
						adapterEvidence: {
							agentAuthority: signTestCallerContextAgentAuthority(
								{
									agentId: 'main',
									agentWorkspaceDir: '/zone/agents/main',
									sessionKey: 'agent:main:test-session',
									workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
									zoneId: 'shravan',
								},
								connectedOptions.material.agentAuthorityKeys.main,
							),
							agentId: 'main',
							agentWorkspaceDir: '/zone/agents/main',
							proof: signTestCallerContextProof(
								{
									agentId: 'main',
									agentWorkspaceDir: '/zone/agents/main',
									sessionKey: 'agent:main:test-session',
									workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
									zoneId: 'shravan',
								},
								connectedOptions.material.callerContextProofKey,
							),
							sessionKey: 'agent:main:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
							zoneId: 'shravan',
						},
					},
				},
			}),
		);
		const callerContextId = registerResult.payload.callerContext?.callerContextId;
		if (callerContextId === undefined) {
			throw new Error('Expected caller_context_register result to include callerContextId.');
		}
		await connectedDispatcher.dispatch({
			attachmentGeneration: 1,
			envelope: createEnvelope({
				commandId: '55555555-5555-4555-8555-555555555555',
				deliveryPolicy: 'critical_idempotent',
				idempotencyKey: 'lease-create',
				messageId: '66666666-6666-4666-8666-666666666666',
				operation: 'lease_create',
				sequence: 2,
			}),
			payload: {
				kind: 'command',
				operation: 'lease_create',
				payload: {
					callerContext: { callerContextId },
				},
			},
		});
		expect(prepareSemanticMutation).toHaveBeenCalledWith({
			attachmentGeneration: 1,
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId,
				zoneId: 'shravan',
			}),
			gateway: expect.objectContaining({
				bootId: connectedOptions.material.bootId,
				controllerEpoch: 'controller-epoch-test',
				generationId: connectedOptions.material.generationId,
				zoneId: 'shravan',
			}),
			operation: 'lease_create',
			payload: {
				callerContext: { callerContextId },
			},
			processEpoch: connectedOptions.material.bootId,
		});
		const hostActionRegisterResult = GatewayControlRpcCommandResultMessageSchema.parse(
			await connectedDispatcher.dispatch({
				envelope: createEnvelope({
					commandId: '99999999-9999-4999-8999-999999999999',
					deliveryPolicy: 'critical_idempotent',
					idempotencyKey: 'register-host-action-context',
					messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
					operation: 'caller_context_register',
					sequence: 3,
				}),
				payload: {
					kind: 'command',
					operation: 'caller_context_register',
					payload: {
						adapterEvidence: {
							agentAuthority: signTestCallerContextAgentAuthority(
								{
									agentId: 'main',
									agentWorkspaceDir: '/zone/agents/main',
									purpose: 'tool_portal_controller_host_action',
									sessionKey: 'agent:main:test-session',
									workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
									zoneId: 'shravan',
								},
								connectedOptions.material.agentAuthorityKeys.main,
							),
							agentId: 'main',
							agentWorkspaceDir: '/zone/agents/main',
							proof: signTestCallerContextProof(
								{
									agentId: 'main',
									agentWorkspaceDir: '/zone/agents/main',
									purpose: 'tool_portal_controller_host_action',
									sessionKey: 'agent:main:test-session',
									workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
									zoneId: 'shravan',
								},
								connectedOptions.material.callerContextProofKey,
							),
							purpose: 'tool_portal_controller_host_action',
							sessionKey: 'agent:main:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
							zoneId: 'shravan',
						},
					},
				},
			}),
		);
		const hostActionCallerContextId =
			hostActionRegisterResult.payload.callerContext?.callerContextId;
		if (hostActionCallerContextId === undefined) {
			throw new Error(
				'Expected host-action caller_context_register result to include callerContextId.',
			);
		}
		const hostActionResult = GatewayControlRpcCommandResultMessageSchema.parse(
			await connectedDispatcher.dispatch({
				attachmentGeneration: 1,
				envelope: createEnvelope({
					commandId: '77777777-7777-4777-8777-777777777777',
					deliveryPolicy: 'single_use_critical',
					idempotencyKey: 'zone-git-push',
					messageId: '88888888-8888-4888-8888-888888888888',
					operation: 'tool_portal_controller_host_action',
					sequence: 4,
				}),
				payload: {
					kind: 'command',
					operation: 'tool_portal_controller_host_action',
					payload: {
						actionId: 'zone_git_push',
						callerContext: { callerContextId: hostActionCallerContextId },
						correlation: {
							capability: {
								name: 'zone_git_push',
								namespace: 'controller_host_action',
							},
						},
						expectedHead: 'abc123',
					},
				},
			}),
		);
		expect(pushZoneGit).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: hostActionCallerContextId,
				purpose: 'tool_portal_controller_host_action',
				zoneId: 'shravan',
			}),
			payload: {
				actionId: 'zone_git_push',
				callerContext: { callerContextId: hostActionCallerContextId },
				correlation: {
					capability: {
						name: 'zone_git_push',
						namespace: 'controller_host_action',
					},
				},
				expectedHead: 'abc123',
			},
			session: expect.objectContaining({
				peerId: 'gateway-shravan',
				zoneId: 'shravan',
			}),
		});
		expect(hostActionResult).toMatchObject({
			kind: 'command_result',
			operation: 'tool_portal_controller_host_action',
			payload: {
				controllerHostAction: {
					actionId: 'zone_git_push',
					result: {
						branch: 'agent/main',
						localHead: 'abc123',
						pushedCommits: [{ sha: 'abc123', subject: 'docs: update memory' }],
						remoteHead: 'abc123',
					},
				},
				result: 'ok',
			},
		});
		expect(taskTitles).toContain('Connecting gateway control session');
		expect(taskTitles.indexOf('Connecting gateway control session')).toBeLessThan(
			taskTitles.indexOf('Recording gateway runtime'),
		);
		expect(result.controlSession).toBe(controlSessionClient);
		expect(result.controlSessionRecoverySourceKey).toEqual({
			bootId: connectedGatewayControlSessionOptions?.material.bootId,
			domain: 'gateway_control',
			gatewayVmId: 'vm-control-session',
			generationId: connectedGatewayControlSessionOptions?.material.generationId,
			zoneId: 'shravan',
		});

		const zone = systemConfigWithToolPortal.zones.find((candidate) => candidate.id === 'shravan');
		if (zone?.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const effectiveConfig = JSON.parse(
			await readFile(path.join(zone.gateway.stateDir, 'effective-openclaw.json'), 'utf8'),
		) as {
			readonly plugins?: {
				readonly entries?: {
					readonly gondolin?: {
						readonly config?: {
							readonly controlSession?: {
								readonly controllerEpoch?: string;
								readonly peerId?: string;
								readonly verifierPublicKeyPem?: string;
							};
						};
					};
				};
			};
		};
		const controlSessionConfig = effectiveConfig.plugins?.entries?.gondolin?.config?.controlSession;
		expect(controlSessionConfig).toMatchObject({
			controllerEpoch: 'controller-epoch-test',
			peerId: 'gateway-shravan',
		});
		expect(controlSessionConfig?.verifierPublicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/u);

		const guestVisibleRuntimeRecordText = await readFile(
			path.join(zone.gateway.stateDir, 'gateway-runtime.json'),
			'utf8',
		);
		const guestVisibleRuntimeRecord = parseJsonObject(guestVisibleRuntimeRecordText);
		expect(guestVisibleRuntimeRecord).not.toHaveProperty('controlSession');
		expect(guestVisibleRuntimeRecordText).not.toContain('privateKeyPkcs8Pem');
		expect(guestVisibleRuntimeRecordText).not.toContain('BEGIN PRIVATE KEY');

		const controllerOnlyMaterialText = await readFile(
			resolveGatewayControlSessionMaterialPath(systemConfigWithToolPortal.runtimeDir, 'shravan'),
			'utf8',
		);
		const controllerOnlyMaterial = requireObjectProperty(
			parseJsonObject(controllerOnlyMaterialText),
			'material',
		);
		const connectedMaterial = connectedOptions.material;
		expect(controllerOnlyMaterial).toMatchObject({
			bootId: connectedMaterial.bootId,
			controllerEpoch: connectedMaterial.controllerEpoch,
			generationId: connectedMaterial.generationId,
			peerId: connectedMaterial.peerId,
			zoneId: connectedMaterial.zoneId,
		});
		expect(controllerOnlyMaterialText).toContain('privateKeyPkcs8Pem');
		expect(controllerOnlyMaterialText).toContain('BEGIN PRIVATE KEY');
	});

	it('accepts caller context registration for declared non-default agents in multi-agent OpenClaw zones', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				callerContextProofKey: testCallerContextProofKey,
				payload: {
					adapterEvidence: {
						agentAuthority: signTestCallerContextAgentAuthority({
							agentId: 'second',
							agentWorkspaceDir: '/zone/agents/second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
							zoneId: 'shravan',
						}),
						agentId: 'second',
						agentWorkspaceDir: '/zone/agents/second',
						proof: signTestCallerContextProof({
							agentId: 'second',
							agentWorkspaceDir: '/zone/agents/second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
							zoneId: 'shravan',
						}),
						sessionKey: 'agent:second:test-session',
						workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
						zoneId: 'shravan',
					},
				},
				zone: multiAgentZone,
			}),
		).not.toThrow();
	});

	it('rejects caller context registration without per-agent authority proof in multi-agent OpenClaw zones', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				callerContextProofKey: testCallerContextProofKey,
				payload: {
					adapterEvidence: {
						agentId: 'second',
						agentWorkspaceDir: '/zone/agents/second',
						proof: signTestCallerContextProof({
							agentId: 'second',
							agentWorkspaceDir: '/zone/agents/second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
							zoneId: 'shravan',
						}),
						sessionKey: 'agent:second:test-session',
						workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
						zoneId: 'shravan',
					},
				} as unknown as GatewayControlCallerContextRegisterPayload,
				zone: multiAgentZone,
			}),
		).toThrow(/agent authority/u);
	});

	it('rejects caller context registration when a declared agent presents a forged workspace', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				callerContextProofKey: testCallerContextProofKey,
				payload: {
					adapterEvidence: {
						agentAuthority: signTestCallerContextAgentAuthority({
							agentId: 'second',
							agentWorkspaceDir: '/home/openclaw/workspace-second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
							zoneId: 'shravan',
						}),
						agentId: 'second',
						agentWorkspaceDir: '/home/openclaw/workspace-second',
						proof: signTestCallerContextProof({
							agentId: 'second',
							agentWorkspaceDir: '/home/openclaw/workspace-second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
							zoneId: 'shravan',
						}),
						sessionKey: 'agent:second:test-session',
						workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
						zoneId: 'shravan',
					},
				},
				zone: multiAgentZone,
			}),
		).toThrow(/agentWorkspaceDir/u);
	});

	it('rejects caller context registration when the proof was not issued for the session material', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				callerContextProofKey: testCallerContextProofKey,
				payload: {
					adapterEvidence: {
						agentAuthority: signTestCallerContextAgentAuthority({
							agentId: 'second',
							agentWorkspaceDir: '/zone/agents/second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
							zoneId: 'shravan',
						}),
						agentId: 'second',
						agentWorkspaceDir: '/zone/agents/second',
						proof: signTestCallerContextProof(
							{
								agentId: 'second',
								agentWorkspaceDir: '/zone/agents/second',
								sessionKey: 'agent:second:test-session',
								workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
								zoneId: 'shravan',
							},
							'wrong-caller-context-proof-key',
						),
						sessionKey: 'agent:second:test-session',
						workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
						zoneId: 'shravan',
					},
				},
				zone: multiAgentZone,
			}),
		).toThrow(/caller-context proof/u);
	});

	it('rejects caller context registration when a declared agent presents another agent work mount', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				callerContextProofKey: testCallerContextProofKey,
				payload: {
					adapterEvidence: {
						agentAuthority: signTestCallerContextAgentAuthority({
							agentId: 'second',
							agentWorkspaceDir: '/zone/agents/second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
							zoneId: 'shravan',
						}),
						agentId: 'second',
						agentWorkspaceDir: '/zone/agents/second',
						proof: signTestCallerContextProof({
							agentId: 'second',
							agentWorkspaceDir: '/zone/agents/second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
							zoneId: 'shravan',
						}),
						sessionKey: 'agent:second:test-session',
						workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
						zoneId: 'shravan',
					},
				},
				zone: multiAgentZone,
			}),
		).toThrow(/only .*second/u);
	});

	it('rejects caller context registration when a declared agent presents another agent /zone workspace', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				callerContextProofKey: testCallerContextProofKey,
				payload: {
					adapterEvidence: {
						agentAuthority: signTestCallerContextAgentAuthority({
							agentId: 'second',
							agentWorkspaceDir: '/zone/agents/second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/zone/agents/main',
							zoneId: 'shravan',
						}),
						agentId: 'second',
						agentWorkspaceDir: '/zone/agents/second',
						proof: signTestCallerContextProof({
							agentId: 'second',
							agentWorkspaceDir: '/zone/agents/second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/zone/agents/main',
							zoneId: 'shravan',
						}),
						sessionKey: 'agent:second:test-session',
						workMountDir: '/zone/agents/main',
						zoneId: 'shravan',
					},
				},
				zone: multiAgentZone,
			}),
		).toThrow(/\/zone\/agents\/second/u);
	});

	it('rejects caller context registration for ambiguous shared OpenClaw work mounts', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				callerContextProofKey: testCallerContextProofKey,
				payload: {
					adapterEvidence: {
						agentAuthority: signTestCallerContextAgentAuthority({
							agentId: 'second',
							agentWorkspaceDir: '/zone/agents/second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/workspace-main',
							zoneId: 'shravan',
						}),
						agentId: 'second',
						agentWorkspaceDir: '/zone/agents/second',
						proof: signTestCallerContextProof({
							agentId: 'second',
							agentWorkspaceDir: '/zone/agents/second',
							sessionKey: 'agent:second:test-session',
							workMountDir: '/home/openclaw/.openclaw/state/workspace-main',
							zoneId: 'shravan',
						}),
						sessionKey: 'agent:second:test-session',
						workMountDir: '/home/openclaw/.openclaw/state/workspace-main',
						zoneId: 'shravan',
					},
				},
				zone: multiAgentZone,
			}),
		).toThrow(/workspace-second/u);
	});

	it('coalesces bounded successor control-attempt outcomes into default operator output', async () => {
		const gatewayIdentity = createTestGatewayEpochIdentity('vm-successor-control-observation');
		const ownership = createTestVmOwnershipHarness(
			'vm-successor-control-observation',
			gatewayIdentity,
		);
		const { managedVm } = createHealthyGatewayVmStub('vm-successor-control-observation', 28_401);
		const initialProcessEpoch = 'process-initial-private-epoch';
		const successorProcessEpoch = 'process-successor-private-epoch';
		const initialMaterial = createGatewayControlSessionMaterial({
			agentIds: ['main'],
			bootId: gatewayIdentity.bootId,
			controllerEpoch: gatewayIdentity.controllerEpoch,
			generationId: gatewayIdentity.generationId,
			processEpoch: initialProcessEpoch,
			zoneId: gatewayIdentity.zoneId,
		});
		const rawConnectionId = '11111111-1111-4111-8111-111111111111';
		const rawSessionId = '22222222-2222-4222-8222-222222222222';
		const rawCredential = 'Bearer successor-private-credential';
		const rawTransportError = 'successor websocket exposed private failure detail';
		let controlConnectionCount = 0;
		const connectGatewayControlSession = vi.fn<GatewayControlSessionConnector>(
			async (connectOptions) => {
				controlConnectionCount += 1;
				if (controlConnectionCount === 2) {
					const attemptOutcomeWithForbiddenDetails = {
						attachmentGeneration: 2,
						credential: rawCredential,
						error: new Error(rawTransportError),
						kind: 'connect_error',
						connectionId: rawConnectionId,
						sessionId: rawSessionId,
					} as Parameters<NonNullable<typeof connectOptions.onAttemptOutcome>>[0];
					connectOptions.onAttemptOutcome?.(attemptOutcomeWithForbiddenDetails);
					connectOptions.onAttemptOutcome?.(attemptOutcomeWithForbiddenDetails);
				}
				return {
					...(await connectTestGatewayControlSession(connectOptions)),
					ready: Promise.resolve({
						attachmentGeneration: controlConnectionCount,
						connectionId: rawConnectionId,
						controllerEpoch: gatewayIdentity.controllerEpoch,
						outcome: 'accepted',
						sessionId: rawSessionId,
					}),
				};
			},
		);
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			const startOptions = {
				beginProcessEpochLoss: () => ({
					affectedLeaseIds: [],
					destroyAffectedLeases: async () => undefined,
				}),
				controlSession: { controllerEpoch: gatewayIdentity.controllerEpoch },
				createVmOwnership: ownership.createVmOwnership,
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: rawCredential,
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: gatewayIdentity.zoneId,
			};
			expect(startOptions).not.toHaveProperty('onControlSessionAttemptOutcome');
			const result = await startGatewayZone(startOptions, {
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'successor-control-observation-image',
					imagePath: '/tmp/successor-control-observation-image',
				})),
				connectGatewayControlSession,
				createGatewayControlSessionMaterial: () => initialMaterial,
				createManagedVm: vi.fn(async () => managedVm),
				createOpenClawProcessSupervisorPorts: ({ gateway }) => {
					const supervisor = createTestOpenClawProcessSupervisor(gateway);
					return {
						reliabilityFaultActuator: {
							terminateOwnedProcess: vi.fn(async () => {
								throw new Error('Operator-outcome test does not actuate process faults.');
							}),
						},
						supervisor: {
							...supervisor,
							contain: async (request) =>
								openClawProcessSupervisorReceiptSchema.parse({
									actionId: request.actionId,
									cgroup: {
										emptyObserved: true,
										name: 'successor-control-observation-cgroup',
										populated: false,
									},
									contractVersion: 1,
									expectedProcessEpoch: request.expectedProcessEpoch,
									gateway,
									kind: 'contain',
									observedProcessEpoch: request.expectedProcessEpoch,
									status: 'completed',
								}),
						},
					};
				},
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			});
			const processEpochOwner = result.openClawProcessEpochOwner;
			expect(processEpochOwner).toBeDefined();
			if (processEpochOwner === undefined) {
				throw new Error('Expected an OpenClaw process epoch owner.');
			}

			await processEpochOwner.replaceCurrentProcess({
				expectedProcessEpoch: initialProcessEpoch,
				selectSuccessorProcessEpoch: () => successorProcessEpoch,
			});

			const operatorOutcomeWrites = stderrWrite.mock.calls
				.map(([chunk]) => String(chunk))
				.filter((message) => message.includes('control attachment'));
			expect(operatorOutcomeWrites).toEqual([
				`[gateway-zone-orchestrator] control attachment for zone 'shravan' process '${successorProcessEpoch}': connect_error\n`,
			]);
			const operatorOutput = operatorOutcomeWrites.join('');
			expect(operatorOutput).not.toContain(rawCredential);
			expect(operatorOutput).not.toContain(rawTransportError);
			expect(operatorOutput).not.toContain(rawConnectionId);
			expect(operatorOutput).not.toContain(rawSessionId);
			expect(operatorOutput).not.toContain(initialProcessEpoch);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it.each([
		{
			entrypoint: 'controller-internal' as const,
			restorationFails: false,
			title: 'restores P2 material when the P3 runtime record fails',
		},
		{
			entrypoint: 'controller-internal' as const,
			restorationFails: true,
			title: 'preserves runtime and restoration failures',
		},
		{
			entrypoint: 'public' as const,
			restorationFails: false,
			title: 'keeps a hidden callback inert at the public runtime entrypoint',
		},
	])('$title', async ({ entrypoint, restorationFails }) => {
		const gatewayIdentity = createTestGatewayEpochIdentity('vm-process-owner');
		const ownership = createTestVmOwnershipHarness('vm-process-owner', gatewayIdentity);
		const { enableIngress, exec, managedVm } = createHealthyGatewayVmStub(
			'vm-process-owner',
			28_399,
		);
		const processEpochOne = 'process-epoch-1';
		const processEpochTwo = 'process-epoch-2';
		const processEpochThree = 'process-epoch-3';
		const initialMaterial = createGatewayControlSessionMaterial({
			agentIds: ['main'],
			bootId: gatewayIdentity.bootId,
			controllerEpoch: gatewayIdentity.controllerEpoch,
			generationId: gatewayIdentity.generationId,
			processEpoch: processEpochOne,
			zoneId: gatewayIdentity.zoneId,
		});
		const replacementOrder: string[] = [];
		const preparedHostStateProcessEpochs: string[] = [];
		const persistedMaterialEpochs: string[] = [];
		const runtimeRecordError = new Error('successor runtime record write failed');
		const materialRestorationError = new Error('previous material restoration failed');
		let rejectRuntimeRecord = false;
		let successorMaterialWriteObserved = false;
		const writeGatewayControlSessionMaterial = vi.fn(
			async (_runtimeDirectory: string, material: GatewayControlSessionMaterial) => {
				persistedMaterialEpochs.push(material.processEpoch);
				if (
					restorationFails &&
					successorMaterialWriteObserved &&
					material.processEpoch === processEpochTwo
				) {
					throw materialRestorationError;
				}
				if (material.processEpoch === processEpochThree) {
					successorMaterialWriteObserved = true;
				}
			},
		);
		const writeGatewayRuntimeRecord = vi.fn(async () => {
			if (rejectRuntimeRecord) {
				throw runtimeRecordError;
			}
		});
		const supervisorGateway = {
			controllerEpoch: gatewayIdentity.controllerEpoch,
			gatewayEpochId: gatewayIdentity.gatewayEpochId,
			gatewayVmId: gatewayIdentity.gatewayVmId,
		};
		let replacementExecCount = 0;
		let replacementStarted = false;
		exec.mockImplementation((command) => {
			if (replacementStarted) {
				replacementExecCount += 1;
				replacementOrder.push(
					replacementExecCount === 1
						? `exec-p2-config:${String(command)}`
						: `service-health:${String(command)}`,
				);
			}
			return createManagedExecProcessStub({ stdout: '200' });
		});
		let currentProcessEpoch: string | undefined;
		const processSupervisor: OpenClawProcessSupervisor = {
			contain: vi.fn<OpenClawProcessSupervisor['contain']>(async (request) => {
				replacementOrder.push(`contain:${request.expectedProcessEpoch}`);
				currentProcessEpoch = undefined;
				return openClawProcessSupervisorReceiptSchema.parse({
					actionId: request.actionId,
					cgroup: {
						emptyObserved: true,
						name: 'process-owner-cgroup',
						populated: false,
					},
					contractVersion: 1,
					expectedProcessEpoch: request.expectedProcessEpoch,
					gateway: supervisorGateway,
					kind: 'contain',
					observedProcessEpoch: request.expectedProcessEpoch,
					status: 'completed',
				});
			}),
			observe: vi.fn<OpenClawProcessSupervisor['observe']>(async (request) => {
				if (replacementStarted) {
					replacementOrder.push(`observe:${String(request.expectedProcessEpoch)}`);
				}
				return openClawProcessSupervisorReceiptSchema.parse({
					actionId: request.actionId,
					cgroup: { name: 'process-owner-cgroup', populated: true },
					contractVersion: 1,
					expectedProcessEpoch: request.expectedProcessEpoch,
					gateway: supervisorGateway,
					kind: 'observe',
					observedProcessEpoch: request.expectedProcessEpoch,
					status: 'completed',
				});
			}),
			start: vi.fn<OpenClawProcessSupervisor['start']>(async (request) => {
				currentProcessEpoch = request.selectedProcessEpoch;
				if (replacementStarted) {
					replacementOrder.push(
						`start:${String(request.expectedProcessEpoch)}->${request.selectedProcessEpoch}`,
					);
				}
				return openClawProcessSupervisorReceiptSchema.parse({
					actionId: request.actionId,
					cgroup: { name: 'process-owner-cgroup', populated: true },
					contractVersion: 1,
					expectedProcessEpoch: request.expectedProcessEpoch,
					gateway: supervisorGateway,
					kind: 'start',
					observedProcessEpoch: request.selectedProcessEpoch,
					status: 'completed',
				});
			}),
		};
		const connectedMaterials: GatewayControlSessionMaterial[] = [];
		const connectedDispatchers: unknown[] = [];
		const connectedFenceRegistries: unknown[] = [];
		const connectedStablePrincipalResolvers: unknown[] = [];
		const firstSessionClose = vi.fn(() => {
			replacementOrder.push('S1.close');
		});
		const connectGatewayControlSession = vi.fn<GatewayControlSessionConnector>(
			async (connectOptions) => {
				connectedMaterials.push(connectOptions.material);
				connectedDispatchers.push(connectOptions.dispatcher);
				connectedFenceRegistries.push(connectOptions.sessionFenceRegistry);
				connectedStablePrincipalResolvers.push(connectOptions.resolveInboundStablePrincipal);
				if (replacementStarted) {
					replacementOrder.push(`connect:${connectOptions.material.processEpoch}`);
				}
				const connectionOrdinal = connectedMaterials.length;
				return {
					...(await connectTestGatewayControlSession(connectOptions)),
					close: connectionOrdinal === 1 ? firstSessionClose : vi.fn(),
				};
			},
		);
		const destroyAffectedLeases = vi.fn(async () => {
			replacementOrder.push('destroy-affected-leases');
		});
		const beginProcessEpochLoss = vi.fn(() => {
			replacementOrder.push(
				`begin-process-loss:${gatewayIdentity.gatewayEpochId}:${processEpochOne}`,
			);
			return { affectedLeaseIds: ['lease-active'], destroyAffectedLeases };
		});
		const onOpenClawProcessReliabilityFaultTarget = vi.fn();
		const startOptions = {
			beginProcessEpochLoss,
			controlSession: { controllerEpoch: gatewayIdentity.controllerEpoch },
			createVmOwnership: ownership.createVmOwnership,
			onOpenClawProcessReliabilityFaultTarget,
			secretResolver: createOpenClawSecretResolver({
				DISCORD_BOT_TOKEN: 'discord-token',
				OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
				PERPLEXITY_API_KEY: 'pplx-key',
			}),
			systemConfig: await createSystemConfig(),
			zoneId: gatewayIdentity.zoneId,
		};
		const result = await startGatewayZone(
			startOptions,
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'process-owner-image',
					imagePath: '/tmp/process-owner-image',
				})),
				connectGatewayControlSession,
				createGatewayControlSessionMaterial: () => initialMaterial,
				createManagedVm: vi.fn(async () => managedVm),
				createOpenClawProcessSupervisorPorts: () => ({
					reliabilityFaultActuator: {
						terminateOwnedProcess: vi.fn(async () => {
							throw new Error('Process owner test did not expect reliability actuation.');
						}),
					},
					supervisor: processSupervisor,
				}),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				loadGatewayLifecycle: (gatewayType) => {
					const lifecycle = loadGatewayLifecycle(gatewayType);
					return {
						...lifecycle,
						prepareHostState: async (lifecycleZone, secretResolver) => {
							const gondolinPluginConfig = lifecycleZone.runtimePluginConfigs?.gondolin;
							const controlSessionConfig = isJsonRecord(gondolinPluginConfig)
								? gondolinPluginConfig.controlSession
								: undefined;
							if (
								!isJsonRecord(controlSessionConfig) ||
								typeof controlSessionConfig.processEpoch !== 'string'
							) {
								throw new Error('Expected bounded Gondolin control-session process epoch.');
							}
							preparedHostStateProcessEpochs.push(controlSessionConfig.processEpoch);
							if (replacementStarted) {
								replacementOrder.push(`prepare-host-state:${controlSessionConfig.processEpoch}`);
							}
							await lifecycle.prepareHostState?.(lifecycleZone, secretResolver);
						},
					};
				},
				writeGatewayControlSessionMaterial,
				writeGatewayRuntimeRecord,
			},
			entrypoint,
		);
		expect(currentProcessEpoch).toBe(processEpochOne);
		if (entrypoint === 'public') {
			expect(onOpenClawProcessReliabilityFaultTarget).not.toHaveBeenCalled();
		} else {
			expect(onOpenClawProcessReliabilityFaultTarget).toHaveBeenCalledExactlyOnceWith({
				controlSession: expect.objectContaining({
					close: expect.any(Function),
					emitApplicationMessage: expect.any(Function),
					fenceCurrentSession: expect.any(Function),
					getDiagnostics: expect.any(Function),
					ready: expect.any(Promise),
				}),
				gateway: gatewayIdentity,
				processEpoch: processEpochOne,
				reliabilityFaultActuator: expect.objectContaining({
					terminateOwnedProcess: expect.any(Function),
				}),
			});
		}
		const publicStartOptionsExposeReliabilityFaultTarget: 'onOpenClawProcessReliabilityFaultTarget' extends keyof StartGatewayZoneOptions
			? true
			: false = false;
		const publicRootExportsControllerStart: 'startGatewayZoneForController' extends keyof typeof import('../index.js')
			? true
			: false = false;
		expect(publicStartOptionsExposeReliabilityFaultTarget).toBe(false);
		expect(publicRootExportsControllerStart).toBe(false);
		expect(result).not.toHaveProperty('reliabilityFaultActuator');
		replacementOrder.splice(0);
		replacementStarted = true;
		const processEpochOwner = result.openClawProcessEpochOwner;
		expect(processEpochOwner).toBeDefined();
		if (processEpochOwner === undefined) {
			throw new Error('Expected an OpenClaw process epoch owner.');
		}

		await expect(
			processEpochOwner.replaceCurrentProcess({
				expectedProcessEpoch: 'stale-process-epoch',
				selectSuccessorProcessEpoch: vi
					.fn<() => string | undefined>()
					.mockReturnValueOnce(processEpochTwo),
			}),
		).rejects.toThrow(/expected.*current/iu);
		expect(replacementOrder).toEqual([]);

		const replacement = await processEpochOwner.replaceCurrentProcess({
			expectedProcessEpoch: processEpochOne,
			selectSuccessorProcessEpoch: vi
				.fn<() => string | undefined>()
				.mockReturnValueOnce(processEpochTwo),
		});
		replacementOrder.push(`published:${replacement.material.processEpoch}`);
		expect(preparedHostStateProcessEpochs).toEqual([processEpochOne, processEpochTwo]);

		expect(replacementOrder.map((event) => event.split(':', 1)[0])).toEqual([
			'begin-process-loss',
			'S1.close',
			'contain',
			'destroy-affected-leases',
			'prepare-host-state',
			'exec-p2-config',
			'start',
			'observe',
			'service-health',
			'connect',
			'published',
		]);
		expect(beginProcessEpochLoss).toHaveBeenCalledWith({
			ambiguousAtMs: expect.any(Number),
			gateway: gatewayIdentity,
			processEpoch: processEpochOne,
		});
		expect(enableIngress).toHaveBeenCalledOnce();
		expect(ownership.createVmOwnership).toHaveBeenCalledOnce();
		expect(connectedMaterials).toHaveLength(2);
		expect(connectedMaterials[1]).toEqual({
			...initialMaterial,
			processEpoch: processEpochTwo,
		});
		expect(connectedMaterials[1]?.privateKey).toBe(initialMaterial.privateKey);
		expect(connectedMaterials[1]?.agentAuthorityKeys).toBe(initialMaterial.agentAuthorityKeys);
		expect(connectedDispatchers[1]).not.toBe(connectedDispatchers[0]);
		expect(connectedFenceRegistries[1]).not.toBe(connectedFenceRegistries[0]);
		expect(connectedStablePrincipalResolvers).toEqual([expect.any(Function), expect.any(Function)]);
		expect(processEpochOwner.getCurrentBinding()).toBe(replacement);
		expect(replacement).toMatchObject({
			material: { processEpoch: processEpochTwo },
		});

		rejectRuntimeRecord = true;
		let persistenceError: unknown;
		try {
			await processEpochOwner.replaceCurrentProcess({
				expectedProcessEpoch: processEpochTwo,
				selectSuccessorProcessEpoch: vi
					.fn<() => string | undefined>()
					.mockReturnValueOnce(processEpochThree),
			});
		} catch (error) {
			persistenceError = error;
		}

		expect(persistedMaterialEpochs.slice(-2)).toEqual([processEpochThree, processEpochTwo]);
		expect(processEpochOwner.getCurrentBinding()).toBe(replacement);
		expect(persistenceError).toBeInstanceOf(Error);
		expect(persistenceError).toMatchObject({
			message: `OpenClaw successor process '${processEpochThree}' failed during phase 'persist-binding'.`,
		});
		expect((persistenceError as Error).message).not.toContain(runtimeRecordError.message);
		const persistenceCause = (persistenceError as Error).cause;
		if (restorationFails) {
			expect(persistenceCause).toBeInstanceOf(AggregateError);
			const aggregateError = persistenceCause as AggregateError;
			expect(aggregateError.errors).toEqual([runtimeRecordError, materialRestorationError]);
			expect(aggregateError.cause).toBe(runtimeRecordError);
		} else {
			expect(persistenceCause).toBe(runtimeRecordError);
		}
	});
});
