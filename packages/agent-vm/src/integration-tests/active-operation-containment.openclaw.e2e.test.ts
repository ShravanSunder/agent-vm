/* oxlint-disable eslint/no-await-in-loop -- live VM state transitions require sequential observation */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER,
	gatewayRuntimeSandboxWriteReadE2eTestExports,
} from '@agent-vm/openclaw-agent-vm-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../controller/durable-state/controller-state-paths.js';
import {
	resolveControllerGatewayRecordTargets,
	type ControllerGatewayRecordTargets,
	type ControllerToolLeaseRecordsTarget,
} from '../controller/durable-state/controller-state-record-paths.js';
import {
	loadAllToolVmRuntimeRecords,
	type ToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import {
	readManagedGatewaySiblingProcessIdentity,
	terminateManagedGatewaySibling,
	type ManagedGatewaySiblingProcessIdentity,
} from '../controller/reliability/testing/gateway-reliability-fault-adapter.js';
import { loadManagedGatewayRuntimeRecord } from '../gateway/gateway-runtime-record.js';
import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';
import {
	expectedControlLeaseReliabilityEvidenceWriteKind,
	hashControlLeaseReliabilityArtifact,
	writeControlLeaseReliabilityEvidence,
} from './control-lease-reliability-evidence.js';
import {
	canRunManagedVmE2e,
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	startE2eControllerRuntime,
	startE2eGatewayZoneForController as startGatewayZone,
	type E2eHarnessRuntime,
	type OpenClawE2eProject,
	useLocalOpenClawGatewayImagePackages,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval, withProtocolDeadline } from './e2e-protocol-wait.js';

const architecture = currentE2eArchitecture();
type GatewayVmObservationOperations = Pick<
	GatewayZoneVmOperations,
	'enableSsh' | 'exec' | 'getHostProcessId' | 'id'
>;
const canRunActiveOperationContainmentE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeActiveOperationContainmentE2e = canRunActiveOperationContainmentE2e
	? describe
	: describe.skip;
const zoneId = 'active-operation-containment';
const gatewayToken = 'active-operation-containment-gateway-token';
const probeSigningKey = 'active-operation-containment-proof-key';
const reliabilityOperationId = 'active-operation-containment';
const affectedIdentity = {
	agentId: 'main',
	sessionKey: 'agent:main:tool-vm-write-read:active-operation-main',
} as const;
const siblingIdentity = {
	agentId: 'beta',
	sessionKey: 'agent:beta:tool-vm-write-read:active-operation-beta',
} as const;
const configuredProbeIdentities = [affectedIdentity, siblingIdentity] as const;
const recoveryGatewayServiceAutoRestart = {
	channelProviderHealth: {
		consecutiveFailureThreshold: 3,
		enabled: true,
		restartGatewayOnRecoverable: true,
		restartGatewayOnUnrecoverable: false,
		transitioningTimeoutMs: 120_000,
	},
	cooldownMs: 1,
	consecutiveFailureThreshold: 1,
	enabled: true,
	failedRecoveryResetMs: 24 * 60 * 60 * 1_000,
	maxConsecutiveFailedRecoveries: 3,
	restartTimeoutMs: 120_000,
} as const;

function resolveFixtureControllerRecordTargets(options: {
	readonly controllerStateDirectoryPath: string;
	readonly zoneId: string;
}): ControllerGatewayRecordTargets {
	return resolveControllerGatewayRecordTargets({
		gatewayStateRoot: resolveControllerGatewayStateRoot({
			controllerStateRoot: createControllerStateRoot({
				controllerStateDirectoryPath: options.controllerStateDirectoryPath,
			}),
			zoneId: options.zoneId,
		}),
	});
}

type ManagedGatewayStartResult = Extract<
	Awaited<ReturnType<typeof startGatewayZone>>,
	{ readonly executionModel: 'managed-gateway' }
>;

interface ActiveRequestConnectionLoss {
	readonly kind: 'connection-loss';
	readonly message: string;
}

interface ActiveRequestResponse {
	readonly bodyText: string;
	readonly kind: 'response';
	readonly status: number;
}

type ActiveRequestOutcome = ActiveRequestConnectionLoss | ActiveRequestResponse;

type GatewaySiblingProcessIdentity = ManagedGatewaySiblingProcessIdentity;

interface GatewaySiblingProcessIdentities {
	readonly framework: GatewaySiblingProcessIdentity;
	readonly toolPortal: GatewaySiblingProcessIdentity;
}

interface ManagedGatewayStartObservation {
	readonly hostProcessId: number;
	readonly result: ManagedGatewayStartResult;
}

interface ToolVmWriteReadResult {
	readonly agentId: string;
	readonly marker: string;
	readonly readBack: string;
}

interface PredecessorContainmentObservation {
	readonly gatewayRuntimeRecordAbsent: true;
	readonly gatewayVmHostProcessAbsent: true;
	readonly siblingProcessesContainedByGatewayVm: GatewaySiblingProcessIdentities;
	readonly toolVmProcesses: readonly {
		readonly leaseId: string;
		readonly processAbsent: true;
		readonly qemuPid: number;
	}[];
	readonly toolVmRuntimeRecordsAbsent: true;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createDeferredPromise<TValue>(): {
	readonly promise: Promise<TValue>;
	readonly resolve: (value: TValue) => void;
} {
	let resolvePromise!: (value: TValue) => void;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function parseWriteReadResult(value: unknown): ToolVmWriteReadResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error(`Tool VM probe did not return successful details: ${JSON.stringify(value)}`);
	}
	const details = value.details;
	if (
		typeof details.agentId !== 'string' ||
		typeof details.marker !== 'string' ||
		typeof details.readBack !== 'string'
	) {
		throw new Error(`Tool VM probe details were malformed: ${JSON.stringify(details)}`);
	}
	return {
		agentId: details.agentId,
		marker: details.marker,
		readBack: details.readBack,
	};
}

function createSignedProbeRequest(options: {
	readonly body: Readonly<Record<string, unknown>>;
	readonly harness: E2eHarnessRuntime;
}): { readonly bodyText: string; readonly url: string } {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Active-operation containment E2E did not expose Gateway ingress.');
	}
	return {
		bodyText: JSON.stringify(options.body),
		url: `http://${ingress.host}:${String(ingress.port)}${AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH}`,
	};
}

