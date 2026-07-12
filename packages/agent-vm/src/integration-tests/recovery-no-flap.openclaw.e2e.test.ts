/* oxlint-disable eslint/no-await-in-loop -- serialized faults and stability observations are intentional */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	CONTROL_PROTOCOL_VERSION,
	ControlEnvelopeSchema,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import type { GatewayControlLeaseSnapshot } from '@agent-vm/gateway-control-contracts';
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

import type { GatewayControlLeaseRpcOperations } from '../controller/control-session/index.js';
import {
	loadAllToolVmRuntimeRecords,
	type ToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import { createOpenClawProcessReliabilityFaultHandler } from '../controller/reliability/testing/openclaw-process-reliability-fault-handler.js';
import {
	createOpenClawProcessReliabilityFaultTargetRegistry,
	type OpenClawProcessReliabilityFaultTargetRegistry,
	type OpenClawProcessReliabilityFaultTargetSnapshot,
} from '../controller/reliability/testing/openclaw-process-reliability-fault-target-registry.js';
import type { ReliabilityFaultApplyRequest } from '../controller/reliability/testing/reliability-test-fault-contracts.js';
import {
	OPENCLAW_PROCESS_RECOVERY_ATTEMPT_WINDOW_MS,
	OPENCLAW_PROCESS_RECOVERY_COOLDOWN_MS,
	OPENCLAW_PROCESS_RECOVERY_MAX_ATTEMPTS,
	OPENCLAW_PROCESS_RECOVERY_STABILITY_HEARTBEATS,
	OPENCLAW_PROCESS_RECOVERY_STABILITY_MS,
	OPENCLAW_PROCESS_RECOVERY_STABILITY_OBSERVATIONS,
	OPENCLAW_PROCESS_RECOVERY_SUCCESS_HISTORY_MS,
	OPENCLAW_PROCESS_RECOVERY_SUCCESS_LIMIT,
} from '../controller/zone-runtimes/openclaw-process-recovery.js';
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

interface ToolVmWriteReadResult {
	readonly agentId: 'beta' | 'main';
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
}

interface ObservedRecoveryIdentity {
	readonly processEpoch: string;
	readonly processId: number;
	readonly processStartTimeTicks: string;
	readonly sessionAttachmentGeneration: number;
	readonly sessionId: string;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrivateLeaseSnapshot(value: unknown): value is GatewayControlLeaseSnapshot & {
	readonly ssh: {
		readonly host: string;
		readonly identityPem: string;
		readonly knownHostsLine: string;
		readonly port: number;
		readonly user: string;
	};
} {
	return (
		isObjectRecord(value) &&
		typeof value.leaseId === 'string' &&
		isObjectRecord(value.ssh) &&
		typeof value.ssh.host === 'string' &&
		typeof value.ssh.identityPem === 'string' &&
		typeof value.ssh.knownHostsLine === 'string' &&
		typeof value.ssh.port === 'number' &&
		typeof value.ssh.user === 'string'
	);
}

function capturePrivateLeaseSnapshots(
	operations: GatewayControlLeaseRpcOperations,
	snapshots: Map<string, GatewayControlLeaseSnapshot>,
): GatewayControlLeaseRpcOperations {
	const capture = (result: unknown): void => {
		if (isPrivateLeaseSnapshot(result)) {
			snapshots.set(result.leaseId, result);
		}
	};
	return {
		getLease: async (request, options) => {
			const result = await operations.getLease(request, options);
			capture(result);
			return result;
		},
		prepareSemanticMutation: async (options) => {
			const prepared = await operations.prepareSemanticMutation(options);
			return {
				...prepared,
				execute: async (proof) => {
					const result = await prepared.execute(proof);
					capture(result);
					return result;
				},
			};
		},
	};
}

function parseWriteReadResult(value: unknown): ToolVmWriteReadResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error(`Tool VM probe did not return successful details: ${JSON.stringify(value)}`);
	}
	const details = value.details;
	if (
		(details.agentId !== 'main' && details.agentId !== 'beta') ||
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
		filePath: `.agent-vm/recovery-no-flap-${randomUUID()}.txt`,
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
		`${options.identity.agentId} Tool VM probe`,
		60_000,
	);
	const responseBody: unknown = await response.json();
	if (!response.ok) {
		throw new Error(`Tool VM probe failed with HTTP ${String(response.status)}.`);
	}
	return parseWriteReadResult(responseBody);
}

