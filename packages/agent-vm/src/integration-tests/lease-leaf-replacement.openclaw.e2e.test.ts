/* oxlint-disable eslint/no-await-in-loop -- live process disappearance is observed sequentially */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { GatewayControlLeaseSnapshot } from '@agent-vm/gateway-control-contracts';
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

import type { GatewayControlLeaseRpcOperations } from '../controller/control-session/index.js';
import {
	loadAllToolVmRuntimeRecords,
	type ToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import { startGatewayZoneForController as startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import { isProcessAlive } from '../shared/managed-vm-process.js';
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
import { waitForProtocolRetryInterval, withProtocolDeadline } from './e2e-protocol-wait.js';

const architecture = currentE2eArchitecture();
const runLeaseLeafReplacementE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeLeaseLeafReplacementE2e = runLeaseLeafReplacementE2e ? describe : describe.skip;
const zoneId = 'lease-leaf-replacement';
const gatewayToken = 'lease-leaf-replacement-gateway-token';
const probeSigningKey = 'lease-leaf-replacement-write-read-proof-key';
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

interface ToolVmWriteReadResult {
	readonly agentId: string;
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
	readonly sessionKey: string;
	readonly status: 'ok';
}

interface ToolVmStaleReacquireResult {
	readonly agentId: string;
	readonly first: ToolVmWriteReadResult;
	readonly newRuntimeId: string;
	readonly oldRuntimeId: string;
	readonly second: ToolVmWriteReadResult;
	readonly status: 'ok';
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWriteReadStep(value: unknown): ToolVmWriteReadResult {
	if (
		!isObjectRecord(value) ||
		value.status !== 'ok' ||
		typeof value.agentId !== 'string' ||
		typeof value.marker !== 'string' ||
		typeof value.readBack !== 'string' ||
		typeof value.runtimeId !== 'string' ||
		typeof value.sessionKey !== 'string'
	) {
		throw new Error(`Tool VM write/read result is malformed: ${JSON.stringify(value)}`);
	}
	return {
		agentId: value.agentId,
		marker: value.marker,
		readBack: value.readBack,
		runtimeId: value.runtimeId,
		sessionKey: value.sessionKey,
		status: value.status,
	};
}

function parseProbeResult(value: unknown): ToolVmWriteReadResult | ToolVmStaleReacquireResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error(`Tool VM probe did not return successful details: ${JSON.stringify(value)}`);
	}
	const details = value.details;
	if (details.scenario !== 'stale-reacquire') {
		return parseWriteReadStep(details);
	}
	if (
		typeof details.agentId !== 'string' ||
		typeof details.oldRuntimeId !== 'string' ||
		typeof details.newRuntimeId !== 'string' ||
		!isObjectRecord(details.first) ||
		!isObjectRecord(details.second)
	) {
		throw new Error(`Tool VM stale-reacquire result is malformed: ${JSON.stringify(details)}`);
	}
	return {
		agentId: details.agentId,
		first: parseWriteReadStep({
			...details.first,
			agentId: details.agentId,
			sessionKey: details.sessionKey,
			status: 'ok',
		}),
		newRuntimeId: details.newRuntimeId,
		oldRuntimeId: details.oldRuntimeId,
		second: parseWriteReadStep({
			...details.second,
			agentId: details.agentId,
			sessionKey: details.sessionKey,
			status: 'ok',
		}),
		status: 'ok',
	};
}

async function callProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly scenario?: 'stale-reacquire';
}): Promise<ToolVmWriteReadResult | ToolVmStaleReacquireResult> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Lease leaf replacement E2E did not expose Gateway ingress.');
	}
	const firstMarker = `${options.identity.agentId}_FIRST_${randomUUID()}`;
	const bodyText = JSON.stringify({
		agentId: options.identity.agentId,
		filePath: `.agent-vm/lease-leaf-${randomUUID()}.txt`,
		marker: firstMarker,
		...(options.scenario === undefined
			? {}
			: {
					scenario: options.scenario,
					secondFilePath: `.agent-vm/lease-leaf-replacement-${randomUUID()}.txt`,
					secondMarker: `${options.identity.agentId}_REPLACEMENT_${randomUUID()}`,
				}),
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
	return parseProbeResult(responseBody);
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
	return {
		getLease: async (request, options) => {
			const result = await operations.getLease(request, options);
			if (isPrivateLeaseSnapshot(result)) {
				snapshots.set(result.leaseId, result);
			}
			return result;
		},
		prepareSemanticMutation: async (options) => {
			const prepared = await operations.prepareSemanticMutation(options);
			return {
				...prepared,
				execute: async (proof) => {
					const result = await prepared.execute(proof);
					if (isPrivateLeaseSnapshot(result)) {
						snapshots.set(result.leaseId, result);
					}
					return result;
				},
			};
		},
	};
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

async function runStrictSshCanary(options: {
	readonly gatewayVm: ManagedVm;
	readonly identityPem: string;
	readonly knownHostsLine: string;
	readonly snapshot: GatewayControlLeaseSnapshot & {
		readonly ssh: NonNullable<GatewayControlLeaseSnapshot['ssh']>;
	};
	readonly marker: string;
}): Promise<Awaited<ReturnType<ManagedVm['exec']>>> {
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
	let gatewayVm: ManagedVm | undefined;
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
			secrets: {
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV]: '1',
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV]:
					JSON.stringify(configuredProbeIdentities),
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV]: probeSigningKey,
				GITHUB_TOKEN: 'unused-lease-leaf-replacement-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-lease-leaf-replacement-token',
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
				result.vm.setIngressRoutes([
					{ port: result.processSpec.guestListenPort, prefix: '/', stripPrefix: true },
				]);
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
		if (systemZone === undefined) {
			throw new Error('Expected lease leaf replacement zone configuration.');
		}

		const [affectedInitial, siblingInitial] = await Promise.all([
			callProbe({ harness: activeHarness, identity: affectedIdentity }),
			callProbe({ harness: activeHarness, identity: siblingIdentity }),
		]);
		if ('first' in affectedInitial || 'first' in siblingInitial) {
			throw new Error('Initial Tool VM probes unexpectedly performed replacement.');
		}
		expect(affectedInitial.runtimeId).not.toBe(siblingInitial.runtimeId);
		const initialRecords = await readCurrentRecords(systemZone.gateway.stateDir);
		const affectedRecordBefore = initialRecords.get(affectedInitial.runtimeId);
		const siblingRecordBefore = initialRecords.get(siblingInitial.runtimeId);
		const affectedSnapshotBefore = leaseSnapshots.get(affectedInitial.runtimeId);
		const siblingSnapshotBefore = leaseSnapshots.get(siblingInitial.runtimeId);
		if (
			affectedRecordBefore === undefined ||
			siblingRecordBefore === undefined ||
			!isPrivateLeaseSnapshot(affectedSnapshotBefore) ||
			!isPrivateLeaseSnapshot(siblingSnapshotBefore)
		) {
			throw new Error('Expected exact pre-fault Tool VM records and private SSH snapshots.');
		}
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

		const replacement = await callProbe({
			harness: activeHarness,
			identity: affectedIdentity,
			scenario: 'stale-reacquire',
		});
		if (!('first' in replacement)) {
			throw new Error('Affected Tool VM probe did not perform stale reacquire.');
		}
		expect(replacement.oldRuntimeId).toBe(affectedInitial.runtimeId);
		expect(replacement.newRuntimeId).not.toBe(replacement.oldRuntimeId);
		expect(replacement.first.readBack).toBe(replacement.first.marker);
		expect(replacement.second.readBack).toBe(replacement.second.marker);
		await waitForProcessAbsent(affectedRecordBefore.qemuPid);

		const postRecords = await readCurrentRecords(systemZone.gateway.stateDir);
		const affectedRecordAfter = postRecords.get(replacement.newRuntimeId);
		const siblingRecordAfter = postRecords.get(siblingInitial.runtimeId);
		const affectedSnapshotAfter = leaseSnapshots.get(replacement.newRuntimeId);
		if (affectedRecordAfter === undefined || !isPrivateLeaseSnapshot(affectedSnapshotAfter)) {
			throw new Error('Expected exact replacement Tool VM record and private SSH snapshot.');
		}
		expect(affectedRecordAfter.vmId).not.toBe(affectedRecordBefore.vmId);
		expect(affectedRecordAfter.qemuPid).not.toBe(affectedRecordBefore.qemuPid);
		expect(affectedRecordAfter.tcpSlot).toBe(affectedRecordBefore.tcpSlot);
		expect(postRecords.has(replacement.oldRuntimeId)).toBe(false);
		expect(postRecords.size).toBe(initialRecords.size);
		expect(affectedSnapshotAfter.ssh.knownHostsLine).not.toBe(
			affectedSnapshotBefore.ssh.knownHostsLine,
		);
		expect(siblingRecordAfter).toEqual(siblingRecordBefore);
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
