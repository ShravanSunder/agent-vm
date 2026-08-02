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
	connectGatewayControlSession,
	GATEWAY_CONTROL_RECONNECT_DEADLINE_MS,
	GATEWAY_CONTROL_RECONNECT_MAX_ATTEMPTS,
} from '../controller/control-session/index.js';
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
	startControlTransportReliabilityProxy,
	type ControlTransportReliabilityProxy,
} from '../controller/reliability/testing/control-transport-reliability-proxy.js';
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
import {
	configureOpenClawControlRecoveryModel,
	openClawControlRecoveryFrameworkResponseMarker,
	openClawControlRecoverySandboxExecOutputMarker,
	runOpenClawControlRecoveryAgentRequest,
	startOpenClawControlRecoveryActiveOperation,
	startOpenClawControlRecoveryModelServer,
	waitForOpenClawCommittedSentinelWhileRequestIsActive,
} from './openclaw-control-recovery-model-fixture.js';

const architecture = currentE2eArchitecture();
type GatewayVmObservationOperations = Pick<
	GatewayZoneVmOperations,
	'enableSsh' | 'exec' | 'getHostProcessId' | 'id'
>;
const runControlSessionRecoveryE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
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
const mockOpenAiPort = 38_941;

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

interface OpenClawProcessIdentity {
	readonly pid: number;
	readonly startTimeTicks: string;
}

interface ToolVmWriteReadResult {
	readonly agentId: string;
	readonly filePath: string;
	readonly kind: 'read-existing' | 'write-read';
	readonly marker: string;
	readonly readBack: string;
	readonly status: 'ok';
}

async function readExactToolVmRuntimeRecords(
	recordsTarget: ControllerToolLeaseRecordsTarget,
	agentIds: ReadonlySet<string>,
	gatewayGenerationId: string,
): Promise<ReadonlyMap<string, ToolVmRuntimeRecord>> {
	const loadResults = await loadAllToolVmRuntimeRecords(recordsTarget);
	const parseError = loadResults.find((result) => result.kind === 'parse-error');
	if (parseError !== undefined) {
		throw new Error(`Tool VM runtime record failed to parse: ${parseError.path}`);
	}
	const records = loadResults
		.filter((result) => result.kind === 'loaded')
		.map((result) => result.record)
		.filter(
			(record) =>
				agentIds.has(record.agentId) && record.gateway.generationId === gatewayGenerationId,
		);
	if (
		records.length !== agentIds.size ||
		new Set(records.map((record) => record.agentId)).size !== agentIds.size
	) {
		throw new Error(
			`Expected one current Tool VM runtime record for each of ${String(agentIds.size)} agents, found ${String(records.length)}.`,
		);
	}
	return new Map(records.map((record) => [record.agentId, record] as const));
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolVmWriteReadResult(
	value: unknown,
	expectedKind: ToolVmWriteReadResult['kind'],
): ToolVmWriteReadResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error('Tool VM write/read probe did not return a successful result.');
	}
	const details = value.details;
	if (
		details.status !== 'ok' ||
		typeof details.agentId !== 'string' ||
		typeof details.filePath !== 'string' ||
		details.kind !== expectedKind ||
		typeof details.marker !== 'string' ||
		typeof details.readBack !== 'string'
	) {
		throw new Error('Tool VM write/read probe returned malformed details.');
	}
	return {
		agentId: details.agentId,
		filePath: details.filePath,
		kind: expectedKind,
		marker: details.marker,
		readBack: details.readBack,
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
		filePath: `agent-vm-e2e-control-session-recovery-${options.identity.agentId}-${randomUUID()}.txt`,
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
	return parseToolVmWriteReadResult(responseBody, 'write-read');
}

async function callSignedReadExistingProbe(options: {
	readonly filePath: string;
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly marker: string;
}): Promise<ToolVmWriteReadResult> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Control-session recovery E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify({
		action: 'read-existing',
		agentId: options.identity.agentId,
		filePath: options.filePath,
		marker: options.marker,
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
		`Tool VM ${options.identity.agentId} read-existing probe`,
		30_000,
	);
	const responseBody: unknown = await response.json();
	if (!response.ok) {
		throw new Error(
			`Tool VM read-existing probe failed with HTTP ${String(response.status)}: ${JSON.stringify(responseBody)}`,
		);
	}
	return parseToolVmWriteReadResult(responseBody, 'read-existing');
}

