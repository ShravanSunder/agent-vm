/* oxlint-disable eslint/no-await-in-loop -- stability probes are sequential against live VMs */
import { randomUUID } from 'node:crypto';
import fs, { watch } from 'node:fs/promises';
import path from 'node:path';

import type { AgentVmHealthEvent, ZoneHealthSnapshot } from '@agent-vm/gateway-lifecycle';
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
} from '../controller/durable-state/controller-state-record-paths.js';
import {
	controllerHealthEventLogPath,
	readDurableHealthEvents,
} from '../controller/health/durable-health-event-log.js';
import {
	loadAllToolVmRuntimeRecords,
	type ToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import {
	readManagedGatewaySiblingProcessIdentity,
	terminateManagedGatewaySibling,
} from '../controller/reliability/testing/gateway-reliability-fault-adapter.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../controller/vm-ownership/vm-ownership-contracts.js';
import type { GatewayExpectedAdmissionCohort } from '../gateway/gateway-aggregate-admission-state.js';
import {
	loadManagedGatewayRuntimeRecord,
	type ManagedGatewayRuntimeRecord,
} from '../gateway/gateway-runtime-record.js';
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
const runOpenClawProcessRecoveryE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeOpenClawProcessRecoveryE2e = runOpenClawProcessRecoveryE2e ? describe : describe.skip;
const zoneId = 'process-recovery-smoke';
const gatewayToken = 'process-recovery-smoke-gateway-token';
const probeSigningKey = 'process-recovery-tool-vm-write-read-proof-key';
const mainIdentity = {
	agentId: 'main',
	sessionKey: 'agent:main:tool-vm-write-read:process-recovery-main',
} as const;
const betaIdentity = {
	agentId: 'beta',
	sessionKey: 'agent:beta:tool-vm-write-read:process-recovery-beta',
} as const;
const configuredProbeIdentities = [mainIdentity, betaIdentity] as const;
const stabilityWindowMs = 60_000;
const stabilityProbeIntervalMs = 2_000;
const reliabilityOperationId = 'openclaw-process-recovery';
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

interface ToolVmWriteReadResult {
	readonly agentId: 'beta' | 'main';
	readonly marker: string;
	readonly readBack: string;
	readonly status: 'ok';
}

interface ManagedGatewayStartObservation {
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly qemuPid: number;
	readonly vm: GatewayVmObservationOperations;
}

class E2eTimeoutError extends Error {}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function latestEvents(snapshot: ZoneHealthSnapshot): readonly AgentVmHealthEvent[] {
	return 'latestEvents' in snapshot ? snapshot.latestEvents : [];
}

function withTimeout<TValue>(
	promise: Promise<TValue>,
	timeoutMs: number,
	message: string,
): Promise<TValue> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new E2eTimeoutError(message)), timeoutMs);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeout !== undefined) clearTimeout(timeout);
	});
}

async function readHealthSnapshot(controllerUrl: string): Promise<ZoneHealthSnapshot> {
	const response = await fetch(
		`${controllerUrl}/zones/${encodeURIComponent(zoneId)}/health-snapshot`,
	);
	if (!response.ok) {
		throw new Error(`Health snapshot returned HTTP ${String(response.status)}.`);
	}
	return (await response.json()) as ZoneHealthSnapshot;
}

async function waitForGatewayReplacementEvent(options: {
	readonly controllerUrl: string;
	readonly oldVmId: string;
	readonly controllerRuntimeDir: string;
	readonly timeoutMs: number;
}): Promise<
	Extract<AgentVmHealthEvent, { readonly kind: 'gateway-recovery'; readonly result: 'ok' }>
