/* oxlint-disable eslint/no-await-in-loop -- reconnect probes are sequential against one live control session */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
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

import { GATEWAY_CONTROL_RECONNECT_DEADLINE_MS } from '../controller/control-session/gateway-disposable-control-session-client.js';
import {
	loadAllToolVmRuntimeRecords,
	type ToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import {
	createOpenClawProcessReliabilityFaultTargetRegistry,
	type OpenClawProcessReliabilityFaultTargetRegistry,
} from '../controller/reliability/testing/openclaw-process-reliability-fault-target-registry.js';
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
import { waitForProtocolRetryInterval, withProtocolDeadline } from './e2e-protocol-wait.js';

const architecture = currentE2eArchitecture();
const runControlSessionRecoveryE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeControlSessionRecoveryE2e = runControlSessionRecoveryE2e ? describe : describe.skip;
const zoneId = 'control-session-recovery';
const gatewayToken = 'control-session-recovery-gateway-token';
const probeSigningKey = 'control-session-recovery-write-read-proof-key';
const mainIdentity = {
	agentId: 'main',
	sessionKey: 'agent:main:tool-vm-write-read:control-session-recovery-main',
} as const;
const betaIdentity = {
	agentId: 'beta',
	sessionKey: 'agent:beta:tool-vm-write-read:control-session-recovery-beta',
} as const;
const configuredProbeIdentities = [mainIdentity, betaIdentity] as const;
const reliabilityOperationId = 'control-session-recovery';

interface OpenClawProcessIdentity {
	readonly pid: number;
	readonly startTimeTicks: string;
}

interface ToolVmWriteReadResult {
	readonly agentId: string;
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
	readonly sessionKey: string;
	readonly status: 'ok';
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
			`Expected ${String(leaseIds.size)} exact Tool VM runtime records, found ${String(records.length)}.`,
		);
	}
	return new Map(records.map((record) => [record.leaseId, record] as const));
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolVmWriteReadResult(value: unknown): ToolVmWriteReadResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error('Tool VM write/read probe did not return a successful result.');
	}
	const details = value.details;
	if (
		details.status !== 'ok' ||
		typeof details.agentId !== 'string' ||
		typeof details.marker !== 'string' ||
		typeof details.readBack !== 'string' ||
		typeof details.runtimeId !== 'string' ||
		typeof details.sessionKey !== 'string'
	) {
		throw new Error('Tool VM write/read probe returned malformed details.');
	}
	return {
		agentId: details.agentId,
		marker: details.marker,
		readBack: details.readBack,
		runtimeId: details.runtimeId,
		sessionKey: details.sessionKey,
		status: details.status,
	};
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

async function callSignedWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly marker: string;
}): Promise<ToolVmWriteReadResult> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Control-session recovery E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify({
		agentId: options.identity.agentId,
		filePath: `.agent-vm/control-session-recovery-${options.identity.agentId}-${randomUUID()}.txt`,
		marker: options.marker,
		scenario: 'write-read',
		sessionKey: options.identity.sessionKey,
	});
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

