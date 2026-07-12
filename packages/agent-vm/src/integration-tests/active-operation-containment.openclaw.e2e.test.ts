/* oxlint-disable eslint/no-await-in-loop -- live VM state transitions require sequential observation */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { GatewayControlLeaseSnapshot } from '@agent-vm/gateway-control-contracts';
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
import { resolveLeaseWorkMountDir } from '../controller/leases/lease-work-mount-paths.js';
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
const canRunActiveOperationContainmentE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeActiveOperationContainmentE2e = canRunActiveOperationContainmentE2e
	? describe
	: describe.skip;
const zoneId = 'active-operation-containment';
const gatewayToken = 'active-operation-containment-gateway-token';
const probeSigningKey = 'active-operation-containment-proof-key';
const reliabilityOperationId = 'active-operation-containment';
const affectedIdentity = {
	agentId: 'main',
	sessionKey: 'agent:main:tool-vm-write-read:active-operation-main',
} as const;
const siblingIdentity = {
	agentId: 'beta',
	sessionKey: 'agent:beta:tool-vm-write-read:active-operation-beta',
} as const;
const configuredProbeIdentities = [affectedIdentity, siblingIdentity] as const;

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

type ActiveRequestOutcome =
	| { readonly kind: 'connection-loss'; readonly message: string }
	| { readonly bodyText: string; readonly kind: 'response'; readonly status: number };

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createDeferredPromise<TValue>(): {
	readonly promise: Promise<TValue>;
	readonly resolve: (value: TValue) => void;
} {
	let resolvePromise!: (value: TValue) => void;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
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

async function callWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly marker: string;
}): Promise<ToolVmWriteReadResult> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Active-operation containment E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify({
		agentId: options.identity.agentId,
		filePath: `.agent-vm/write-read-${randomUUID()}.txt`,
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
		`${options.identity.agentId} write/read probe`,
		60_000,
	);
	const responseBody: unknown = await response.json();
	if (!response.ok) {
		throw new Error(`Tool VM probe failed with HTTP ${String(response.status)}.`);
	}
	return parseWriteReadResult(responseBody);
}

function startActiveOperation(options: {
	readonly filePath: string;
	readonly harness: E2eHarnessRuntime;
	readonly marker: string;
	readonly sentinelFilePath: string;
}): Promise<ActiveRequestOutcome> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Active-operation containment E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify({
		agentId: affectedIdentity.agentId,
		filePath: options.filePath,
		marker: options.marker,
		scenario: 'active-operation-containment',
		sentinelFilePath: options.sentinelFilePath,
		sessionKey: affectedIdentity.sessionKey,
	});
	return fetch(
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
	).then(
		async (response) => ({
			bodyText: await response.text(),
			kind: 'response' as const,
			status: response.status,
		}),
		(error: unknown) => ({
			kind: 'connection-loss' as const,
			message: error instanceof Error ? error.message : String(error),
		}),
	);
}

async function waitForSentinel(sentinelPath: string, expectedMarker: string): Promise<void> {
	const deadlineMs = Date.now() + 60_000;
	while (Date.now() < deadlineMs) {
		try {
			if ((await fs.readFile(sentinelPath, 'utf8')).trim() === expectedMarker) {
				return;
			}
		} catch (error) {
			if (!isObjectRecord(error) || error.code !== 'ENOENT') {
				throw error;
			}
		}
		await waitForProtocolRetryInterval(100);
	}
	throw new Error(`Timed out waiting for committed active-operation sentinel '${sentinelPath}'.`);
}

async function waitForCommittedSentinelWhileRequestIsActive(options: {
	readonly expectedMarker: string;
	readonly requestOutcome: Promise<ActiveRequestOutcome>;
	readonly sentinelPath: string;
}): Promise<void> {
	await Promise.race([
		waitForSentinel(options.sentinelPath, options.expectedMarker),
		options.requestOutcome.then((outcome) => {
			const details =
				outcome.kind === 'response'
					? `HTTP ${String(outcome.status)}: ${outcome.bodyText}`
					: `connection loss: ${outcome.message}`;
			throw new Error(
				`Active-operation request completed before its committed sentinel became visible (${details}).`,
			);
		}),
	]);
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
		throw new Error(`OpenClaw process identity output was invalid: ${result.stdout}`);
	}
	return { pid, startTimeTicks };
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
scratch_dir=/tmp/active-operation-ssh-${randomUUID()}
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