async function callWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly marker: string;
}): Promise<ToolVmWriteReadResult> {
	const request = createSignedProbeRequest({
		body: {
			agentId: options.identity.agentId,
			filePath: `agent-vm-e2e-write-read-${randomUUID()}.txt`,
			marker: options.marker,
			action: 'write-read',
			sessionKey: options.identity.sessionKey,
		},
		harness: options.harness,
	});
	const response = await withProtocolDeadline(
		fetch(request.url, {
			body: request.bodyText,
			headers: {
				authorization: `Bearer ${gatewayToken}`,
				'content-type': 'application/json',
				[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER]:
					gatewayRuntimeSandboxWriteReadE2eTestExports.signBody(request.bodyText, probeSigningKey),
			},
			method: 'POST',
		}),
		`${options.identity.agentId} write/read probe`,
		60_000,
	);
	const responseBody: unknown = await response.json();
	if (!response.ok) {
		throw new Error(`Tool VM probe failed with HTTP ${String(response.status)}.`);
	}
	return parseWriteReadResult(responseBody);
}

function startActiveOperation(options: {
	readonly filePath: string;
	readonly harness: E2eHarnessRuntime;
	readonly marker: string;
	readonly sentinelFilePath: string;
}): Promise<ActiveRequestOutcome> {
	const request = createSignedProbeRequest({
		body: {
			agentId: affectedIdentity.agentId,
			filePath: options.filePath,
			marker: options.marker,
			action: 'active-operation-containment',
			sentinelFilePath: options.sentinelFilePath,
			sessionKey: affectedIdentity.sessionKey,
		},
		harness: options.harness,
	});
	return fetch(request.url, {
		body: request.bodyText,
		headers: {
			authorization: `Bearer ${gatewayToken}`,
			'content-type': 'application/json',
			[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER]:
				gatewayRuntimeSandboxWriteReadE2eTestExports.signBody(request.bodyText, probeSigningKey),
		},
		method: 'POST',
	}).then(
		async (response) => ({
			bodyText: await response.text(),
			kind: 'response' as const,
			status: response.status,
		}),
		(error: unknown) => ({
			kind: 'connection-loss' as const,
			message: error instanceof Error ? error.message : String(error),
		}),
	);
}

