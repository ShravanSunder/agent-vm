/* oxlint-disable eslint/no-await-in-loop -- live retirement is observed through bounded protocol and state probes */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ToolPortalConfig } from '@agent-vm/config-contracts';
import type { GatewayControlLeaseSnapshot } from '@agent-vm/gateway-control-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { createGatewayApiClient } from '../gateway-api-client/gateway-api-client.js';
import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';
import { isProcessAlive } from '../shared/managed-vm-process.js';
import { hashControlLeaseReliabilityArtifact } from './control-lease-reliability-evidence.js';
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
const runIdleRetirementE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeIdleRetirementE2e = runIdleRetirementE2e ? describe : describe.skip;
const zoneId = 'tool-vm-idle-retirement';
const gatewayToken = 'tool-vm-idle-retirement-gateway-token';
const sandboxToolPortalProfileId = 'idle-retirement-sandbox';
const idleTtlMs = 5_000;
const portalToolNames = [
	'tool_portal_list',
	'tool_portal_search',
	'tool_portal_describe',
	'tool_portal_call',
] as const;
const probeIdentity = {
	agentId: 'main',
	sessionKey: 'agent:main:tool-vm-write-read:idle-retirement-main',
} as const;

type GatewayVmObservationOperations = Pick<
	GatewayZoneVmOperations,
	'enableSsh' | 'exec' | 'getHostProcessId' | 'id'
>;

interface OpenClawProcessIdentity {
	readonly pid: number;
	readonly startTimeTicks: string;
}

interface ToolVmWriteReadResult {
	readonly agentId: string;
	readonly byteLength: number;
	readonly filePath: string;
	readonly kind: 'write-read';
	readonly marker: string;
	readonly readArtifactCount: number;
	readonly status: 'ok';
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

interface StrictSshCanaryResult {
	readonly exitCode: number;
	readonly scratchIdentityAbsent: boolean;
	readonly stderr: string;
	readonly stdout: string;
}

const sandboxToolPortalConfig = {
	agents: { [probeIdentity.agentId]: { profile: sandboxToolPortalProfileId } },
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
								description: 'Read the idle-retirement proof file.',
								kind: 'filesystem.read',
							},
							write_file: {
								description: 'Write the idle-retirement proof file.',
								kind: 'filesystem.write',
							},
						},
						profile: 'sandbox_ssh',
					},
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['write_file', 'read_file'], deny: [] },
					},
					tools: { allow: ['write_file', 'read_file'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies ToolPortalConfig;

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function allowPortalNativeToolsInOpenClawConfig(configPath: string): Promise<void> {
	const parsed: unknown = JSON.parse(await fs.readFile(configPath, 'utf8'));
	if (!isObjectRecord(parsed)) {
		throw new Error('Expected OpenClaw idle-retirement config to be a JSON object.');
	}
	const tools = isObjectRecord(parsed.tools) ? parsed.tools : {};
	const existingAllow = Array.isArray(tools.allow)
		? tools.allow.filter((tool): tool is string => typeof tool === 'string')
		: [];
	const updatedConfig = {
		...parsed,
		tools: {
			...tools,
			allow: [...new Set([...existingAllow, ...portalToolNames])],
		},
	};
	await fs.writeFile(configPath, `${JSON.stringify(updatedConfig, null, '\t')}\n`, 'utf8');
}

function parseNativePortalToolResult(value: unknown): unknown {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.result)) {
		throw new Error(`Expected successful OpenClaw /tools/invoke result: ${JSON.stringify(value)}`);
	}
	const details = value.result.details;
	if (details !== undefined) return details;
	if (typeof value.result.content === 'string') {
		return JSON.parse(value.result.content) as unknown;
	}
	throw new Error(
		`Expected OpenClaw tool result details or JSON content: ${JSON.stringify(value)}`,
	);
}