function createTerminationRequest(
	snapshot: OpenClawProcessReliabilityFaultTargetSnapshot,
): ReliabilityFaultApplyRequest {
	const issuedAtMs = Date.now();
	return {
		action: 'terminate-owned-gateway-service',
		actionId: randomUUID(),
		authorityId: randomUUID(),
		expiresAtMs: issuedAtMs + 30_000,
		fences: {
			controller: snapshot.controllerGeneration,
			controlSession: { generation: 0, id: 'neutral-control-session' },
			gateway: snapshot.gatewayGeneration,
			leaseLeaf: { generation: 0, id: 'neutral-lease-leaf' },
			openClawProcess: snapshot.openClawProcessGeneration,
		},
		issuedAtMs,
		nonce: randomUUID().replaceAll('-', ''),
		runId: 'active-operation-containment-e2e',
		schemaVersion: 1,
		target: snapshot.target,
	};
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

describeActiveOperationContainmentE2e('e2e: active-use P1 loss containment', () => {
	let gatewayVm: ManagedVm | undefined;
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	let registry: OpenClawProcessReliabilityFaultTargetRegistry | undefined;
	const leaseSnapshots = new Map<string, GatewayControlLeaseSnapshot>();
	const p2Publication = createDeferredPromise<OpenClawProcessReliabilityFaultTargetSnapshot>();
	let publicationCount = 0;

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: configuredProbeIdentities.map(({ agentId }) => agentId),
			architecture,
			prefix: 'active-operation-containment-e2e-',
			zoneId,
		});
		const systemZone = project.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected active-operation containment project to contain an OpenClaw zone.');
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
						publicationCount += 1;
						if (publicationCount === 2) {
							p2Publication.resolve(snapshot);
						}
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
				GITHUB_TOKEN: 'unused-active-operation-containment-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-active-operation-containment-token',
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

	it('replaces only the active Tool leaf after exact P1 termination without replay', async () => {
		if (gatewayVm === undefined || harness === undefined || registry === undefined) {
			throw new Error('Expected active-operation containment harness, Gateway, and registry.');
		}
		const activeGatewayVm = gatewayVm;
		const activeHarness = harness;
		const activeRegistry = registry;
		const activeZone = activeHarness.systemConfig.zones[0];
		const p1 = activeRegistry.getCurrent();
		if (activeZone === undefined || activeZone.gateway.type !== 'openclaw' || p1 === undefined) {
			throw new Error('Expected active zone and exact current P1 target.');
		}

		const [affectedBeforeProbe, siblingBeforeProbe] = await Promise.all([
			callWriteReadProbe({
				harness: activeHarness,
				identity: affectedIdentity,
				marker: `AFFECTED_BEFORE_${randomUUID()}`,
			}),
			callWriteReadProbe({
				harness: activeHarness,
				identity: siblingIdentity,
				marker: `SIBLING_BEFORE_${randomUUID()}`,
			}),
		]);
		const recordsBefore = await readCurrentRecords(activeZone.gateway.stateDir);
		const affectedRecordBefore = recordsBefore.get(affectedBeforeProbe.runtimeId);
		const siblingRecordBefore = recordsBefore.get(siblingBeforeProbe.runtimeId);
		const affectedSnapshotBefore = leaseSnapshots.get(affectedBeforeProbe.runtimeId);
		const siblingSnapshotBefore = leaseSnapshots.get(siblingBeforeProbe.runtimeId);
		if (
			affectedRecordBefore === undefined ||
			siblingRecordBefore === undefined ||
			!isPrivateLeaseSnapshot(affectedSnapshotBefore) ||
			!isPrivateLeaseSnapshot(siblingSnapshotBefore)
		) {
			throw new Error('Expected exact pre-fault Tool records and SSH snapshots.');
		}
		const gatewayVmId = activeGatewayVm.id;
		const p1Process = await readOpenClawProcessIdentity(activeGatewayVm);
		const siblingCanaryMarker = `SIBLING_CANARY_${randomUUID()}`;
		const siblingCanaryPath = `.agent-vm/sibling-canary-${randomUUID()}.txt`;
		const siblingCanaryWrite = await runStrictSshCommand({
			command: `mkdir -p .agent-vm && printf %s ${siblingCanaryMarker} > ${siblingCanaryPath} && cat ${siblingCanaryPath}`,
			gatewayVm: activeGatewayVm,
			snapshot: siblingSnapshotBefore,
		});
		expect(siblingCanaryWrite).toMatchObject({ exitCode: 0 });
		expect(siblingCanaryWrite.stdout).toContain(siblingCanaryMarker);

		const operationMarker = `ACTIVE_${randomUUID()}`;
		const operationFilePath = `.agent-vm/active-operation-${randomUUID()}.txt`;
		const sentinelFilePath = `.agent-vm/active-operation-${randomUUID()}.committed`;
		const resolvedAffectedWorkMount = await resolveLeaseWorkMountDir({
			agentId: affectedIdentity.agentId,
			runtimeDir: activeHarness.systemConfig.runtimeDir,
			workMountDir: `/zone/agents/${affectedIdentity.agentId}`,
			zone: activeZone,
		});
		const agentHostWorkMount = resolvedAffectedWorkMount.hostWorkMountDir;
		const operationHostPath = path.join(agentHostWorkMount, operationFilePath);
		const sentinelHostPath = path.join(agentHostWorkMount, sentinelFilePath);
		const activeRequestOutcome = startActiveOperation({
			filePath: operationFilePath,
			harness: activeHarness,
			marker: operationMarker,
			sentinelFilePath,
		});
		await waitForCommittedSentinelWhileRequestIsActive({
			expectedMarker: operationMarker,
			requestOutcome: activeRequestOutcome,
			sentinelPath: sentinelHostPath,
		});

		const handler = createOpenClawProcessReliabilityFaultHandler({
			createReceiptId: randomUUID,
			nowMs: Date.now,
			registry: activeRegistry,
		});
		const terminationReceipt = await handler(createTerminationRequest(p1));
		expect(terminationReceipt).toMatchObject({
			action: 'terminate-owned-gateway-service',
			state: 'applied',
			target: p1.target,
		});
		const p2 = await withProtocolDeadline(
			p2Publication.promise,
			'P2 publication after active-operation P1 loss',
			120_000,
		);
		const activeOutcome = await withProtocolDeadline(
			activeRequestOutcome,
			'active request connection-loss classification',
			30_000,
		);
		if (
			activeOutcome.kind !== 'connection-loss' &&
			!(
				activeOutcome.kind === 'response' &&
				(activeOutcome.status === 502 || activeOutcome.status === 503)
			)
		) {
			throw new Error(
				`Active operation returned an unexpected post-termination outcome: ${JSON.stringify(activeOutcome)}.`,
			);
		}
		expect(p2.gateway).toEqual(p1.gateway);
		expect(p2.processEpoch).not.toBe(p1.processEpoch);
		expect(activeGatewayVm.id).toBe(gatewayVmId);
		const p2Process = await readOpenClawProcessIdentity(activeGatewayVm);
		expect(p2Process).not.toEqual(p1Process);

		const affectedAfterProbe = await callWriteReadProbe({
			harness: activeHarness,
			identity: affectedIdentity,
			marker: `AFFECTED_AFTER_${randomUUID()}`,
		});
		const siblingAfterProbe = await callWriteReadProbe({
			harness: activeHarness,
			identity: siblingIdentity,
			marker: `SIBLING_AFTER_${randomUUID()}`,
		});
		expect(affectedAfterProbe.runtimeId).not.toBe(affectedBeforeProbe.runtimeId);
		expect(siblingAfterProbe.runtimeId).toBe(siblingBeforeProbe.runtimeId);
		const recordsAfter = await readCurrentRecords(activeZone.gateway.stateDir);
		const affectedRecordAfter = recordsAfter.get(affectedAfterProbe.runtimeId);
		const siblingRecordAfter = recordsAfter.get(siblingAfterProbe.runtimeId);
		const affectedSnapshotAfter = leaseSnapshots.get(affectedAfterProbe.runtimeId);
		const siblingSnapshotAfter = leaseSnapshots.get(siblingAfterProbe.runtimeId);
		if (
			affectedRecordAfter === undefined ||
			siblingRecordAfter === undefined ||
			!isPrivateLeaseSnapshot(affectedSnapshotAfter) ||
			!isPrivateLeaseSnapshot(siblingSnapshotAfter)
		) {
			throw new Error('Expected exact post-fault Tool records and SSH snapshots.');
		}
		expect(recordsAfter.has(affectedBeforeProbe.runtimeId)).toBe(false);
		expect(affectedRecordAfter.vmId).not.toBe(affectedRecordBefore.vmId);
		expect(affectedRecordAfter.qemuPid).not.toBe(affectedRecordBefore.qemuPid);
		expect(affectedSnapshotAfter.ssh.knownHostsLine).not.toBe(
			affectedSnapshotBefore.ssh.knownHostsLine,
		);
		expect(siblingRecordAfter).toEqual(siblingRecordBefore);
		expect(siblingSnapshotAfter.ssh).toEqual(siblingSnapshotBefore.ssh);

		const siblingCanaryRead = await runStrictSshCommand({
			command: `cat ${siblingCanaryPath}`,
			gatewayVm: activeGatewayVm,
			snapshot: siblingSnapshotBefore,
		});
		expect(siblingCanaryRead).toMatchObject({ exitCode: 0 });
		expect(siblingCanaryRead.stdout.trim()).toBe(siblingCanaryMarker);
		const markerLines = (await fs.readFile(operationHostPath, 'utf8'))
			.split('\n')
			.filter((line) => line === operationMarker);
		expect(markerLines).toHaveLength(1);

		const transitionArtifact = JSON.stringify({
			affected: {
				after: affectedRecordAfter,
				before: affectedRecordBefore,
				sshAfter: hashControlLeaseReliabilityArtifact(affectedSnapshotAfter.ssh.knownHostsLine),
				sshBefore: hashControlLeaseReliabilityArtifact(affectedSnapshotBefore.ssh.knownHostsLine),
			},
			gateway: { after: gatewayVmId, before: gatewayVmId },
			markerCount: markerLines.length,
			openClawProcess: { p1: p1Process, p2: p2Process },
			sibling: {
				after: siblingRecordAfter,
				before: siblingRecordBefore,
				ssh: hashControlLeaseReliabilityArtifact(siblingSnapshotBefore.ssh.knownHostsLine),
			},
			terminationReceipt,
		});
		const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
			expectedOperationId: reliabilityOperationId,
			payload: {
				artifacts: [
					{
						operationId: 'active-operation-transition',
						sha256: hashControlLeaseReliabilityArtifact(transitionArtifact),
					},
				],
				generationIdentities: [
					{
						generation: p1.gatewayGeneration.generation,
						targetId: p1.gatewayGeneration.id,
						targetKind: 'gateway',
					},
					{
						generation: p1.openClawProcessGeneration.generation,
						targetId: p1.openClawProcessGeneration.id,
						targetKind: 'openclaw-process',
					},
					{
						generation: p2.openClawProcessGeneration.generation,
						targetId: p2.openClawProcessGeneration.id,
						targetKind: 'openclaw-process',
					},
				],
				packageIdentities: [await readPackageIdentity()],
				processIdentities: [
					{
						bootId: p1.processEpoch,
						kind: 'openclaw-process',
						processId: p1Process.pid,
						startIdentity: `proc-start-${p1Process.startTimeTicks}`,
					},
					{
						bootId: p2.processEpoch,
						kind: 'openclaw-process',
						processId: p2Process.pid,
						startIdentity: `proc-start-${p2Process.startTimeTicks}`,
					},
					...[affectedRecordBefore, affectedRecordAfter, siblingRecordBefore].map((record) => ({
						bootId: record.gateway.gatewayEpochId,
						kind: 'tool-vm-process' as const,
						processId: record.qemuPid,
						startIdentity: hashControlLeaseReliabilityArtifact(
							`${record.processIdentity.command}\n${record.processIdentity.lstart}`,
						),
					})),
				],
				runtimeIdentities: [
					{ generation: p1.gatewayGeneration.generation, id: gatewayVmId, kind: 'gateway-vm' },
					{ generation: 0, id: affectedRecordBefore.vmId, kind: 'tool-vm' },
					{ generation: 1, id: affectedRecordAfter.vmId, kind: 'tool-vm' },
					{ generation: 0, id: siblingRecordBefore.vmId, kind: 'tool-vm' },
				],
			},
		});
		expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
	}, 900_000);
});