> {
	const matches = (
		event: AgentVmHealthEvent,
	): event is Extract<
		AgentVmHealthEvent,
		{ readonly kind: 'gateway-recovery'; readonly result: 'ok' }
	> =>
		event.kind === 'gateway-recovery' &&
		event.result === 'ok' &&
		event.action === 'gateway-vm-restart' &&
		event.oldVmId === options.oldVmId;
	const eventLogPath = controllerHealthEventLogPath(options.controllerRuntimeDir);
	await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
	await fs.appendFile(eventLogPath, '', 'utf8');
	const watcher = watch(eventLogPath, { persistent: false });
	const deadlineMs = Date.now() + options.timeoutMs;
	try {
		while (true) {
			const event = (
				await readDurableHealthEvents({
					controllerRuntimeDir: options.controllerRuntimeDir,
				})
			)
				.map((record) => record.body)
				.find(matches);
			if (event !== undefined) return event;
			const remainingTimeoutMs = deadlineMs - Date.now();
			if (remainingTimeoutMs <= 0) break;
			try {
				const nextResult = await withTimeout(
					watcher.next(),
					remainingTimeoutMs,
					`Timed out waiting for Gateway replacement of '${options.oldVmId}'.`,
				);
				if (nextResult.done === true) break;
			} catch (error) {
				if (error instanceof E2eTimeoutError) break;
				throw error;
			}
		}
	} finally {
		await watcher.return?.();
	}
	const lastSnapshot = await readHealthSnapshot(options.controllerUrl).catch(() => undefined);
	const snapshotEvent =
		lastSnapshot === undefined ? undefined : latestEvents(lastSnapshot).find(matches);
	if (snapshotEvent !== undefined) return snapshotEvent;
	throw new Error(
		`Timed out waiting for Gateway replacement of '${options.oldVmId}'; last snapshot: ${JSON.stringify(lastSnapshot)}`,
	);
}

function parseToolVmWriteReadResult(value: unknown): ToolVmWriteReadResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error('Tool VM write/read probe did not return a successful result.');
	}
	const details = value.details;
	if (
		details.status !== 'ok' ||
		(details.agentId !== 'main' && details.agentId !== 'beta') ||
		typeof details.marker !== 'string' ||
		typeof details.readBack !== 'string'
	) {
		throw new Error('Tool VM write/read probe returned malformed details.');
	}
	return {
		agentId: details.agentId,
		marker: details.marker,
		readBack: details.readBack,
		status: details.status,
	};
}

async function loadConfiguredToolVmRuntimeRecords(options: {
	readonly expectedGateway: GatewayEpochIdentity;
	readonly recordTargets: ControllerGatewayRecordTargets;
}): Promise<Readonly<Record<'beta' | 'main', ToolVmRuntimeRecord>>> {
	const results = await loadAllToolVmRuntimeRecords(options.recordTargets.toolLeaseRecords);
	const parseError = results.find((result) => result.kind === 'parse-error');
	if (parseError !== undefined) {
		throw new Error(`Tool VM runtime record failed to parse: ${parseError.path}`);
	}
	const records = results
		.filter((result) => result.kind === 'loaded')
		.map((result) => result.record)
		.filter(
			(record) =>
				record.zoneId === zoneId &&
				configuredProbeIdentities.some((identity) => identity.agentId === record.agentId) &&
				gatewayIdentitiesEqual(record.gateway, options.expectedGateway),
		);
	if (records.length !== configuredProbeIdentities.length) {
		throw new Error(
			`Expected ${String(configuredProbeIdentities.length)} Tool VM runtime records for Gateway '${options.expectedGateway.gatewayVmId}', found ${String(records.length)}.`,
		);
	}
	const recordsByAgentId = Object.fromEntries(
		records.map((record) => [record.agentId, record]),
	) as Partial<Record<'beta' | 'main', ToolVmRuntimeRecord>>;
	if (recordsByAgentId.main === undefined || recordsByAgentId.beta === undefined) {
		throw new Error('Expected one Tool VM runtime record per configured agent.');
	}
	return { beta: recordsByAgentId.beta, main: recordsByAgentId.main };
}

