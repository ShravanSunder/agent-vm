import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createManagedVm, type ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import {
	buildToolVmRuntimeRecord,
	loadToolVmRuntimeRecord,
	writeToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import {
	buildGatewayRuntimeRecord,
	loadGatewayRuntimeRecord,
	writeGatewayRuntimeRecord,
} from '../gateway/gateway-runtime-record.js';
import { runControllerOfflineCleanup } from '../operations/controller-offline-cleanup.js';
import { isProcessAlive } from '../shared/managed-vm-process.js';
import {
	captureManagedVmTermination,
	type CapturedManagedVmTermination,
} from '../testing/managed-vm-test-helpers.js';
import { waitForProtocolRetryInterval, withProtocolDeadline } from './e2e-protocol-wait.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const describeLiveVmE2e = shouldRunLiveVmE2e() ? describe : describe.skip;
const zoneId = 'ownership-restart';

interface TestDeployment {
	readonly rootDirectory: string;
	readonly stateDirectory: string;
	readonly systemConfig: LoadedSystemConfig;
}

const temporaryDeploymentRoots: string[] = [];
const managedVmTerminationsForHarnessCleanup: CapturedManagedVmTermination[] = [];

function createTestSystemConfig(options: {
	readonly rootDirectory: string;
	readonly stateDirectory: string;
}): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			cacheDir: path.join(options.rootDirectory, 'cache'),
			host: {
				controllerPort: 18_841,
				projectNamespace: 'ownership-restart-e2e',
			},
			imageProfiles: {
				gateways: {
					openclaw: {
						buildConfig: './vm-images/gateways/openclaw/build-config.jsonc',
						source: { base: 'openclaw-gateway', kind: 'managedBase' },
						type: 'openclaw',
					},
				},
				toolVms: {
					default: {
						buildConfig: './vm-images/tool-vms/default/build-config.jsonc',
						source: { base: 'tool-vm', kind: 'managedBase' },
						type: 'toolVm',
					},
				},
			},
			runtimeDir: path.join(options.rootDirectory, 'runtime'),
			schemaVersion: 1,
			tcpPool: { basePort: 29_000, size: 8 },
			toolVmProfiles: {
				default: { cpus: 1, imageProfile: 'default', memory: '512M' },
			},
			zones: [
				{
					agents: [{ id: 'current-agent' }, { id: 'second-agent' }],
					agentToolVmProfiles: {},
					defaultToolVmProfile: 'default',
					egressHosts: [{ audience: 'gateway', host: 'api.openai.com' }],
					gateway: {
						config: path.join(options.rootDirectory, 'config', 'openclaw.json'),
						controlAuth: {
							mode: 'token',
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
						cpus: 1,
						imageProfile: 'openclaw',
						memory: '512M',
						port: 28_891,
						stateDir: options.stateDirectory,
						type: 'openclaw',
						zoneFilesDir: path.join(options.rootDirectory, 'zone-files'),
					},
					id: zoneId,
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							audience: 'gateway',
							envVar: 'OPENCLAW_GATEWAY_TOKEN',
							injection: 'env',
							source: 'environment',
						},
					},
				},
			],
		},
		{
			systemConfigPath: path.join(
				options.rootDirectory,
				'nested-deployment-segment'.repeat(8),
				'config',
				'system.json',
			),
		},
	);
}

async function createTestDeployment(): Promise<TestDeployment> {
	const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-own-'));
	const stateDirectory = path.join(rootDirectory, 'state');
	return {
		rootDirectory,
		stateDirectory,
		systemConfig: createTestSystemConfig({ rootDirectory, stateDirectory }),
	};
}

async function createStartedRealVm(sessionLabel: string): Promise<ManagedVm> {
	const managedVm = await createManagedVm({
		allowedHosts: [],
		cpus: 1,
		imagePath: '',
		memory: '512M',
		rootfsMode: 'memory',
		secrets: {},
		sessionLabel,
		vfsMounts: {},
	});
	await managedVm.start();
	managedVmTerminationsForHarnessCleanup.push(await captureManagedVmTermination(managedVm));
	return managedVm;
}

