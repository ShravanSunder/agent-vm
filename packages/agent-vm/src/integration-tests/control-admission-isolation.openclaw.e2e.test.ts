import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
	CONTROL_PROTOCOL_VERSION,
	ControlEnvelopeSchema,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlRpcCommandResultMessageSchema,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import type { ManagedVm } from '@agent-vm/managed-vm';
import {
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER,
	testExports as toolVmWriteReadE2eToolTestExports,
} from '@agent-vm/openclaw-agent-vm-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	loadAllToolVmRuntimeRecords,
	type ToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import {
	expectedControlLeaseReliabilityEvidenceWriteKind,
	hashControlLeaseReliabilityArtifact,
	writeControlLeaseReliabilityEvidence,
} from './control-lease-reliability-evidence.js';
import {
	canRunGondolinE2e,
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
import { withProtocolDeadline } from './e2e-protocol-wait.js';

const architecture = currentE2eArchitecture();
const canRunControlAdmissionIsolationE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeControlAdmissionIsolationE2e = canRunControlAdmissionIsolationE2e
	? describe
	: describe.skip;
const zoneId = 'control-admission-isolation';
const gatewayToken = 'control-admission-isolation-gateway-token';
const probeSigningKey = 'control-admission-isolation-proof-key';
const controlAdmissionPressureEnv = 'AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE';
const reliabilityOperationId = 'control-admission-isolation';
const mainIdentity = {
	agentId: 'main',
	sessionKey: 'agent:main:tool-vm-write-read:control-admission-main',
} as const;
const betaIdentity = {
	agentId: 'beta',
	sessionKey: 'agent:beta:tool-vm-write-read:control-admission-beta',
} as const;
const configuredProbeIdentities = [mainIdentity, betaIdentity] as const;

interface OpenClawProcessIdentity {
	readonly pid: number;
	readonly startTimeTicks: string;
}

interface ToolVmWriteReadResult {
	readonly agentId: string;
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
}

interface AdmissionDirectionDiagnostics {
	readonly activeByClass: Readonly<Record<string, number>>;
	readonly queuedByClass: Readonly<Record<string, number>>;
	readonly scheduler: {
		readonly diagnosticMessages: number;
		readonly droppedMessages: number;
		readonly shedMessages: number;
	};
}

interface AdmissionPressureSnapshot {
	readonly acceptedAttachmentGeneration: number;
	readonly capacities: {
		readonly queue: { readonly diagnostic: { readonly maxMessages: number } };
	};
	readonly egress: AdmissionDirectionDiagnostics;
	readonly highWater: {
		readonly egress: Readonly<Record<string, number>>;
	};
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWriteReadResult(value: unknown): ToolVmWriteReadResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error(`Tool VM probe did not return successful details: ${JSON.stringify(value)}`);
	}
	const details = value.details;
	if (
		typeof details.agentId !== 'string' ||
		typeof details.marker !== 'string' ||
		typeof details.readBack !== 'string' ||
		typeof details.runtimeId !== 'string'
	) {
		throw new Error(`Tool VM probe details were malformed: ${JSON.stringify(details)}`);
	}
	return {
		agentId: details.agentId,
		marker: details.marker,
		readBack: details.readBack,
		runtimeId: details.runtimeId,
	};
}

function parseAdmissionPressureSnapshot(value: unknown): AdmissionPressureSnapshot {
	if (
		!isObjectRecord(value) ||
		typeof value.acceptedAttachmentGeneration !== 'number' ||
		!isObjectRecord(value.capacities) ||
		!isObjectRecord(value.capacities.queue) ||
		!isObjectRecord(value.capacities.queue.diagnostic) ||
		typeof value.capacities.queue.diagnostic.maxMessages !== 'number' ||
		!isObjectRecord(value.egress) ||
		!isObjectRecord(value.egress.activeByClass) ||
		!isObjectRecord(value.egress.queuedByClass) ||
		!isObjectRecord(value.egress.scheduler) ||
		typeof value.egress.scheduler.diagnosticMessages !== 'number' ||
		typeof value.egress.scheduler.droppedMessages !== 'number' ||
		typeof value.egress.scheduler.shedMessages !== 'number' ||
		!isObjectRecord(value.highWater) ||
		!isObjectRecord(value.highWater.egress)
	) {
		throw new Error(`Control admission snapshot was malformed: ${JSON.stringify(value)}`);
	}
	return value as unknown as AdmissionPressureSnapshot;
}