async function callSignedWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly marker: string;
}): Promise<ToolVmWriteReadResult> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('OpenClaw process recovery E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify({
		agentId: options.identity.agentId,
		filePath: `agent-vm-e2e-process-recovery-${options.identity.agentId}-${randomUUID()}.txt`,
		marker: options.marker,
		action: 'write-read',
		sessionKey: options.identity.sessionKey,
	});
	const response = await withProtocolDeadline(
		fetch(
			`http://${ingress.host}:${String(ingress.port)}${AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH}`,
			{
				body: bodyText,
				headers: {
					authorization: `Bearer ${gatewayToken}`,
					'content-type': 'application/json',
					[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER]:
						gatewayRuntimeSandboxWriteReadE2eTestExports.signBody(bodyText, probeSigningKey),
				},
				method: 'POST',
			},
		),
		`Tool VM ${options.identity.agentId} write/read probe`,
		30_000,
	);
	const responseBody: unknown = await response.json();
	if (!response.ok) {
		throw new Error(
			`Tool VM write/read probe failed with HTTP ${String(response.status)}: ${JSON.stringify(responseBody)}`,
		);
	}
	return parseToolVmWriteReadResult(responseBody);
}

async function killFrameworkSibling(start: ManagedGatewayStartObservation): Promise<void> {
	const frameworkPort = start.expectedCohort.ingressIntent.frameworkRootRoute.guestPort;
	const identity = await readManagedGatewaySiblingProcessIdentity({
		gatewayVm: start.vm,
		guestPort: frameworkPort,
		role: 'framework',
	});
	await terminateManagedGatewaySibling({ gatewayVm: start.vm, identity, role: 'framework' });
}

