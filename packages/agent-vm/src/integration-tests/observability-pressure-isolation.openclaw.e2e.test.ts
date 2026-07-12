import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	CONTROL_PROTOCOL_VERSION,
	ControlEnvelopeSchema,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlRpcCommandResultMessageSchema,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import {
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER,
	testExports as toolVmWriteReadE2eToolTestExports,
} from '@agent-vm/openclaw-agent-vm-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HealthEventStore } from '../controller/health/health-event-store.js';
import { startGatewayZoneForController as startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
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
	type E2eHarnessRuntime,
	type OpenClawE2eProject,
	useLocalOpenClawGatewayImagePackages,
} from './e2e-harness.js';
import { withProtocolDeadline } from './e2e-protocol-wait.js';

const architecture = currentE2eArchitecture();
const runObservabilityPressureE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeObservabilityPressureE2e = runObservabilityPressureE2e ? describe : describe.skip;
const reliabilityOperationId = 'observability-pressure-isolation';
const zoneId = 'observability-pressure-isolation';
const gatewayToken = 'observability-pressure-gateway-token';
const probeSigningKey = 'observability-pressure-tool-vm-probe-key';
const productOperationDeadlineMs = 30_000;
const configuredProbeIdentities = [
	{
		agentId: 'main',
		sessionKey: 'agent:main:tool-vm-write-read:observability-pressure-main',
	},
	{
		agentId: 'beta',
		sessionKey: 'agent:beta:tool-vm-write-read:observability-pressure-beta',
	},
] as const;

interface ToolVmWriteReadResult {
	readonly agentId: string;
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
	readonly sessionKey: string;
	readonly status: 'ok';
}

interface OpenClawProcessIdentity {
	readonly pid: number;
	readonly startTimeTicks: string;
}