async function readOpenClawGatewayProcessIdentity(
	gatewayVm: ManagedVm,
): Promise<OpenClawProcessIdentity> {
	const result = await gatewayVm.exec(`
set -eu
port_hex="$(printf '%04X' 18789)"
socket_inode="$(awk -v port=":$port_hex" '$2 ~ port && $4 == "0A" { print $10; exit }' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)"
gateway_pid=""
if [ -n "$socket_inode" ]; then
  for fd in /proc/[0-9]*/fd/*; do
    target="$(readlink "$fd" 2>/dev/null || true)"
    if [ "$target" = "socket:[$socket_inode]" ]; then
      gateway_pid="$(echo "$fd" | cut -d / -f 3)"
      break
    fi
  done
fi
if [ -z "$gateway_pid" ]; then
  echo "no openclaw gateway process found" >&2
  exit 1
fi
start_time_ticks="$(awk '{ print $22 }' "/proc/$gateway_pid/stat")"
printf '%s %s\\n' "$gateway_pid" "$start_time_ticks"
`);
	if (result.exitCode !== 0) {
		throw new Error(
			`OpenClaw gateway process identity read failed with exit ${String(result.exitCode)}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	const [pidText, startTimeTicks] = result.stdout.trim().split(/\s+/u);
	const pid = Number.parseInt(pidText ?? '', 10);
	if (!Number.isSafeInteger(pid) || pid <= 0 || startTimeTicks === undefined) {
		throw new Error(`Invalid OpenClaw process identity output: ${result.stdout}`);
	}
	return { pid, startTimeTicks };
}

async function waitForFreshAcceptedControlSession(options: {
	readonly controlSession: NonNullable<
		Awaited<ReturnType<typeof startGatewayZone>>['controlSession']
	>;
	readonly minimumAttachmentGeneration: number;
	readonly minimumHelloCount: number;
	readonly previousSessionId: string;
	readonly timeoutMs: number;
}): Promise<void> {
	const deadlineMs = Date.now() + options.timeoutMs;
	while (Date.now() < deadlineMs) {
		const diagnostics = options.controlSession.getDiagnostics();
		if (
			diagnostics.connected &&
			diagnostics.ready &&
			diagnostics.helloCount >= options.minimumHelloCount &&
			diagnostics.attachmentGeneration !== undefined &&
			diagnostics.attachmentGeneration >= options.minimumAttachmentGeneration &&
			diagnostics.lastHelloResponse?.outcome === 'accepted' &&
			diagnostics.lastHelloResponse.sessionId !== options.previousSessionId &&
			diagnostics.transportName === 'websocket'
		) {
			return;
		}
		await waitForProtocolRetryInterval(1_000);
	}
	throw new Error(
		`Timed out waiting for a fresh accepted control session: ${JSON.stringify(options.controlSession.getDiagnostics())}`,
	);
}

async function sendControllerOriginatedControlPing(options: {
	readonly gatewayStart: Awaited<ReturnType<typeof startGatewayZone>>;
	readonly sequence: number;
}): Promise<void> {
	const controlSession = options.gatewayStart.controlSession;
	const recoverySourceKey = options.gatewayStart.controlSessionRecoverySourceKey;
	const processEpoch = options.gatewayStart.processEpoch;
	if (
		controlSession === undefined ||
		recoverySourceKey === undefined ||
		processEpoch === undefined
	) {
		throw new Error('Expected Gateway start to expose a control session and process epoch.');
	}
	const diagnostics = controlSession.getDiagnostics();
	const helloResponse = diagnostics.lastHelloResponse;
	if (helloResponse === undefined || helloResponse.outcome !== 'accepted') {
		throw new Error(
			`Expected accepted control-session hello before control_ping: ${JSON.stringify(diagnostics)}`,
		);
	}
	const envelope: ControlEnvelope = ControlEnvelopeSchema.parse({
		bootId: processEpoch,
		connectionId: helloResponse.connectionId,
		controllerEpoch: helloResponse.controllerEpoch,
		createdAtMs: Date.now(),
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation.control_ping,
		domain: 'gateway_control',
		kind: 'command',
		messageId: randomUUID(),
		operation: 'control_ping',
		peerId: `gateway-${recoverySourceKey.zoneId}`,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: options.sequence,
		sessionId: helloResponse.sessionId,
		zoneId: recoverySourceKey.zoneId,
	});
	const response = GatewayControlRpcCommandResultMessageSchema.parse(
		await controlSession.emitApplicationMessage(
			envelope,
			{ kind: 'command', operation: 'control_ping' },
			{ kind: 'command', operation: 'control_ping', payload: {} },
		),
	);
	expect(response).toMatchObject({
		kind: 'command_result',
		operation: 'control_ping',
		payload: {
			responseToMessageId: envelope.messageId,
			result: 'ok',
		},
	});
}

describeControlSessionRecoveryE2e('e2e: disposable control-session recovery', () => {
	let gatewayStart: Awaited<ReturnType<typeof startGatewayZone>> | undefined;
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	let reliabilityTargetRegistry: OpenClawProcessReliabilityFaultTargetRegistry | undefined;

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: configuredProbeIdentities.map((identity) => identity.agentId),
			architecture,
			prefix: 'control-session-recovery-e2e-',
			zoneId,
		});
		const systemZone = project.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected control-session recovery project to contain an OpenClaw zone.');
		}
		const openClawGateway = systemZone.gateway;
		for (const envName of [
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV,
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
		harness = await startE2eControllerRuntime({
			createOpenClawProcessReliabilityFaultTargetRegistry: (options) => {
				const registry = createOpenClawProcessReliabilityFaultTargetRegistry(options);
				reliabilityTargetRegistry = registry;
				return registry;
			},
			secrets: {
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV]: '1',
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV]:
					JSON.stringify(configuredProbeIdentities),
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV]: probeSigningKey,
				GITHUB_TOKEN: 'unused-control-session-recovery-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-control-session-recovery-token',
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

	it('fences only S1 and accepts S2 without Gateway, process, or Tool leaf churn', async () => {
		if (
			gatewayStart?.controlSession === undefined ||
			harness === undefined ||
			reliabilityTargetRegistry === undefined
		) {
			throw new Error('Expected control-session recovery harness to be initialized.');
		}
		const activeGatewayStart = gatewayStart;
		const activeHarness = harness;
		const activeZone = activeHarness.systemConfig.zones[0];
		if (activeZone === undefined) {
			throw new Error('Expected the control-session recovery zone configuration.');
		}
		const reliabilityTarget = reliabilityTargetRegistry.getCurrent();
		if (reliabilityTarget?.controlSession === undefined) {
			throw new Error('Expected an exact current control-session reliability target.');
		}
		const controlSession = reliabilityTarget.controlSession;
		const initialResults = await Promise.all(
			configuredProbeIdentities.map(
				async (identity) =>
					await callSignedWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `S1_${identity.agentId}_${randomUUID()}`,
					}),
			),
		);
		const toolRuntimeIds = Object.fromEntries(
			initialResults.map((result) => [result.agentId, result.runtimeId]),
		) as Record<'beta' | 'main', string>;
		expect(toolRuntimeIds.main).not.toBe(toolRuntimeIds.beta);
		const toolLeaseIds = new Set(Object.values(toolRuntimeIds));
		const initialToolVmRecords = await readExactToolVmRuntimeRecords(
			activeZone.gateway.stateDir,
			toolLeaseIds,
		);

		const gatewayVmId = activeGatewayStart.vm.id;
		const processIdentity = await readOpenClawGatewayProcessIdentity(activeGatewayStart.vm);
		const s1Diagnostics = controlSession.getDiagnostics();
		const s1AttachmentGeneration = s1Diagnostics.attachmentGeneration;
		const s1SessionId = s1Diagnostics.lastHelloResponse?.sessionId;
		if (
			s1AttachmentGeneration === undefined ||
			s1SessionId === undefined ||
			s1Diagnostics.lastHelloResponse?.outcome !== 'accepted' ||
			!s1Diagnostics.connected ||
			!s1Diagnostics.ready
		) {
			throw new Error(`Expected accepted S1 before interruption: ${JSON.stringify(s1Diagnostics)}`);
		}

		const controlFaultStartedAtMs = Date.now();
		expect(
			controlSession.fenceCurrentSession({
				expectedAttachmentGeneration: s1AttachmentGeneration,
				expectedSessionId: s1SessionId,
				reason: 'reliability_test_disconnect',
			}),
		).toMatchObject({
			attachmentGeneration: s1AttachmentGeneration,
			sessionId: s1SessionId,
			status: 'fenced',
		});
		await waitForFreshAcceptedControlSession({
			controlSession,
			minimumAttachmentGeneration: s1AttachmentGeneration + 1,
			minimumHelloCount: s1Diagnostics.helloCount + 1,
			previousSessionId: s1SessionId,
			timeoutMs: GATEWAY_CONTROL_RECONNECT_DEADLINE_MS,
		});
		const controlRecoveryDurationMs = Date.now() - controlFaultStartedAtMs;
		expect(controlRecoveryDurationMs).toBeLessThanOrEqual(GATEWAY_CONTROL_RECONNECT_DEADLINE_MS);

		const s2Diagnostics = controlSession.getDiagnostics();
		const s2AttachmentGeneration = s2Diagnostics.attachmentGeneration;
		const s2SessionId = s2Diagnostics.lastHelloResponse?.sessionId;
		if (s2AttachmentGeneration === undefined || s2SessionId === undefined) {
			throw new Error(`Expected exact accepted S2 identity: ${JSON.stringify(s2Diagnostics)}`);
		}
		expect(s2Diagnostics).toMatchObject({
			connected: true,
			lastHelloResponse: { outcome: 'accepted' },
			ready: true,
			transportName: 'websocket',
		});
		expect(s2AttachmentGeneration).toBeGreaterThan(s1AttachmentGeneration);
		expect(s2SessionId).not.toBe(s1SessionId);

		await sendControllerOriginatedControlPing({ gatewayStart: activeGatewayStart, sequence: 1 });
		const postRecoveryResults = await Promise.all(
			configuredProbeIdentities.map(
				async (identity) =>
					await callSignedWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `S2_${identity.agentId}_${randomUUID()}`,
					}),
			),
		);
		for (const result of postRecoveryResults) {
			expect(result.readBack).toBe(result.marker);
			expect(result.runtimeId).toBe(toolRuntimeIds[result.agentId as 'beta' | 'main']);
		}
		const postRecoveryToolVmRecords = await readExactToolVmRuntimeRecords(
			activeZone.gateway.stateDir,
			toolLeaseIds,
		);
		for (const leaseId of toolLeaseIds) {
			expect(postRecoveryToolVmRecords.get(leaseId)).toEqual(initialToolVmRecords.get(leaseId));
		}
		expect(activeHarness.runtime.zones[0]).toMatchObject({
			gateway: { vm: { id: gatewayVmId } },
			lifecycleState: 'running',
		});
		expect(await readOpenClawGatewayProcessIdentity(activeGatewayStart.vm)).toEqual(
			processIdentity,
		);
		expect(reliabilityTargetRegistry.isCurrent(reliabilityTarget)).toBe(true);

		const packageIdentity = await readAgentVmPackageIdentity();
		const transitionArtifact = JSON.stringify({
			controlRecoveryDurationMs,
			gatewayVmId,
			processEpoch: reliabilityTarget.processEpoch,
			s1: {
				attachmentGeneration: s1AttachmentGeneration,
				sessionId: s1SessionId,
			},
			s2: {
				attachmentGeneration: s2AttachmentGeneration,
				sessionId: s2SessionId,
			},
		});
		const preservedLeavesArtifact = JSON.stringify({
			initialRuntimeIds: Object.fromEntries(
				initialResults.map((result) => [result.agentId, result.runtimeId]),
			),
			postRecoveryRuntimeIds: Object.fromEntries(
				postRecoveryResults.map((result) => [result.agentId, result.runtimeId]),
			),
		});
		const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
			expectedOperationId: reliabilityOperationId,
			payload: {
				artifacts: [
					{
						operationId: 'control-session-transition',
						sha256: hashControlLeaseReliabilityArtifact(transitionArtifact),
					},
					{
						operationId: 'control-session-preserved-leaves',
						sha256: hashControlLeaseReliabilityArtifact(preservedLeavesArtifact),
					},
				],
				generationIdentities: [
					{
						generation: reliabilityTarget.controllerGeneration.generation,
						targetId: reliabilityTarget.controllerGeneration.id,
						targetKind: 'controller',
					},
					{
						generation: reliabilityTarget.gatewayGeneration.generation,
						targetId: reliabilityTarget.gatewayGeneration.id,
						targetKind: 'gateway',
					},
					{
						generation: reliabilityTarget.openClawProcessGeneration.generation,
						targetId: reliabilityTarget.openClawProcessGeneration.id,
						targetKind: 'openclaw-process',
					},
					{
						generation: s1AttachmentGeneration,
						targetId: s1SessionId,
						targetKind: 'control-session',
					},
					{
						generation: s2AttachmentGeneration,
						targetId: s2SessionId,
						targetKind: 'control-session',
					},
				],
				packageIdentities: [packageIdentity],
				processIdentities: [
					{
						bootId: reliabilityTarget.processEpoch,
						kind: 'openclaw-process',
						processId: processIdentity.pid,
						startIdentity: `proc-start-${processIdentity.startTimeTicks}`,
					},
					...Array.from(initialToolVmRecords.values(), (record) => ({
						bootId: record.gateway.gatewayEpochId,
						kind: 'tool-vm-process' as const,
						processId: record.qemuPid,
						startIdentity: hashControlLeaseReliabilityArtifact(
							`${record.processIdentity.command}\n${record.processIdentity.lstart}`,
						),
					})),
				],
				runtimeIdentities: [
					{
						generation: reliabilityTarget.gatewayGeneration.generation,
						id: gatewayVmId,
						kind: 'gateway-vm',
					},
					...Object.values(toolRuntimeIds).map((runtimeId) => ({
						generation: reliabilityTarget.gatewayGeneration.generation,
						id: initialToolVmRecords.get(runtimeId)?.vmId ?? runtimeId,
						kind: 'tool-vm' as const,
					})),
				],
			},
		});
		expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
	});
});
