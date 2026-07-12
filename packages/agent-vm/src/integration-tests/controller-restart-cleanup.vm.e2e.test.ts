import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createManagedVm, type ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import {
	buildToolVmRuntimeRecord,
	loadToolVmRuntimeRecord,
	type ToolVmRuntimeRecord,
	writeToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import {
	buildGatewayRuntimeRecord,
	loadGatewayRuntimeRecord,
	type GatewayRuntimeRecord,
	writeGatewayRuntimeRecord,
} from '../gateway/gateway-runtime-record.js';
import { runControllerOfflineCleanup } from '../operations/controller-offline-cleanup.js';
import { isProcessAlive } from '../shared/managed-vm-process.js';
import {
	captureManagedVmTermination,
	type CapturedManagedVmTermination,
} from '../testing/managed-vm-test-helpers.js';
import {
	expectedControlLeaseReliabilityEvidenceWriteKind,
	hashControlLeaseReliabilityArtifact,
	writeControlLeaseReliabilityEvidence,
} from './control-lease-reliability-evidence.js';
import { waitForProtocolRetryInterval, withProtocolDeadline } from './e2e-protocol-wait.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const describeLiveVmE2e = shouldRunLiveVmE2e() ? describe : describe.skip;
const reliabilityOperationId = 'controller-restart-cleanup';
const zoneId = 'controller-restart-cleanup';

interface TestDeployment {
	readonly rootDirectory: string;
	readonly stateDirectory: string;
	readonly systemConfig: LoadedSystemConfig;
}

const temporaryDeploymentRoots: string[] = [];
const managedVmTerminationsForHarnessCleanup: CapturedManagedVmTermination[] = [];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireDefined<TValue>(value: TValue | undefined, message: string): TValue {
	if (value === undefined) {
		throw new Error(message);
	}
	return value;
}

function createTestSystemConfig(options: {
	readonly rootDirectory: string;
	readonly stateDirectory: string;
}): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			cacheDir: path.join(options.rootDirectory, 'cache'),
			host: {
				controllerPort: 18_842,
				projectNamespace: 'controller-restart-cleanup-e2e',
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
			tcpPool: { basePort: 29_010, size: 8 },
			toolVmProfiles: {
				default: { cpus: 1, imageProfile: 'default', memory: '512M' },
			},
			zones: [
				{
					agents: [{ id: 'first-agent' }, { id: 'second-agent' }],
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
						port: 28_892,
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
	const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-restart-cleanup-'));
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
		bootId: 'c1-gateway-boot',
		controllerEpoch: 'c1-controller-epoch',
		gatewayEpochId: randomUUID(),
		gatewayVmId: gatewayVm.id,
		generationId: 'c1-gateway-generation',
		zoneId,
	};
}

async function buildAndPersistGatewayRuntime(options: {
	readonly deployment: TestDeployment;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly gatewayVm: ManagedVm;
}): Promise<GatewayRuntimeRecord> {
	const runtimeRecord = await buildGatewayRuntimeRecord({
		controllerPort: options.deployment.systemConfig.host.controllerPort,
		gatewayIdentity: options.gatewayIdentity,
		gatewayType: 'openclaw',
		managedVm: options.gatewayVm,
		processSpec: {
			bootstrapCommand: 'true',
			guestListenPort: 18_789,
			healthCheck: { command: 'true', type: 'command' },
			logPath: '/tmp/controller-restart-cleanup-e2e.log',
			startCommand: 'true',
		},
		projectNamespace: options.deployment.systemConfig.host.projectNamespace,
		systemConfigPath: options.deployment.systemConfig.systemConfigPath,
		zoneId,
	});
	await writeGatewayRuntimeRecord(options.deployment.stateDirectory, runtimeRecord);
	return runtimeRecord;
}

async function buildAndPersistToolRuntime(options: {
	readonly agentId: string;
	readonly deployment: TestDeployment;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly recordId: string;
	readonly tcpSlot: number;
	readonly toolVm: ManagedVm;
}): Promise<ToolVmRuntimeRecord> {
	const runtimeRecord = await buildToolVmRuntimeRecord({
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
	});
	await writeToolVmRuntimeRecord(options.deployment.stateDirectory, runtimeRecord);
	return runtimeRecord;
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
		// oxlint-disable-next-line no-await-in-loop -- no process event source exists; a named bounded protocol interval prevents a busy host-process probe.
		await waitForProtocolRetryInterval(10);
	}
}

function processStartIdentity(record: GatewayRuntimeRecord | ToolVmRuntimeRecord): string {
	return hashControlLeaseReliabilityArtifact(
		`${record.processIdentity.command}\n${record.processIdentity.lstart}`,
	);
}

async function readAgentVmPackageIdentity(): Promise<{
	readonly checksumSha256: string;
	readonly name: string;
	readonly version: string;
}> {
	const packageJsonText = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
	const packageJson: unknown = JSON.parse(packageJsonText);
	if (
		!isObjectRecord(packageJson) ||
		typeof packageJson.name !== 'string' ||
		typeof packageJson.version !== 'string'
	) {
		throw new Error('Agent VM package identity is malformed.');
	}
	return {
		checksumSha256: hashControlLeaseReliabilityArtifact(packageJsonText),
		name: packageJson.name,
		version: packageJson.version,
	};
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
		throw new AggregateError(cleanupErrors, 'controller-restart cleanup E2E harness failed');
	}
});