async function observeWithdrawnIngress(harness: E2eHarnessRuntime): Promise<ActiveRequestOutcome> {
	const request = createSignedProbeRequest({
		body: {
			agentId: affectedIdentity.agentId,
			filePath: `agent-vm-e2e-withdrawn-ingress-${randomUUID()}.txt`,
			marker: `WITHDRAWN_${randomUUID()}`,
			action: 'write-read',
			sessionKey: affectedIdentity.sessionKey,
		},
		harness,
	});
	return await withProtocolDeadline(
		fetch(request.url, {
			body: request.bodyText,
			headers: {
				authorization: `Bearer ${gatewayToken}`,
				'content-type': 'application/json',
				[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER]:
					gatewayRuntimeSandboxWriteReadE2eTestExports.signBody(request.bodyText, probeSigningKey),
			},
			method: 'POST',
		}),
		'withdrawn Gateway ingress probe',
		10_000,
	).then(
		async (response) => ({
			bodyText: await response.text(),
			kind: 'response' as const,
			status: response.status,
		}),
		(error: unknown) => ({
			kind: 'connection-loss' as const,
			message: error instanceof Error ? error.message : String(error),
		}),
	);
}

async function waitForSentinel(sentinelPath: string, expectedMarker: string): Promise<void> {
	const deadlineMs = Date.now() + 60_000;
	while (Date.now() < deadlineMs) {
		try {
			if ((await fs.readFile(sentinelPath, 'utf8')).trim() === expectedMarker) {
				return;
			}
		} catch (error) {
			if (!isObjectRecord(error) || error.code !== 'ENOENT') {
				throw error;
			}
		}
		await waitForProtocolRetryInterval(100);
	}
	throw new Error(`Timed out waiting for committed active-operation sentinel '${sentinelPath}'.`);
}

async function waitForCommittedSentinelWhileRequestIsActive(options: {
	readonly expectedMarker: string;
	readonly requestOutcome: Promise<ActiveRequestOutcome>;
	readonly sentinelPath: string;
}): Promise<void> {
	await Promise.race([
		waitForSentinel(options.sentinelPath, options.expectedMarker),
		options.requestOutcome.then((outcome) => {
			const details =
				outcome.kind === 'response'
					? `HTTP ${String(outcome.status)}: ${outcome.bodyText}`
					: `connection loss: ${outcome.message}`;
			throw new Error(
				`Active-operation request completed before its committed sentinel became visible (${details}).`,
			);
		}),
	]);
}

async function readCurrentRecords(
	recordsTarget: ControllerToolLeaseRecordsTarget,
	agentIds: ReadonlySet<string>,
	gatewayVmId: string,
): Promise<Map<string, ToolVmRuntimeRecord>> {
	const results = await loadAllToolVmRuntimeRecords(recordsTarget);
	const parseError = results.find((result) => result.kind === 'parse-error');
	if (parseError !== undefined) {
		throw new Error(`Tool VM runtime record failed to parse: ${parseError.path}`);
	}
	const records = results
		.filter((result) => result.kind === 'loaded')
		.map((result) => result.record)
		.filter((record) => agentIds.has(record.agentId) && record.gateway.gatewayVmId === gatewayVmId);
	if (
		records.length !== agentIds.size ||
		new Set(records.map((record) => record.agentId)).size !== agentIds.size
	) {
		throw new Error(
			`Expected one current Tool VM runtime record for each of ${String(agentIds.size)} agents in Gateway VM '${gatewayVmId}', found ${String(records.length)}.`,
		);
	}
	return new Map(records.map((record) => [record.agentId, record] as const));
}

