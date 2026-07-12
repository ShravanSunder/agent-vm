/* oxlint-disable eslint/no-await-in-loop -- stability probes are sequential against live VMs */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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

import { createOpenClawProcessReliabilityFaultHandler } from '../controller/reliability/testing/openclaw-process-reliability-fault-handler.js';
import {
	createOpenClawProcessReliabilityFaultTargetRegistry,
	type OpenClawProcessReliabilityFaultTargetRegistry,
	type OpenClawProcessReliabilityFaultTargetSnapshot,
} from '../controller/reliability/testing/openclaw-process-reliability-fault-target-registry.js';
import type {
	ReliabilityFaultApplyRequest,
	ReliabilityFaultReceipt,
} from '../controller/reliability/testing/reliability-test-fault-contracts.js';
import {
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
const runOpenClawProcessRecoveryE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeOpenClawProcessRecoveryE2e = runOpenClawProcessRecoveryE2e ? describe : describe.skip;
const zoneId = 'process-recovery-smoke';
const gatewayToken = 'process-recovery-smoke-gateway-token';
const probeSigningKey = 'process-recovery-tool-vm-write-read-proof-key';
const mainIdentity = {
	agentId: 'main',
	sessionKey: 'agent:main:tool-vm-write-read:process-recovery-main',
} as const;
const betaIdentity = {
	agentId: 'beta',
	sessionKey: 'agent:beta:tool-vm-write-read:process-recovery-beta',
} as const;
const configuredProbeIdentities = [mainIdentity, betaIdentity] as const;
const stabilityWindowMs = 60_000;
const stabilityProbeIntervalMs = 2_000;
const reliabilityOperationId = 'openclaw-process-recovery';

interface ToolVmWriteReadResult {
	readonly agentId: string;
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
	readonly sessionKey: string;
	readonly status: 'ok';
}

type RegistryEvent =
	| {
			readonly kind: 'publish';
			readonly snapshot: OpenClawProcessReliabilityFaultTargetSnapshot;
	  }
	| {
			readonly kind: 'revoke';
			readonly snapshot: OpenClawProcessReliabilityFaultTargetSnapshot;
	  };

interface ObservedOpenClawProcessIdentity {
	readonly bootId: string;
	readonly kind: 'openclaw-process';
	readonly processId: number;
	readonly startIdentity: string;
}

function openClawProcessCgroupName(
	snapshot: OpenClawProcessReliabilityFaultTargetSnapshot,
): string {
	return `agent-vm-${createHash('sha256')
		.update(`${snapshot.gateway.gatewayEpochId}\0${snapshot.processEpoch}`)
		.digest('hex')
		.slice(0, 24)}`;
}

function parseProcessStartIdentity(processStat: string, processId: number): string {
	const commandEndIndex = processStat.lastIndexOf(')');
	if (commandEndIndex < 0) {
		throw new Error(`OpenClaw process ${String(processId)} stat omitted its command boundary.`);
	}
	const fieldsAfterCommand = processStat
		.slice(commandEndIndex + 1)
		.trim()
		.split(/\s+/u);
	const startTimeTicks = fieldsAfterCommand[19];
	if (startTimeTicks === undefined || !/^\d+$/u.test(startTimeTicks)) {
		throw new Error(`OpenClaw process ${String(processId)} stat omitted its start identity.`);
	}
	return `proc-start-${startTimeTicks}`;
}

async function readOpenClawProcessIdentity(options: {
	readonly gatewayVm: ManagedVm;
	readonly snapshot: OpenClawProcessReliabilityFaultTargetSnapshot;
}): Promise<ObservedOpenClawProcessIdentity> {
	const cgroupName = openClawProcessCgroupName(options.snapshot);
	const cgroupProcesses = await options.gatewayVm.exec([
		'/bin/cat',
		`/sys/fs/cgroup/${cgroupName}/cgroup.procs`,
	]);
	if (cgroupProcesses.exitCode !== 0) {
		throw new Error(
			`OpenClaw process cgroup read failed with exit ${String(cgroupProcesses.exitCode)}: ${cgroupProcesses.stderr}`,
		);
	}
	const processIds = cgroupProcesses.stdout
		.split(/\s+/u)
		.filter((value) => value.length > 0)
		.map((value) => Number(value))
		.filter((value) => Number.isSafeInteger(value) && value > 0)
		.toSorted((left, right) => left - right);
	const processId = processIds[0];
	if (processId === undefined) {
		throw new Error(`OpenClaw process cgroup '${cgroupName}' contained no live process.`);
	}
	const processStat = await options.gatewayVm.exec(['/bin/cat', `/proc/${String(processId)}/stat`]);
	if (processStat.exitCode !== 0) {
		throw new Error(
			`OpenClaw process ${String(processId)} stat read failed with exit ${String(processStat.exitCode)}: ${processStat.stderr}`,
		);
	}
	return {
		bootId: options.snapshot.processEpoch,
		kind: 'openclaw-process',
		processId,
		startIdentity: parseProcessStartIdentity(processStat.stdout, processId),
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

function instrumentGatewayStockClose(managedVm: ManagedVm): void {
	const closeGatewayVm = managedVm.close.bind(managedVm);
	let closeEmitted = false;
	managedVm.close = async (): Promise<void> => {
		await closeGatewayVm();
		if (!closeEmitted) {
			closeEmitted = true;
			process.stderr.write('[process-recovery-e2e] stock Gateway close completed\n');
		}
	};
}

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

async function callSignedWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly marker: string;
}): Promise<ToolVmWriteReadResult> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('OpenClaw process recovery E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify({
		agentId: options.identity.agentId,
		filePath: `.agent-vm/process-recovery-${options.identity.agentId}-${randomUUID()}.txt`,
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
			// This process-scoped handler intentionally ignores the non-target session and leaf fences.
			controlSession: { generation: 0, id: 'neutral-control-session' },
			gateway: snapshot.gatewayGeneration,
			leaseLeaf: { generation: 0, id: 'neutral-lease-leaf' },
			openClawProcess: snapshot.openClawProcessGeneration,
		},
		issuedAtMs,
		nonce: randomUUID().replaceAll('-', ''),
		runId: 'openclaw-process-recovery-e2e',
		schemaVersion: 1,
		target: snapshot.target,
	};
}

