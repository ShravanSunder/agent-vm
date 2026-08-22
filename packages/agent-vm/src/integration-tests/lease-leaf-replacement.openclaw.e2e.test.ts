/* oxlint-disable eslint/no-await-in-loop -- live process disappearance is observed sequentially */
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ToolPortalConfig } from '@agent-vm/config-contracts';
import type { GatewayControlLeaseSnapshot } from '@agent-vm/gateway-control-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import type { GatewayControlBindingPublicationSource } from '../controller/control-session/index.js';
import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../controller/durable-state/controller-state-paths.js';
import {
	resolveControllerGatewayRecordTargets,
	type ControllerToolLeaseRecordsTarget,
} from '../controller/durable-state/controller-state-record-paths.js';
import {
	loadAllToolVmRuntimeRecords,
	type ToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';
import { terminateRecordedManagedVmProcess } from '../shared/controller-managed-vm-termination.js';
import { isProcessAlive } from '../shared/managed-vm-process.js';
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
const managedVmRuntimeComposition = createManagedVmRuntimeComposition();
type GatewayVmObservationOperations = Pick<
	GatewayZoneVmOperations,
	'enableSsh' | 'exec' | 'getHostProcessId' | 'id'
>;
const runLeaseLeafReplacementE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeLeaseLeafReplacementE2e = runLeaseLeafReplacementE2e ? describe : describe.skip;
const zoneId = 'lease-leaf-replacement';
const gatewayToken = 'lease-leaf-replacement-gateway-token';
const probeSigningKey = 'lease-leaf-replacement-write-read-proof-key';
const gatewayRuntimeSandboxProbeEnv = 'AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE';
const gatewayRuntimeSandboxProbeIdentitiesEnv =
	'AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES';
const gatewayRuntimeSandboxProbeKeyEnv = 'AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY';
const gatewayRuntimeSandboxProbePath = '/plugins/gondolin/e2e/gateway-runtime-sandbox-write-read';
const gatewayRuntimeSandboxProbeSignatureHeader =
	'x-agent-vm-e2e-gateway-runtime-sandbox-signature';
const sandboxToolPortalProfileId = 's2-sandbox';
const resetConnectionObservationFileName = 'agent-vm-lease-leaf-reset-connection.log';
const resetConnectionObservationMarker = 'S2_RESET_CONNECTION_DISPATCHED';
const resetConnectionScript = [
	'set -eu',
	`marker_file=/workspace/${resetConnectionObservationFileName}`,
	`printf '%s\\n' '${resetConnectionObservationMarker}' >> "$marker_file"`,
	'sync "$marker_file"',
	'current_pid=$$',
	'sshd_pid=',
	'while [ "$current_pid" -gt 1 ]; do',
	'  parent_pid=$(awk \'/^PPid:/ { print $2 }\' "/proc/$current_pid/status")',
	'  [ -n "$parent_pid" ] || exit 96',
	'  parent_name=$(awk \'/^Name:/ { print $2 }\' "/proc/$parent_pid/status")',
	'  case "$parent_name" in',
	'    sshd|sshd-session) sshd_pid=$parent_pid; break ;;',
	'  esac',
	'  current_pid=$parent_pid',
	'done',
	'[ -n "$sshd_pid" ] || exit 97',
	'kill -TERM "$sshd_pid"',
	'exit 98',
].join('\n');
const reliabilityOperationId = 'lease-leaf-replacement';
const affectedIdentity = {
	agentId: 'main',
	sessionKey: 'agent:main:tool-vm-write-read:lease-leaf-replacement-main',
} as const;
const siblingIdentity = {
	agentId: 'beta',
	sessionKey: 'agent:beta:tool-vm-write-read:lease-leaf-replacement-beta',
} as const;
const configuredProbeIdentities = [affectedIdentity, siblingIdentity] as const;

const sandboxToolPortalConfig = {
	agents: {
		main: { profile: sandboxToolPortalProfileId },
		beta: { profile: sandboxToolPortalProfileId },
	},
	mode: 'managed',
	profiles: {
		[sandboxToolPortalProfileId]: {
			namespaces: {
				sandbox: {
					discovery: {},
					backend: {
						kind: 'tool_vm_runner',
						operations: {
							read_file: {
								description: 'Read the S2 lease replacement proof file.',
								kind: 'filesystem.read',
							},
							reset_connection: {
								description: 'Record and interrupt the current S2 strict SSH connection.',
								executable: '/bin/sh',
								kind: 'command.fixed',
								mandatoryArgvPrefix: ['-c', resetConnectionScript],
								workingDirectory: '.',
							},
							write_file: {
								description: 'Write the S2 lease replacement proof file.',
								kind: 'filesystem.write',
							},
						},
						profile: 'sandbox_ssh',
					},
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: {
							allow: ['write_file', 'read_file', 'reset_connection'],
							deny: [],
						},
					},
					tools: { allow: ['write_file', 'read_file', 'reset_connection'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies ToolPortalConfig;

interface ToolVmWriteReadResult {
	readonly agentId: string;
	readonly filePath: string;
	readonly kind: 'write-read';
	readonly marker: string;
	readonly readBack: string;
	readonly status: 'ok';
}

interface ToolVmResetConnectionResult {
	readonly agentId: string;
	readonly kind: 'reset-connection';
	readonly status: 'ambiguous';
}

interface WriteReadProbeRequest {
	readonly action: 'write-read';
	readonly agentId: string;
	readonly filePath: string;
	readonly marker: string;
	readonly sessionKey: string;
}

interface ResetConnectionProbeRequest {
	readonly action: 'reset-connection';
	readonly agentId: string;
	readonly sessionKey: string;
}

type GatewayRuntimeSandboxProbeRequest = ResetConnectionProbeRequest | WriteReadProbeRequest;

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWriteReadStep(value: unknown): ToolVmWriteReadResult {
	if (
		!isObjectRecord(value) ||
		value.status !== 'ok' ||
		value.kind !== 'write-read' ||
		typeof value.agentId !== 'string' ||
		typeof value.filePath !== 'string' ||
		typeof value.marker !== 'string' ||
		typeof value.readBack !== 'string'
	) {
		throw new Error(`Tool VM write/read result is malformed: ${JSON.stringify(value)}`);
	}
	return {
		agentId: value.agentId,
		filePath: value.filePath,
		kind: value.kind,
		marker: value.marker,
		readBack: value.readBack,
		status: value.status,
	};
}

function parseResetConnectionStep(value: unknown): ToolVmResetConnectionResult {
	if (
		!isObjectRecord(value) ||
		value.kind !== 'reset-connection' ||
		value.status !== 'ambiguous' ||
		typeof value.agentId !== 'string'
	) {
		throw new Error(`Tool VM reset result is malformed: ${JSON.stringify(value)}`);
	}
	return { agentId: value.agentId, kind: value.kind, status: value.status };
}

function parseProbeDetails(value: unknown): Readonly<Record<string, unknown>> {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error(`Tool VM probe did not return successful details: ${JSON.stringify(value)}`);
	}
	return value.details;
}

async function postProbeRequest(options: {
	readonly body: GatewayRuntimeSandboxProbeRequest;
	readonly harness: E2eHarnessRuntime;
}): Promise<unknown> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Lease leaf replacement E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify(options.body);
	const response = await withProtocolDeadline(
		fetch(`http://${ingress.host}:${String(ingress.port)}${gatewayRuntimeSandboxProbePath}`, {
			body: bodyText,
			headers: {
				authorization: `Bearer ${gatewayToken}`,
				'content-type': 'application/json',
				[gatewayRuntimeSandboxProbeSignatureHeader]: createHmac('sha256', probeSigningKey)
					.update(bodyText, 'utf8')
					.digest('base64url'),
			},
			method: 'POST',
		}),
		`${options.body.agentId} Tool VM ${options.body.action} probe`,
		60_000,
	);
	const responseBody: unknown = await response.json();
	if (!response.ok) {
		throw new Error(
			`Tool VM probe failed with HTTP ${String(response.status)}: ${JSON.stringify(responseBody)}`,
		);
	}
	return responseBody;
}

async function callWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly phase: 'initial' | 'qemu-death-reacquisition' | 'replacement';
}): Promise<ToolVmWriteReadResult> {
	const responseBody = await postProbeRequest({
		body: {
			action: 'write-read',
			agentId: options.identity.agentId,
			filePath: `agent-vm-e2e-lease-leaf-${options.phase}-${randomUUID()}.txt`,
			marker: `${options.identity.agentId}_${options.phase.toUpperCase()}_${randomUUID()}`,
			sessionKey: options.identity.sessionKey,
		},
		harness: options.harness,
	});
	return parseWriteReadStep(parseProbeDetails(responseBody));
}

async function callResetConnectionProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
}): Promise<ToolVmResetConnectionResult> {
	const responseBody = await postProbeRequest({
		body: {
			action: 'reset-connection',
			agentId: options.identity.agentId,
			sessionKey: options.identity.sessionKey,
		},
		harness: options.harness,
	});
	return parseResetConnectionStep(parseProbeDetails(responseBody));
}

type PrivateLeaseSnapshot = GatewayControlLeaseSnapshot & {
	readonly leafGeneration: string;
	readonly ssh: {
		readonly host: string;
		readonly identityPem: string;
		readonly knownHostsLine: string;
		readonly port: number;
		readonly user: string;
	};
	readonly sshBindingId: string;
};

function isPrivateLeaseSnapshot(value: unknown): value is PrivateLeaseSnapshot {
	return (
		isObjectRecord(value) &&
		typeof value.leaseId === 'string' &&
		typeof value.leafGeneration === 'string' &&
		isObjectRecord(value.ssh) &&
		typeof value.ssh.host === 'string' &&
		typeof value.ssh.identityPem === 'string' &&
		typeof value.ssh.knownHostsLine === 'string' &&
		typeof value.ssh.port === 'number' &&
		typeof value.ssh.user === 'string' &&
		typeof value.sshBindingId === 'string'
	);
}

function capturePrivateBindingSnapshots(
	publicationSource: GatewayControlBindingPublicationSource,
	snapshots: Map<string, GatewayControlLeaseSnapshot>,
): GatewayControlBindingPublicationSource {
	return {
		...publicationSource,
		createBinding: async (request) => {
			const binding = await publicationSource.createBinding(request);
			if (isPrivateLeaseSnapshot(binding)) snapshots.set(binding.leaseId, binding);
			return binding;
		},
	};
}

async function readCurrentRecords(
	recordsTarget: ControllerToolLeaseRecordsTarget,
): Promise<Map<string, ToolVmRuntimeRecord>> {
	const results = await loadAllToolVmRuntimeRecords(recordsTarget);
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

async function readControllerActiveLeaseCount(controllerUrl: string): Promise<number> {
	const response = await withProtocolDeadline(
		fetch(`${controllerUrl}/controller-status`),
		'controller status while waiting for exact Tool VM retirement',
		10_000,
	);
	if (!response.ok) {
		throw new Error(`Controller status returned HTTP ${String(response.status)}.`);
	}
	const payload: unknown = await response.json();
	if (!isObjectRecord(payload) || !Array.isArray(payload.zones)) {
		throw new Error('Controller status did not contain a zones array.');
	}
	const zone = payload.zones.find(
		(candidate) => isObjectRecord(candidate) && candidate.id === zoneId,
	);
	if (!isObjectRecord(zone) || typeof zone.activeLeaseCount !== 'number') {
		throw new Error(`Controller status did not contain zone '${zoneId}'.`);
	}
	return zone.activeLeaseCount;
}

async function waitForControllerLeaseState(options: {
	readonly activeLeaseCount: number;
	readonly affectedLeaseId: string;
	readonly controllerUrl: string;
	readonly expectedAffectedRecordPresent: boolean;
	readonly expectedRecordCount: number;
	readonly phaseLabel: string;
	readonly recordsTarget: ControllerToolLeaseRecordsTarget;
	readonly siblingLeaseId: string;
}): Promise<Map<string, ToolVmRuntimeRecord>> {
	return await withProtocolDeadline(
		(async (): Promise<Map<string, ToolVmRuntimeRecord>> => {
			while (true) {
				const [records, activeLeaseCount] = await Promise.all([
					readCurrentRecords(options.recordsTarget),
					readControllerActiveLeaseCount(options.controllerUrl),
				]);
				if (
					records.has(options.affectedLeaseId) === options.expectedAffectedRecordPresent &&
					records.has(options.siblingLeaseId) &&
					records.size === options.expectedRecordCount &&
					activeLeaseCount === options.activeLeaseCount
				) {
					return records;
				}
				await waitForProtocolRetryInterval(250);
			}
		})(),
		`Tool VM lease '${options.affectedLeaseId}' ${options.phaseLabel}`,
		180_000,
	);
}

function resolveCurrentAgentLease(options: {
	readonly agentId: string;
	readonly records: ReadonlyMap<string, ToolVmRuntimeRecord>;
	readonly snapshots: ReadonlyMap<string, GatewayControlLeaseSnapshot>;
}): {
	readonly record: ToolVmRuntimeRecord;
	readonly snapshot: PrivateLeaseSnapshot;
} {
	const currentSnapshots = [...options.snapshots.values()].filter(
		(snapshot): snapshot is PrivateLeaseSnapshot =>
			isPrivateLeaseSnapshot(snapshot) &&
			snapshot.agentId === options.agentId &&
			options.records.has(snapshot.leaseId),
	);
	if (currentSnapshots.length !== 1) {
		throw new Error(
			`Expected exactly one current private lease snapshot for agent '${options.agentId}', found ${String(currentSnapshots.length)}.`,
		);
	}
	const snapshot = currentSnapshots[0];
	if (snapshot === undefined) {
		throw new Error(`Current private lease snapshot for agent '${options.agentId}' disappeared.`);
	}
	const record = options.records.get(snapshot.leaseId);
	if (record === undefined) {
		throw new Error(`Current runtime record for lease '${snapshot.leaseId}' disappeared.`);
	}
	return { record, snapshot };
}

async function runStrictSshCanary(options: {
	readonly gatewayVm: GatewayVmObservationOperations;
	readonly identityPem: string;
	readonly knownHostsLine: string;
	readonly snapshot: GatewayControlLeaseSnapshot & {
		readonly ssh: NonNullable<GatewayControlLeaseSnapshot['ssh']>;
	};
	readonly marker: string;
}): Promise<Awaited<ReturnType<GatewayVmObservationOperations['exec']>>> {
	const identityBase64 = Buffer.from(options.identityPem).toString('base64');
	const knownHostsBase64 = Buffer.from(`${options.knownHostsLine.trim()}\n`).toString('base64');
	const command = `set -eu
scratch_dir=/tmp/lease-leaf-ssh-${randomUUID()}
mkdir -p "$scratch_dir"
printf %s ${identityBase64} | base64 -d > "$scratch_dir/identity"
printf %s ${knownHostsBase64} | base64 -d > "$scratch_dir/known_hosts"
chmod 600 "$scratch_dir/identity" "$scratch_dir/known_hosts"
ssh -4 -p ${String(options.snapshot.ssh.port)} -i "$scratch_dir/identity" \\
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$scratch_dir/known_hosts" \\
  -o UpdateHostKeys=no -o BatchMode=yes -o ConnectTimeout=10 \\
  ${options.snapshot.ssh.user}@${options.snapshot.ssh.host} 'printf %s ${options.marker}'
result=$?
rm -f "$scratch_dir/identity" "$scratch_dir/known_hosts"
rmdir "$scratch_dir"
exit "$result"`;
	return await options.gatewayVm.exec(command);
}

async function waitForProcessAbsent(pid: number): Promise<void> {
	const deadlineMs = Date.now() + 30_000;
	while (Date.now() < deadlineMs) {
		if (!isProcessAlive(pid)) {
			return;
		}
		await waitForProtocolRetryInterval(250);
	}
	throw new Error(`Replaced Tool VM process ${String(pid)} remained alive.`);
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

describeLeaseLeafReplacementE2e('e2e: one Tool VM leaf replacement', () => {
	let gatewayVm: GatewayVmObservationOperations | undefined;
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	const leaseSnapshots = new Map<string, GatewayControlLeaseSnapshot>();

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: configuredProbeIdentities.map(({ agentId }) => agentId),
			architecture,
			prefix: 'lease-leaf-replacement-e2e-',
			zoneId,
		});
		const systemZone = project.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected lease leaf replacement project to contain an OpenClaw zone.');
		}
		const openClawGateway = systemZone.gateway;
		const toolPortalConfigDir = path.dirname(openClawGateway.config);
		systemZone.toolPortal = {
			configDir: toolPortalConfigDir,
			surfaceEligibilityByProfile: {
				[sandboxToolPortalProfileId]: {
					sandbox: ['protected_uds'],
				},
			},
		};
		await fs.writeFile(
			path.join(toolPortalConfigDir, 'tool-portal.config.jsonc'),
			`${JSON.stringify(sandboxToolPortalConfig, null, '\t')}\n`,
			'utf8',
		);
		for (const envName of [
			gatewayRuntimeSandboxProbeEnv,
			gatewayRuntimeSandboxProbeKeyEnv,
			gatewayRuntimeSandboxProbeIdentitiesEnv,
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
			gatewayRuntimeSandboxProbeEnv,
			gatewayRuntimeSandboxProbeKeyEnv,
			gatewayRuntimeSandboxProbeIdentitiesEnv,
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
				[gatewayRuntimeSandboxProbeEnv]: '1',
				[gatewayRuntimeSandboxProbeIdentitiesEnv]: JSON.stringify(configuredProbeIdentities),
				[gatewayRuntimeSandboxProbeKeyEnv]: probeSigningKey,
				GITHUB_TOKEN: 'unused-lease-leaf-replacement-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-lease-leaf-replacement-token',
			},
			startGatewayZone: async (startOptions) => {
				if (startOptions.gatewayControlBindingPublicationSource === undefined) {
					throw new Error('Expected Gateway control binding publication source.');
				}
				const result = await startGatewayZone({
					...startOptions,
					gatewayControlBindingPublicationSource: capturePrivateBindingSnapshots(
						startOptions.gatewayControlBindingPublicationSource,
						leaseSnapshots,
					),
				});
				if (result.executionModel !== 'managed-gateway') {
					throw new Error('Lease leaf replacement proof requires managed Gateway image boot.');
				}
				gatewayVm = result.vm;
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

	it('replaces exactly one failed leaf with a fresh strict SSH identity', async () => {
		if (gatewayVm === undefined || harness === undefined) {
			throw new Error('Expected lease leaf replacement harness to be initialized.');
		}
		const activeGatewayVm = gatewayVm;
		const activeHarness = harness;
		const systemZone = activeHarness.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected lease leaf replacement zone configuration.');
		}
		const controllerRecordTargets = resolveControllerGatewayRecordTargets({
			gatewayStateRoot: resolveControllerGatewayStateRoot({
				controllerStateRoot: createControllerStateRoot({
					controllerStateDirectoryPath: activeHarness.systemConfig.controllerStateDir,
				}),
				zoneId,
			}),
		});

		const [affectedInitial, siblingInitial] = await Promise.all([
			callWriteReadProbe({
				harness: activeHarness,
				identity: affectedIdentity,
				phase: 'initial',
			}),
			callWriteReadProbe({
				harness: activeHarness,
				identity: siblingIdentity,
				phase: 'initial',
			}),
		]);
		expect(affectedInitial.readBack).toBe(affectedInitial.marker);
		expect(siblingInitial.readBack).toBe(siblingInitial.marker);
		const initialRecords = await readCurrentRecords(controllerRecordTargets.toolLeaseRecords);
		const { record: affectedRecordBefore, snapshot: affectedSnapshotBefore } =
			resolveCurrentAgentLease({
				agentId: affectedIdentity.agentId,
				records: initialRecords,
				snapshots: leaseSnapshots,
			});
		const { record: siblingRecordBefore, snapshot: siblingSnapshotBefore } =
			resolveCurrentAgentLease({
				agentId: siblingIdentity.agentId,
				records: initialRecords,
				snapshots: leaseSnapshots,
			});
		expect(affectedSnapshotBefore.leaseId).not.toBe(siblingSnapshotBefore.leaseId);
		const gatewayVmId = activeGatewayVm.id;
		const affectedSshBefore = await runStrictSshCanary({
			gatewayVm: activeGatewayVm,
			identityPem: affectedSnapshotBefore.ssh.identityPem,
			knownHostsLine: affectedSnapshotBefore.ssh.knownHostsLine,
			marker: 'affected-before',
			snapshot: affectedSnapshotBefore,
		});
		const siblingSshBefore = await runStrictSshCanary({
			gatewayVm: activeGatewayVm,
			identityPem: siblingSnapshotBefore.ssh.identityPem,
			knownHostsLine: siblingSnapshotBefore.ssh.knownHostsLine,
			marker: 'sibling-before',
			snapshot: siblingSnapshotBefore,
		});
		expect(affectedSshBefore).toMatchObject({ exitCode: 0 });
		expect(siblingSshBefore).toMatchObject({ exitCode: 0 });

		expect(isProcessAlive(affectedRecordBefore.qemuPid)).toBe(true);
		const resetObservationHostPath = path.join(
			systemZone.gateway.zoneFilesDir,
			'agents',
			affectedIdentity.agentId,
			resetConnectionObservationFileName,
		);
		const resetObservation = await callResetConnectionProbe({
			harness: activeHarness,
			identity: affectedIdentity,
		});
		expect(resetObservation).toEqual({
			agentId: affectedIdentity.agentId,
			kind: 'reset-connection',
			status: 'ambiguous',
		});
		expect(await fs.readFile(resetObservationHostPath, 'utf8')).toBe(
			`${resetConnectionObservationMarker}\n`,
		);
		expect(isProcessAlive(affectedRecordBefore.qemuPid)).toBe(true);

		const replacementProbe = await callWriteReadProbe({
			harness: activeHarness,
			identity: affectedIdentity,
			phase: 'replacement',
		});
		expect(replacementProbe.readBack).toBe(replacementProbe.marker);
		expect(replacementProbe.filePath).not.toBe(affectedInitial.filePath);
		expect(replacementProbe.marker).not.toBe(affectedInitial.marker);
		expect(await fs.readFile(resetObservationHostPath, 'utf8')).toBe(
			`${resetConnectionObservationMarker}\n`,
		);
		await waitForProcessAbsent(affectedRecordBefore.qemuPid);

		const postRecords = await readCurrentRecords(controllerRecordTargets.toolLeaseRecords);
		const { record: affectedRecordAfter, snapshot: affectedSnapshotAfter } =
			resolveCurrentAgentLease({
				agentId: affectedIdentity.agentId,
				records: postRecords,
				snapshots: leaseSnapshots,
			});
		const { record: siblingRecordAfter, snapshot: siblingSnapshotAfter } = resolveCurrentAgentLease(
			{
				agentId: siblingIdentity.agentId,
				records: postRecords,
				snapshots: leaseSnapshots,
			},
		);
		expect(affectedRecordAfter.vmId).not.toBe(affectedRecordBefore.vmId);
		expect(affectedRecordAfter.qemuPid).not.toBe(affectedRecordBefore.qemuPid);
		expect(affectedRecordAfter.tcpSlot).not.toBe(affectedRecordBefore.tcpSlot);
		expect(postRecords.size).toBe(initialRecords.size);
		expect(affectedSnapshotAfter.ssh.knownHostsLine).not.toBe(
			affectedSnapshotBefore.ssh.knownHostsLine,
		);
		expect(affectedSnapshotAfter.leafGeneration).not.toBe(affectedSnapshotBefore.leafGeneration);
		expect(siblingRecordAfter).toEqual(siblingRecordBefore);
		expect(siblingSnapshotAfter).toEqual(siblingSnapshotBefore);
		expect(activeGatewayVm.id).toBe(gatewayVmId);

		const staleHostIdentity = await runStrictSshCanary({
			gatewayVm: activeGatewayVm,
			identityPem: affectedSnapshotAfter.ssh.identityPem,
			knownHostsLine: affectedSnapshotBefore.ssh.knownHostsLine,
			marker: 'must-not-run',
			snapshot: affectedSnapshotAfter,
		});
		expect(staleHostIdentity.exitCode).not.toBe(0);
		expect(staleHostIdentity.stderr).toMatch(
			/host key verification failed|remote host identification has changed/iu,
		);
		const staleClientIdentity = await runStrictSshCanary({
			gatewayVm: activeGatewayVm,
			identityPem: affectedSnapshotBefore.ssh.identityPem,
			knownHostsLine: affectedSnapshotAfter.ssh.knownHostsLine,
			marker: 'must-not-run',
			snapshot: affectedSnapshotAfter,
		});
		expect(staleClientIdentity.exitCode).not.toBe(0);
		expect(staleClientIdentity.stderr).toMatch(/permission denied|publickey/iu);
		const affectedSshAfter = await runStrictSshCanary({
			gatewayVm: activeGatewayVm,
			identityPem: affectedSnapshotAfter.ssh.identityPem,
			knownHostsLine: affectedSnapshotAfter.ssh.knownHostsLine,
			marker: 'affected-after',
			snapshot: affectedSnapshotAfter,
		});
		const siblingSshAfter = await runStrictSshCanary({
			gatewayVm: activeGatewayVm,
			identityPem: siblingSnapshotBefore.ssh.identityPem,
			knownHostsLine: siblingSnapshotBefore.ssh.knownHostsLine,
			marker: 'sibling-after',
			snapshot: siblingSnapshotBefore,
		});
		expect(affectedSshAfter).toMatchObject({ exitCode: 0 });
		expect(affectedSshAfter.stdout).toContain('affected-after');
		expect(siblingSshAfter).toMatchObject({ exitCode: 0 });
		expect(siblingSshAfter.stdout).toContain('sibling-after');

		const exactProcessTermination = await terminateRecordedManagedVmProcess({
			contextLabel: `Lease leaf replacement E2E Tool VM lease '${affectedRecordAfter.leaseId}'`,
			exactProcessTermination: managedVmRuntimeComposition.managedVmExactProcessTermination,
			target: {
				hostPid: affectedRecordAfter.qemuPid,
				processIdentity: affectedRecordAfter.processIdentity,
				vmId: affectedRecordAfter.vmId,
			},
		});
		expect(exactProcessTermination).toEqual({
			kind: 'terminated',
			pid: affectedRecordAfter.qemuPid,
		});
		await waitForProcessAbsent(affectedRecordAfter.qemuPid);

		const recordsWhileAffectedLeaseCleanupPending = await waitForControllerLeaseState({
			activeLeaseCount: 1,
			affectedLeaseId: affectedRecordAfter.leaseId,
			controllerUrl: activeHarness.controllerUrl,
			expectedAffectedRecordPresent: true,
			expectedRecordCount: 2,
			phaseLabel: 'controller unrouting before cleanup',
			recordsTarget: controllerRecordTargets.toolLeaseRecords,
			siblingLeaseId: siblingRecordAfter.leaseId,
		});
		expect(recordsWhileAffectedLeaseCleanupPending.get(affectedRecordAfter.leaseId)).toEqual(
			affectedRecordAfter,
		);
		expect(recordsWhileAffectedLeaseCleanupPending.get(siblingRecordAfter.leaseId)).toEqual(
			siblingRecordAfter,
		);

		const qemuDeathReacquisitionProbe = await callWriteReadProbe({
			harness: activeHarness,
			identity: affectedIdentity,
			phase: 'qemu-death-reacquisition',
		});
		expect(qemuDeathReacquisitionProbe.readBack).toBe(qemuDeathReacquisitionProbe.marker);
		expect(qemuDeathReacquisitionProbe.filePath).not.toBe(replacementProbe.filePath);
		expect(qemuDeathReacquisitionProbe.marker).not.toBe(replacementProbe.marker);

		const recordsAfterQemuDeathReacquisition = await waitForControllerLeaseState({
			activeLeaseCount: 2,
			affectedLeaseId: affectedRecordAfter.leaseId,
			controllerUrl: activeHarness.controllerUrl,
			expectedAffectedRecordPresent: false,
			expectedRecordCount: 2,
			phaseLabel: 'asynchronous cleanup',
			recordsTarget: controllerRecordTargets.toolLeaseRecords,
			siblingLeaseId: siblingRecordAfter.leaseId,
		});
		const affectedRecordAfterQemuDeathReacquisition = [
			...recordsAfterQemuDeathReacquisition.values(),
		].find((record) => record.agentId === affectedIdentity.agentId);
		const siblingRecordAfterQemuDeathReacquisition = recordsAfterQemuDeathReacquisition.get(
			siblingRecordAfter.leaseId,
		);
		if (
			affectedRecordAfterQemuDeathReacquisition === undefined ||
			siblingRecordAfterQemuDeathReacquisition === undefined
		) {
			throw new Error('Expected fresh affected and unchanged sibling Tool VM runtime records.');
		}
		expect(affectedRecordAfterQemuDeathReacquisition.leaseId).not.toBe(affectedRecordAfter.leaseId);
		expect(affectedRecordAfterQemuDeathReacquisition.vmId).not.toBe(affectedRecordAfter.vmId);
		expect(affectedRecordAfterQemuDeathReacquisition.qemuPid).not.toBe(affectedRecordAfter.qemuPid);
		expect(affectedRecordAfterQemuDeathReacquisition.tcpSlot).not.toBe(affectedRecordAfter.tcpSlot);
		expect(affectedRecordAfterQemuDeathReacquisition.gateway).toEqual(affectedRecordAfter.gateway);
		expect(siblingRecordAfterQemuDeathReacquisition).toEqual(siblingRecordAfter);
		expect(recordsAfterQemuDeathReacquisition.size).toBe(postRecords.size);
		expect(isProcessAlive(affectedRecordAfterQemuDeathReacquisition.qemuPid)).toBe(true);
		expect(activeGatewayVm.id).toBe(gatewayVmId);
		expect(await readControllerActiveLeaseCount(activeHarness.controllerUrl)).toBe(
			postRecords.size,
		);

		const transitionArtifact = JSON.stringify({
			affected: {
				after: affectedRecordAfter,
				before: affectedRecordBefore,
				freshKnownHostsHash: hashControlLeaseReliabilityArtifact(
					affectedSnapshotAfter.ssh.knownHostsLine,
				),
				oldKnownHostsHash: hashControlLeaseReliabilityArtifact(
					affectedSnapshotBefore.ssh.knownHostsLine,
				),
			},
			gatewayVmId,
			sibling: { after: siblingRecordAfter, before: siblingRecordBefore },
		});
		const packageIdentity = await readPackageIdentity();
		const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
			expectedOperationId: reliabilityOperationId,
			payload: {
				artifacts: [
					{
						operationId: 'leaf-replacement-transition',
						sha256: hashControlLeaseReliabilityArtifact(transitionArtifact),
					},
				],
				generationIdentities: [
					{
						generation: 0,
						targetId: affectedRecordBefore.gateway.gatewayEpochId,
						targetKind: 'gateway',
					},
				],
				packageIdentities: [packageIdentity],
				processIdentities: [affectedRecordBefore, affectedRecordAfter, siblingRecordBefore].map(
					(record) => ({
						bootId: record.gateway.gatewayEpochId,
						kind: 'tool-vm-process',
						processId: record.qemuPid,
						startIdentity: hashControlLeaseReliabilityArtifact(
							`${record.processIdentity.command}\n${record.processIdentity.lstart}`,
						),
					}),
				),
				runtimeIdentities: [
					{
						generation: 0,
						id: gatewayVmId,
						kind: 'gateway-vm',
					},
					...[affectedRecordBefore, affectedRecordAfter, siblingRecordBefore].map(
						(record, generation) => ({
							generation,
							id: record.vmId,
							kind: 'tool-vm',
						}),
					),
				],
			},
		});
		expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
	}, 900_000);
});