async function readGatewaySiblingProcessIdentities(
	start: ManagedGatewayStartObservation,
): Promise<GatewaySiblingProcessIdentities> {
	const [framework, toolPortal] = await Promise.all([
		readManagedGatewaySiblingProcessIdentity({
			gatewayVm: start.result.vm,
			guestPort: start.result.expectedCohort.ingressIntent.frameworkRootRoute.guestPort,
			role: 'framework',
		}),
		readManagedGatewaySiblingProcessIdentity({
			gatewayVm: start.result.vm,
			guestPort: start.result.expectedCohort.ingressIntent.controlRoute.guestPort,
			role: 'tool-portal',
		}),
	]);
	if (framework.processId === toolPortal.processId) {
		throw new Error('Managed framework and Tool Portal roles unexpectedly shared one process.');
	}
	return { framework, toolPortal };
}

async function killFrameworkSibling(options: {
	readonly gatewayVm: GatewayVmObservationOperations;
	readonly identity: GatewaySiblingProcessIdentity;
}): Promise<void> {
	await terminateManagedGatewaySibling({
		gatewayVm: options.gatewayVm,
		identity: options.identity,
		role: 'framework',
	});
}

function isHostProcessAbsent(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return false;
	} catch (error) {
		return isObjectRecord(error) && error.code === 'ESRCH';
	}
}

function expectFreshManagedGatewayCohort(options: {
	readonly predecessor: ManagedGatewayStartObservation;
	readonly successor: ManagedGatewayStartObservation;
}): void {
	expect(options.successor.result.vm.id).not.toBe(options.predecessor.result.vm.id);
	expect(options.successor.result.expectedCohort.fence.gatewayEpoch).not.toBe(
		options.predecessor.result.expectedCohort.fence.gatewayEpoch,
	);
	expect(options.successor.result.expectedCohort.frameworkIdentity).not.toEqual(
		options.predecessor.result.expectedCohort.frameworkIdentity,
	);
	expect(options.successor.result.expectedCohort.frameworkIdentity.frameworkEpoch).not.toBe(
		options.predecessor.result.expectedCohort.frameworkIdentity.frameworkEpoch,
	);
	expect(options.successor.result.expectedCohort.toolPortalIdentity).not.toEqual(
		options.predecessor.result.expectedCohort.toolPortalIdentity,
	);
	expect(options.successor.result.expectedCohort.toolPortalIdentity.processEpoch).not.toBe(
		options.predecessor.result.expectedCohort.toolPortalIdentity.processEpoch,
	);
	expect(options.successor.result.expectedCohort.toolPortalIdentity.runtimeEpoch).not.toBe(
		options.predecessor.result.expectedCohort.toolPortalIdentity.runtimeEpoch,
	);
	expect(options.successor.result.expectedCohort.controlIdentity).not.toEqual(
		options.predecessor.result.expectedCohort.controlIdentity,
	);
	expect(options.successor.result.expectedCohort.controlIdentity.generationId).not.toBe(
		options.predecessor.result.expectedCohort.controlIdentity.generationId,
	);
	expect(options.successor.result.expectedCohort.controlIdentity.processEpoch).not.toBe(
		options.predecessor.result.expectedCohort.controlIdentity.processEpoch,
	);
}