async function holdStableRecoveryWindow(options: {
	readonly expectedGatewayVmId: string;
	readonly expectedRuntimeIds: Readonly<Record<'beta' | 'main', string>>;
	readonly harness: E2eHarnessRuntime;
	readonly p2: OpenClawProcessReliabilityFaultTargetSnapshot;
	readonly registry: OpenClawProcessReliabilityFaultTargetRegistry;
}): Promise<void> {
	const deadlineMs = Date.now() + stabilityWindowMs;
	let probeIndex = 0;
	while (Date.now() < deadlineMs) {
		const identity = configuredProbeIdentities[probeIndex % configuredProbeIdentities.length];
		if (identity === undefined) {
			throw new Error('Stability probe identity selection failed.');
		}
		await waitForProtocolRetryInterval(stabilityProbeIntervalMs);
		const result = await callSignedWriteReadProbe({
			harness: options.harness,
			identity,
			marker: `STABLE_${identity.agentId}_${String(probeIndex)}_${randomUUID()}`,
		});
		expect(result.runtimeId).toBe(options.expectedRuntimeIds[identity.agentId]);
		expect(result.readBack).toBe(result.marker);
		expect(options.registry.getCurrent()).toBe(options.p2);
		expect(options.harness.runtime.zones[0]).toMatchObject({
			gateway: { vm: { id: options.expectedGatewayVmId } },
			lifecycleState: 'running',
		});
		probeIndex += 1;
	}
	expect(probeIndex).toBeGreaterThanOrEqual(2);
}