async function callSignedRoute(options: {
	readonly body: Readonly<Record<string, unknown>>;
	readonly harness: E2eHarnessRuntime;
	readonly operationName: string;
	readonly timeoutMs: number;
}): Promise<unknown> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Control admission isolation E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify(options.body);
	const response = await withProtocolDeadline(
		fetch(
			`http://${ingress.host}:${String(ingress.port)}${AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH}`,
			{
				body: bodyText,
				headers: {
					authorization: `Bearer ${gatewayToken}`,
					'content-type': 'application/json',
					[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER]:
						toolVmWriteReadE2eToolTestExports.signToolVmWriteReadE2eRouteBody(
							bodyText,
							probeSigningKey,
						),
				},
				method: 'POST',
			},
		),
		options.operationName,
		options.timeoutMs,
	);
	const responseBody: unknown = await response.json();
	if (!response.ok) {
		throw new Error(
			`${options.operationName} failed with HTTP ${String(response.status)}: ${JSON.stringify(responseBody)}`,
		);
	}
	if (!isObjectRecord(responseBody) || responseBody.ok !== true || !('details' in responseBody)) {
		throw new Error(`${options.operationName} returned malformed route output.`);
	}
	return responseBody.details;
}

async function callWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly marker: string;
}): Promise<ToolVmWriteReadResult> {
	const response = await callSignedRoute({
		body: {
			agentId: options.identity.agentId,
			filePath: `.agent-vm/control-admission-${options.identity.agentId}-${randomUUID()}.txt`,
			marker: options.marker,
			scenario: 'write-read',
			sessionKey: options.identity.sessionKey,
		},
		harness: options.harness,
		operationName: `${options.identity.agentId} lease SSH write/read probe`,
		timeoutMs: 60_000,
	});
	return parseWriteReadResult({ details: response, ok: true });
}

async function callAdmissionAction(options: {
	readonly action: 'hold' | 'release' | 'snapshot' | 'submitBatch';
	readonly attachmentGeneration: number;
	readonly fields?: Readonly<Record<string, unknown>>;
	readonly harness: E2eHarnessRuntime;
}): Promise<unknown> {
	return await callSignedRoute({
		body: {
			action: options.action,
			agentId: mainIdentity.agentId,
			attachmentGeneration: options.attachmentGeneration,
			scenario: 'control-admission-pressure',
			sessionKey: mainIdentity.sessionKey,
			...options.fields,
		},
		harness: options.harness,
		operationName: `control admission ${options.action}`,
		timeoutMs: 30_000,
	});
}