async function readCurrentRecords(
	stateDirectory: string,
): Promise<Map<string, ToolVmRuntimeRecord>> {
	const results = await loadAllToolVmRuntimeRecords(stateDirectory);
	const parseError = results.find((result) => result.kind === 'parse-error');
	if (parseError !== undefined) {
		throw new Error(`Tool VM runtime record failed to parse: ${parseError.path}`);
	}
	return new Map(
		results
			.filter((result) => result.kind === 'loaded')
			.map((result) => [result.record.leaseId, result.record] as const),
	);
}

async function readOpenClawProcessIdentity(gatewayVm: ManagedVm): Promise<{
	readonly processId: number;
	readonly startTimeTicks: string;
}> {
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
	const [processIdText, startTimeTicks] = result.stdout.trim().split(/\s+/u);
	const processId = Number(processIdText);
	if (!Number.isSafeInteger(processId) || processId <= 0 || startTimeTicks === undefined) {
		throw new Error(`OpenClaw process identity output was invalid: ${result.stdout}`);
	}
	return { processId, startTimeTicks };
}

async function runStrictSshCommand(options: {
	readonly command: string;
	readonly gatewayVm: ManagedVm;
	readonly snapshot: GatewayControlLeaseSnapshot & {
		readonly ssh: {
			readonly host: string;
			readonly identityPem: string;
			readonly knownHostsLine: string;
			readonly port: number;
			readonly user: string;
		};
	};
}): Promise<Awaited<ReturnType<ManagedVm['exec']>>> {
	const identityBase64 = Buffer.from(options.snapshot.ssh.identityPem).toString('base64');
	const knownHostsBase64 = Buffer.from(`${options.snapshot.ssh.knownHostsLine.trim()}\n`).toString(
		'base64',
	);
	const commandBase64 = Buffer.from(options.command).toString('base64');
	return await options.gatewayVm.exec(`set -eu
scratch_dir=/tmp/recovery-no-flap-ssh-${randomUUID()}
mkdir -p "$scratch_dir"
printf %s ${identityBase64} | base64 -d > "$scratch_dir/identity"
printf %s ${knownHostsBase64} | base64 -d > "$scratch_dir/known_hosts"
chmod 600 "$scratch_dir/identity" "$scratch_dir/known_hosts"
remote_command="$(printf %s ${commandBase64} | base64 -d)"
ssh -4 -p ${String(options.snapshot.ssh.port)} -i "$scratch_dir/identity" \\
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$scratch_dir/known_hosts" \\
  -o UpdateHostKeys=no -o BatchMode=yes -o ConnectTimeout=10 \\
  ${options.snapshot.ssh.user}@${options.snapshot.ssh.host} "$remote_command"
result=$?
rm -f "$scratch_dir/identity" "$scratch_dir/known_hosts"
rmdir "$scratch_dir"
exit "$result"`);
}

function currentAcceptedSessionIdentity(
	controlSession: NonNullable<Awaited<ReturnType<typeof startGatewayZone>>['controlSession']>,
): { readonly attachmentGeneration: number; readonly sessionId: string } {
	const diagnostics = controlSession.getDiagnostics();
	const attachmentGeneration = diagnostics.attachmentGeneration;
	const sessionId = diagnostics.lastHelloResponse?.sessionId;
	if (
		attachmentGeneration === undefined ||
		sessionId === undefined ||
		diagnostics.lastHelloResponse?.outcome !== 'accepted' ||
		!diagnostics.connected ||
		!diagnostics.ready
	) {
		throw new Error(`Expected accepted control session: ${JSON.stringify(diagnostics)}`);
	}
	return { attachmentGeneration, sessionId };
}

async function waitForSuccessor(options: {
	readonly gatewayVm: ManagedVm;
	readonly previousProcessEpoch: string;
	readonly previousSessionId: string;
	readonly registry: OpenClawProcessReliabilityFaultTargetRegistry;
}): Promise<{
	readonly identity: ObservedRecoveryIdentity;
	readonly target: OpenClawProcessReliabilityFaultTargetSnapshot;
}> {
	const deadlineMs = Date.now() + 120_000;
	while (Date.now() < deadlineMs) {
		const target = options.registry.getCurrent();
		const diagnostics = target?.controlSession?.getDiagnostics();
		const attachmentGeneration = diagnostics?.attachmentGeneration;
		const sessionId = diagnostics?.lastHelloResponse?.sessionId;
		if (
			target !== undefined &&
			target.processEpoch !== options.previousProcessEpoch &&
			attachmentGeneration !== undefined &&
			sessionId !== undefined &&
			sessionId !== options.previousSessionId &&
			diagnostics?.lastHelloResponse?.outcome === 'accepted' &&
			diagnostics.connected &&
			diagnostics.ready
		) {
			const process = await readOpenClawProcessIdentity(options.gatewayVm);
			return {
				identity: {
					processEpoch: target.processEpoch,
					processId: process.processId,
					processStartTimeTicks: process.startTimeTicks,
					sessionAttachmentGeneration: attachmentGeneration,
					sessionId,
				},
				target,
			};
		}
		await waitForProtocolRetryInterval(500);
	}
	throw new Error('Timed out waiting for a distinct accepted OpenClaw process/session successor.');
}