describeOpenClawProcessRecoveryE2e('e2e: same-G OpenClaw process recovery', () => {
	let gatewayManagedVm: ManagedVm | undefined;
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	let registry: OpenClawProcessReliabilityFaultTargetRegistry | undefined;
	const registryEvents: RegistryEvent[] = [];
	const p2Publication = createDeferredPromise<OpenClawProcessReliabilityFaultTargetSnapshot>();

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: configuredProbeIdentities.map((identity) => identity.agentId),
			architecture,
			prefix: 'openclaw-process-recovery-e2e-',
			zoneId,
		});
		const systemZone = project.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected process recovery E2E project to contain an OpenClaw zone.');
		}
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
		systemZone.gateway.rawEnvSecrets = [
			...(systemZone.gateway.rawEnvSecrets ?? []),
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV,
		];
		const zoneFilesDir = systemZone.gateway.zoneFilesDir;
		await Promise.all(
			configuredProbeIdentities.map(async ({ agentId }) => {
				await fs.mkdir(path.join(zoneFilesDir, 'agents', agentId), {
					recursive: true,
				});
			}),
		);
		await useLocalOpenClawGatewayImagePackages({
			enableToolVmWriteReadE2eRoute: true,
			profileName: systemZone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		await prepareGatewayE2eProjectImages({ project });
		harness = await startE2eControllerRuntime({
			createOpenClawProcessReliabilityFaultTargetRegistry: (options) => {
				const delegate = createOpenClawProcessReliabilityFaultTargetRegistry(options);
				const instrumentedRegistry = {
					getCurrent: (target) => delegate.getCurrent(target),
					isCurrent: (snapshot) => delegate.isCurrent(snapshot),
					publish: (publication) => {
						const snapshot = delegate.publish(publication);
						registryEvents.push({ kind: 'publish', snapshot });
						if (registryEvents.filter((event) => event.kind === 'publish').length === 2) {
							p2Publication.resolve(snapshot);
						}
						return snapshot;
					},
					revoke: (revocation) => {
						const current = delegate.getCurrent();
						const revoked = delegate.revoke(revocation);
						if (revoked && current !== undefined) {
							registryEvents.push({ kind: 'revoke', snapshot: current });
						}
						return revoked;
					},
				} satisfies OpenClawProcessReliabilityFaultTargetRegistry;
				registry = instrumentedRegistry;
				return instrumentedRegistry;
			},
			secrets: {
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV]: '1',
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV]:
					JSON.stringify(configuredProbeIdentities),
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV]: probeSigningKey,
				GITHUB_TOKEN: 'unused-process-recovery-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-process-recovery-token',
			},
			startGatewayZone: async (startOptions) => {
				const result = await startGatewayZone(startOptions);
				gatewayManagedVm = result.vm;
				instrumentGatewayStockClose(result.vm);
				result.vm.configureIngressRoutes([
					{ port: result.processSpec.guestListenPort, prefix: '/', stripPrefix: true },
				]);
				return result;
			},
			startOptions: { systemConfig: project.systemConfig, zoneIds: [zoneId] },
		});
	}, 900_000);

	afterAll(async () => {
		if (
			project !== undefined &&
			process.env.AGENT_VM_PROCESS_RECOVERY_E2E_PRESERVE_TEMP_ROOT === '1'
		) {
			const supervisorStateSource = path.join(
				project.systemConfig.runtimeDir,
				'zones',
				zoneId,
				'openclaw-process-supervisor',
			);
			const supervisorStateDestination = path.join(
				process.cwd(),
				'tmp',
				'debug-workflows',
				'2026-07-09-agent-vm-mcp-portal-better-interface-sunfam-113-control-session',
				`process-recovery-supervisor-${randomUUID()}`,
			);
			await fs.cp(supervisorStateSource, supervisorStateDestination, { recursive: true });
			process.stderr.write(
				`[process-recovery-e2e] preserved supervisor state: ${supervisorStateDestination}\n`,
			);
			const gatewayLogsSource = path.join(project.systemConfig.runtimeDir, 'zones', zoneId, 'logs');
			const gatewayLogsDestination = path.join(
				process.cwd(),
				'tmp',
				'debug-workflows',
				'2026-07-09-agent-vm-mcp-portal-better-interface-sunfam-113-control-session',
				`process-recovery-logs-${randomUUID()}`,
			);
			await fs.cp(gatewayLogsSource, gatewayLogsDestination, { recursive: true });
			await fs.chmod(gatewayLogsDestination, 0o700);
			process.stderr.write(
				`[process-recovery-e2e] preserved private Gateway logs: ${gatewayLogsDestination}\n`,
			);
		}
		const preserveTempRoot = process.env.AGENT_VM_PROCESS_RECOVERY_E2E_PRESERVE_TEMP_ROOT === '1';
		try {
			await harness?.close(preserveTempRoot ? { preserveTempRoot: true } : undefined);
		} finally {
			if (project !== undefined) {
				if (preserveTempRoot) {
					await fs.access(project.tempRoot);
					process.stderr.write(`[process-recovery-e2e] preserved temp root: ${project.tempRoot}\n`);
				} else if (harness === undefined) {
					await removeE2eTempRoot(project.tempRoot);
				}
			}
		}
	});

	it('contains P1, publishes P2 in the same Gateway, and preserves both Tool VM leaves', async () => {
		if (harness === undefined || registry === undefined) {
			throw new Error('Expected process recovery E2E harness and registry.');
		}
		const activeHarness = harness;
		const activeRegistry = registry;
		const p1 = activeRegistry.getCurrent();
		const gatewayVmIdentity = activeHarness.runtime.zones[0]?.gateway?.vm;
		if (p1 === undefined || gatewayManagedVm === undefined || gatewayVmIdentity === undefined) {
			throw new Error('Expected accepted P1 and Gateway VM identity.');
		}
		const gatewayVm = gatewayManagedVm;
		const gatewayVmId = gatewayVmIdentity.id;
		const p1ProcessIdentity = await readOpenClawProcessIdentity({ gatewayVm, snapshot: p1 });
		const initialResults = await Promise.all(
			configuredProbeIdentities.map(
				async (identity) =>
					await callSignedWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `INITIAL_${identity.agentId}_${randomUUID()}`,
					}),
			),
		);
		const runtimeIds = Object.fromEntries(
			initialResults.map((result) => [result.agentId, result.runtimeId]),
		) as Record<'beta' | 'main', string>;
		expect(runtimeIds.main).not.toBe(runtimeIds.beta);

		const handler = createOpenClawProcessReliabilityFaultHandler({
			createReceiptId: randomUUID,
			nowMs: Date.now,
			registry: activeRegistry,
		});
		const terminationReceipt: ReliabilityFaultReceipt = await handler(createTerminationRequest(p1));
		expect(terminationReceipt).toMatchObject({
			action: 'terminate-owned-gateway-service',
			state: 'applied',
			target: p1.target,
		});

		const p2 = await withProtocolDeadline(
			p2Publication.promise,
			'P2 reliability target publication',
			120_000,
		);
		expect(p2.gateway).toEqual(p1.gateway);
		expect(p2.gatewayGeneration).toEqual(p1.gatewayGeneration);
		expect(p2.processEpoch).not.toBe(p1.processEpoch);
		expect(p2.openClawProcessGeneration.generation).toBeGreaterThan(
			p1.openClawProcessGeneration.generation,
		);
		const p2ProcessIdentity = await readOpenClawProcessIdentity({ gatewayVm, snapshot: p2 });
		expect(p2ProcessIdentity.processId).not.toBe(p1ProcessIdentity.processId);
		expect(p2ProcessIdentity.startIdentity).not.toBe(p1ProcessIdentity.startIdentity);
		expect(activeHarness.runtime.zones[0]?.gateway?.vm.id).toBe(gatewayVmId);
		expect(registryEvents.slice(0, 3).map((event) => event.kind)).toEqual([
			'publish',
			'revoke',
			'publish',
		]);

		const postRecoveryResults = await Promise.all(
			configuredProbeIdentities.map(
				async (identity) =>
					await callSignedWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `POST_RECOVERY_${identity.agentId}_${randomUUID()}`,
					}),
			),
		);
		for (const result of postRecoveryResults) {
			expect(result.runtimeId).toBe(runtimeIds[result.agentId as 'beta' | 'main']);
			expect(result.readBack).toBe(result.marker);
		}

		await holdStableRecoveryWindow({
			expectedGatewayVmId: gatewayVmId,
			expectedRuntimeIds: runtimeIds,
			harness: activeHarness,
			p2,
			registry: activeRegistry,
		});

		const packageIdentity = await readAgentVmPackageIdentity();
		const transitionArtifact = JSON.stringify({
			gateway: p1.gateway,
			p1: {
				generation: p1.openClawProcessGeneration,
				process: p1ProcessIdentity,
			},
			p2: {
				generation: p2.openClawProcessGeneration,
				process: p2ProcessIdentity,
			},
			terminationReceipt,
		});
		const preservedLeavesArtifact = JSON.stringify({
			gatewayVmId,
			initialRuntimeIds: Object.fromEntries(
				initialResults.map((result) => [result.agentId, result.runtimeId]),
			),
			postRecoveryRuntimeIds: Object.fromEntries(
				postRecoveryResults.map((result) => [result.agentId, result.runtimeId]),
			),
		});
		await writeControlLeaseReliabilityEvidence({
			expectedOperationId: reliabilityOperationId,
			payload: {
				artifacts: [
					{
						operationId: 'process-recovery-transition',
						sha256: hashControlLeaseReliabilityArtifact(transitionArtifact),
					},
					{
						operationId: 'process-recovery-preserved-leaves',
						sha256: hashControlLeaseReliabilityArtifact(preservedLeavesArtifact),
					},
				],
				generationIdentities: [
					{
						generation: p1.controllerGeneration.generation,
						targetId: p1.controllerGeneration.id,
						targetKind: 'controller',
					},
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
				packageIdentities: [packageIdentity],
				processIdentities: [p1ProcessIdentity, p2ProcessIdentity],
				runtimeIdentities: [
					{
						generation: p1.gatewayGeneration.generation,
						id: gatewayVmId,
						kind: 'gateway-vm',
					},
					...Object.values(runtimeIds).map((runtimeId) => ({
						generation: p1.gatewayGeneration.generation,
						id: runtimeId,
						kind: 'tool-vm-lease' as const,
					})),
				],
			},
		});
	}, 300_000);
});
