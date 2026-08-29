import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm, ManagedVmImageBuildResult } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it } from 'vitest';

import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../controller/durable-state/controller-state-paths.js';
import {
	resolveControllerGatewayRecordTargets,
	type ControllerGatewayRecordTargets,
	type ControllerManagedGatewayRuntimeRecordTarget,
} from '../controller/durable-state/controller-state-record-paths.js';
import {
	buildToolVmRuntimeRecord,
	loadToolVmRuntimeRecord,
	writeToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import type { GatewayVmLifecycleAuthority } from '../controller/vm-ownership/gateway-vm-lifecycle-authority.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import {
	buildManagedGatewayRuntimeRecord,
	deleteManagedGatewayRuntimeRecord,
	loadManagedGatewayRuntimeRecord,
	type ManagedGatewayRuntimeRecord,
	writeManagedGatewayRuntimeRecord,
} from '../gateway/gateway-runtime-record.js';
import type { GatewayZoneDestroyResult } from '../gateway/gateway-zone-support.js';
import { createManagedGatewayBootContract } from '../gateway/managed-gateway-boot-contract.js';
import { runControllerOfflineCleanup } from '../operations/controller-offline-cleanup.js';
import type { ManagedVmProcessTarget } from '../shared/controller-managed-vm-termination.js';
import { isProcessAlive, readProcessIdentity } from '../shared/managed-vm-process.js';

const managedVmRuntimeComposition = createManagedVmRuntimeComposition();
const { managedVmFactory } = managedVmRuntimeComposition;
import {
	captureManagedVmTermination,
	type CapturedManagedVmTermination,
} from '../testing/managed-vm-test-helpers.js';
import { waitForProtocolRetryInterval, withProtocolDeadline } from './e2e-protocol-wait.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const describeLiveVmE2e = shouldRunLiveVmE2e() ? describe : describe.skip;
const zoneId = 'ownership-restart';
const testManagedGatewayBootContract = createManagedGatewayBootContract({
	bootEntry: 'hermes-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'hermes',
	ingress: { guestPort: 8642, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/hermes-service.log',
		serviceName: 'agent-vm-hermes-test',
	},
	readiness: { guestPort: 8642, kind: 'framework-http', path: '/health' },
	role: 'framework-service',
});

const testManagedGatewayImage = {
	built: false,
	fingerprint: 'controller-restart-ownership-alpine-base',
	imageReference: 'alpine-base:latest',
} satisfies ManagedVmImageBuildResult;

interface TestDeployment {
	readonly controllerRecordTargets: ControllerGatewayRecordTargets;
	readonly rootDirectory: string;
	readonly stateDirectory: string;
	readonly systemConfig: LoadedSystemConfig;
}

const temporaryDeploymentRoots: string[] = [];
const managedVmTerminationsForHarnessCleanup: CapturedManagedVmTermination[] = [];

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