function createTerminationRequest(
	target: OpenClawProcessReliabilityFaultTargetSnapshot,
	recoveryIndex: number,
): ReliabilityFaultApplyRequest {
	const issuedAtMs = Date.now();
	return {
		action: 'terminate-owned-gateway-service',
		actionId: randomUUID(),
		authorityId: randomUUID(),
		expiresAtMs: issuedAtMs + 30_000,
		fences: {
			controller: target.controllerGeneration,
			controlSession: { generation: 0, id: 'neutral-control-session' },
			gateway: target.gatewayGeneration,
			leaseLeaf: { generation: 0, id: 'neutral-lease-leaf' },
			openClawProcess: target.openClawProcessGeneration,
		},
		issuedAtMs,
		nonce: randomUUID().replaceAll('-', ''),
		runId: `recovery-no-flap-e2e-${String(recoveryIndex)}`,
		schemaVersion: 1,
		target: target.target,
	};
}

async function sendControlPing(options: {
	readonly sequence: number;
	readonly target: OpenClawProcessReliabilityFaultTargetSnapshot;
}): Promise<void> {
	const controlSession = options.target.controlSession;
	if (controlSession === undefined) {
		throw new Error('Expected Gateway control session identity for stability ping.');
	}
	const diagnostics = controlSession.getDiagnostics();
	const hello = diagnostics.lastHelloResponse;
	if (hello === undefined || hello.outcome !== 'accepted') {
		throw new Error(
			`Expected accepted control session before ping: ${JSON.stringify(diagnostics)}`,
		);
	}
	const envelope: ControlEnvelope = ControlEnvelopeSchema.parse({
		bootId: options.target.processEpoch,
		connectionId: hello.connectionId,
		controllerEpoch: hello.controllerEpoch,
		createdAtMs: Date.now(),
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation.control_ping,
		domain: 'gateway_control',
		kind: 'command',
		messageId: randomUUID(),
		operation: 'control_ping',
		peerId: `gateway-${options.target.gateway.zoneId}`,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: options.sequence,
		sessionId: hello.sessionId,
		zoneId: options.target.gateway.zoneId,
	});
	const result = GatewayControlRpcCommandResultMessageSchema.parse(
		await controlSession.emitApplicationMessage(
			envelope,
			{ kind: 'command', operation: 'control_ping' },
			{ kind: 'command', operation: 'control_ping', payload: {} },
		),
	);
	expect(result).toMatchObject({
		kind: 'command_result',
		operation: 'control_ping',
		payload: { responseToMessageId: envelope.messageId, result: 'ok' },
	});
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

describeRecoveryNoFlapE2e('e2e: repeated process recovery followed by no-flap window', () => {
	let gatewayStart: Awaited<ReturnType<typeof startGatewayZone>> | undefined;
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	let registry: OpenClawProcessReliabilityFaultTargetRegistry | undefined;
	const leaseSnapshots = new Map<string, GatewayControlLeaseSnapshot>();
	const publishedTargets: OpenClawProcessReliabilityFaultTargetSnapshot[] = [];

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
				const delegate = createOpenClawProcessReliabilityFaultTargetRegistry(options);
				const instrumented = {
					getCurrent: (target) => delegate.getCurrent(target),
					isCurrent: (snapshot) => delegate.isCurrent(snapshot),
					publish: (publication) => {
						const snapshot = delegate.publish(publication);
						publishedTargets.push(snapshot);
						return snapshot;
					},
					revoke: (revocation) => delegate.revoke(revocation),
				} satisfies OpenClawProcessReliabilityFaultTargetRegistry;
				registry = instrumented;
				return instrumented;
			},
			secrets: {
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV]: '1',
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV]:
					JSON.stringify(configuredProbeIdentities),
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV]: probeSigningKey,
				GITHUB_TOKEN: 'unused-recovery-no-flap-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-recovery-no-flap-token',
			},
			startGatewayZone: async (startOptions) => {
				if (startOptions.gatewayControlLeaseRpc === undefined) {
					throw new Error('Expected Gateway control lease RPC operations.');
				}
				const result = await startGatewayZone({
					...startOptions,
					gatewayControlLeaseRpc: capturePrivateLeaseSnapshots(
						startOptions.gatewayControlLeaseRpc,
						leaseSnapshots,
					),
				});
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

	it('recovers exactly three times and remains stable without Gateway or Tool churn', async () => {
		if (gatewayStart === undefined || harness === undefined || registry === undefined) {
			throw new Error('Expected recovery no-flap Gateway, control session, and registry.');
		}
		const activeGatewayStart = gatewayStart;
		const activeHarness = harness;
		const activeRegistry = registry;
		const activeZone = activeHarness.systemConfig.zones[0];
		if (activeZone === undefined) {
			throw new Error('Expected recovery no-flap zone configuration.');
		}

		const initialProbes = await Promise.all(
			configuredProbeIdentities.map(
				async (identity) =>
					await callWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `INITIAL_${identity.agentId}_${randomUUID()}`,
					}),
			),
		);
		const runtimeIds = Object.fromEntries(
			initialProbes.map((result) => [result.agentId, result.runtimeId]),
		) as Record<'beta' | 'main', string>;
		const initialRecords = await readCurrentRecords(activeZone.gateway.stateDir);
		const ownedInitialRecords = new Map(
			Object.values(runtimeIds).map(
				(runtimeId) => [runtimeId, initialRecords.get(runtimeId)] as const,
			),
		);
		if (Array.from(ownedInitialRecords.values()).some((record) => record === undefined)) {
			throw new Error('Expected both exact initial Tool VM runtime records.');
		}
		const gatewayVmId = activeGatewayStart.vm.id;
		const canaryPaths = new Map<string, string>();
		const initialSshSnapshots = new Map<string, NonNullable<GatewayControlLeaseSnapshot['ssh']>>();
		for (const identity of configuredProbeIdentities) {
			const runtimeId = runtimeIds[identity.agentId];
			const snapshot = leaseSnapshots.get(runtimeId);
			if (!isPrivateLeaseSnapshot(snapshot)) {
				throw new Error(`Expected private SSH snapshot for ${identity.agentId}.`);
			}
			const canaryPath = `.agent-vm/no-flap-${identity.agentId}-${randomUUID()}.txt`;
			const canaryMarker = `CANARY_${identity.agentId}_${randomUUID()}`;
			canaryPaths.set(identity.agentId, `${canaryPath}\0${canaryMarker}`);
			initialSshSnapshots.set(identity.agentId, snapshot.ssh);
			const write = await runStrictSshCommand({
				command: `mkdir -p .agent-vm && printf %s ${canaryMarker} > ${canaryPath}`,
				gatewayVm: activeGatewayStart.vm,
				snapshot,
			});
			expect(write).toMatchObject({ exitCode: 0 });
		}

		const initialTarget = activeRegistry.getCurrent();
		if (initialTarget === undefined) {
			throw new Error('Expected exact initial OpenClaw process fault target.');
		}
		if (initialTarget.controlSession === undefined) {
			throw new Error('Expected initial exact process target to expose its control session.');
		}
		const initialSession = currentAcceptedSessionIdentity(initialTarget.controlSession);
		const initialProcess = await readOpenClawProcessIdentity(activeGatewayStart.vm);
		const observedRecoveries: ObservedRecoveryIdentity[] = [
			{
				processEpoch: initialTarget.processEpoch,
				processId: initialProcess.processId,
				processStartTimeTicks: initialProcess.startTimeTicks,
				sessionAttachmentGeneration: initialSession.attachmentGeneration,
				sessionId: initialSession.sessionId,
			},
		];
		const handler = createOpenClawProcessReliabilityFaultHandler({
			createReceiptId: randomUUID,
			nowMs: Date.now,
			registry: activeRegistry,
		});
		let currentTarget = initialTarget;
		for (let recoveryIndex = 1; recoveryIndex <= requiredRecoveryCount; recoveryIndex += 1) {
			const previousIdentity = observedRecoveries.at(-1);
			if (previousIdentity === undefined) {
				throw new Error('Previous recovery identity became unavailable.');
			}
			const receipt = await handler(createTerminationRequest(currentTarget, recoveryIndex));
			expect(receipt).toMatchObject({ state: 'applied', target: currentTarget.target });
			const successor = await waitForSuccessor({
				gatewayVm: activeGatewayStart.vm,
				previousProcessEpoch: previousIdentity.processEpoch,
				previousSessionId: previousIdentity.sessionId,
				registry: activeRegistry,
			});
			currentTarget = successor.target;
			observedRecoveries.push(successor.identity);
			expect(activeGatewayStart.vm.id).toBe(gatewayVmId);
			const probes = await Promise.all(
				configuredProbeIdentities.map(
					async (identity) =>
						await callWriteReadProbe({
							harness: activeHarness,
							identity,
							marker: `RECOVERY_${String(recoveryIndex)}_${identity.agentId}_${randomUUID()}`,
						}),
				),
			);
			for (const probe of probes) {
				expect(probe.runtimeId).toBe(runtimeIds[probe.agentId]);
				expect(probe.readBack).toBe(probe.marker);
			}
			const currentRecords = await readCurrentRecords(activeZone.gateway.stateDir);
			for (const runtimeId of Object.values(runtimeIds)) {
				expect(currentRecords.get(runtimeId)).toEqual(ownedInitialRecords.get(runtimeId));
			}
			for (const identity of configuredProbeIdentities) {
				const runtimeId = runtimeIds[identity.agentId];
				const snapshot = leaseSnapshots.get(runtimeId);
				const canary = canaryPaths.get(identity.agentId)?.split('\0');
				if (
					!isPrivateLeaseSnapshot(snapshot) ||
					canary?.[0] === undefined ||
					canary[1] === undefined
				) {
					throw new Error(`Expected stable SSH canary for ${identity.agentId}.`);
				}
				expect(snapshot.ssh).toEqual(initialSshSnapshots.get(identity.agentId));
				const read = await runStrictSshCommand({
					command: `cat ${canary[0]}`,
					gatewayVm: activeGatewayStart.vm,
					snapshot,
				});
				expect(read).toMatchObject({ exitCode: 0 });
				expect(read.stdout.trim()).toBe(canary[1]);
			}
		}

		expect(new Set(observedRecoveries.map((identity) => identity.processEpoch)).size).toBe(
			requiredRecoveryCount + 1,
		);
		expect(new Set(observedRecoveries.map((identity) => identity.sessionId)).size).toBe(
			requiredRecoveryCount + 1,
		);
		const quietWindowStartedAtMs = Date.now();
		const quietWindowTarget = activeRegistry.getCurrent();
		const quietWindowPublicationCount = publishedTargets.length;
		let stabilityObservationCount = 0;
		while (Date.now() - quietWindowStartedAtMs < stabilityWindowMs) {
			const identity =
				configuredProbeIdentities[stabilityObservationCount % configuredProbeIdentities.length];
			if (identity === undefined) {
				throw new Error('Stability probe identity selection failed.');
			}
			await sendControlPing({
				sequence: stabilityObservationCount + 1,
				target: currentTarget,
			});
			const probe = await callWriteReadProbe({
				harness: activeHarness,
				identity,
				marker: `QUIET_${String(stabilityObservationCount)}_${identity.agentId}_${randomUUID()}`,
			});
			expect(probe.runtimeId).toBe(runtimeIds[identity.agentId]);
			const quietRecords = await readCurrentRecords(activeZone.gateway.stateDir);
			for (const runtimeId of Object.values(runtimeIds)) {
				expect(quietRecords.get(runtimeId)).toEqual(ownedInitialRecords.get(runtimeId));
			}
			const quietSnapshot = leaseSnapshots.get(runtimeIds[identity.agentId]);
			const quietCanary = canaryPaths.get(identity.agentId)?.split('\0');
			if (
				!isPrivateLeaseSnapshot(quietSnapshot) ||
				quietCanary?.[0] === undefined ||
				quietCanary[1] === undefined
			) {
				throw new Error(`Expected quiet-window SSH canary for ${identity.agentId}.`);
			}
			expect(quietSnapshot.ssh).toEqual(initialSshSnapshots.get(identity.agentId));
			const quietCanaryRead = await runStrictSshCommand({
				command: `cat ${quietCanary[0]}`,
				gatewayVm: activeGatewayStart.vm,
				snapshot: quietSnapshot,
			});
			expect(quietCanaryRead).toMatchObject({ exitCode: 0 });
			expect(quietCanaryRead.stdout.trim()).toBe(quietCanary[1]);
			expect(activeRegistry.getCurrent()).toBe(quietWindowTarget);
			expect(publishedTargets).toHaveLength(quietWindowPublicationCount);
			expect(activeGatewayStart.vm.id).toBe(gatewayVmId);
			stabilityObservationCount += 1;
			await waitForProtocolRetryInterval(stabilityProbeIntervalMs);
		}
		const quietWindowEndedAtMs = Date.now();
		expect(quietWindowEndedAtMs - quietWindowStartedAtMs).toBeGreaterThanOrEqual(stabilityWindowMs);
		expect(stabilityObservationCount).toBeGreaterThanOrEqual(2);
		expect(publishedTargets).toHaveLength(requiredRecoveryCount + 1);

		const budgetsArtifact = JSON.stringify({
			observedRecoveryCount: requiredRecoveryCount,
			policy: {
				attemptWindowMs: OPENCLAW_PROCESS_RECOVERY_ATTEMPT_WINDOW_MS,
				cooldownMs: OPENCLAW_PROCESS_RECOVERY_COOLDOWN_MS,
				maxAttempts: OPENCLAW_PROCESS_RECOVERY_MAX_ATTEMPTS,
				stabilityHeartbeats: OPENCLAW_PROCESS_RECOVERY_STABILITY_HEARTBEATS,
				stabilityMs: OPENCLAW_PROCESS_RECOVERY_STABILITY_MS,
				stabilityObservations: OPENCLAW_PROCESS_RECOVERY_STABILITY_OBSERVATIONS,
				successHistoryMs: OPENCLAW_PROCESS_RECOVERY_SUCCESS_HISTORY_MS,
				successLimit: OPENCLAW_PROCESS_RECOVERY_SUCCESS_LIMIT,
			},
			quietWindow: {
				endedAtMs: quietWindowEndedAtMs,
				observationCount: stabilityObservationCount,
				probeIntervalMs: stabilityProbeIntervalMs,
				startedAtMs: quietWindowStartedAtMs,
				windowMs: quietWindowEndedAtMs - quietWindowStartedAtMs,
			},
		});
		const identityArtifact = JSON.stringify({
			gatewayVmId,
			processes: observedRecoveries,
			toolRecords: Object.fromEntries(ownedInitialRecords),
		});
		const runScopedQueryMarker = `quiet-${hashControlLeaseReliabilityArtifact(
			process.env.AGENT_VM_RELIABILITY_RUN_ID ?? 'local',
		).slice(0, 24)}`;
		const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
			expectedOperationId: reliabilityOperationId,
			payload: {
				artifacts: [
					{
						operationId: 'recovery-no-flap-budgets',
						sha256: hashControlLeaseReliabilityArtifact(budgetsArtifact),
					},
					{
						operationId: 'recovery-no-flap-identities',
						sha256: hashControlLeaseReliabilityArtifact(identityArtifact),
					},
				],
				generationIdentities: publishedTargets.map((target) => ({
					generation: target.openClawProcessGeneration.generation,
					targetId: target.openClawProcessGeneration.id,
					targetKind: 'openclaw-process',
				})),
				packageIdentities: [await readPackageIdentity()],
				processIdentities: [
					...observedRecoveries.map((identity) => ({
						bootId: identity.processEpoch,
						kind: 'openclaw-process' as const,
						processId: identity.processId,
						startIdentity: `proc-start-${identity.processStartTimeTicks}`,
					})),
					...Array.from(ownedInitialRecords.values()).flatMap((record) =>
						record === undefined
							? []
							: [
									{
										bootId: record.gateway.gatewayEpochId,
										kind: 'tool-vm-process' as const,
										processId: record.qemuPid,
										startIdentity: hashControlLeaseReliabilityArtifact(
											`${record.processIdentity.command}\n${record.processIdentity.lstart}`,
										),
									},
								],
					),
				],
				queryIdentities: [
					{
						marker: runScopedQueryMarker,
						source: 'recovery-no-flap-stability-window',
						windowEndMs: quietWindowEndedAtMs,
						windowStartMs: quietWindowStartedAtMs,
					},
				],
				runtimeIdentities: [
					{
						generation: initialTarget.gatewayGeneration.generation,
						id: gatewayVmId,
						kind: 'gateway-vm',
					},
					...Array.from(ownedInitialRecords.values()).flatMap((record) =>
						record === undefined
							? []
							: [{ generation: 0, id: record.vmId, kind: 'tool-vm' as const }],
					),
				],
			},
		});
		expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
	}, 900_000);
});