function createGatewayIdentity(gatewayVm: ManagedVm): GatewayEpochIdentity {
	return {
		bootId: 'gateway-boot-before-restart',
		controllerEpoch: 'controller-epoch-before-restart',
		gatewayEpochId: randomUUID(),
		gatewayVmId: gatewayVm.id,
		generationId: 'gateway-generation-before-restart',
		zoneId,
	};
}

async function persistGatewayRuntime(options: {
	readonly deployment: TestDeployment;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly gatewayVm: ManagedVm;
}): Promise<void> {
	await writeGatewayRuntimeRecord(
		options.deployment.stateDirectory,
		await buildGatewayRuntimeRecord({
			controllerPort: options.deployment.systemConfig.host.controllerPort,
			gatewayIdentity: options.gatewayIdentity,
			gatewayType: 'openclaw',
			managedVm: options.gatewayVm,
			processSpec: {
				bootstrapCommand: 'true',
				guestListenPort: 18_789,
				healthCheck: { command: 'true', type: 'command' },
				logPath: '/tmp/controller-restart-e2e.log',
				startCommand: 'true',
			},
			projectNamespace: options.deployment.systemConfig.host.projectNamespace,
			systemConfigPath: options.deployment.systemConfig.systemConfigPath,
			zoneId,
		}),
	);
}

async function persistToolRuntime(options: {
	readonly agentId: string;
	readonly deployment: TestDeployment;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly recordId: string;
	readonly tcpSlot: number;
	readonly toolVm: ManagedVm;
}): Promise<void> {
	await writeToolVmRuntimeRecord(
		options.deployment.stateDirectory,
		await buildToolVmRuntimeRecord({
			agentId: options.agentId,
			controllerPort: options.deployment.systemConfig.host.controllerPort,
			gatewayIdentity: options.gatewayIdentity,
			leaseId: `lease-${options.agentId}`,
			managedVm: options.toolVm,
			projectNamespace: options.deployment.systemConfig.host.projectNamespace,
			recordId: options.recordId,
			systemConfigPath: options.deployment.systemConfig.systemConfigPath,
			tcpSlot: options.tcpSlot,
			zoneId,
		}),
	);
}

async function assertVmMarker(managedVm: ManagedVm, marker: string): Promise<void> {
	await expect(managedVm.exec(`printf '${marker}'`)).resolves.toMatchObject({
		exitCode: 0,
		stdout: marker,
	});
}

async function waitForOldTreeAbsence(options: {
	readonly gatewayPid: number;
	readonly toolPids: readonly [number, number];
}): Promise<void> {
	for (;;) {
		const toolPidLiveness = options.toolPids.map((pid) => isProcessAlive(pid));
		if (!isProcessAlive(options.gatewayPid)) {
			expect(toolPidLiveness).toEqual([false, false]);
			return;
		}
		// oxlint-disable-next-line no-await-in-loop -- no process event source exists; the named bounded protocol interval prevents a busy host-process probe.
		await waitForProtocolRetryInterval(10);
	}
}

afterEach(async () => {
	const cleanupResults = await Promise.allSettled(
		managedVmTerminationsForHarnessCleanup
			.splice(0)
			.map(async (termination) => await termination.terminate()),
	);
	await Promise.all(
		temporaryDeploymentRoots
			.splice(0)
			.map(async (rootDirectory) => await rm(rootDirectory, { force: true, recursive: true })),
	);
	const cleanupErrors = cleanupResults.flatMap((result) =>
		result.status === 'rejected' ? [result.reason as unknown] : [],
	);
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, 'real VM controller-restart harness cleanup failed');
	}
});