function createTestSystemConfig(options: { readonly rootDirectory: string }): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			storageRootDir: options.rootDirectory,
			host: {
				controllerPort: 18_841,
				projectNamespace: 'ownership-restart-e2e',
			},
			imageProfiles: {
				gateways: {
					hermes: {
						buildConfig: './vm-images/gateways/hermes/build-config.jsonc',
						type: 'hermes',
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
			schemaVersion: 2,
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
						config: path.join(options.rootDirectory, 'config', 'config.yaml'),
						cpus: 1,
						imageProfile: 'hermes',
						memory: '512M',
						port: 28_891,
						type: 'hermes',
						profileSecretProjectionsByAgent: {
							'current-agent': {
								API_SERVER_KEY: 'API_SERVER_KEY_CURRENT',
								DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_CURRENT',
							},
							'second-agent': {
								API_SERVER_KEY: 'API_SERVER_KEY_SECOND',
								DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SECOND',
							},
						},
						profilesByAgent: {
							'current-agent': 'current-agent',
							'second-agent': 'second-agent',
						},
					},
					id: zoneId,
					secrets: {
						API_SERVER_KEY: {
							audience: 'gateway',
							injection: 'env',
							source: 'config',
							value: 'test-root-api-server-key',
						},
						API_SERVER_KEY_CURRENT: {
							audience: 'gateway',
							envVar: 'API_SERVER_KEY_CURRENT',
							injection: 'env',
							source: 'environment',
						},
						API_SERVER_KEY_SECOND: {
							audience: 'gateway',
							envVar: 'API_SERVER_KEY_SECOND',
							injection: 'env',
							source: 'environment',
						},
						DISCORD_BOT_TOKEN_CURRENT: {
							audience: 'gateway',
							envVar: 'DISCORD_BOT_TOKEN_CURRENT',
							injection: 'env',
							source: 'environment',
						},
						DISCORD_BOT_TOKEN_SECOND: {
							audience: 'gateway',
							envVar: 'DISCORD_BOT_TOKEN_SECOND',
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
	const stateDirectory = path.join(rootDirectory, zoneId, 'state');
	const systemConfig = createTestSystemConfig({ rootDirectory });
	return {
		controllerRecordTargets: resolveControllerGatewayRecordTargets({
			gatewayStateRoot: resolveControllerGatewayStateRoot({
				controllerStateRoot: createControllerStateRoot({
					controllerStateDirectoryPath: systemConfig.controllerStateDir,
				}),
				zoneId,
			}),
		}),
		rootDirectory,
		stateDirectory,
		systemConfig,
	};
}

async function createStartedRealVm(sessionLabel: string): Promise<ManagedVm> {
	const managedVm = await managedVmFactory.createManagedVm({
		allowedHosts: [],
		environment: {},
		imageReference: 'alpine-base:latest',
		mediatedSecrets: [],
		mounts: {},
		resources: { cpuCount: 1, memory: '512M' },
		rootfsMode: 'memory',
		sessionLabel,
		tcpHosts: [],
	});
	await managedVm.start();
	managedVmTerminationsForHarnessCleanup.push(await captureManagedVmTermination(managedVm));
	return managedVm;
}

async function captureStartedManagedVmProcessTarget(
	managedVm: ManagedVm,
): Promise<ManagedVmProcessTarget> {
	const hostPid = managedVm.getHostProcessId();
	if (hostPid === null) {
		throw new Error(`Managed VM '${managedVm.id}' has no live runner to capture.`);
	}
	const processIdentity = await readProcessIdentity(hostPid);
	if (processIdentity === null) {
		throw new Error(
			`Managed VM '${managedVm.id}' pid ${String(hostPid)} disappeared before identity capture.`,
		);
	}
	return { hostPid, processIdentity, vmId: managedVm.id };
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
				guestPort: 8642,
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

async function persistGatewayRuntime(options: {
	readonly deployment: TestDeployment;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly gatewayVm: ManagedVm;
}): Promise<void> {
	const expectedCohort = createManagedGatewayExpectedCohort({
		configuredAgentIds: ['current-agent', 'second-agent'],
		gatewayIdentity: options.gatewayIdentity,
	});
	await writeManagedGatewayRuntimeRecord(
		options.deployment.controllerRecordTargets.managedGatewayRuntimeRecord,
		await buildManagedGatewayRuntimeRecord({
			appliedIngressRoutes: [
				expectedCohort.ingressIntent.controlRoute,
				expectedCohort.ingressIntent.frameworkRootRoute,
			],
			bootContract: testManagedGatewayBootContract,
			controllerPort: options.deployment.systemConfig.host.controllerPort,
			expectedCohort,
			gatewayIdentity: options.gatewayIdentity,
			image: testManagedGatewayImage,
			managedVm: options.gatewayVm,
			processTarget: await captureStartedManagedVmProcessTarget(options.gatewayVm),
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
		options.deployment.controllerRecordTargets.toolLeaseRecords,
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
		if (zone === undefined || zone.gateway.type !== 'hermes') {
			throw new Error('Expected one Hermes restart test zone.');
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
		const gatewayPid = gatewayVm.getHostProcessId();
		const firstToolPid = firstToolVm.getHostProcessId();
		const secondToolPid = secondToolVm.getHostProcessId();
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
					...managedVmRuntimeComposition,
					controllerEpoch: 'controller-epoch-after-restart',
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					preflightGatewayZoneStart: async (startOptions) => ({
						image: {
							built: false,
							fingerprint: 'controller-restart-successor',
							imageReference: 'alpine-base:latest',
						},
						secretResolver: startOptions.secretResolver,
					}),
					startGatewayZone: async (startOptions) => {
						await oldTreeAbsence;
						await expect(
							loadToolVmRuntimeRecord(
								deployment.controllerRecordTargets.toolLeaseRecords,
								firstToolRecordId,
							),
						).resolves.toBeNull();
						await expect(
							loadToolVmRuntimeRecord(
								deployment.controllerRecordTargets.toolLeaseRecords,
								secondToolRecordId,
							),
						).resolves.toBeNull();
						await expect(
							loadManagedGatewayRuntimeRecord(
								deployment.controllerRecordTargets.managedGatewayRuntimeRecord,
							),
						).resolves.toBeNull();
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
						successorGatewayVm = await managedVmFactory.createManagedVm({
							allowedHosts: [],
							environment: {},
							imageReference: 'alpine-base:latest',
							mediatedSecrets: [],
							mounts: {},
							resources: { cpuCount: 1, memory: '512M' },
							rootfsMode: 'memory',
							sessionLabel: 'gateway-after-controller-restart',
							tcpHosts: [],
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
							bootContract: testManagedGatewayBootContract,
							destroyGateway: createFixtureGatewayDestroyer({
								destroyGatewayVm: async () => {
									await successorGatewayTermination?.terminate();
								},
								runtimeRecordTarget: deployment.controllerRecordTargets.managedGatewayRuntimeRecord,
								vmOwnership,
							}),
							executionModel: 'managed-gateway',
							expectedCohort: createManagedGatewayExpectedCohort({
								configuredAgentIds: ['current-agent', 'second-agent'],
								gatewayIdentity: successorGatewayIdentity,
							}),
							gatewayIdentity: successorGatewayIdentity,
							image: {
								built: false,
								fingerprint: 'controller-restart-successor',
								imageReference: 'alpine-base:latest',
							},
							ingress: { host: '127.0.0.1', port: 28_891 },
							vm: successorGatewayVm,
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
			await expect(
				loadManagedGatewayRuntimeRecord(
					deployment.controllerRecordTargets.managedGatewayRuntimeRecord,
				),
			).resolves.toMatchObject({
				vmId: successorGatewayIdentity?.gatewayVmId,
			});
			await assertVmMarker(unrelatedVm, 'unrelated-live-after-successor');
			if (successorGatewayVm !== undefined) {
				await assertVmMarker(successorGatewayVm, 'successor-live');
			}
		} finally {
			await runtime?.close();
		}

		await expect(
			loadManagedGatewayRuntimeRecord(
				deployment.controllerRecordTargets.managedGatewayRuntimeRecord,
			),
		).resolves.toBeNull();
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
		await writeToolVmRuntimeRecord(deployment.controllerRecordTargets.toolLeaseRecords, {
			...toolRecord,
			processIdentity: {
				...toolRecord.processIdentity,
				command: `${toolRecord.processIdentity.command} --mismatched-record`,
			},
		});
		await persistGatewayRuntime({ deployment, gatewayIdentity, gatewayVm });
		const gatewayPid = gatewayVm.getHostProcessId();
		const toolPid = toolVm.getHostProcessId();
		if (gatewayPid === null || toolPid === null) {
			throw new Error('Expected live Gateway and Tool VM host processes.');
		}

		await expect(
			runControllerOfflineCleanup(
				{
					force: true,
					systemConfig: deployment.systemConfig,
					zoneId,
				},
				{
					exactProcessTermination: managedVmRuntimeComposition.managedVmExactProcessTermination,
				},
			),
		).rejects.toThrow(/command changed/u);

		expect(isProcessAlive(toolPid)).toBe(true);
		expect(isProcessAlive(gatewayPid)).toBe(true);
		await expect(
			loadToolVmRuntimeRecord(deployment.controllerRecordTargets.toolLeaseRecords, toolRecordId),
		).resolves.toMatchObject({
			vmId: toolVm.id,
		});
		await expect(
			loadManagedGatewayRuntimeRecord(
				deployment.controllerRecordTargets.managedGatewayRuntimeRecord,
			),
		).resolves.toMatchObject({
			vmId: gatewayVm.id,
		});
		await Promise.all([
			assertVmMarker(toolVm, 'tool-still-live'),
			assertVmMarker(gatewayVm, 'gateway-still-live'),
		]);
	}, 180_000);
});