describeLiveVmE2e('live e2e: controller restart composed cleanup', () => {
	it('fails closed on ambiguity, then destroys C1 Tool leaves before Gateway and publishes C2', async () => {
		const deployment = await createTestDeployment();
		temporaryDeploymentRoots.push(deployment.rootDirectory);
		const zone = deployment.systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected one OpenClaw controller-restart cleanup zone.');
		}

		const c1GatewayVm = await createStartedRealVm('c1-gateway-before-controller-restart');
		const c1FirstToolVm = await createStartedRealVm('c1-first-tool-before-controller-restart');
		const c1SecondToolVm = await createStartedRealVm('c1-second-tool-before-controller-restart');
		const unrelatedVm = await createStartedRealVm('unrelated-vm-must-survive-controller-restart');
		const c1GatewayIdentity = createGatewayIdentity(c1GatewayVm);
		const firstToolRecordId = randomUUID();
		const secondToolRecordId = randomUUID();
		const [c1FirstToolRecord, c1SecondToolRecord, c1GatewayRecord] = await Promise.all([
			buildAndPersistToolRuntime({
				agentId: 'first-agent',
				deployment,
				gatewayIdentity: c1GatewayIdentity,
				recordId: firstToolRecordId,
				tcpSlot: 0,
				toolVm: c1FirstToolVm,
			}),
			buildAndPersistToolRuntime({
				agentId: 'second-agent',
				deployment,
				gatewayIdentity: c1GatewayIdentity,
				recordId: secondToolRecordId,
				tcpSlot: 1,
				toolVm: c1SecondToolVm,
			}),
			buildAndPersistGatewayRuntime({
				deployment,
				gatewayIdentity: c1GatewayIdentity,
				gatewayVm: c1GatewayVm,
			}),
		]);
		const c1GatewayPid = c1GatewayRecord.qemuPid;
		const c1FirstToolPid = c1FirstToolRecord.qemuPid;
		const c1SecondToolPid = c1SecondToolRecord.qemuPid;

		await writeToolVmRuntimeRecord(deployment.stateDirectory, {
			...c1FirstToolRecord,
			processIdentity: {
				...c1FirstToolRecord.processIdentity,
				lstart: 'Thu Jan 01 00:00:00 1970',
			},
		});
		await expect(
			runControllerOfflineCleanup({
				force: true,
				systemConfig: deployment.systemConfig,
				zoneId,
			}),
		).rejects.toThrow(/process identity changed/u);
		expect([c1GatewayPid, c1FirstToolPid, c1SecondToolPid].every(isProcessAlive)).toBe(true);
		await expect(loadGatewayRuntimeRecord(deployment.stateDirectory)).resolves.toMatchObject({
			vmId: c1GatewayVm.id,
		});
		await expect(
			loadToolVmRuntimeRecord(deployment.stateDirectory, firstToolRecordId),
		).resolves.toMatchObject({ vmId: c1FirstToolVm.id });
		await assertVmMarker(unrelatedVm, 'unrelated-live-after-fail-closed');

		await writeToolVmRuntimeRecord(deployment.stateDirectory, c1FirstToolRecord);
		const oldTreeAbsence = withProtocolDeadline(
			waitForOldTreeAbsence({
				gatewayPid: c1GatewayPid,
				toolPids: [c1FirstToolPid, c1SecondToolPid],
			}),
			'controller restart C1 tree reconciliation',
			120_000,
		);
		let c2GatewayIdentity: GatewayEpochIdentity | undefined;
		let c2GatewayRecord: GatewayRuntimeRecord | undefined;
		let c2GatewayVm: ManagedVm | undefined;
		let c2GatewayTermination: CapturedManagedVmTermination | undefined;
		let runtime: Awaited<ReturnType<typeof startControllerRuntime>> | undefined;

		try {
			runtime = await startControllerRuntime(
				{ systemConfig: deployment.systemConfig, zoneIds: [zoneId] },
				{
					controllerEpoch: 'c2-controller-epoch',
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					preflightGatewayZoneStart: async (startOptions) => ({
						image: {
							built: false,
							fingerprint: 'controller-restart-cleanup-c2',
							imagePath: '',
						},
						secretResolver: startOptions.secretResolver,
					}),
					startGatewayZone: async (startOptions) => {
						await oldTreeAbsence;
						expect([c1GatewayPid, c1FirstToolPid, c1SecondToolPid].some(isProcessAlive)).toBe(
							false,
						);
						await expect(
							loadToolVmRuntimeRecord(deployment.stateDirectory, firstToolRecordId),
						).resolves.toBeNull();
						await expect(
							loadToolVmRuntimeRecord(deployment.stateDirectory, secondToolRecordId),
						).resolves.toBeNull();
						await expect(loadGatewayRuntimeRecord(deployment.stateDirectory)).resolves.toBeNull();
						await assertVmMarker(unrelatedVm, 'unrelated-live-before-c2-publication');

						const vmOwnership = await startOptions.createVmOwnership({
							controlIdentity: {
								bootId: 'c2-gateway-boot',
								generationId: 'c2-gateway-generation',
							},
							kind: 'gateway-epoch',
							sessionLabel: 'c2-gateway-after-controller-restart',
							zoneId,
						});
						c2GatewayVm = await createManagedVm({
							allowedHosts: [],
							cpus: 1,
							imagePath: '',
							memory: '512M',
							rootfsMode: 'memory',
							secrets: {},
							sessionLabel: 'c2-gateway-after-controller-restart',
							vfsMounts: {},
						});
						vmOwnership.attachGatewayVm(c2GatewayVm.id);
						await c2GatewayVm.start();
						c2GatewayTermination = await captureManagedVmTermination(c2GatewayVm);
						managedVmTerminationsForHarnessCleanup.push(c2GatewayTermination);
						c2GatewayIdentity = vmOwnership.gatewayIdentity;
						if (c2GatewayIdentity === undefined) {
							throw new Error('Expected C2 Gateway identity before runtime publication.');
						}
						c2GatewayRecord = await buildAndPersistGatewayRuntime({
							deployment,
							gatewayIdentity: c2GatewayIdentity,
							gatewayVm: c2GatewayVm,
						});
						return {
							image: {
								built: false,
								fingerprint: 'controller-restart-cleanup-c2',
								imagePath: '',
							},
							ingress: { host: '127.0.0.1', port: 28_892 },
							processSpec: {
								bootstrapCommand: 'true',
								guestListenPort: 18_789,
								healthCheck: { command: 'true', type: 'command' },
								logPath: '/tmp/controller-restart-cleanup-e2e.log',
								startCommand: 'true',
							},
							terminateVm: async () => {
								await c2GatewayTermination?.terminate();
							},
							vm: c2GatewayVm,
							vmOwnership,
							zone,
						};
					},
					startHttpServer: async () => ({ close: async () => {} }),
				},
			);

			const publishedC2GatewayVm = requireDefined<ManagedVm>(
				c2GatewayVm,
				'Controller restart did not publish the C2 Gateway VM.',
			);
			const publishedC2GatewayIdentity = requireDefined<GatewayEpochIdentity>(
				c2GatewayIdentity,
				'Controller restart did not publish the C2 Gateway identity.',
			);
			const publishedC2GatewayRecord = requireDefined<GatewayRuntimeRecord>(
				c2GatewayRecord,
				'Controller restart did not publish the C2 Gateway runtime record.',
			);
			expect(publishedC2GatewayIdentity).toMatchObject({
				controllerEpoch: 'c2-controller-epoch',
				generationId: 'c2-gateway-generation',
				zoneId,
			});
			expect(publishedC2GatewayVm.id).not.toBe(c1GatewayVm.id);
			expect(runtime.zones).toEqual([
				expect.objectContaining({ lifecycleState: 'running', zoneId }),
			]);
			await assertVmMarker(publishedC2GatewayVm, 'c2-successor-live');
			await assertVmMarker(unrelatedVm, 'unrelated-live-after-c2-publication');

			const transitionArtifact = JSON.stringify({
				c1: {
					gateway: { pid: c1GatewayPid, vmId: c1GatewayVm.id },
					tools: [
						{ pid: c1FirstToolPid, vmId: c1FirstToolVm.id },
						{ pid: c1SecondToolPid, vmId: c1SecondToolVm.id },
					],
				},
				c2: {
					gateway: {
						pid: publishedC2GatewayRecord.qemuPid,
						vmId: publishedC2GatewayVm.id,
					},
				},
				failClosedIdentityMismatch: true,
				oldTreeAbsentBeforeSuccessorPublication: true,
				unrelatedVmId: unrelatedVm.id,
			});
			const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
				expectedOperationId: reliabilityOperationId,
				payload: {
					artifacts: [
						{
							operationId: 'controller-restart-cleanup-transition',
							sha256: hashControlLeaseReliabilityArtifact(transitionArtifact),
						},
					],
					generationIdentities: [
						{ generation: 1, targetId: 'c1-controller-epoch', targetKind: 'controller' },
						{
							generation: 1,
							targetId: c1GatewayIdentity.generationId,
							targetKind: 'gateway',
						},
						{ generation: 2, targetId: 'c2-controller-epoch', targetKind: 'controller' },
						{
							generation: 2,
							targetId: publishedC2GatewayIdentity.generationId,
							targetKind: 'gateway',
						},
					],
					packageIdentities: [await readAgentVmPackageIdentity()],
					processIdentities: [
						{
							bootId: c1GatewayIdentity.bootId,
							kind: 'gateway-vm-process',
							processId: c1GatewayPid,
							startIdentity: processStartIdentity(c1GatewayRecord),
						},
						...([c1FirstToolRecord, c1SecondToolRecord] as const).map((record) => ({
							bootId: c1GatewayIdentity.gatewayEpochId,
							kind: 'tool-vm-process',
							processId: record.qemuPid,
							startIdentity: processStartIdentity(record),
						})),
						{
							bootId: publishedC2GatewayIdentity.bootId,
							kind: 'gateway-vm-process',
							processId: publishedC2GatewayRecord.qemuPid,
							startIdentity: processStartIdentity(publishedC2GatewayRecord),
						},
					],
					runtimeIdentities: [
						{ generation: 1, id: c1GatewayVm.id, kind: 'gateway-vm' },
						{ generation: 1, id: c1FirstToolVm.id, kind: 'tool-vm' },
						{ generation: 1, id: c1SecondToolVm.id, kind: 'tool-vm' },
						{ generation: 2, id: publishedC2GatewayVm.id, kind: 'gateway-vm' },
					],
				},
			});
			expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
		} finally {
			await runtime?.close();
		}

		await expect(loadGatewayRuntimeRecord(deployment.stateDirectory)).resolves.toBeNull();
	}, 180_000);
});