interface EvidenceQueueDiagnostics {
	readonly droppedBytes: number;
	readonly droppedRecords: number;
	readonly highWaterPendingBytes: number;
	readonly highWaterPendingRecords: number;
	readonly maxPendingBytes: number;
	readonly maxPendingRecords: number;
	readonly operationTimeoutMs: number;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolVmWriteReadResult(value: unknown): ToolVmWriteReadResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error('Tool VM write/read pressure probe did not return a successful result.');
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
		throw new Error('Tool VM write/read pressure probe returned malformed details.');
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

async function callSignedWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly marker: string;
}): Promise<ToolVmWriteReadResult> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Observability pressure E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify({
		agentId: options.identity.agentId,
		filePath: `.agent-vm/observability-pressure-${options.identity.agentId}-${randomUUID()}.txt`,
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
		`Tool VM ${options.identity.agentId} write/read under observability pressure`,
		productOperationDeadlineMs,
	);
	const responseBody: unknown = await response.json();
	if (!response.ok) {
		throw new Error(
			`Tool VM write/read pressure probe failed with HTTP ${String(response.status)}: ${JSON.stringify(responseBody)}`,
		);
	}
	return parseToolVmWriteReadResult(responseBody);
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
		throw new Error('Expected observability pressure Gateway to expose its control session.');
	}
	const diagnostics = controlSession.getDiagnostics();
	const helloResponse = diagnostics.lastHelloResponse;
	if (helloResponse === undefined || helloResponse.outcome !== 'accepted') {
		throw new Error(
			`Expected accepted control session before pressure ping: ${JSON.stringify(diagnostics)}`,
		);
	}
	const envelope = ControlEnvelopeSchema.parse({
		bootId: processEpoch,
		connectionId: helloResponse.connectionId,
		controllerEpoch: helloResponse.controllerEpoch,
		createdAtMs: Date.now(),
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation.control_ping,
		domain: 'gateway_control',
		kind: 'command',
		messageId: randomUUID(),
		operation: 'control_ping',
		peerId: `gateway-${zoneId}`,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: options.sequence,
		sessionId: helloResponse.sessionId,
		zoneId,
	});
	const response = GatewayControlRpcCommandResultMessageSchema.parse(
		await withProtocolDeadline(
			controlSession.emitApplicationMessage(
				envelope,
				{ kind: 'command', operation: 'control_ping' },
				{ kind: 'command', operation: 'control_ping', payload: {} },
			),
			'controller-originated control ping under observability pressure',
			productOperationDeadlineMs,
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

function durableQueueDiagnosticsFromControllerStatus(value: unknown): EvidenceQueueDiagnostics {
	if (
		!isObjectRecord(value) ||
		!isObjectRecord(value.observability) ||
		!isObjectRecord(value.observability.evidence) ||
		!isObjectRecord(value.observability.evidence.durableLog)
	) {
		throw new Error(
			`Controller status omitted durable evidence diagnostics: ${JSON.stringify(value)}`,
		);
	}
	const diagnostics = value.observability.evidence.durableLog;
	const requireNumber = (fieldName: string): number => {
		const fieldValue = diagnostics[fieldName];
		if (typeof fieldValue !== 'number') {
			throw new Error(`Durable evidence diagnostics omitted numeric '${fieldName}'.`);
		}
		return fieldValue;
	};
	return {
		droppedBytes: requireNumber('droppedBytes'),
		droppedRecords: requireNumber('droppedRecords'),
		highWaterPendingBytes: requireNumber('highWaterPendingBytes'),
		highWaterPendingRecords: requireNumber('highWaterPendingRecords'),
		maxPendingBytes: requireNumber('maxPendingBytes'),
		maxPendingRecords: requireNumber('maxPendingRecords'),
		operationTimeoutMs: requireNumber('operationTimeoutMs'),
	};
}

async function queryControllerStatus(controllerUrl: string): Promise<unknown> {
	const response = await withProtocolDeadline(
		fetch(`${controllerUrl}/controller-status`),
		'controller observability status query',
		productOperationDeadlineMs,
	);
	if (!response.ok) {
		throw new Error(`Controller status query failed with HTTP ${String(response.status)}.`);
	}
	return await response.json();
}

async function readOpenClawProcessIdentity(gatewayVm: ManagedVm): Promise<OpenClawProcessIdentity> {
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
test -n "$gateway_pid"
start_time_ticks="$(awk '{ print $22 }' "/proc/$gateway_pid/stat")"
printf '%s %s\\n' "$gateway_pid" "$start_time_ticks"
`);
	if (result.exitCode !== 0) {
		throw new Error(`OpenClaw process identity read failed: ${result.stderr}`);
	}
	const [pidText, startTimeTicks] = result.stdout.trim().split(/\s+/u);
	const pid = Number(pidText);
	if (!Number.isSafeInteger(pid) || pid <= 0 || startTimeTicks === undefined) {
		throw new Error(`OpenClaw process identity output was malformed: ${result.stdout}`);
	}
	return { pid, startTimeTicks };
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

describeObservabilityPressureE2e(
	'e2e: bounded observability pressure cannot impair control, Gateway, or Tool VM work',
	() => {
		let gatewayStart: Awaited<ReturnType<typeof startGatewayZone>> | undefined;
		let harness: E2eHarnessRuntime | undefined;
		let healthEventStore: HealthEventStore | undefined;
		let project: OpenClawE2eProject | undefined;

		beforeAll(async () => {
			const repoRoot = path.resolve(process.cwd());
			project = await scaffoldOpenClawE2eProject({
				agents: configuredProbeIdentities.map((identity) => identity.agentId),
				architecture,
				prefix: 'observability-pressure-isolation-e2e-',
				zoneId,
			});
			const systemZone = project.systemConfig.zones[0];
			if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
				throw new Error('Expected observability pressure E2E to contain an OpenClaw zone.');
			}
			const systemGateway = systemZone.gateway;
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
			systemGateway.rawEnvSecrets = [
				...(systemGateway.rawEnvSecrets ?? []),
				AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
				AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
				AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV,
			];
			await Promise.all(
				configuredProbeIdentities.map(async ({ agentId }) => {
					await fs.mkdir(path.join(systemGateway.zoneFilesDir, 'agents', agentId), {
						recursive: true,
					});
				}),
			);
			await useLocalOpenClawGatewayImagePackages({
				enableToolVmWriteReadE2eRoute: true,
				profileName: systemGateway.imageProfile,
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
					GITHUB_TOKEN: 'unused-observability-pressure-token',
					OPENCLAW_GATEWAY_TOKEN: gatewayToken,
					PERPLEXITY_API_KEY: 'unused-observability-pressure-token',
				},
				startGatewayZone: async (startOptions) => {
					if (startOptions.healthEventStore === undefined) {
						throw new Error('Controller did not supply its production health event store.');
					}
					healthEventStore = startOptions.healthEventStore;
					const result = await startGatewayZone(startOptions);
					gatewayStart = result;
					result.vm.setIngressRoutes([
						{ port: result.processSpec.guestListenPort, prefix: '/', stripPrefix: true },
					]);
					return result;
				},
				startOptions: { systemConfig: project.systemConfig, zoneIds: [zoneId] },
			});
		}, 900_000);

		afterAll(async () => {
			try {
				await harness?.close();
			} finally {
				if (project !== undefined) {
					await removeE2eTempRoot(project.tempRoot);
				}
			}
		});

		it('sheds bounded evidence while concurrent product paths meet their deadlines without identity churn', async () => {
			if (gatewayStart === undefined || harness === undefined || healthEventStore === undefined) {
				throw new Error('Expected observability pressure harness to be initialized.');
			}
			const activeGatewayStart = gatewayStart;
			const activeHarness = harness;
			const activeHealthEventStore = healthEventStore;
			const runMarker = `observability-pressure-${randomUUID()}`;
			const faultWindowStartMs = Date.now();
			const gatewayVmIdBefore = activeGatewayStart.vm.id;
			const processEpochBefore = activeGatewayStart.processEpoch;
			if (processEpochBefore === undefined) {
				throw new Error('Gateway process epoch was unavailable before observability pressure.');
			}
			const processIdentityBefore = await readOpenClawProcessIdentity(activeGatewayStart.vm);
			const baselineResults = await Promise.all(
				configuredProbeIdentities.map(
					async (identity) =>
						await callSignedWriteReadProbe({
							harness: activeHarness,
							identity,
							marker: `${runMarker}-baseline-${identity.agentId}`,
						}),
				),
			);

			const baselineStatus = await queryControllerStatus(activeHarness.controllerUrl);
			const baselineDiagnostics = durableQueueDiagnosticsFromControllerStatus(baselineStatus);
			const oversizedEvidence: AgentVmHealthEvent = {
				correlationId: 'p'.repeat(baselineDiagnostics.maxPendingBytes + 1),
				kind: 'gateway-service-health',
				observedAtMs: Date.now(),
				path: '/health',
				port: 18_789,
				result: 'ok',
				runId: runMarker,
				statusCode: 200,
				zoneId,
			};
			activeHealthEventStore.record(oversizedEvidence);

			const [pressureMain, pressureBeta] = await Promise.all([
				callSignedWriteReadProbe({
					harness: activeHarness,
					identity: configuredProbeIdentities[0],
					marker: `${runMarker}-pressure-main`,
				}),
				callSignedWriteReadProbe({
					harness: activeHarness,
					identity: configuredProbeIdentities[1],
					marker: `${runMarker}-pressure-beta`,
				}),
				sendControllerOriginatedControlPing({
					gatewayStart: activeGatewayStart,
					sequence: 90_001,
				}),
				withProtocolDeadline(
					fetch(`${activeHarness.controllerUrl}/zones/${zoneId}/health`),
					'Gateway provider health path under observability pressure',
					productOperationDeadlineMs,
				).then(async (response) => {
					expect(response.ok).toBe(true);
					await response.text();
				}),
			]);
			const pressureStatus = await queryControllerStatus(activeHarness.controllerUrl);
			const faultWindowEndMs = Date.now();
			const pressureDiagnostics = durableQueueDiagnosticsFromControllerStatus(pressureStatus);

			expect(pressureDiagnostics.maxPendingBytes).toBe(baselineDiagnostics.maxPendingBytes);
			expect(pressureDiagnostics.maxPendingRecords).toBe(baselineDiagnostics.maxPendingRecords);
			expect(pressureDiagnostics.operationTimeoutMs).toBe(baselineDiagnostics.operationTimeoutMs);
			expect(pressureDiagnostics.droppedRecords).toBeGreaterThan(
				baselineDiagnostics.droppedRecords,
			);
			expect(pressureDiagnostics.droppedBytes).toBeGreaterThan(baselineDiagnostics.droppedBytes);
			expect(pressureDiagnostics.highWaterPendingBytes).toBeGreaterThan(0);
			expect(pressureDiagnostics.highWaterPendingRecords).toBeGreaterThan(0);
			expect(pressureMain).toMatchObject({
				agentId: 'main',
				readBack: `${runMarker}-pressure-main`,
				status: 'ok',
			});
			expect(pressureBeta).toMatchObject({
				agentId: 'beta',
				readBack: `${runMarker}-pressure-beta`,
				status: 'ok',
			});
			expect(pressureMain.runtimeId).toBe(baselineResults[0]?.runtimeId);
			expect(pressureBeta.runtimeId).toBe(baselineResults[1]?.runtimeId);
			expect(activeGatewayStart.vm.id).toBe(gatewayVmIdBefore);
			expect(activeGatewayStart.processEpoch).toBe(processEpochBefore);
			expect(await readOpenClawProcessIdentity(activeGatewayStart.vm)).toEqual(
				processIdentityBefore,
			);

			const artifact = JSON.stringify({
				baselineDiagnostics,
				faultWindowEndMs,
				faultWindowStartMs,
				pressureDiagnostics,
				productOperationDeadlineMs,
				runMarker,
				toolRuntimeIds: [pressureMain.runtimeId, pressureBeta.runtimeId],
			});
			const gatewayIdentity = activeGatewayStart.vmOwnership.gatewayIdentity;
			if (gatewayIdentity === undefined) {
				throw new Error('Gateway identity was unavailable for reliability evidence.');
			}
			const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
				expectedOperationId: reliabilityOperationId,
				payload: {
					artifacts: [
						{
							operationId: reliabilityOperationId,
							sha256: hashControlLeaseReliabilityArtifact(artifact),
						},
					],
					generationIdentities: [
						{
							generation: 1,
							targetId: gatewayIdentity.generationId,
							targetKind: 'gateway-generation',
						},
					],
					packageIdentities: [await readAgentVmPackageIdentity()],
					processIdentities: [
						{
							bootId: processEpochBefore,
							kind: 'openclaw-process',
							processId: processIdentityBefore.pid,
							startIdentity: `proc-start-${processIdentityBefore.startTimeTicks}`,
						},
					],
					queryIdentities: [
						{
							marker: runMarker,
							source: 'controller-status',
							windowEndMs: faultWindowEndMs,
							windowStartMs: faultWindowStartMs,
						},
					],
					runtimeIdentities: [
						{ generation: 1, id: gatewayVmIdBefore, kind: 'gateway-vm' },
						{ generation: 1, id: processEpochBefore, kind: 'openclaw-process' },
						{ generation: 1, id: pressureMain.runtimeId, kind: 'tool-vm-main' },
						{ generation: 1, id: pressureBeta.runtimeId, kind: 'tool-vm-beta' },
					],
				},
			});
			expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
		});
	},
);