async function readExactToolVmRuntimeRecords(
	stateDirectory: string,
	leaseIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, ToolVmRuntimeRecord>> {
	const loadResults = await loadAllToolVmRuntimeRecords(stateDirectory);
	const parseError = loadResults.find((result) => result.kind === 'parse-error');
	if (parseError !== undefined) {
		throw new Error(`Tool VM runtime record failed to parse: ${parseError.path}`);
	}
	const records = loadResults
		.filter((result) => result.kind === 'loaded')
		.map((result) => result.record)
		.filter((record) => leaseIds.has(record.leaseId));
	if (records.length !== leaseIds.size) {
		throw new Error(
			`Expected ${String(leaseIds.size)} exact Tool VM records, found ${String(records.length)}.`,
		);
	}
	return new Map(records.map((record) => [record.leaseId, record] as const));
}

async function readOpenClawProcessIdentity(gatewayVm: ManagedVm): Promise<OpenClawProcessIdentity> {
	const result = await gatewayVm.exec(`
set -eu
port_hex="$(printf '%04X' 18789)"
socket_inode="$(awk -v port=":$port_hex" '$2 ~ port && $4 == "0A" { print $10; exit }' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)"
gateway_pid=""
for fd in /proc/[0-9]*/fd/*; do
  if [ "$(readlink "$fd" 2>/dev/null || true)" = "socket:[$socket_inode]" ]; then
    gateway_pid="$(echo "$fd" | cut -d / -f 3)"
    break
  fi
done
test -n "$gateway_pid"
start_time_ticks="$(awk '{ print $22 }' "/proc/$gateway_pid/stat")"
printf '%s %s\n' "$gateway_pid" "$start_time_ticks"
`);
	if (result.exitCode !== 0) {
		throw new Error(`OpenClaw process identity read failed: ${result.stderr}`);
	}
	const [pidText, startTimeTicks] = result.stdout.trim().split(/\s+/u);
	const pid = Number.parseInt(pidText ?? '', 10);
	if (!Number.isSafeInteger(pid) || pid <= 0 || startTimeTicks === undefined) {
		throw new Error(`Invalid OpenClaw process identity: ${result.stdout}`);
	}
	return { pid, startTimeTicks };
}

async function sendControllerControlPing(options: {
	readonly gatewayStart: Awaited<ReturnType<typeof startGatewayZone>>;
}): Promise<void> {
	const controlSession = options.gatewayStart.controlSession;
	const recoverySourceKey = options.gatewayStart.controlSessionRecoverySourceKey;
	const processEpoch = options.gatewayStart.processEpoch;
	if (
		controlSession === undefined ||
		recoverySourceKey === undefined ||
		processEpoch === undefined
	) {
		throw new Error('Expected a live Gateway control session for the pressure proof.');
	}
	const diagnostics = controlSession.getDiagnostics();
	const hello = diagnostics.lastHelloResponse;
	if (hello === undefined || hello.outcome !== 'accepted') {
		throw new Error(`Expected accepted control session: ${JSON.stringify(diagnostics)}`);
	}
	const envelope: ControlEnvelope = ControlEnvelopeSchema.parse({
		bootId: processEpoch,
		connectionId: hello.connectionId,
		controllerEpoch: hello.controllerEpoch,
		createdAtMs: Date.now(),
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation.control_ping,
		domain: 'gateway_control',
		kind: 'command',
		messageId: randomUUID(),
		operation: 'control_ping',
		peerId: `gateway-${recoverySourceKey.zoneId}`,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: 1,
		sessionId: hello.sessionId,
		zoneId: recoverySourceKey.zoneId,
	});
	const response = GatewayControlRpcCommandResultMessageSchema.parse(
		await withProtocolDeadline(
			controlSession.emitApplicationMessage(
				envelope,
				{ kind: 'command', operation: 'control_ping' },
				{ kind: 'command', operation: 'control_ping', payload: {} },
			),
			'controller-originated control ping under diagnostic pressure',
			15_000,
		),
	);
	expect(response).toMatchObject({
		kind: 'command_result',
		operation: 'control_ping',
		payload: { responseToMessageId: envelope.messageId, result: 'ok' },
	});
}

async function readAgentVmPackageIdentity(): Promise<{
	readonly checksumSha256: string;
	readonly name: string;
	readonly version: string;
}> {
	const packageText = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
	const parsed: unknown = JSON.parse(packageText);
	if (
		!isObjectRecord(parsed) ||
		typeof parsed.name !== 'string' ||
		typeof parsed.version !== 'string'
	) {
		throw new Error('Agent VM package identity was malformed.');
	}
	return {
		checksumSha256: hashControlLeaseReliabilityArtifact(packageText),
		name: parsed.name,
		version: parsed.version,
	};
}

describeControlAdmissionIsolationE2e('e2e: control admission pressure isolation', () => {
	let gatewayStart: Awaited<ReturnType<typeof startGatewayZone>> | undefined;
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: configuredProbeIdentities.map((identity) => identity.agentId),
			architecture,
			prefix: 'control-admission-isolation-e2e-',
			zoneId,
		});
		const systemZone = project.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected control admission isolation project to contain OpenClaw.');
		}
		const openClawGateway = systemZone.gateway;
		for (const envName of [
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV,
			controlAdmissionPressureEnv,
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
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV,
			controlAdmissionPressureEnv,
		];
		await Promise.all(
			configuredProbeIdentities.map(async ({ agentId }) => {
				await mkdir(path.join(openClawGateway.zoneFilesDir, 'agents', agentId), {
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
		harness = await startE2eControllerRuntime({
			secrets: {
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV]: '1',
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV]:
					JSON.stringify(configuredProbeIdentities),
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV]: probeSigningKey,
				[controlAdmissionPressureEnv]: '1',
				GITHUB_TOKEN: 'unused-control-admission-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-control-admission-token',
			},
			startGatewayZone: async (startOptions) => {
				const result = await startGatewayZone(startOptions);
				result.vm.configureIngressRoutes([
					{ port: result.processSpec.guestListenPort, prefix: '/', stripPrefix: true },
				]);
				gatewayStart = result;
				return result;
			},
			startOptions: { systemConfig: project.systemConfig, zoneIds: [zoneId] },
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

	it('drops bounded diagnostics without delaying control authority, safety replies, or either Tool leaf', async () => {
		if (gatewayStart?.controlSession === undefined || harness === undefined) {
			throw new Error('Expected control admission isolation harness initialization.');
		}
		const activeGatewayStart = gatewayStart;
		const activeControlSession = gatewayStart.controlSession;
		const activeHarness = harness;
		const activeZone = activeHarness.systemConfig.zones[0];
		if (activeZone === undefined) {
			throw new Error('Expected control admission isolation zone configuration.');
		}
		const initialResults = await Promise.all(
			configuredProbeIdentities.map(
				async (identity) =>
					await callWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `BEFORE_${identity.agentId}_${randomUUID()}`,
					}),
			),
		);
		const runtimeIds = Object.fromEntries(
			initialResults.map((result) => [result.agentId, result.runtimeId]),
		) as Record<'beta' | 'main', string>;
		expect(runtimeIds.main).not.toBe(runtimeIds.beta);
		const leaseIds = new Set(Object.values(runtimeIds));
		const initialToolRecords = await readExactToolVmRuntimeRecords(
			activeZone.gateway.stateDir,
			leaseIds,
		);
		const gatewayVmId = activeGatewayStart.vm.id;
		const processIdentity = await readOpenClawProcessIdentity(activeGatewayStart.vm);
		const diagnostics = activeControlSession.getDiagnostics();
		const attachmentGeneration = diagnostics.attachmentGeneration;
		const acceptedSessionId = diagnostics.lastHelloResponse?.sessionId;
		if (
			attachmentGeneration === undefined ||
			acceptedSessionId === undefined ||
			diagnostics.lastHelloResponse?.outcome !== 'accepted'
		) {
			throw new Error(`Expected exact accepted control session: ${JSON.stringify(diagnostics)}`);
		}

		const before = parseAdmissionPressureSnapshot(
			await callAdmissionAction({
				action: 'snapshot',
				attachmentGeneration,
				harness: activeHarness,
			}),
		);
		const holdResult = await callAdmissionAction({
			action: 'hold',
			attachmentGeneration,
			fields: { direction: 'egress', messageClass: 'diagnostic' },
			harness: activeHarness,
		});
		if (!isObjectRecord(holdResult) || typeof holdResult.holdId !== 'string') {
			throw new Error(`Control admission hold result was malformed: ${JSON.stringify(holdResult)}`);
		}
		const pressureResult = await callAdmissionAction({
			action: 'submitBatch',
			attachmentGeneration,
			fields: {
				batchSize: before.capacities.queue.diagnostic.maxMessages + 1,
				byteLength: 1,
				coalesceKeyPrefix: `diagnostic-${randomUUID()}`,
				direction: 'egress',
				messageClass: 'diagnostic',
			},
			harness: activeHarness,
		});
		if (!isObjectRecord(pressureResult) || !Array.isArray(pressureResult.admissions)) {
			throw new Error(
				`Control admission batch result was malformed: ${JSON.stringify(pressureResult)}`,
			);
		}
		const underPressure = parseAdmissionPressureSnapshot(pressureResult.snapshot);
		const droppedAdmissions = pressureResult.admissions.filter(
			(admission) => isObjectRecord(admission) && admission.status === 'dropped',
		).length;
		expect(droppedAdmissions).toBeGreaterThan(0);
		expect(underPressure.acceptedAttachmentGeneration).toBe(attachmentGeneration);
		expect(underPressure.egress.activeByClass.diagnostic).toBe(1);
		expect(underPressure.egress.scheduler.diagnosticMessages).toBe(
			before.capacities.queue.diagnostic.maxMessages,
		);
		expect(underPressure.egress.scheduler.droppedMessages).toBeGreaterThan(
			before.egress.scheduler.droppedMessages,
		);
		expect(underPressure.egress.scheduler.shedMessages).toBe(before.egress.scheduler.shedMessages);

		const pressureWindowStartedAtMs = Date.now();
		const controlPingPromise = sendControllerControlPing({ gatewayStart: activeGatewayStart });
		const postPressureResultsPromise = Promise.all(
			configuredProbeIdentities.map(
				async (identity) =>
					await callWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `PRESSURE_${identity.agentId}_${randomUUID()}`,
					}),
			),
		);
		const [, postPressureResults] = await Promise.all([
			controlPingPromise,
			postPressureResultsPromise,
		]);
		const pressureWindowEndedAtMs = Date.now();
		for (const result of postPressureResults) {
			expect(result.readBack).toBe(result.marker);
			expect(result.runtimeId).toBe(runtimeIds[result.agentId as 'beta' | 'main']);
		}

		await callAdmissionAction({
			action: 'release',
			attachmentGeneration,
			fields: { holdId: holdResult.holdId },
			harness: activeHarness,
		});
		const after = parseAdmissionPressureSnapshot(
			await callAdmissionAction({
				action: 'snapshot',
				attachmentGeneration,
				harness: activeHarness,
			}),
		);
		expect(after.egress.activeByClass.diagnostic).toBe(0);
		expect(after.egress.queuedByClass.diagnostic).toBe(0);
		expect(after.egress.scheduler.diagnosticMessages).toBe(0);
		expect(after.highWater.egress.diagnostic).toBe(before.capacities.queue.diagnostic.maxMessages);
		expect(activeHarness.runtime.zones[0]).toMatchObject({
			gateway: { vm: { id: gatewayVmId } },
			lifecycleState: 'running',
		});
		expect(await readOpenClawProcessIdentity(activeGatewayStart.vm)).toEqual(processIdentity);
		expect(activeControlSession.getDiagnostics()).toMatchObject({
			attachmentGeneration,
			connected: true,
			lastHelloResponse: { outcome: 'accepted', sessionId: acceptedSessionId },
			ready: true,
		});
		const finalToolRecords = await readExactToolVmRuntimeRecords(
			activeZone.gateway.stateDir,
			leaseIds,
		);
		for (const leaseId of leaseIds) {
			expect(finalToolRecords.get(leaseId)).toEqual(initialToolRecords.get(leaseId));
		}

		const pressureArtifact = JSON.stringify({
			after,
			before,
			droppedAdmissions,
			pressureWindowEndedAtMs,
			pressureWindowStartedAtMs,
			underPressure,
		});
		const identityArtifact = JSON.stringify({
			attachmentGeneration,
			gatewayVmId,
			processIdentity,
			runtimeIds,
		});
		const packageIdentity = await readAgentVmPackageIdentity();
		const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
			expectedOperationId: reliabilityOperationId,
			payload: {
				artifacts: [
					{
						operationId: 'control-admission-capacity-pressure',
						sha256: hashControlLeaseReliabilityArtifact(pressureArtifact),
					},
					{
						operationId: 'control-admission-stable-identities',
						sha256: hashControlLeaseReliabilityArtifact(identityArtifact),
					},
				],
				generationIdentities: [
					{
						generation: attachmentGeneration,
						targetId: acceptedSessionId,
						targetKind: 'control-session',
					},
				],
				packageIdentities: [packageIdentity],
				processIdentities: [
					{
						bootId: activeGatewayStart.processEpoch ?? 'openclaw-process',
						kind: 'openclaw-process',
						processId: processIdentity.pid,
						startIdentity: `proc-start-${processIdentity.startTimeTicks}`,
					},
					...Array.from(initialToolRecords.values(), (record) => ({
						bootId: record.gateway.gatewayEpochId,
						kind: 'tool-vm-process' as const,
						processId: record.qemuPid,
						startIdentity: hashControlLeaseReliabilityArtifact(
							`${record.processIdentity.command}\n${record.processIdentity.lstart}`,
						),
					})),
				],
				queryIdentities: [
					{
						marker: `control-admission-${attachmentGeneration}`,
						source: 'signed-private-e2e-route',
						windowEndMs: pressureWindowEndedAtMs,
						windowStartMs: pressureWindowStartedAtMs,
					},
				],
				runtimeIdentities: [
					{
						generation: attachmentGeneration,
						id: gatewayVmId,
						kind: 'gateway-vm',
					},
					...Object.values(runtimeIds).map((runtimeId) => ({
						generation: attachmentGeneration,
						id: initialToolRecords.get(runtimeId)?.vmId ?? runtimeId,
						kind: 'tool-vm' as const,
					})),
				],
			},
		});
		expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
	});
});