async function readPackageIdentity(): Promise<{
	readonly checksumSha256: string;
	readonly name: string;
	readonly version: string;
}> {
	const packageJsonText = await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8');
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

describeActiveOperationContainmentE2e(
	'e2e: active operation containment across whole-Gateway-VM replacement',
	() => {
		let harness: E2eHarnessRuntime | undefined;
		let oldToolRecords: ReadonlyMap<string, ToolVmRuntimeRecord> | undefined;
		let predecessorContainment: PredecessorContainmentObservation | undefined;
		let predecessorSiblingProcesses: GatewaySiblingProcessIdentities | undefined;
		let project: OpenClawE2eProject | undefined;
		const allowSuccessorStart = createDeferredPromise<void>();
		const gatewayStarts: ManagedGatewayStartObservation[] = [];
		const successorStartBlocked = createDeferredPromise<void>();
		const successorStarted = createDeferredPromise<ManagedGatewayStartObservation>();

		beforeAll(async () => {
			const repoRoot = path.resolve(process.cwd());
			project = await scaffoldOpenClawE2eProject({
				agents: configuredProbeIdentities.map(({ agentId }) => agentId),
				architecture,
				prefix: 'active-operation-containment-e2e-',
				zoneId,
			});
			const systemZone = project.systemConfig.zones[0];
			if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
				throw new Error(
					'Expected active-operation containment project to contain an OpenClaw zone.',
				);
			}
			const openClawGateway = systemZone.gateway;
			for (const envName of [
				AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV,
				AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV,
				AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV,
			]) {
				systemZone.secrets[envName] = {
					audience: 'gateway',
					envVar: envName,
					injection: 'env',
					source: 'environment',
				};
			}
			openClawGateway.rawEnvSecrets = [
				...(openClawGateway.rawEnvSecrets ?? []),
				AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV,
				AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV,
				AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV,
			];
			await Promise.all(
				configuredProbeIdentities.map(async ({ agentId }) => {
					await fs.mkdir(path.join(openClawGateway.zoneFilesDir, 'agents', agentId), {
						recursive: true,
					});
				}),
			);
			await useLocalOpenClawGatewayImagePackages({
				enableToolVmWriteReadE2eRoute: true,
				profileName: openClawGateway.imageProfile,
				projectRoot: project.tempRoot,
				repoRoot,
				systemConfig: project.systemConfig,
			});
			await prepareGatewayE2eProjectImages({ project });
			const systemConfig = {
				...project.systemConfig,
				controller: {
					health: {
						...project.systemConfig.controller?.health,
						controlSessionDeathGraceMs: 30_000,
						enabled: true,
						eventHistoryLimit: 200,
						gatewayServiceAutoRestart: recoveryGatewayServiceAutoRestart,
						gatewayServiceIntervalMs: 500,
						staleAfterMs: 10_000,
					},
				},
			};
			const controllerRecordTargets = resolveFixtureControllerRecordTargets({
				controllerStateDirectoryPath: systemConfig.controllerStateDir,
				zoneId: systemZone.id,
			});
			harness = await startE2eControllerRuntime({
				secrets: {
					[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV]: '1',
					[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV]:
						JSON.stringify(configuredProbeIdentities),
					[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV]: probeSigningKey,
					GITHUB_TOKEN: 'unused-active-operation-containment-token',
					OPENCLAW_GATEWAY_TOKEN: gatewayToken,
					PERPLEXITY_API_KEY: 'unused-active-operation-containment-token',
				},
				startGatewayZone: async (startOptions) => {
					if (gatewayStarts.length === 1) {
						const predecessor = gatewayStarts[0];
						const exactOldToolRecords = oldToolRecords;
						const exactSiblingProcesses = predecessorSiblingProcesses;
						if (
							predecessor === undefined ||
							exactOldToolRecords === undefined ||
							exactSiblingProcesses === undefined
						) {
							throw new Error('Successor start began before predecessor identities were captured.');
						}
						const remainingToolRecords = await loadAllToolVmRuntimeRecords(
							controllerRecordTargets.toolLeaseRecords,
						);
						if (remainingToolRecords.length !== 0) {
							throw new Error('Successor start began while predecessor Tool VM records remained.');
						}
						const remainingGatewayRecord = await loadManagedGatewayRuntimeRecord(
							controllerRecordTargets.managedGatewayRuntimeRecord,
						);
						if (remainingGatewayRecord !== null) {
							throw new Error(
								'Successor start began while the predecessor Gateway record remained.',
							);
						}
						if (
							predecessor.result.vm.getHostProcessId() !== null ||
							!isHostProcessAbsent(predecessor.hostProcessId)
						) {
							throw new Error(
								'Successor start began before positive predecessor Gateway VM quiescence.',
							);
						}
						const toolVmProcesses = [...exactOldToolRecords.values()].map((record) => {
							if (!isHostProcessAbsent(record.qemuPid)) {
								throw new Error(
									`Successor start began before Tool VM '${record.leaseId}' was positively quiesced.`,
								);
							}
							return {
								leaseId: record.leaseId,
								processAbsent: true as const,
								qemuPid: record.qemuPid,
							};
						});
						predecessorContainment = {
							gatewayRuntimeRecordAbsent: true,
							gatewayVmHostProcessAbsent: true,
							siblingProcessesContainedByGatewayVm: exactSiblingProcesses,
							toolVmProcesses,
							toolVmRuntimeRecordsAbsent: true,
						};
						successorStartBlocked.resolve();
						await allowSuccessorStart.promise;
					}
					const result = await startGatewayZone(startOptions);
					if (result.executionModel !== 'managed-gateway') {
						throw new Error('Active-operation proof requires managed Gateway image boot.');
					}
					const hostProcessId = result.vm.getHostProcessId();
					if (hostProcessId === null) {
						throw new Error('Managed Gateway start omitted its host QEMU pid.');
					}
					const observation = { hostProcessId, result } satisfies ManagedGatewayStartObservation;
					gatewayStarts.push(observation);
					if (gatewayStarts.length === 2) {
						successorStarted.resolve(observation);
					}
					return result;
				},
				startOptions: { systemConfig, zoneIds: [zoneId] },
			});
		}, 900_000);

		afterAll(async () => {
			allowSuccessorStart.resolve();
			try {
				await harness?.close();
			} finally {
				if (project !== undefined && harness === undefined) {
					await removeE2eTempRoot(project.tempRoot);
				}
			}
		});

		it('withdraws ingress, quiesces the predecessor, and does not replay committed work', async () => {
			if (harness === undefined || project === undefined) {
				throw new Error('Expected active-operation containment harness.');
			}
			const activeHarness = harness;
			const activeZone = project.systemConfig.zones[0];
			const predecessor = gatewayStarts[0];
			if (
				activeZone === undefined ||
				activeZone.gateway.type !== 'openclaw' ||
				predecessor === undefined
			) {
				throw new Error('Expected an initial managed OpenClaw Gateway.');
			}
			const controllerRecordTargets = resolveFixtureControllerRecordTargets({
				controllerStateDirectoryPath: activeHarness.systemConfig.controllerStateDir,
				zoneId: activeZone.id,
			});
			const predecessorRuntimeRecord = await loadManagedGatewayRuntimeRecord(
				controllerRecordTargets.managedGatewayRuntimeRecord,
			);
			if (
				predecessorRuntimeRecord === null ||
				predecessorRuntimeRecord.vmId !== predecessor.result.vm.id
			) {
				throw new Error('Expected the exact predecessor managed Gateway runtime record.');
			}
			predecessorSiblingProcesses = await readGatewaySiblingProcessIdentities(predecessor);

			const [affectedBeforeProbe, siblingBeforeProbe] = await Promise.all([
				callWriteReadProbe({
					harness: activeHarness,
					identity: affectedIdentity,
					marker: `AFFECTED_BEFORE_${randomUUID()}`,
				}),
				callWriteReadProbe({
					harness: activeHarness,
					identity: siblingIdentity,
					marker: `SIBLING_BEFORE_${randomUUID()}`,
				}),
			]);
			const configuredAgentIds = new Set(
				configuredProbeIdentities.map((identity) => identity.agentId),
			);
			const recordsBefore = await readCurrentRecords(
				controllerRecordTargets.toolLeaseRecords,
				configuredAgentIds,
				predecessor.result.vm.id,
			);
			const affectedRecordBefore = recordsBefore.get(affectedBeforeProbe.agentId);
			const siblingRecordBefore = recordsBefore.get(siblingBeforeProbe.agentId);
			if (affectedRecordBefore === undefined || siblingRecordBefore === undefined) {
				throw new Error('Expected exact pre-fault Tool VM runtime records.');
			}
			oldToolRecords = new Map([
				[affectedRecordBefore.leaseId, affectedRecordBefore],
				[siblingRecordBefore.leaseId, siblingRecordBefore],
			]);

			const operationMarker = `ACTIVE_${randomUUID()}`;
			const operationFilePath = `agent-vm-e2e-active-operation-${randomUUID()}.txt`;
			const sentinelFilePath = `agent-vm-e2e-active-operation-${randomUUID()}.committed`;
			const affectedWorkspaceRoot = await fs.realpath(
				path.join(activeZone.gateway.zoneFilesDir, 'agents', affectedIdentity.agentId),
			);
			const operationHostPath = path.join(affectedWorkspaceRoot, operationFilePath);
			const sentinelHostPath = path.join(affectedWorkspaceRoot, sentinelFilePath);
			const activeRequestOutcome = startActiveOperation({
				filePath: operationFilePath,
				harness: activeHarness,
				marker: operationMarker,
				sentinelFilePath,
			});
			await waitForCommittedSentinelWhileRequestIsActive({
				expectedMarker: operationMarker,
				requestOutcome: activeRequestOutcome,
				sentinelPath: sentinelHostPath,
			});

			await killFrameworkSibling({
				gatewayVm: predecessor.result.vm,
				identity: predecessorSiblingProcesses.framework,
			});
			await withProtocolDeadline(
				successorStartBlocked.promise,
				'successor start blocked after predecessor positive quiescence',
				300_000,
			);
			if (predecessorContainment === undefined) {
				throw new Error('Expected positive predecessor containment before successor admission.');
			}
			const withdrawnIngressOutcome = await observeWithdrawnIngress(activeHarness);
			if (
				withdrawnIngressOutcome.kind === 'response' &&
				withdrawnIngressOutcome.status >= 200 &&
				withdrawnIngressOutcome.status < 300
			) {
				throw new Error(
					`Gateway ingress admitted work during predecessor replacement: HTTP ${String(withdrawnIngressOutcome.status)}.`,
				);
			}
			allowSuccessorStart.resolve();
			const successor = await withProtocolDeadline(
				successorStarted.promise,
				'fresh whole-Gateway-VM successor',
				300_000,
			);
			expectFreshManagedGatewayCohort({ predecessor, successor });
			expect(gatewayStarts).toHaveLength(2);

			const activeOutcome = await withProtocolDeadline(
				activeRequestOutcome,
				'active request termination after predecessor loss',
				30_000,
			);
			if (
				activeOutcome.kind === 'response' &&
				activeOutcome.status >= 200 &&
				activeOutcome.status < 300
			) {
				throw new Error(
					`Predecessor active operation unexpectedly completed successfully: HTTP ${String(activeOutcome.status)}.`,
				);
			}

			const [affectedAfterProbe, siblingAfterProbe] = await Promise.all([
				callWriteReadProbe({
					harness: activeHarness,
					identity: affectedIdentity,
					marker: `AFFECTED_AFTER_${randomUUID()}`,
				}),
				callWriteReadProbe({
					harness: activeHarness,
					identity: siblingIdentity,
					marker: `SIBLING_AFTER_${randomUUID()}`,
				}),
			]);
			const recordsAfter = await readCurrentRecords(
				controllerRecordTargets.toolLeaseRecords,
				configuredAgentIds,
				successor.result.vm.id,
			);
			const affectedRecordAfter = recordsAfter.get(affectedAfterProbe.agentId);
			const siblingRecordAfter = recordsAfter.get(siblingAfterProbe.agentId);
			if (affectedRecordAfter === undefined || siblingRecordAfter === undefined) {
				throw new Error('Expected fresh successor Tool VM runtime records.');
			}
			for (const record of [affectedRecordAfter, siblingRecordAfter]) {
				expect(record.gateway.gatewayVmId).toBe(successor.result.vm.id);
			}
			expect(affectedRecordAfter.leaseId).not.toBe(affectedRecordBefore.leaseId);
			expect(siblingRecordAfter.leaseId).not.toBe(siblingRecordBefore.leaseId);
			expect(affectedRecordAfter.vmId).not.toBe(affectedRecordBefore.vmId);
			expect(siblingRecordAfter.vmId).not.toBe(siblingRecordBefore.vmId);

			const markerLines = (await fs.readFile(operationHostPath, 'utf8'))
				.split('\n')
				.filter((line) => line === operationMarker);
			expect(markerLines).toHaveLength(1);
			expect((await fs.readFile(sentinelHostPath, 'utf8')).trim()).toBe(operationMarker);

			const successorRuntimeRecord = await loadManagedGatewayRuntimeRecord(
				controllerRecordTargets.managedGatewayRuntimeRecord,
			);
			if (
				successorRuntimeRecord === null ||
				successorRuntimeRecord.vmId !== successor.result.vm.id
			) {
				throw new Error('Expected the exact successor managed Gateway runtime record.');
			}
			const transitionArtifact = JSON.stringify({
				activeOutcome,
				committedOperation: { markerCount: markerLines.length, marker: operationMarker },
				predecessor: {
					cohort: predecessor.result.expectedCohort,
					containment: predecessorContainment,
					vmId: predecessor.result.vm.id,
				},
				successor: {
					cohort: successor.result.expectedCohort,
					vmId: successor.result.vm.id,
				},
				withdrawnIngressOutcome,
			});
			const processIdentity = (record: ToolVmRuntimeRecord): string =>
				`process-${hashControlLeaseReliabilityArtifact(
					`${record.processIdentity.command}\n${record.processIdentity.lstart}`,
				).slice(0, 32)}`;
			const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
				expectedOperationId: reliabilityOperationId,
				payload: {
					artifacts: [
						{
							operationId: 'active-operation-whole-gateway-transition',
							sha256: hashControlLeaseReliabilityArtifact(transitionArtifact),
						},
					],
					generationIdentities: [
						{ generation: 1, targetId: predecessor.result.vm.id, targetKind: 'gateway' },
						{ generation: 2, targetId: successor.result.vm.id, targetKind: 'gateway' },
					],
					packageIdentities: [await readPackageIdentity()],
					processIdentities: [
						{
							bootId: `gateway-${predecessor.result.vm.id}`,
							kind: 'gateway-qemu',
							processId: predecessor.hostProcessId,
							startIdentity: `process-${hashControlLeaseReliabilityArtifact(
								predecessorRuntimeRecord.processIdentity.lstart,
							).slice(0, 32)}`,
						},
						{
							bootId: `gateway-${successor.result.vm.id}`,
							kind: 'gateway-qemu',
							processId: successor.hostProcessId,
							startIdentity: `process-${hashControlLeaseReliabilityArtifact(
								successorRuntimeRecord.processIdentity.lstart,
							).slice(0, 32)}`,
						},
						...[affectedRecordBefore, siblingRecordBefore].map((record) => ({
							bootId: record.gateway.gatewayEpochId,
							kind: 'tool-vm-process' as const,
							processId: record.qemuPid,
							startIdentity: processIdentity(record),
						})),
					],
					runtimeIdentities: [
						{ generation: 1, id: predecessor.result.vm.id, kind: 'gateway-vm' },
						{ generation: 2, id: successor.result.vm.id, kind: 'gateway-vm' },
						{ generation: 1, id: affectedRecordBefore.vmId, kind: 'tool-vm' },
						{ generation: 1, id: siblingRecordBefore.vmId, kind: 'tool-vm' },
						{ generation: 2, id: affectedRecordAfter.vmId, kind: 'tool-vm' },
						{ generation: 2, id: siblingRecordAfter.vmId, kind: 'tool-vm' },
					],
				},
			});
			expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
		}, 900_000);
	},
);