async function readAgentVmPackageIdentity(): Promise<{
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

async function assertAggregateAdmission(options: {
	readonly expectedStart: ManagedGatewayStartObservation;
	readonly harness: E2eHarnessRuntime;
	readonly markerPrefix: string;
	readonly recordTargets: ControllerGatewayRecordTargets;
}): Promise<{
	readonly probes: readonly ToolVmWriteReadResult[];
	readonly runtimeRecord: ManagedGatewayRuntimeRecord;
	readonly toolVmRecords: Readonly<Record<'beta' | 'main', ToolVmRuntimeRecord>>;
}> {
	const runtimeRecord = await loadManagedGatewayRuntimeRecord(
		options.recordTargets.managedGatewayRuntimeRecord,
	);
	if (runtimeRecord === null) {
		throw new Error('Managed Gateway aggregate admission omitted its runtime record.');
	}
	expect(runtimeRecord.vmId).toBe(options.expectedStart.vm.id);
	expect(runtimeRecord.expectedCohort).toEqual(options.expectedStart.expectedCohort);
	expect(options.expectedStart.expectedCohort.fence.vmId).toBe(options.expectedStart.vm.id);
	const probes = await Promise.all(
		configuredProbeIdentities.map(
			async (identity) =>
				await callSignedWriteReadProbe({
					harness: options.harness,
					identity,
					marker: `${options.markerPrefix}_${identity.agentId}_${randomUUID()}`,
				}),
		),
	);
	for (const probe of probes) expect(probe.readBack).toBe(probe.marker);
	const toolVmRecords = await loadConfiguredToolVmRuntimeRecords({
		expectedGateway: runtimeRecord.gateway,
		recordTargets: options.recordTargets,
	});
	for (const record of Object.values(toolVmRecords)) {
		expect(record.gateway.gatewayVmId).toBe(options.expectedStart.vm.id);
	}
	return { probes, runtimeRecord, toolVmRecords };
}

function expectFreshManagedGatewayCohort(options: {
	readonly predecessor: ManagedGatewayStartObservation;
	readonly successor: ManagedGatewayStartObservation;
}): void {
	expect(options.successor.vm.id).not.toBe(options.predecessor.vm.id);
	expect(options.successor.expectedCohort.fence.gatewayEpoch).not.toBe(
		options.predecessor.expectedCohort.fence.gatewayEpoch,
	);
	expect(options.successor.expectedCohort.frameworkIdentity.frameworkEpoch).not.toBe(
		options.predecessor.expectedCohort.frameworkIdentity.frameworkEpoch,
	);
	expect(options.successor.expectedCohort.toolPortalIdentity.processEpoch).not.toBe(
		options.predecessor.expectedCohort.toolPortalIdentity.processEpoch,
	);
	expect(options.successor.expectedCohort.toolPortalIdentity.runtimeEpoch).not.toBe(
		options.predecessor.expectedCohort.toolPortalIdentity.runtimeEpoch,
	);
}

describeOpenClawProcessRecoveryE2e(
	'e2e: managed Gateway recovery after OpenClaw sibling loss',
	() => {
		let harness: E2eHarnessRuntime | undefined;
		let project: OpenClawE2eProject | undefined;
		const gatewayStarts: ManagedGatewayStartObservation[] = [];

		beforeAll(async () => {
			const repoRoot = path.resolve(process.cwd());
			project = await scaffoldOpenClawE2eProject({
				agents: configuredProbeIdentities.map((identity) => identity.agentId),
				architecture,
				prefix: 'openclaw-process-recovery-e2e-',
				zoneId,
			});
			const systemZone = project.systemConfig.zones[0];
			if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
				throw new Error('Expected process recovery E2E project to contain an OpenClaw zone.');
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
			harness = await startE2eControllerRuntime({
				secrets: {
					[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV]: '1',
					[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV]:
						JSON.stringify(configuredProbeIdentities),
					[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV]: probeSigningKey,
					GITHUB_TOKEN: 'unused-process-recovery-token',
					OPENCLAW_GATEWAY_TOKEN: gatewayToken,
					PERPLEXITY_API_KEY: 'unused-process-recovery-token',
				},
				startGatewayZone: async (startOptions) => {
					const result = await startGatewayZone(startOptions);
					if (result.executionModel !== 'managed-gateway') {
						throw new Error('OpenClaw recovery proof requires managed Gateway image boot.');
					}
					const qemuPid = result.vm.getHostProcessId();
					if (qemuPid === null) throw new Error('Managed Gateway start omitted its QEMU pid.');
					gatewayStarts.push({ expectedCohort: result.expectedCohort, qemuPid, vm: result.vm });
					return result;
				},
				startOptions: { systemConfig, zoneIds: [zoneId] },
			});
		}, 900_000);

		afterAll(async () => {
			try {
				await harness?.close();
			} finally {
				if (project !== undefined && harness === undefined) {
					await removeE2eTempRoot(project.tempRoot);
				}
			}
		});

		it('replaces the whole Gateway cohort and restores aggregate admission with fresh Tool VM leaves', async () => {
			if (harness === undefined || project === undefined) {
				throw new Error('Expected process recovery E2E harness.');
			}
			const activeHarness = harness;
			const systemZone = project.systemConfig.zones[0];
			const predecessor = gatewayStarts[0];
			if (
				systemZone === undefined ||
				systemZone.gateway.type !== 'openclaw' ||
				predecessor === undefined
			) {
				throw new Error('Expected initial managed OpenClaw Gateway.');
			}
			const controllerRecordTargets = resolveControllerGatewayRecordTargets({
				gatewayStateRoot: resolveControllerGatewayStateRoot({
					controllerStateRoot: createControllerStateRoot({
						controllerStateDirectoryPath: activeHarness.systemConfig.controllerStateDir,
					}),
					zoneId,
				}),
			});
			const initialAdmission = await assertAggregateAdmission({
				expectedStart: predecessor,
				harness: activeHarness,
				markerPrefix: 'INITIAL',
				recordTargets: controllerRecordTargets,
			});
			const initialRuntimeIds = new Set(
				Object.values(initialAdmission.toolVmRecords).map((record) => record.leaseId),
			);
			expect(initialRuntimeIds.size).toBe(configuredProbeIdentities.length);

			await killFrameworkSibling(predecessor);
			const recoveryEvent = await waitForGatewayReplacementEvent({
				controllerUrl: activeHarness.controllerUrl,
				oldVmId: predecessor.vm.id,
				controllerRuntimeDir: activeHarness.systemConfig.controllerRuntimeDir,
				timeoutMs: 300_000,
			});
			const successor = gatewayStarts.find((start) => start.vm.id === recoveryEvent.newVmId);
			if (successor === undefined) {
				throw new Error(`Gateway replacement '${recoveryEvent.newVmId}' was not observed.`);
			}
			expectFreshManagedGatewayCohort({ predecessor, successor });
			expect(recoveryEvent).toMatchObject({
				action: 'gateway-vm-restart',
				oldVmId: predecessor.vm.id,
				result: 'ok',
				zoneId,
			});
			expect(['gateway-control-session-unhealthy', 'gateway-service-unhealthy']).toContain(
				recoveryEvent.reason,
			);
			const successorAdmission = await assertAggregateAdmission({
				expectedStart: successor,
				harness: activeHarness,
				markerPrefix: 'SUCCESSOR',
				recordTargets: controllerRecordTargets,
			});
			for (const record of Object.values(successorAdmission.toolVmRecords)) {
				expect(initialRuntimeIds.has(record.leaseId)).toBe(false);
			}

			const stableGatewayStartCount = gatewayStarts.length;
			const stableRuntimeIds = Object.fromEntries(
				Object.values(successorAdmission.toolVmRecords).map((record) => [
					record.agentId,
					record.leaseId,
				]),
			) as Readonly<Record<'beta' | 'main', string>>;
			const stabilityStartedAtMs = Date.now();
			let probeIndex = 0;
			while (Date.now() - stabilityStartedAtMs < stabilityWindowMs) {
				const identity = configuredProbeIdentities[probeIndex % configuredProbeIdentities.length];
				if (identity === undefined) throw new Error('Stability probe identity selection failed.');
				await waitForProtocolRetryInterval(stabilityProbeIntervalMs);
				const probe = await callSignedWriteReadProbe({
					harness: activeHarness,
					identity,
					marker: `STABLE_${identity.agentId}_${String(probeIndex)}_${randomUUID()}`,
				});
				expect(probe.readBack).toBe(probe.marker);
				const stableRecords = await loadConfiguredToolVmRuntimeRecords({
					expectedGateway: successorAdmission.runtimeRecord.gateway,
					recordTargets: controllerRecordTargets,
				});
				expect(stableRecords[identity.agentId].leaseId).toBe(stableRuntimeIds[identity.agentId]);
				expect(gatewayStarts).toHaveLength(stableGatewayStartCount);
				probeIndex += 1;
			}
			expect(probeIndex).toBeGreaterThanOrEqual(2);

			const transitionArtifact = JSON.stringify({
				predecessor: {
					cohort: predecessor.expectedCohort,
					runtimeIds: [...initialRuntimeIds],
					vmId: predecessor.vm.id,
				},
				recoveryEvent,
				successor: {
					cohort: successor.expectedCohort,
					runtimeIds: Object.values(stableRuntimeIds),
					vmId: successor.vm.id,
				},
			});
			const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
				expectedOperationId: reliabilityOperationId,
				payload: {
					artifacts: [
						{
							operationId: 'managed-gateway-whole-vm-transition',
							sha256: hashControlLeaseReliabilityArtifact(transitionArtifact),
						},
					],
					generationIdentities: [predecessor, successor].map((start, generationIndex) => ({
						generation: generationIndex + 1,
						targetId: start.expectedCohort.fence.gatewayEpoch,
						targetKind: 'gateway-cohort',
					})),
					packageIdentities: [await readAgentVmPackageIdentity()],
					processIdentities: [
						{
							bootId: `gateway-${predecessor.vm.id}`,
							kind: 'gateway-qemu',
							processId: predecessor.qemuPid,
							startIdentity: `process-${hashControlLeaseReliabilityArtifact(
								initialAdmission.runtimeRecord.processIdentity.lstart,
							).slice(0, 32)}`,
						},
						{
							bootId: `gateway-${successor.vm.id}`,
							kind: 'gateway-qemu',
							processId: successor.qemuPid,
							startIdentity: `process-${hashControlLeaseReliabilityArtifact(
								successorAdmission.runtimeRecord.processIdentity.lstart,
							).slice(0, 32)}`,
						},
					],
					runtimeIdentities: [
						{ generation: 1, id: predecessor.vm.id, kind: 'gateway-vm' },
						{ generation: 2, id: successor.vm.id, kind: 'gateway-vm' },
						...Object.values(successorAdmission.toolVmRecords).map((record) => ({
							generation: 2,
							id: record.leaseId,
							kind: 'tool-vm-lease',
						})),
					],
				},
			});
			expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
		}, 600_000);
	},
);
