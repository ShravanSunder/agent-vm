import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
	ManagedVm,
	ManagedVmFactory,
	ManagedVmImageCapability,
	ManagedVmOwnedDirectoryCapability,
} from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../controller/durable-state/controller-state-paths.js';
import type { ControllerManagedGatewayRuntimeRecordTarget } from '../controller/durable-state/controller-state-record-paths.js';
import { resolveControllerGatewayRecordTargets } from '../controller/durable-state/controller-state-record-paths.js';
import { startControllerHttpServer } from '../controller/http/controller-http-server.js';
import type { GatewayVmLifecycleAuthority } from '../controller/vm-ownership/gateway-vm-lifecycle-authority.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import {
	deleteManagedGatewayRuntimeRecord,
	loadManagedGatewayRuntimeRecord,
	type ManagedGatewayRuntimeRecord,
	writeManagedGatewayRuntimeRecord,
} from '../gateway/gateway-runtime-record.js';
import type {
	GatewayZoneDestroyResult,
	ManagedGatewayZoneStartResult,
} from '../gateway/gateway-zone-support.js';
import { createManagedGatewayBootContract } from '../gateway/managed-gateway-boot-contract.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../testing/managed-vm-test-helpers.js';

const testManagedGatewayBootContract = createManagedGatewayBootContract({
	bootEntry: 'hermes-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'hermes',
	ingress: { guestPort: 18_789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/hermes-service.log',
		serviceName: 'agent-vm-hermes',
	},
	readiness: { guestPort: 18_789, kind: 'framework-http', path: '/health' },
	role: 'framework-service',
});

const testManagedGatewayImage = {
	built: true,
	fingerprint: 'gateway-image',
	imageReference: '/tmp/gateway-image',
};

function createFixtureGatewayDestroyer(options: {
	readonly destroyGatewayVm: () => Promise<void>;
	readonly runtimeRecordTarget: ControllerManagedGatewayRuntimeRecordTarget;
	readonly vmOwnership: GatewayVmLifecycleAuthority;
}): () => Promise<GatewayZoneDestroyResult> {
	let exactDestruction: Promise<void> | undefined;
	let exactDestructionComplete = false;
	let runtimeRecordDeleted = false;
	let destroyAttemptInFlight: Promise<GatewayZoneDestroyResult> | undefined;

	return (): Promise<GatewayZoneDestroyResult> => {
		if (destroyAttemptInFlight !== undefined) {
			return destroyAttemptInFlight;
		}
		const attempt = (async (): Promise<GatewayZoneDestroyResult> => {
			if (!exactDestructionComplete) {
				exactDestruction ??= options.vmOwnership.destroyLive(options.destroyGatewayVm);
				await exactDestruction;
				exactDestructionComplete = true;
			}
			if (runtimeRecordDeleted) {
				return { kind: 'destroyed-clean' };
			}
			try {
				await deleteManagedGatewayRuntimeRecord(options.runtimeRecordTarget);
				runtimeRecordDeleted = true;
				return { kind: 'destroyed-clean' };
			} catch (error) {
				return {
					cleanupFailures: [{ error, stage: 'runtime-record-deletion' }],
					kind: 'destroyed-cleanup-incomplete',
				};
			}
		})();
		const trackedAttempt = attempt.finally(() => {
			if (destroyAttemptInFlight === trackedAttempt) {
				destroyAttemptInFlight = undefined;
			}
		});
		destroyAttemptInFlight = trackedAttempt;
		return trackedAttempt;
	};
}

