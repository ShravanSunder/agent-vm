/* oxlint-disable eslint/no-await-in-loop -- serialized faults and stability observations are intentional */
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
const canRunRecoveryNoFlapE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeRecoveryNoFlapE2e = canRunRecoveryNoFlapE2e ? describe : describe.skip;
const zoneId = 'recovery-no-flap';
const gatewayToken = 'recovery-no-flap-gateway-token';
const probeSigningKey = 'recovery-no-flap-proof-key';
const reliabilityOperationId = 'recovery-no-flap';
const requiredRecoveryCount = 3;
const stabilityWindowMs = 60_000;
const stabilityProbeIntervalMs = 5_000;
const mainIdentity = {
	agentId: 'main',
	sessionKey: 'agent:main:tool-vm-write-read:recovery-no-flap-main',
} as const;
const betaIdentity = {
	agentId: 'beta',
	sessionKey: 'agent:beta:tool-vm-write-read:recovery-no-flap-beta',
} as const;
const configuredProbeIdentities = [mainIdentity, betaIdentity] as const;
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
}

interface ManagedGatewayStartObservation {
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly qemuPid: number;
	readonly vm: GatewayVmObservationOperations;
}

interface AdmittedGatewayObservation {
	readonly gatewayStart: ManagedGatewayStartObservation;
	readonly runtimeIds: Readonly<Record<'beta' | 'main', string>>;
	readonly runtimeRecord: ManagedGatewayRuntimeRecord;
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

function parseWriteReadResult(value: unknown): ToolVmWriteReadResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error(`Tool VM probe did not return successful details: ${JSON.stringify(value)}`);
	}
	const details = value.details;
	if (
		(details.agentId !== 'main' && details.agentId !== 'beta') ||
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

async function callWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly marker: string;
}): Promise<ToolVmWriteReadResult> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Recovery no-flap E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify({
		agentId: options.identity.agentId,
		filePath: `agent-vm-e2e-recovery-no-flap-${randomUUID()}.txt`,
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
		`${options.identity.agentId} Tool VM probe`,
		60_000,
	);
	const responseBody: unknown = await response.json();
	if (!response.ok) {
		throw new Error(`Tool VM probe failed with HTTP ${String(response.status)}.`);
	}
	return parseWriteReadResult(responseBody);
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

async function observeAggregateAdmission(options: {
	readonly gatewayStart: ManagedGatewayStartObservation;
	readonly harness: E2eHarnessRuntime;
	readonly markerPrefix: string;
	readonly recordTargets: ControllerGatewayRecordTargets;
}): Promise<AdmittedGatewayObservation> {
	const runtimeRecord = await loadManagedGatewayRuntimeRecord(
		options.recordTargets.managedGatewayRuntimeRecord,
	);
	if (runtimeRecord === null) {
		throw new Error('Managed Gateway aggregate admission omitted its runtime record.');
	}
	expect(runtimeRecord.vmId).toBe(options.gatewayStart.vm.id);
	expect(runtimeRecord.expectedCohort).toEqual(options.gatewayStart.expectedCohort);
	expect(options.gatewayStart.expectedCohort.fence.vmId).toBe(options.gatewayStart.vm.id);
	const probes = await Promise.all(
		configuredProbeIdentities.map(
			async (identity) =>
				await callWriteReadProbe({
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
	const runtimeIds = Object.fromEntries(
		Object.values(toolVmRecords).map((record) => [record.agentId, record.leaseId]),
	) as Readonly<Record<'beta' | 'main', string>>;
	expect(new Set(Object.values(runtimeIds)).size).toBe(configuredProbeIdentities.length);
	for (const record of Object.values(toolVmRecords)) {
		expect(record.gateway.gatewayVmId).toBe(options.gatewayStart.vm.id);
	}
	return { gatewayStart: options.gatewayStart, runtimeIds, runtimeRecord };
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

describeRecoveryNoFlapE2e('e2e: repeated whole-Gateway recovery followed by no-flap window', () => {
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	const gatewayStarts: ManagedGatewayStartObservation[] = [];

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: configuredProbeIdentities.map(({ agentId }) => agentId),
			architecture,
			prefix: 'recovery-no-flap-e2e-',
			zoneId,
		});
		const systemZone = project.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected recovery no-flap project to contain an OpenClaw zone.');
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
					eventHistoryLimit: 400,
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
				GITHUB_TOKEN: 'unused-recovery-no-flap-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-recovery-no-flap-token',
			},
			startGatewayZone: async (startOptions) => {
				const result = await startGatewayZone(startOptions);
				if (result.executionModel !== 'managed-gateway') {
					throw new Error('Recovery no-flap proof requires managed Gateway image boot.');
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

	it('replaces three failed cohorts and then keeps the admitted successor stable', async () => {
		if (harness === undefined || project === undefined) {
			throw new Error('Expected recovery no-flap harness.');
		}
		const activeHarness = harness;
		const systemZone = project.systemConfig.zones[0];
		const initialStart = gatewayStarts[0];
		if (
			systemZone === undefined ||
			systemZone.gateway.type !== 'openclaw' ||
			initialStart === undefined
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
		const admittedGateways: AdmittedGatewayObservation[] = [
			await observeAggregateAdmission({
				gatewayStart: initialStart,
				harness: activeHarness,
				markerPrefix: 'INITIAL',
				recordTargets: controllerRecordTargets,
			}),
		];
		const recoveryEvents: Extract<
			AgentVmHealthEvent,
			{ readonly kind: 'gateway-recovery'; readonly result: 'ok' }
		>[] = [];

		for (let recoveryIndex = 1; recoveryIndex <= requiredRecoveryCount; recoveryIndex += 1) {
			const predecessor = admittedGateways.at(-1);
			if (predecessor === undefined)
				throw new Error('Previous admitted Gateway became unavailable.');
			await killFrameworkSibling(predecessor.gatewayStart);
			const recoveryEvent = await waitForGatewayReplacementEvent({
				controllerUrl: activeHarness.controllerUrl,
				oldVmId: predecessor.gatewayStart.vm.id,
				controllerRuntimeDir: activeHarness.systemConfig.controllerRuntimeDir,
				timeoutMs: 300_000,
			});
			recoveryEvents.push(recoveryEvent);
			const successorStart = gatewayStarts.find((start) => start.vm.id === recoveryEvent.newVmId);
			if (successorStart === undefined) {
				throw new Error(`Gateway replacement '${recoveryEvent.newVmId}' was not observed.`);
			}
			expectFreshManagedGatewayCohort({
				predecessor: predecessor.gatewayStart,
				successor: successorStart,
			});
			expect(recoveryEvent).toMatchObject({
				action: 'gateway-vm-restart',
				oldVmId: predecessor.gatewayStart.vm.id,
				result: 'ok',
				zoneId,
			});
			expect(['gateway-control-session-unhealthy', 'gateway-service-unhealthy']).toContain(
				recoveryEvent.reason,
			);
			const successor = await observeAggregateAdmission({
				gatewayStart: successorStart,
				harness: activeHarness,
				markerPrefix: `RECOVERY_${String(recoveryIndex)}`,
				recordTargets: controllerRecordTargets,
			});
			const predecessorRuntimeIds = new Set(Object.values(predecessor.runtimeIds));
			for (const runtimeId of Object.values(successor.runtimeIds)) {
				expect(predecessorRuntimeIds.has(runtimeId)).toBe(false);
			}
			admittedGateways.push(successor);
			if (recoveryIndex < requiredRecoveryCount) {
				const stabilizationStartedAtMs = Date.now();
				const stabilizationGatewayStartCount = gatewayStarts.length;
				let stabilizationObservationCount = 0;
				while (
					Date.now() - stabilizationStartedAtMs <
					recoveryGatewayServiceAutoRestart.restartTimeoutMs + stabilityProbeIntervalMs
				) {
					const identity =
						configuredProbeIdentities[
							stabilizationObservationCount % configuredProbeIdentities.length
						];
					if (identity === undefined) {
						throw new Error('Recovery stabilization identity selection failed.');
					}
					const stabilizationProbe = await callWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `STABILIZING_${String(recoveryIndex)}_${String(stabilizationObservationCount)}_${identity.agentId}_${randomUUID()}`,
					});
					expect(stabilizationProbe.readBack).toBe(stabilizationProbe.marker);
					const stabilizationRecords = await loadConfiguredToolVmRuntimeRecords({
						expectedGateway: successor.runtimeRecord.gateway,
						recordTargets: controllerRecordTargets,
					});
					expect(stabilizationRecords[identity.agentId].leaseId).toBe(
						successor.runtimeIds[identity.agentId],
					);
					expect(gatewayStarts).toHaveLength(stabilizationGatewayStartCount);
					stabilizationObservationCount += 1;
					await waitForProtocolRetryInterval(stabilityProbeIntervalMs);
				}
				expect(stabilizationObservationCount).toBeGreaterThanOrEqual(2);
			}
		}

		expect(admittedGateways).toHaveLength(requiredRecoveryCount + 1);
		expect(new Set(admittedGateways.map((gateway) => gateway.gatewayStart.vm.id)).size).toBe(
			requiredRecoveryCount + 1,
		);
		expect(
			new Set(
				admittedGateways.map((gateway) => gateway.gatewayStart.expectedCohort.fence.gatewayEpoch),
			).size,
		).toBe(requiredRecoveryCount + 1);

		const stableGateway = admittedGateways.at(-1);
		if (stableGateway === undefined) throw new Error('Final admitted Gateway became unavailable.');
		const quietWindowStartedAtMs = Date.now();
		const quietWindowGatewayStartCount = gatewayStarts.length;
		let stabilityObservationCount = 0;
		while (Date.now() - quietWindowStartedAtMs < stabilityWindowMs) {
			const identity =
				configuredProbeIdentities[stabilityObservationCount % configuredProbeIdentities.length];
			if (identity === undefined) throw new Error('Stability probe identity selection failed.');
			const probe = await callWriteReadProbe({
				harness: activeHarness,
				identity,
				marker: `QUIET_${String(stabilityObservationCount)}_${identity.agentId}_${randomUUID()}`,
			});
			expect(probe.readBack).toBe(probe.marker);
			const quietWindowRecords = await loadConfiguredToolVmRuntimeRecords({
				expectedGateway: stableGateway.runtimeRecord.gateway,
				recordTargets: controllerRecordTargets,
			});
			expect(quietWindowRecords[identity.agentId].leaseId).toBe(
				stableGateway.runtimeIds[identity.agentId],
			);
			expect(gatewayStarts).toHaveLength(quietWindowGatewayStartCount);
			stabilityObservationCount += 1;
			await waitForProtocolRetryInterval(stabilityProbeIntervalMs);
		}
		const quietWindowEndedAtMs = Date.now();
		expect(quietWindowEndedAtMs - quietWindowStartedAtMs).toBeGreaterThanOrEqual(stabilityWindowMs);
		expect(stabilityObservationCount).toBeGreaterThanOrEqual(2);
		expect(gatewayStarts).toHaveLength(requiredRecoveryCount + 1);

		const budgetsArtifact = JSON.stringify({
			observedRecoveryCount: recoveryEvents.length,
			policy: recoveryGatewayServiceAutoRestart,
			quietWindow: {
				endedAtMs: quietWindowEndedAtMs,
				observationCount: stabilityObservationCount,
				probeIntervalMs: stabilityProbeIntervalMs,
				startedAtMs: quietWindowStartedAtMs,
				windowMs: quietWindowEndedAtMs - quietWindowStartedAtMs,
			},
		});
		const identityArtifact = JSON.stringify({
			cohorts: admittedGateways.map((gateway) => ({
				expectedCohort: gateway.gatewayStart.expectedCohort,
				runtimeIds: gateway.runtimeIds,
				vmId: gateway.gatewayStart.vm.id,
			})),
			recoveryEvents,
		});
		const runScopedQueryMarker = `quiet-${hashControlLeaseReliabilityArtifact(
			process.env.AGENT_VM_RELIABILITY_RUN_ID ?? 'local',
		).slice(0, 24)}`;
		const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
			expectedOperationId: reliabilityOperationId,
			payload: {
				artifacts: [
					{
						operationId: 'whole-gateway-recovery-no-flap-budgets',
						sha256: hashControlLeaseReliabilityArtifact(budgetsArtifact),
					},
					{
						operationId: 'whole-gateway-recovery-no-flap-identities',
						sha256: hashControlLeaseReliabilityArtifact(identityArtifact),
					},
				],
				generationIdentities: admittedGateways.map((gateway, generationIndex) => ({
					generation: generationIndex + 1,
					targetId: gateway.gatewayStart.expectedCohort.fence.gatewayEpoch,
					targetKind: 'gateway-cohort',
				})),
				packageIdentities: [await readPackageIdentity()],
				processIdentities: admittedGateways.map((gateway) => ({
					bootId: `gateway-${gateway.gatewayStart.vm.id}`,
					kind: 'gateway-qemu',
					processId: gateway.gatewayStart.qemuPid,
					startIdentity: `process-${hashControlLeaseReliabilityArtifact(
						gateway.runtimeRecord.processIdentity.lstart,
					).slice(0, 32)}`,
				})),
				queryIdentities: [
					{
						marker: runScopedQueryMarker,
						source: 'whole-gateway-recovery-no-flap-stability-window',
						windowEndMs: quietWindowEndedAtMs,
						windowStartMs: quietWindowStartedAtMs,
					},
				],
				runtimeIdentities: [
					...admittedGateways.map((gateway, generationIndex) => ({
						generation: generationIndex + 1,
						id: gateway.gatewayStart.vm.id,
						kind: 'gateway-vm',
					})),
					...Object.values(stableGateway.runtimeIds).map((runtimeId) => ({
						generation: requiredRecoveryCount + 1,
						id: runtimeId,
						kind: 'tool-vm-lease',
					})),
				],
			},
		});
		expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
	}, 900_000);
});