async function readOpenClawGatewayProcessIdentity(
	gatewayVm: GatewayVmObservationOperations,
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
	readonly controlSession: NonNullable<ManagedGatewayStartResult['controlSession']>;
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
	readonly gatewayStart: ManagedGatewayStartResult;
	readonly sequence: number;
}): Promise<void> {
	const controlSession = options.gatewayStart.controlSession;
	if (controlSession === undefined) {
		throw new Error('Expected Gateway start to expose a control session and process epoch.');
	}
	const controlIdentity = options.gatewayStart.expectedCohort.controlIdentity;
	const diagnostics = controlSession.getDiagnostics();
	const helloResponse = diagnostics.lastHelloResponse;
	if (helloResponse === undefined || helloResponse.outcome !== 'accepted') {
		throw new Error(
			`Expected accepted control-session hello before control_ping: ${JSON.stringify(diagnostics)}`,
		);
	}
	const envelope: ControlEnvelope = ControlEnvelopeSchema.parse({
		bootId: controlIdentity.processEpoch,
		connectionId: helloResponse.connectionId,
		controllerEpoch: helloResponse.controllerEpoch,
		createdAtMs: Date.now(),
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation.control_ping,
		domain: 'gateway_control',
		kind: 'command',
		messageId: randomUUID(),
		operation: 'control_ping',
		peerId: controlIdentity.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: options.sequence,
		sessionId: helloResponse.sessionId,
		zoneId: options.gatewayStart.expectedCohort.fence.zoneId,
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
	let controlTransportProxy: ControlTransportReliabilityProxy | undefined;
	let gatewayStart: ManagedGatewayStartResult | undefined;
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;

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
		await configureOpenClawControlRecoveryModel({
			configPath: openClawGateway.config,
			mockPort: mockOpenAiPort,
		});
		systemZone.secrets.OPENAI_API_KEY = {
			audience: 'gateway',
			envVar: 'OPENAI_API_KEY',
			injection: 'env',
			source: 'environment',
		};
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
			'OPENAI_API_KEY',
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
		harness = await startE2eControllerRuntime({
			secrets: {
				[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV]: '1',
				[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV]:
					JSON.stringify(configuredProbeIdentities),
				[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV]: probeSigningKey,
				GITHUB_TOKEN: 'unused-control-session-recovery-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				OPENAI_API_KEY: 'unused-control-session-recovery-model-token',
				PERPLEXITY_API_KEY: 'unused-control-session-recovery-token',
			},
			startGatewayZone: async (startOptions) => {
				const result = await startGatewayZone(startOptions, {
					connectGatewayControlSession: async (connectOptions) => {
						if (controlTransportProxy !== undefined) {
							throw new Error('Control-session recovery created more than one control proxy.');
						}
						controlTransportProxy = await startControlTransportReliabilityProxy({
							target: connectOptions.endpoint,
						});
						return await connectGatewayControlSession({
							...connectOptions,
							endpoint: {
								...connectOptions.endpoint,
								...controlTransportProxy.endpoint,
							},
						});
					},
				});
				if (result.executionModel !== 'managed-gateway') {
					throw new Error('Control-session recovery proof requires managed Gateway image boot.');
				}
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
			try {
				await controlTransportProxy?.close();
			} finally {
				if (project !== undefined && harness === undefined) {
					await removeE2eTempRoot(project.tempRoot);
				}
			}
		}
	});

	it('recovers after the former terminal budget without Gateway, framework, or Tool VM churn', async () => {
		if (
			gatewayStart === undefined ||
			harness === undefined ||
			controlTransportProxy === undefined
		) {
			throw new Error('Expected control-session recovery harness to be initialized.');
		}
		const activeGatewayStart = gatewayStart;
		const activeHarness = harness;
		const controlSession = activeGatewayStart.controlSession;
		if (controlSession === undefined) {
			throw new Error('Expected control-session recovery to expose its managed control session.');
		}
		const activeZone = activeHarness.systemConfig.zones[0];
		if (activeZone === undefined || activeZone.gateway.type !== 'openclaw') {
			throw new Error('Expected the control-session recovery zone configuration.');
		}
		const controllerRecordTargets = resolveFixtureControllerRecordTargets({
			controllerStateDirectoryPath: activeHarness.systemConfig.controllerStateDir,
			zoneId: activeZone.id,
		});
		const expectedCohort = structuredClone(activeGatewayStart.expectedCohort);
		await startOpenClawControlRecoveryModelServer({
			gatewayVm: activeGatewayStart.vm,
			port: mockOpenAiPort,
		});
		const initialProbeResults = await Promise.all(
			configuredProbeIdentities.map(
				async (identity) =>
					await callSignedWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `S1_${identity.agentId}_${randomUUID()}`,
					}),
			),
		);
		const configuredAgentIds = new Set(
			configuredProbeIdentities.map((identity) => identity.agentId),
		);
		const initialToolVmRecords = await readExactToolVmRuntimeRecords(
			controllerRecordTargets.toolLeaseRecords,
			configuredAgentIds,
			expectedCohort.controlIdentity.generationId,
		);
		const toolRuntimeIds = Object.fromEntries(
			Array.from(initialToolVmRecords, ([agentId, record]) => [agentId, record.leaseId]),
		) as Record<'beta' | 'main', string>;
		expect(toolRuntimeIds.main).not.toBe(toolRuntimeIds.beta);

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

		const ambiguousOperationMarker = `AMBIGUOUS_${randomUUID()}`;
		const ambiguousOperationFilePath = `agent-vm-e2e-control-recovery-active-${randomUUID()}.txt`;
		const ambiguousSentinelFilePath = `agent-vm-e2e-control-recovery-active-${randomUUID()}.committed`;
		const ambiguousOperationWorkspaceRoot = await fs.realpath(
			path.join(activeZone.gateway.zoneFilesDir, 'agents', betaIdentity.agentId),
		);
		const ambiguousSentinelHostPath = path.join(
			ambiguousOperationWorkspaceRoot,
			ambiguousSentinelFilePath,
		);
		const activeOperationOutcome = startOpenClawControlRecoveryActiveOperation({
			agentId: betaIdentity.agentId,
			filePath: ambiguousOperationFilePath,
			gatewayToken,
			harness: activeHarness,
			marker: ambiguousOperationMarker,
			probeSigningKey,
			sentinelFilePath: ambiguousSentinelFilePath,
			sessionKey: betaIdentity.sessionKey,
		});
		await waitForOpenClawCommittedSentinelWhileRequestIsActive({
			expectedMarker: ambiguousOperationMarker,
			requestOutcome: activeOperationOutcome,
			sentinelPath: ambiguousSentinelHostPath,
		});

		const controlFaultStartedAtMs = Date.now();
		const isolation = controlTransportProxy.isolate();
		const interruptedOperationOutcome = await withProtocolDeadline(
			activeOperationOutcome,
			'ambiguous Tool VM operation termination after control transport isolation',
			30_000,
		);
		if (
			interruptedOperationOutcome.kind === 'response' &&
			interruptedOperationOutcome.status >= 200 &&
			interruptedOperationOutcome.status < 300
		) {
			throw new Error(
				`Ambiguous Tool VM operation was falsely reported successful: HTTP ${String(interruptedOperationOutcome.status)}.`,
			);
		}
		const postBudgetAttempt = await controlTransportProxy.waitForRejectedConnection({
			minimumObservedAtMs: isolation.startedAtMs + GATEWAY_CONTROL_RECONNECT_DEADLINE_MS + 1,
			minimumRejectedConnectionCount:
				isolation.rejectedConnectionCount + GATEWAY_CONTROL_RECONNECT_MAX_ATTEMPTS + 1,
			timeoutMs: GATEWAY_CONTROL_RECONNECT_DEADLINE_MS * 3,
		});
		expect(postBudgetAttempt.observedAtMs - isolation.startedAtMs).toBeGreaterThan(
			GATEWAY_CONTROL_RECONNECT_DEADLINE_MS,
		);
		expect(
			postBudgetAttempt.rejectedConnectionCount - isolation.rejectedConnectionCount,
		).toBeGreaterThan(GATEWAY_CONTROL_RECONNECT_MAX_ATTEMPTS);
		await runOpenClawControlRecoveryAgentRequest({
			expectedHistoryMarker: openClawControlRecoveryFrameworkResponseMarker,
			gatewayVm: activeGatewayStart.vm,
			message: 'Provide the configured control-recovery response without using tools.',
		});
		expect(await readOpenClawGatewayProcessIdentity(activeGatewayStart.vm)).toEqual(
			processIdentity,
		);
		controlTransportProxy.restore();
		await waitForFreshAcceptedControlSession({
			controlSession,
			minimumAttachmentGeneration: s1AttachmentGeneration + 1,
			minimumHelloCount: s1Diagnostics.helloCount + 1,
			previousSessionId: s1SessionId,
			timeoutMs: 30_000,
		});
		const controlRecoveryDurationMs = Date.now() - controlFaultStartedAtMs;
		expect(controlRecoveryDurationMs).toBeGreaterThan(GATEWAY_CONTROL_RECONNECT_DEADLINE_MS);

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
		const ambiguousSentinelLines = (await fs.readFile(ambiguousSentinelHostPath, 'utf8'))
			.split('\n')
			.filter((line) => line.length > 0);
		expect(ambiguousSentinelLines).toEqual([ambiguousOperationMarker]);

		await sendControllerOriginatedControlPing({ gatewayStart: activeGatewayStart, sequence: 1 });
		await runOpenClawControlRecoveryAgentRequest({
			expectedHistoryMarker: openClawControlRecoveryFrameworkResponseMarker,
			gatewayVm: activeGatewayStart.vm,
			message:
				`Use the exec tool to run a non-mutating command that prints exactly ${openClawControlRecoverySandboxExecOutputMarker}. ` +
				'After the tool succeeds, provide the configured control-recovery response.',
			requiredToolOutputMarker: openClawControlRecoverySandboxExecOutputMarker,
		});
		const initialMainProbe = initialProbeResults.find(
			(result) => result.agentId === mainIdentity.agentId,
		);
		if (initialMainProbe === undefined) {
			throw new Error(`Missing initial Tool VM probe for '${mainIdentity.agentId}'.`);
		}
		const postRecoveryMainResult = await callSignedReadExistingProbe({
			filePath: initialMainProbe.filePath,
			harness: activeHarness,
			identity: mainIdentity,
			marker: initialMainProbe.marker,
		});
		expect(postRecoveryMainResult.readBack).toBe(postRecoveryMainResult.marker);
		const postRecoveryToolVmRecords = await readExactToolVmRuntimeRecords(
			controllerRecordTargets.toolLeaseRecords,
			configuredAgentIds,
			expectedCohort.controlIdentity.generationId,
		);
		for (const agentId of configuredAgentIds) {
			expect(postRecoveryToolVmRecords.get(agentId)).toEqual(initialToolVmRecords.get(agentId));
		}
		expect(activeHarness.runtime.zones[0]).toMatchObject({
			gateway: { vm: { id: gatewayVmId } },
			lifecycleState: 'running',
		});
		expect(await readOpenClawGatewayProcessIdentity(activeGatewayStart.vm)).toEqual(
			processIdentity,
		);
		expect(activeGatewayStart.expectedCohort).toEqual(expectedCohort);

		const packageIdentity = await readAgentVmPackageIdentity();
		const transitionArtifact = JSON.stringify({
			controlRecoveryDurationMs,
			gatewayVmId,
			processEpoch: expectedCohort.controlIdentity.processEpoch,
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
				Array.from(initialToolVmRecords, ([agentId, record]) => [agentId, record.leaseId]),
			),
			postRecoveryRuntimeIds: Object.fromEntries(
				Array.from(postRecoveryToolVmRecords, ([agentId, record]) => [agentId, record.leaseId]),
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
						generation: 1,
						targetId: expectedCohort.controlIdentity.controllerEpoch,
						targetKind: 'controller',
					},
					{
						generation: 1,
						targetId: expectedCohort.controlIdentity.generationId,
						targetKind: 'gateway',
					},
					{
						generation: 1,
						targetId: expectedCohort.frameworkIdentity.frameworkEpoch,
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
						bootId: expectedCohort.controlIdentity.processEpoch,
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
						generation: 1,
						id: gatewayVmId,
						kind: 'gateway-vm',
					},
					...Array.from(initialToolVmRecords.values(), (record) => ({
						generation: 1,
						id: record.vmId,
						kind: 'tool-vm' as const,
					})),
				],
			},
		});
		expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
	});
});