function expectSingleItemStatusOk(result: unknown): Readonly<Record<string, unknown>> {
	if (!isObjectRecord(result) || !Array.isArray(result.items) || result.items.length !== 1) {
		throw new Error(`Expected Portal result with exactly one item: ${JSON.stringify(result)}`);
	}
	const item: unknown = result.items[0];
	if (!isObjectRecord(item) || item.status !== 'ok') {
		throw new Error(`Expected Portal item status ok: ${JSON.stringify(item)}`);
	}
	return item;
}

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

function capturePrivateLeaseSnapshots(
	publicationSource: GatewayControlBindingPublicationSource,
	snapshots: Map<string, PrivateLeaseSnapshot>,
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

async function callWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly phase: 'before-retirement' | 'successor';
}): Promise<ToolVmWriteReadResult> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Idle-retirement E2E did not expose Gateway ingress.');
	}
	const marker = `${options.phase.toUpperCase()}_${randomUUID()}`;
	const filePath = `agent-vm-e2e-idle-retirement-${options.phase}-${randomUUID()}.txt`;
	const gatewayClient = createGatewayApiClient({
		gatewayUrl: `http://${ingress.host}:${String(ingress.port)}`,
		token: gatewayToken,
	});
	const writeResult = parseNativePortalToolResult(
		await withProtocolDeadline(
			gatewayClient.invokeTool({
				agentId: probeIdentity.agentId,
				sessionKey: probeIdentity.sessionKey,
				args: {
					calls: [
						{
							arguments: { content: marker, path: filePath },
							id: `${options.phase}-write`,
							name: 'write_file',
							namespace: 'sandbox',
						},
					],
				},
				tool: 'tool_portal_call',
			}),
			`Tool VM ${options.phase} Tool Portal write operation`,
			120_000,
		),
	);
	const writeItem = expectSingleItemStatusOk(writeResult);
	expect(writeItem).toMatchObject({
		id: `${options.phase}-write`,
		value: {
			byteLength: Buffer.byteLength(marker),
			kind: 'written',
			path: filePath,
		},
	});
	const readResult = parseNativePortalToolResult(
		await withProtocolDeadline(
			gatewayClient.invokeTool({
				agentId: probeIdentity.agentId,
				sessionKey: probeIdentity.sessionKey,
				args: {
					calls: [
						{
							arguments: { path: filePath },
							id: `${options.phase}-read`,
							name: 'read_file',
							namespace: 'sandbox',
						},
					],
				},
				tool: 'tool_portal_call',
			}),
			`Tool VM ${options.phase} Tool Portal read operation`,
			120_000,
		),
	);
	const readItem = expectSingleItemStatusOk(readResult);
	const readArtifacts = Array.isArray(readItem.artifacts) ? readItem.artifacts : [];
	expect(readItem).toMatchObject({
		id: `${options.phase}-read`,
		value: { byteLength: Buffer.byteLength(marker), kind: 'file' },
	});
	expect(readArtifacts).toHaveLength(1);
	return {
		agentId: probeIdentity.agentId,
		byteLength: Buffer.byteLength(marker),
		filePath,
		kind: 'write-read',
		marker,
		readArtifactCount: readArtifacts.length,
		status: 'ok',
	};
}