function createSystemConfig(
	controllerPort: number,
	storageRootDir: string,
	hermesConfigPath: string,
): LoadedSystemConfig {
	return {
		schemaVersion: 2,
		storageRootDir,
		cacheDir: path.join(path.dirname(storageRootDir), 'cache'),
		controllerRuntimeDir: path.join(storageRootDir, 'controller-runtime'),
		controllerStateDir: path.join(storageRootDir, 'controller-state'),
		systemConfigPath: path.join(storageRootDir, 'config', 'system.json'),
		host: {
			controllerPort,
			projectNamespace: 'controller-restart-tests-a1b2c3d4',
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
			},
		},
		imageProfiles: {
			gateways: {
				hermes: {
					type: 'hermes',
					buildConfig: './vm-images/gateways/hermes/build-config.jsonc',
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
				agents: [{ id: 'shravan' }],
				id: 'shravan',
				gateway: {
					type: 'hermes',
					profileSecretProjectionsByAgent: { shravan: {} },
					profilesByAgent: { shravan: 'shravan' },
					imageProfile: 'hermes',
					memory: '2G',
					cpus: 2,
					port: controllerPort + 100,
					config: hermesConfigPath,
					stateDir: path.join(storageRootDir, 'shravan', 'state'),
					zoneFilesDir: path.join(storageRootDir, 'shravan', 'zone-files'),
					zoneRuntimeDir: path.join(storageRootDir, 'shravan', 'runtime'),
				},
				secrets: {},
				egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
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
	};
}

async function startManagedVmStub(): Promise<void> {}

function createManagedGatewayExpectedCohort(options: {
	readonly configuredAgentIds: readonly string[];
	readonly gatewayIdentity: GatewayEpochIdentity;
}): ManagedGatewayRuntimeRecord['expectedCohort'] {
	const identitySuffix = `${options.gatewayIdentity.zoneId}:${options.gatewayIdentity.generationId}`;
	const frameworkEpoch = `hermes-framework:${options.gatewayIdentity.bootId}`;
	const processEpoch = `tool-portal-process:${options.gatewayIdentity.bootId}`;
	const runtimeEpoch = `tool-portal-runtime:${options.gatewayIdentity.generationId}`;
	return {
		controlIdentity: {
			controllerEpoch: options.gatewayIdentity.controllerEpoch,
			generationId: options.gatewayIdentity.generationId,
			peerId: `tool-portal-control:${options.gatewayIdentity.zoneId}`,
			processEpoch,
		},
		fence: {
			controllerEpoch: options.gatewayIdentity.controllerEpoch,
			gatewayEpoch: options.gatewayIdentity.generationId,
			vmId: options.gatewayIdentity.gatewayVmId,
			zoneId: options.gatewayIdentity.zoneId,
		},
		frameworkIdentity: {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: options.configuredAgentIds,
			frameworkEpoch,
			frameworkKind: 'hermes',
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		},
		ingressIntent: {
			controlRoute: {
				audience: 'gateway-control',
				guestPort: 18_790,
				kind: 'tool-portal-control',
				prefix: '/__agent-vm',
				stripPrefix: false,
			},
			frameworkRootRoute: {
				guestPort: 18_789,
				kind: 'framework-root',
				prefix: '/',
				stripPrefix: true,
			},
		},
		providerRevision: `provider:${identitySuffix}`,
		requiredBackendRevision: `required-backends:${identitySuffix}`,
		semanticRevision: `semantic:${identitySuffix}`,
		toolPortalIdentity: {
			processEpoch,
			role: 'tool-portal',
			runtimeEpoch,
			serviceId: `tool-portal-service:${identitySuffix}`,
		},
		udsIdentity: {
			frameworkEpoch,
			gatewayEpoch: options.gatewayIdentity.generationId,
			runtimeEpoch,
			socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
		},
	};
}

async function enableIngressStub(): Promise<{
	close(): Promise<void>;
	readonly host: string;
	readonly port: number;
}> {
	return { close: async () => {}, host: '127.0.0.1', port: 18_791 };
}

function setIngressRoutesStub(): void {}

async function createGatewayVmMock(
	stateDirectory: string,
	vmOwnership: GatewayVmLifecycleAuthority,
): Promise<ManagedVm> {
	const vmId = `gateway-${vmOwnership.gatewaySeed.gatewayEpochId}`;
	let hostPid: number | null = 28_000;
	const close = async (): Promise<void> => {
		hostPid = null;
	};
	const start = startManagedVmStub;
	const enableIngress = enableIngressStub;
	const enableSsh: ManagedVm['enableSsh'] = async () => ({
		close: async () => {},
		command: 'ssh -i /tmp/gateway-key root@127.0.0.1 -p 19000',
		host: '127.0.0.1',
		identityFile: '/tmp/gateway-key',
		port: 19_000,
		serverHostKey: TEST_SSH_SERVER_HOST_KEY,
		user: 'root',
	});
	const exec: ManagedVm['exec'] = (command: string) => {
		if (command === 'write-state persistence.txt persistent-value') {
			fs.writeFileSync(path.join(stateDirectory, 'persistence.txt'), 'persistent-value', 'utf8');
			return createManagedExecProcessStub();
		}

		if (command === 'read-state persistence.txt') {
			return createManagedExecProcessStub({
				stdout: fs.readFileSync(path.join(stateDirectory, 'persistence.txt'), 'utf8'),
			});
		}

		if (command.includes('cat /agent-vm/logs/gateway-boot-latest.log')) {
			return createManagedExecProcessStub({ stdout: 'gateway-log' });
		}

		return createManagedExecProcessStub();
	};
	const gatewayVm: ManagedVm = {
		close,
		configureIngressRoutes: setIngressRoutesStub,
		enableIngress,
		enableSsh,
		exec,
		getHostProcessId: () => hostPid,
		id: vmId,
		start,
	};
	vmOwnership.attachGatewayVm(vmId);
	return gatewayVm;
}

function createToolVmMock(identityFile: string): ManagedVm {
	let hostPid: number | null = 28_100;
	const close = async (): Promise<void> => {
		hostPid = null;
	};
	const start = startManagedVmStub;
	const enableIngress = enableIngressStub;
	const enableSsh: ManagedVm['enableSsh'] = async () => ({
		close: async () => {},
		command: 'ssh -i /tmp/tool-key sandbox@127.0.0.1 -p 19000',
		host: '127.0.0.1',
		identityFile,
		port: 19_000,
		serverHostKey: TEST_SSH_SERVER_HOST_KEY,
		user: 'sandbox',
	});
	const exec: ManagedVm['exec'] = () => createManagedExecProcessStub();
	const toolVm: ManagedVm = {
		close,
		configureIngressRoutes: setIngressRoutesStub,
		enableIngress,
		enableSsh,
		exec,
		getHostProcessId: () => hostPid,
		id: 'tool-vm-live-restart',
		start,
	};
	return toolVm;
}

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

describe('live integration: controller restart persistence', () => {
	it('preserves state and recreates managed Gateway ownership across controller restart', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-restart-live-'));
		createdDirectories.push(tempDirectory);

		const stateDirectory = path.join(tempDirectory, 'shravan', 'state');
		const zoneFilesDirectory = path.join(tempDirectory, 'shravan', 'zone-files');
		const zoneLeaseDirectory = path.join(zoneFilesDirectory, 'restart-work');
		const hermesConfigPath = path.join(
			tempDirectory,
			'config',
			'gateways',
			'shravan',
			'hermes-managed',
			'config.yaml',
		);
		fs.mkdirSync(stateDirectory, { recursive: true });
		fs.mkdirSync(zoneLeaseDirectory, { recursive: true });
		fs.mkdirSync(path.dirname(hermesConfigPath), { recursive: true });
		fs.writeFileSync(
			hermesConfigPath,
			'plugins:\n  enabled:\n    - agent-vm-tool-portal\n  disabled: []\n',
			'utf8',
		);

		const controllerPort = 18841;
		const systemConfig = createSystemConfig(controllerPort, tempDirectory, hermesConfigPath);
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected restart test zone.');
		}
		const controllerRecordTargets = resolveControllerGatewayRecordTargets({
			gatewayStateRoot: resolveControllerGatewayStateRoot({
				controllerStateRoot: createControllerStateRoot({
					controllerStateDirectoryPath: systemConfig.controllerStateDir,
				}),
				zoneId: zone.id,
			}),
		});

		let currentServerClosed: Promise<void> | undefined;
		let gatewayStartOrdinal = 0;
		const gatewayVmIds: string[] = [];
		const startRuntime = async (): ReturnType<typeof startControllerRuntime> =>
			await startControllerRuntime(
				{
					systemConfig,
					zoneIds: ['shravan'],
				},
				{
					configureManagedVmHostNetworkDefaults: () => ({
						autoSelectFamily: false,
						dnsResultOrder: 'ipv4first',
					}),
					createManagedToolVm: vi.fn(async () =>
						createToolVmMock(path.join(tempDirectory, 'tool-vm-identity')),
					),
					managedVmFactory: {
						createManagedVm: async () => {
							throw new Error('Restart persistence test injects its gateway and Tool VM doubles.');
						},
					} satisfies ManagedVmFactory,
					managedVmExactProcessTermination: {
						terminateRecordedHostProcess: async (request) => ({
							hostProcessId: request.identity.hostProcessId,
							kind: 'terminated',
						}),
					},
					managedVmImages: {
						prepareImage: async () => ({
							built: false,
							fingerprint: 'restart-persistence-test-image',
							imageReference: '/tmp/restart-persistence-test-image',
						}),
					} satisfies ManagedVmImageCapability,
					managedVmOwnedDirectories: {
						openHostDirectory: () => {
							throw new Error('Restart persistence test injects its Tool VM double.');
						},
					} satisfies ManagedVmOwnedDirectoryCapability,
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					isProcessAlive: () => true,
					readProcessIdentity: async () => ({
						command: 'qemu-system-aarch64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					readIdentityPem: async () => 'pem',
					setTimeoutImpl: (callback) => {
						queueMicrotask(callback);
						return {} as NodeJS.Timeout;
					},
					startHttpServer: async (startHttpServerOptions) => {
						let resolveServerClosed: () => void;
						let rejectServerClosed: (error: unknown) => void;
						let serverClosed = false;
						currentServerClosed = new Promise<void>((resolve, reject) => {
							resolveServerClosed = resolve;
							rejectServerClosed = reject;
						});
						const server = await startControllerHttpServer(startHttpServerOptions);
						return {
							close: async () => {
								if (serverClosed) {
									return;
								}
								try {
									await server.close();
									serverClosed = true;
									resolveServerClosed();
								} catch (error) {
									rejectServerClosed(error);
									throw error;
								}
							},
						};
					},
					startGatewayZone: vi.fn(async (startOptions) => {
						gatewayStartOrdinal += 1;
						const vmOwnership = await startOptions.createVmOwnership({
							controlIdentity: {
								bootId: `controller-restart-gateway-boot-${gatewayStartOrdinal}`,
								generationId: `controller-restart-gateway-generation-${gatewayStartOrdinal}`,
							},
							kind: 'gateway-epoch',
							sessionLabel: `controller-restart-gateway-${gatewayStartOrdinal}`,
							zoneId: zone.id,
						});
						const gatewayVm = await createGatewayVmMock(stateDirectory, vmOwnership);
						await gatewayVm.start();
						const gatewayIdentity = vmOwnership.gatewayIdentity;
						if (gatewayIdentity === undefined) {
							throw new Error('Expected attached Gateway identity before runtime publication.');
						}
						const expectedCohort = createManagedGatewayExpectedCohort({
							configuredAgentIds: ['shravan'],
							gatewayIdentity,
						});
						const qemuPid = gatewayVm.getHostProcessId() ?? 28_000;
						const processIdentity = {
							command: 'qemu-system-aarch64 -m 1G',
							lstart: 'Fri May 22 10:00:00 2026',
						};
						await writeManagedGatewayRuntimeRecord(
							controllerRecordTargets.managedGatewayRuntimeRecord,
							{
								appliedIngressRoutes: [
									{ ...expectedCohort.ingressIntent.controlRoute, guestPort: 18_790 },
									expectedCohort.ingressIntent.frameworkRootRoute,
								],
								bootContract: testManagedGatewayBootContract,
								configPath: systemConfig.systemConfigPath,
								controllerPort: systemConfig.host.controllerPort,
								createdAt: new Date().toISOString(),
								expectedCohort,
								gateway: gatewayIdentity,
								image: testManagedGatewayImage,
								ingressPort: 18_791,
								processIdentity,
								processTarget: {
									hostPid: qemuPid,
									processIdentity,
									vmId: gatewayVm.id,
								},
								projectNamespace: systemConfig.host.projectNamespace,
								qemuPid,
								runtimeKind: 'managed-gateway',
								schemaVersion: 4,
								sessionLabel: `${systemConfig.host.projectNamespace}:${zone.id}:gateway`,
								vmId: gatewayVm.id,
								zoneId: zone.id,
							},
						);
						gatewayVmIds.push(gatewayVm.id);
						return {
							bootContract: testManagedGatewayBootContract,
							destroyGateway: createFixtureGatewayDestroyer({
								destroyGatewayVm: async () => {
									await gatewayVm.close();
								},
								runtimeRecordTarget: controllerRecordTargets.managedGatewayRuntimeRecord,
								vmOwnership,
							}),
							executionModel: 'managed-gateway',
							expectedCohort,
							gatewayIdentity,
							image: testManagedGatewayImage,
							ingress: {
								host: '127.0.0.1',
								port: 18791,
							},
							vm: gatewayVm,
							zone,
						} satisfies ManagedGatewayZoneStartResult;
					}),
				},
			);

		const runtime = await startRuntime();

		const writeResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/shravan/execute-command`,
			{
				body: JSON.stringify({ command: 'write-state persistence.txt persistent-value' }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
		);
		expect(await writeResponse.json()).toMatchObject({
			exitCode: 0,
			stderr: '',
			stdout: '',
		});
		await expect(
			loadManagedGatewayRuntimeRecord(controllerRecordTargets.managedGatewayRuntimeRecord),
		).resolves.toMatchObject({
			runtimeKind: 'managed-gateway',
			schemaVersion: 4,
			vmId: gatewayVmIds[0],
		});

		const stopResponse = await fetch(`http://127.0.0.1:${controllerPort}/stop-controller`, {
			method: 'POST',
		});
		expect(stopResponse.status).toBe(200);

		if (currentServerClosed === undefined) {
			throw new Error('Expected controller server close promise to be captured.');
		}
		await currentServerClosed;
		await runtime.close();
		await expect(fetch(`http://127.0.0.1:${String(controllerPort)}/health`)).rejects.toThrow();
		await expect(
			loadManagedGatewayRuntimeRecord(controllerRecordTargets.managedGatewayRuntimeRecord),
		).resolves.toBeNull();

		const restartedRuntime = await startRuntime();
		expect(gatewayVmIds).toHaveLength(2);
		expect(gatewayVmIds[1]).not.toBe(gatewayVmIds[0]);
		await expect(
			loadManagedGatewayRuntimeRecord(controllerRecordTargets.managedGatewayRuntimeRecord),
		).resolves.toMatchObject({
			runtimeKind: 'managed-gateway',
			schemaVersion: 4,
			vmId: gatewayVmIds[1],
		});

		const readResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/shravan/execute-command`,
			{
				body: JSON.stringify({ command: 'read-state persistence.txt' }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
		);
		expect(readResponse.status).toBe(200);
		const readBody = (await readResponse.json()) as {
			readonly stdout: string;
		};
		expect(readBody.stdout).toBe('persistent-value');

		const leasesResponse = await fetch(`http://127.0.0.1:${controllerPort}/leases`);
		expect(leasesResponse.status).toBe(404);

		const createLeaseResponse = await fetch(`http://127.0.0.1:${controllerPort}/lease`, {
			body: JSON.stringify({
				agentId: 'restart-test',
				agentWorkspaceDir: '/zone',
				profileId: 'standard',
				sessionKey: 'agent:restart-test:integration',
				workMountDir: '/zone/restart-work',
				zoneId: 'shravan',
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		expect(createLeaseResponse.status).toBe(404);

		await restartedRuntime.close();
		await expect(
			loadManagedGatewayRuntimeRecord(controllerRecordTargets.managedGatewayRuntimeRecord),
		).resolves.toBeNull();
	});
});