describeLiveVmE2e('live e2e: controller restart runtime-record ownership', () => {
	it('restarts through the controller front door after destroying the recorded old tree', async () => {
		const deployment = await createTestDeployment();
		temporaryDeploymentRoots.push(deployment.rootDirectory);
		const zone = deployment.systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected one OpenClaw restart test zone.');
		}
		const gatewayVm = await createStartedRealVm('gateway-before-controller-restart');
		const firstToolVm = await createStartedRealVm('first-tool-before-controller-restart');
		const secondToolVm = await createStartedRealVm('second-tool-before-controller-restart');
		const unrelatedVm = await createStartedRealVm('unrelated-sibling-must-survive');
		const gatewayIdentity = createGatewayIdentity(gatewayVm);
		const firstToolRecordId = randomUUID();
		const secondToolRecordId = randomUUID();

		await Promise.all([
			persistToolRuntime({
				agentId: 'current-agent',
				deployment,
				gatewayIdentity,
				recordId: firstToolRecordId,
				tcpSlot: 0,
				toolVm: firstToolVm,
			}),
			persistToolRuntime({
				agentId: 'second-agent',
				deployment,
				gatewayIdentity,
				recordId: secondToolRecordId,
				tcpSlot: 1,
				toolVm: secondToolVm,
			}),
			persistGatewayRuntime({ deployment, gatewayIdentity, gatewayVm }),
		]);
		await Promise.all([
			assertVmMarker(gatewayVm, 'gateway-live'),
			assertVmMarker(firstToolVm, 'first-tool-live'),
			assertVmMarker(secondToolVm, 'second-tool-live'),
			assertVmMarker(unrelatedVm, 'unrelated-live-before'),
		]);
		const gatewayPid = gatewayVm.getHostPid();
		const firstToolPid = firstToolVm.getHostPid();
		const secondToolPid = secondToolVm.getHostPid();
		if (gatewayPid === null || firstToolPid === null || secondToolPid === null) {
			throw new Error('Expected the recorded old Gateway and Tool VM host processes to be live.');
		}
		expect([gatewayPid, firstToolPid, secondToolPid].every(isProcessAlive)).toBe(true);
		const oldTreeAbsence = withProtocolDeadline(
			waitForOldTreeAbsence({
				gatewayPid,
				toolPids: [firstToolPid, secondToolPid],
			}),
			'controller startup recorded VM tree reconciliation',
			120_000,
		);
		let successorGatewayIdentity: GatewayEpochIdentity | undefined;
		let successorGatewayVm: ManagedVm | undefined;
		let successorGatewayTermination: CapturedManagedVmTermination | undefined;
		let runtime: Awaited<ReturnType<typeof startControllerRuntime>> | undefined;

		try {
			runtime = await startControllerRuntime(
				{ systemConfig: deployment.systemConfig, zoneIds: [zoneId] },
				{
					controllerEpoch: 'controller-epoch-after-restart',
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					preflightGatewayZoneStart: async (startOptions) => ({
						image: {
							built: false,
							fingerprint: 'controller-restart-successor',
							imagePath: '',
						},
						secretResolver: startOptions.secretResolver,
					}),
					startGatewayZone: async (startOptions) => {
						await oldTreeAbsence;
						await expect(
							loadToolVmRuntimeRecord(deployment.stateDirectory, firstToolRecordId),
						).resolves.toBeNull();
						await expect(
							loadToolVmRuntimeRecord(deployment.stateDirectory, secondToolRecordId),
						).resolves.toBeNull();
						await expect(loadGatewayRuntimeRecord(deployment.stateDirectory)).resolves.toBeNull();
						await assertVmMarker(unrelatedVm, 'unrelated-live-before-successor');

						const vmOwnership = await startOptions.createVmOwnership({
							controlIdentity: {
								bootId: 'gateway-boot-after-restart',
								generationId: 'gateway-generation-after-restart',
							},
							kind: 'gateway-epoch',
							sessionLabel: 'gateway-after-controller-restart',
							zoneId,
						});
						successorGatewayVm = await createManagedVm({
							allowedHosts: [],
							cpus: 1,
							imagePath: '',
							memory: '512M',
							rootfsMode: 'memory',
							secrets: {},
							sessionLabel: 'gateway-after-controller-restart',
							vfsMounts: {},
						});
						vmOwnership.attachGatewayVm(successorGatewayVm.id);
						await successorGatewayVm.start();
						successorGatewayTermination = await captureManagedVmTermination(successorGatewayVm);
						managedVmTerminationsForHarnessCleanup.push(successorGatewayTermination);
						successorGatewayIdentity = vmOwnership.gatewayIdentity;
						if (successorGatewayIdentity === undefined) {
							throw new Error('Expected attached successor Gateway identity before publication.');
						}
						await persistGatewayRuntime({
							deployment,
							gatewayIdentity: successorGatewayIdentity,
							gatewayVm: successorGatewayVm,
						});
						return {
							image: {
								built: false,
								fingerprint: 'controller-restart-successor',
								imagePath: '',
							},
							ingress: { host: '127.0.0.1', port: 28_891 },
							processSpec: {
								bootstrapCommand: 'true',
								guestListenPort: 18_789,
								healthCheck: { command: 'true', type: 'command' },
								logPath: '/tmp/controller-restart-e2e.log',
								startCommand: 'true',
							},
							terminateVm: async () => {
								await successorGatewayTermination?.terminate();
							},
							vm: successorGatewayVm,
							vmOwnership,
							zone,
						};
					},
					startHttpServer: async () => ({ close: async () => {} }),
				},
			);

			expect(successorGatewayVm).toBeDefined();
			expect(successorGatewayIdentity).toMatchObject({
				controllerEpoch: 'controller-epoch-after-restart',
				zoneId,
			});
			expect(successorGatewayIdentity?.gatewayVmId).not.toBe(gatewayVm.id);
			expect(runtime.zones).toEqual([
				expect.objectContaining({ lifecycleState: 'running', zoneId }),
			]);
			await expect(loadGatewayRuntimeRecord(deployment.stateDirectory)).resolves.toMatchObject({
				vmId: successorGatewayIdentity?.gatewayVmId,
			});
			await assertVmMarker(unrelatedVm, 'unrelated-live-after-successor');
			if (successorGatewayVm !== undefined) {
				await assertVmMarker(successorGatewayVm, 'successor-live');
			}
		} finally {
			await runtime?.close();
		}

		await expect(loadGatewayRuntimeRecord(deployment.stateDirectory)).resolves.toBeNull();
	}, 180_000);

	it('fails closed on changed Tool process identity and leaves the Gateway untouched', async () => {
		const deployment = await createTestDeployment();
		temporaryDeploymentRoots.push(deployment.rootDirectory);
		const gatewayVm = await createStartedRealVm('gateway-before-identity-mismatch');
		const toolVm = await createStartedRealVm('tool-before-identity-mismatch');
		const gatewayIdentity = createGatewayIdentity(gatewayVm);
		const toolRecordId = randomUUID();
		const toolRecord = await buildToolVmRuntimeRecord({
			agentId: 'current-agent',
			controllerPort: deployment.systemConfig.host.controllerPort,
			gatewayIdentity,
			leaseId: 'lease-identity-mismatch',
			managedVm: toolVm,
			projectNamespace: deployment.systemConfig.host.projectNamespace,
			recordId: toolRecordId,
			systemConfigPath: deployment.systemConfig.systemConfigPath,
			tcpSlot: 0,
			zoneId,
		});
		await writeToolVmRuntimeRecord(deployment.stateDirectory, {
			...toolRecord,
			processIdentity: {
				...toolRecord.processIdentity,
				lstart: 'Thu Jan 01 00:00:00 1970',
			},
		});
		await persistGatewayRuntime({ deployment, gatewayIdentity, gatewayVm });
		const gatewayPid = gatewayVm.getHostPid();
		const toolPid = toolVm.getHostPid();
		if (gatewayPid === null || toolPid === null) {
			throw new Error('Expected live Gateway and Tool VM host processes.');
		}

		await expect(
			runControllerOfflineCleanup({
				force: true,
				systemConfig: deployment.systemConfig,
				zoneId,
			}),
		).rejects.toThrow(/process identity changed/u);

		expect(isProcessAlive(toolPid)).toBe(true);
		expect(isProcessAlive(gatewayPid)).toBe(true);
		await expect(
			loadToolVmRuntimeRecord(deployment.stateDirectory, toolRecordId),
		).resolves.toMatchObject({
			vmId: toolVm.id,
		});
		await expect(loadGatewayRuntimeRecord(deployment.stateDirectory)).resolves.toMatchObject({
			vmId: gatewayVm.id,
		});
		await Promise.all([
			assertVmMarker(toolVm, 'tool-still-live'),
			assertVmMarker(gatewayVm, 'gateway-still-live'),
		]);
	}, 180_000);
});