async function readOpenClawProcessIdentity(
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
[ -n "$gateway_pid" ] || exit 1
start_time_ticks="$(awk '{ print $22 }' "/proc/$gateway_pid/stat")"
printf '%s %s\\n' "$gateway_pid" "$start_time_ticks"
`);
	const [pidText, startTimeTicks] = result.stdout.trim().split(/\s+/u);
	const pid = Number.parseInt(pidText ?? '', 10);
	if (result.exitCode !== 0 || !Number.isSafeInteger(pid) || pid <= 0 || !startTimeTicks) {
		throw new Error('OpenClaw process identity probe failed.');
	}
	return { pid, startTimeTicks };
}

async function waitForExactPredecessorRetirement(options: {
	readonly predecessor: ToolVmRuntimeRecord;
	readonly recordsTarget: ControllerToolLeaseRecordsTarget;
}): Promise<void> {
	await withProtocolDeadline(
		(async (): Promise<void> => {
			while (true) {
				const records = await readCurrentRecords(options.recordsTarget);
				if (
					!records.has(options.predecessor.leaseId) &&
					!isProcessAlive(options.predecessor.qemuPid)
				) {
					return;
				}
				await waitForProtocolRetryInterval(250);
			}
		})(),
		`idle retirement of Tool VM lease '${options.predecessor.leaseId}'`,
		180_000,
	);
}

async function waitForSuccessorRecord(options: {
	readonly predecessorLeaseId: string;
	readonly recordsTarget: ControllerToolLeaseRecordsTarget;
}): Promise<ToolVmRuntimeRecord> {
	return await withProtocolDeadline(
		(async (): Promise<ToolVmRuntimeRecord> => {
			while (true) {
				const records = [...(await readCurrentRecords(options.recordsTarget)).values()].filter(
					(record) => record.agentId === probeIdentity.agentId,
				);
				const successorRecord = records[0];
				if (
					records.length === 1 &&
					successorRecord !== undefined &&
					successorRecord.leaseId !== options.predecessorLeaseId
				) {
					return successorRecord;
				}
				await waitForProtocolRetryInterval(250);
			}
		})(),
		'on-demand Tool VM successor runtime record',
		60_000,
	);
}

async function runStrictSshCanary(options: {
	readonly gatewayVm: GatewayVmObservationOperations;
	readonly identityPem: string;
	readonly knownHostsLine: string;
	readonly marker: string;
	readonly snapshot: PrivateLeaseSnapshot;
}): Promise<StrictSshCanaryResult> {
	const scratchDirectory = `/tmp/tool-vm-idle-retirement-ssh-${randomUUID()}`;
	const identityPath = `${scratchDirectory}/identity`;
	const knownHostsPath = `${scratchDirectory}/known_hosts`;
	const identityBase64 = Buffer.from(options.identityPem).toString('base64');
	const knownHostsBase64 = Buffer.from(`${options.knownHostsLine.trim()}\n`).toString('base64');
	let commandResult: Awaited<ReturnType<GatewayVmObservationOperations['exec']>> | undefined;
	let scratchIdentityAbsent = false;
	try {
		commandResult = await options.gatewayVm.exec(`set -u
scratch_dir='${scratchDirectory}'
identity_file='${identityPath}'
known_hosts_file='${knownHostsPath}'
cleanup() { rm -f "$identity_file" "$known_hosts_file"; rmdir "$scratch_dir" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$scratch_dir"
printf %s '${identityBase64}' | base64 -d > "$identity_file"
printf %s '${knownHostsBase64}' | base64 -d > "$known_hosts_file"
chmod 600 "$identity_file" "$known_hosts_file"
ssh -4 -p ${String(options.snapshot.ssh.port)} -i "$identity_file" \\
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts_file" \\
  -o UpdateHostKeys=no -o BatchMode=yes -o ConnectTimeout=10 \\
  ${options.snapshot.ssh.user}@${options.snapshot.ssh.host} 'printf %s ${options.marker}'
`);
	} finally {
		const cleanupResult = await options.gatewayVm.exec(
			`rm -f '${identityPath}' '${knownHostsPath}'; rmdir '${scratchDirectory}' 2>/dev/null || true; test ! -e '${identityPath}'`,
		);
		scratchIdentityAbsent = cleanupResult.exitCode === 0;
	}
	if (commandResult === undefined) {
		throw new Error('Strict SSH canary did not return a command result.');
	}
	return {
		exitCode: commandResult.exitCode,
		scratchIdentityAbsent,
		stderr: commandResult.stderr,
		stdout: commandResult.stdout,
	};
}

describeIdleRetirementE2e('e2e: OpenClaw Tool VM idle retirement', () => {
	let gatewayVm: GatewayVmObservationOperations | undefined;
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	const leaseSnapshots = new Map<string, PrivateLeaseSnapshot>();

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: [probeIdentity.agentId],
			architecture,
			prefix: 'tool-vm-idle-retirement-openclaw-e2e-',
			zoneId,
		});
		project.systemConfig.leaseIdleTtl = {
			defaultMs: idleTtlMs,
			maxRequestedMs: idleTtlMs,
			minRequestedMs: idleTtlMs,
		};
		const systemZone = project.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected idle-retirement project to contain an OpenClaw zone.');
		}
		const openClawGateway = systemZone.gateway;
		const toolPortalConfigDir = path.dirname(openClawGateway.config);
		systemZone.toolPortal = {
			configDir: toolPortalConfigDir,
			surfaceEligibilityByProfile: {
				[sandboxToolPortalProfileId]: { sandbox: ['protected_uds'] },
			},
		};
		await fs.writeFile(
			path.join(toolPortalConfigDir, 'tool-portal.config.jsonc'),
			`${JSON.stringify(sandboxToolPortalConfig, null, '\t')}\n`,
			'utf8',
		);
		await allowPortalNativeToolsInOpenClawConfig(openClawGateway.config);
		await fs.mkdir(path.join(openClawGateway.zoneFilesDir, 'agents', probeIdentity.agentId), {
			recursive: true,
		});
		await useLocalOpenClawGatewayImagePackages({
			profileName: openClawGateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		await prepareGatewayE2eProjectImages({ project });
		harness = await startE2eControllerRuntime({
			secrets: {
				GITHUB_TOKEN: 'unused-tool-vm-idle-retirement-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-tool-vm-idle-retirement-token',
			},
			startGatewayZone: async (startOptions) => {
				if (startOptions.gatewayControlBindingPublicationSource === undefined) {
					throw new Error('Expected Gateway control binding publication source.');
				}
				const result = await startGatewayZone({
					...startOptions,
					gatewayControlBindingPublicationSource: capturePrivateLeaseSnapshots(
						startOptions.gatewayControlBindingPublicationSource,
						leaseSnapshots,
					),
				});
				if (result.executionModel !== 'managed-gateway') {
					throw new Error('Idle-retirement proof requires a managed OpenClaw Gateway.');
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

	it('retires the exact idle predecessor and replaces it on demand without Gateway churn', async () => {
		if (gatewayVm === undefined || harness === undefined) {
			throw new Error('Expected idle-retirement harness to be initialized.');
		}
		const activeGatewayVm = gatewayVm;
		const activeHarness = harness;
		const recordsTarget = resolveControllerGatewayRecordTargets({
			gatewayStateRoot: resolveControllerGatewayStateRoot({
				controllerStateRoot: createControllerStateRoot({
					controllerStateDirectoryPath: activeHarness.systemConfig.controllerStateDir,
				}),
				zoneId,
			}),
		}).toolLeaseRecords;
		const gatewayVmId = activeGatewayVm.id;
		const gatewayHostProcessId = activeGatewayVm.getHostProcessId();
		const openClawProcessIdentity = await readOpenClawProcessIdentity(activeGatewayVm);

		const initialOperation = await callWriteReadProbe({
			harness: activeHarness,
			phase: 'before-retirement',
		});
		expect(initialOperation.byteLength).toBe(Buffer.byteLength(initialOperation.marker));
		expect(initialOperation.readArtifactCount).toBe(1);
		const initialRecords = [...(await readCurrentRecords(recordsTarget)).values()].filter(
			(record) => record.agentId === probeIdentity.agentId,
		);
		expect(initialRecords).toHaveLength(1);
		const predecessorRecord = initialRecords[0];
		if (predecessorRecord === undefined) {
			throw new Error('Expected one predecessor Tool VM runtime record.');
		}
		const predecessorSnapshot = leaseSnapshots.get(predecessorRecord.leaseId);
		if (predecessorSnapshot === undefined) {
			throw new Error('Expected the predecessor private binding snapshot.');
		}
		expect(predecessorSnapshot.idleTtlMs).toBe(idleTtlMs);
		expect(isProcessAlive(predecessorRecord.qemuPid)).toBe(true);
		const predecessorSsh = await runStrictSshCanary({
			gatewayVm: activeGatewayVm,
			identityPem: predecessorSnapshot.ssh.identityPem,
			knownHostsLine: predecessorSnapshot.ssh.knownHostsLine,
			marker: 'predecessor-before-idle-retirement',
			snapshot: predecessorSnapshot,
		});
		expect(predecessorSsh).toMatchObject({ exitCode: 0, scratchIdentityAbsent: true });
		expect(predecessorSsh.stdout).toContain('predecessor-before-idle-retirement');

		await waitForExactPredecessorRetirement({ predecessor: predecessorRecord, recordsTarget });
		expect(isProcessAlive(predecessorRecord.qemuPid)).toBe(false);
		expect((await readCurrentRecords(recordsTarget)).has(predecessorRecord.leaseId)).toBe(false);

		const successorOperation = await callWriteReadProbe({
			harness: activeHarness,
			phase: 'successor',
		});
		expect(successorOperation.byteLength).toBe(Buffer.byteLength(successorOperation.marker));
		expect(successorOperation.readArtifactCount).toBe(1);
		expect(successorOperation.filePath).not.toBe(initialOperation.filePath);
		const successorRecord = await waitForSuccessorRecord({
			predecessorLeaseId: predecessorRecord.leaseId,
			recordsTarget,
		});
		const successorSnapshot = leaseSnapshots.get(successorRecord.leaseId);
		if (successorSnapshot === undefined) {
			throw new Error('Expected the successor private binding snapshot.');
		}

		expect(successorRecord.leaseId).not.toBe(predecessorRecord.leaseId);
		expect(successorSnapshot.leafGeneration).not.toBe(predecessorSnapshot.leafGeneration);
		expect(successorRecord.vmId).not.toBe(predecessorRecord.vmId);
		expect(successorRecord.qemuPid).not.toBe(predecessorRecord.qemuPid);
		expect(successorRecord.processIdentity).not.toEqual(predecessorRecord.processIdentity);
		expect(successorSnapshot.sshBindingId).not.toBe(predecessorSnapshot.sshBindingId);
		const predecessorClientIdentityHash = hashControlLeaseReliabilityArtifact(
			predecessorSnapshot.ssh.identityPem,
		);
		const successorClientIdentityHash = hashControlLeaseReliabilityArtifact(
			successorSnapshot.ssh.identityPem,
		);
		const predecessorHostIdentityHash = hashControlLeaseReliabilityArtifact(
			predecessorSnapshot.ssh.knownHostsLine,
		);
		const successorHostIdentityHash = hashControlLeaseReliabilityArtifact(
			successorSnapshot.ssh.knownHostsLine,
		);
		expect(successorClientIdentityHash).not.toBe(predecessorClientIdentityHash);
		expect(successorHostIdentityHash).not.toBe(predecessorHostIdentityHash);

		const staleHostIdentity = await runStrictSshCanary({
			gatewayVm: activeGatewayVm,
			identityPem: successorSnapshot.ssh.identityPem,
			knownHostsLine: predecessorSnapshot.ssh.knownHostsLine,
			marker: 'must-not-run',
			snapshot: successorSnapshot,
		});
		expect(staleHostIdentity.scratchIdentityAbsent).toBe(true);
		expect(staleHostIdentity.exitCode).not.toBe(0);
		expect(staleHostIdentity.stderr).toMatch(
			/host key verification failed|remote host identification has changed/iu,
		);
		const successorSsh = await runStrictSshCanary({
			gatewayVm: activeGatewayVm,
			identityPem: successorSnapshot.ssh.identityPem,
			knownHostsLine: successorSnapshot.ssh.knownHostsLine,
			marker: 'successor-after-idle-retirement',
			snapshot: successorSnapshot,
		});
		expect(successorSsh).toMatchObject({ exitCode: 0, scratchIdentityAbsent: true });
		expect(successorSsh.stdout).toContain('successor-after-idle-retirement');

		expect(activeGatewayVm.id).toBe(gatewayVmId);
		expect(activeGatewayVm.getHostProcessId()).toBe(gatewayHostProcessId);
		expect(await readOpenClawProcessIdentity(activeGatewayVm)).toEqual(openClawProcessIdentity);
	}, 900_000);
});
