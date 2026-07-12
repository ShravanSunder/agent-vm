/* oxlint-disable eslint/no-await-in-loop -- live replacement assertions are intentionally ordered */
import { randomUUID } from 'node:crypto';
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

import {
	loadAllToolVmRuntimeRecords,
	type ToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import { loadGatewayRuntimeRecord } from '../gateway/gateway-runtime-record.js';
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
import { withProtocolDeadline } from './e2e-protocol-wait.js';

const architecture = currentE2eArchitecture();
const runGatewaySubtreeReplacementE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeGatewaySubtreeReplacementE2e = runGatewaySubtreeReplacementE2e
	? describe
	: describe.skip;
const zoneId = 'gateway-subtree-replacement';
const gatewayToken = 'gateway-subtree-replacement-token';
const probeSigningKey = 'gateway-subtree-replacement-write-read-key';
const reliabilityOperationId = 'gateway-subtree-replacement';
const configuredProbeIdentities = [
	{
		agentId: 'main',
		sessionKey: 'agent:main:tool-vm-write-read:gateway-subtree-main',
	},
	{
		agentId: 'beta',
		sessionKey: 'agent:beta:tool-vm-write-read:gateway-subtree-beta',
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

interface GatewayStartObservation {
	readonly qemuPid: number;
	readonly vm: ManagedVm;
	readonly vmId: string;
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

async function callSignedWriteReadProbe(options: {
	readonly harness: E2eHarnessRuntime;
	readonly identity: (typeof configuredProbeIdentities)[number];
	readonly marker: string;
}): Promise<ToolVmWriteReadResult> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Gateway subtree replacement E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify({
		agentId: options.identity.agentId,
		filePath: `.agent-vm/gateway-subtree-${options.identity.agentId}-${randomUUID()}.txt`,
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

async function readExactToolVmRuntimeRecords(
	stateDirectory: string,
	leaseIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, ToolVmRuntimeRecord>> {
	const results = await loadAllToolVmRuntimeRecords(stateDirectory);
	const parseError = results.find((result) => result.kind === 'parse-error');
	if (parseError !== undefined) {
		throw new Error(`Tool VM runtime record failed to parse: ${parseError.path}`);
	}
	const records = results
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

function isProcessAbsent(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return false;
	} catch (error) {
		return isObjectRecord(error) && error.code === 'ESRCH';
	}
}

function createDeferredPromise(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
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

describeGatewaySubtreeReplacementE2e('e2e: Gateway subtree replacement', () => {
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	const gatewayStarts: GatewayStartObservation[] = [];
	const oldGatewayClosed = createDeferredPromise();
	const allowSuccessorStart = createDeferredPromise();
	let oldToolRecords: ReadonlyMap<string, ToolVmRuntimeRecord> | undefined;
	let replacementOrderingArtifact: string | undefined;

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: configuredProbeIdentities.map((identity) => identity.agentId),
			architecture,
			prefix: 'gateway-subtree-replacement-e2e-',
			zoneId,
		});
		const systemZone = project.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected Gateway replacement E2E project to contain an OpenClaw zone.');
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
				GITHUB_TOKEN: 'unused-gateway-subtree-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-gateway-subtree-token',
			},
			startGatewayZone: async (startOptions) => {
				if (gatewayStarts.length === 1) {
					const exactOldToolRecords = oldToolRecords;
					if (exactOldToolRecords === undefined) {
						throw new Error('Successor start began before old Tool identities were captured.');
					}
					const remainingRecords = await loadAllToolVmRuntimeRecords(systemZone.gateway.stateDir);
					if (remainingRecords.length !== 0) {
						throw new Error(
							'Successor Gateway start began while old Tool runtime records remained.',
						);
					}
					const oldGatewayRecord = await loadGatewayRuntimeRecord(systemZone.gateway.stateDir);
					if (oldGatewayRecord !== null) {
						throw new Error('Successor Gateway start began while the old Gateway record remained.');
					}
					const absentToolPids = [...exactOldToolRecords.values()].map((record) => ({
						absent: isProcessAbsent(record.qemuPid),
						leaseId: record.leaseId,
						qemuPid: record.qemuPid,
						tcpSlot: record.tcpSlot,
					}));
					if (absentToolPids.some((identity) => !identity.absent)) {
						throw new Error(
							'Successor Gateway start began while an old Tool QEMU process remained.',
						);
					}
					replacementOrderingArtifact = JSON.stringify({
						oldGatewayRecordAbsent: true,
						oldToolEndpointsRetired: absentToolPids.map(({ leaseId, tcpSlot }) => ({
							leaseId,
							tcpSlot,
						})),
						oldToolProcesses: absentToolPids,
						ordering: 'old-tools-absent-before-successor-start',
					});
					await allowSuccessorStart.promise;
				}
				const result = await startGatewayZone(startOptions);
				const qemuPid = result.vm.getHostProcessId();
				if (qemuPid === null) {
					throw new Error('Started Gateway omitted its host QEMU pid.');
				}
				gatewayStarts.push({ qemuPid, vm: result.vm, vmId: result.vm.id });
				result.vm.configureIngressRoutes([
					{ port: result.processSpec.guestListenPort, prefix: '/', stripPrefix: true },
				]);
				if (gatewayStarts.length === 1) {
					const stockClose = result.vm.close.bind(result.vm);
					result.vm.close = async (): Promise<void> => {
						await stockClose();
						oldGatewayClosed.resolve();
						await allowSuccessorStart.promise;
					};
				}
				return result;
			},
			startOptions: { systemConfig: project.systemConfig, zoneIds: [zoneId] },
		});
	}, 900_000);

	afterAll(async () => {
		allowSuccessorStart.resolve();
		try {
			await harness?.close();
		} finally {
			if (project !== undefined && harness === undefined) {
				await removeE2eTempRoot(project.tempRoot);
			}
		}
	});

	it('fences admission, destroys G1 children, and starts a clean G2 subtree', async () => {
		if (harness === undefined || project === undefined) {
			throw new Error('Expected Gateway subtree replacement E2E harness.');
		}
		const activeHarness = harness;
		const activeProject = project;
		const activeZone = activeProject.systemConfig.zones[0];
		if (activeZone === undefined || activeZone.gateway.type !== 'openclaw') {
			throw new Error('Expected active OpenClaw zone.');
		}
		const g1 = gatewayStarts[0];
		if (g1 === undefined) {
			throw new Error('Expected initial Gateway start.');
		}
		const g1RuntimeRecord = await loadGatewayRuntimeRecord(activeZone.gateway.stateDir);
		if (g1RuntimeRecord === null || g1RuntimeRecord.vmId !== g1.vmId) {
			throw new Error('Expected exact initial Gateway runtime record.');
		}
		const initialResults = await Promise.all(
			configuredProbeIdentities.map(
				async (identity) =>
					await callSignedWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `G1_${identity.agentId}_${randomUUID()}`,
					}),
			),
		);
		const oldLeaseIds = new Set(initialResults.map((result) => result.runtimeId));
		expect(oldLeaseIds.size).toBe(2);
		oldToolRecords = await readExactToolVmRuntimeRecords(activeZone.gateway.stateDir, oldLeaseIds);
		for (const result of initialResults) {
			expect(result.readBack).toBe(result.marker);
		}

		const refreshResponsePromise = fetch(
			`${activeHarness.controllerUrl}/zones/${encodeURIComponent(zoneId)}/credentials/refresh`,
			{ method: 'POST' },
		);
		await withProtocolDeadline(oldGatewayClosed.promise, 'old Gateway stock close', 180_000);

		const fencedAdmission = await callSignedWriteReadProbe({
			harness: activeHarness,
			identity: configuredProbeIdentities[0],
			marker: `FENCED_${randomUUID()}`,
		})
			.then(() => ({ fenced: false as const, observation: 'unexpected-success' }))
			.catch((error: unknown) => ({
				fenced: true as const,
				observation: error instanceof Error ? error.message : String(error),
			}));
		expect(fencedAdmission.fenced).toBe(true);
		allowSuccessorStart.resolve();

		const refreshResponse = await withProtocolDeadline(
			refreshResponsePromise,
			'Gateway credential refresh replacement',
			300_000,
		);
		expect(refreshResponse.status).toBe(200);
		const refreshBody: unknown = await refreshResponse.json();
		expect(refreshBody).toMatchObject({ ok: true, zoneId });
		const g2 = gatewayStarts[1];
		if (g2 === undefined || replacementOrderingArtifact === undefined) {
			throw new Error('Expected a successor Gateway and pre-start ordering artifact.');
		}
		expect(g2.vmId).not.toBe(g1.vmId);
		expect(isProcessAbsent(g1.qemuPid)).toBe(true);
		const g2RuntimeRecord = await loadGatewayRuntimeRecord(activeZone.gateway.stateDir);
		expect(g2RuntimeRecord).toMatchObject({ vmId: g2.vmId, zoneId });
		expect(g2RuntimeRecord?.gateway.gatewayVmId).toBe(g2.vmId);

		const freshResults = await Promise.all(
			configuredProbeIdentities.map(
				async (identity) =>
					await callSignedWriteReadProbe({
						harness: activeHarness,
						identity,
						marker: `G2_${identity.agentId}_${randomUUID()}`,
					}),
			),
		);
		for (const result of freshResults) {
			expect(result.readBack).toBe(result.marker);
			expect(oldLeaseIds.has(result.runtimeId)).toBe(false);
		}
		const freshLeaseIds = new Set(freshResults.map((result) => result.runtimeId));
		expect(freshLeaseIds.size).toBe(2);
		const freshRecords = await readExactToolVmRuntimeRecords(
			activeZone.gateway.stateDir,
			freshLeaseIds,
		);
		for (const record of freshRecords.values()) {
			expect(record.gateway.gatewayVmId).toBe(g2.vmId);
			expect([...oldLeaseIds]).not.toContain(record.leaseId);
		}

		const packageIdentity = await readAgentVmPackageIdentity();
		const transitionArtifact = JSON.stringify({
			fencedAdmission,
			g1: { leaseIds: [...oldLeaseIds], vmId: g1.vmId },
			g2: { leaseIds: [...freshLeaseIds], vmId: g2.vmId },
		});
		const evidenceWriteResult = await writeControlLeaseReliabilityEvidence({
			expectedOperationId: reliabilityOperationId,
			payload: {
				artifacts: [
					{
						operationId: 'gateway-subtree-transition',
						sha256: hashControlLeaseReliabilityArtifact(transitionArtifact),
					},
					{
						operationId: 'gateway-subtree-destruction-order',
						sha256: hashControlLeaseReliabilityArtifact(replacementOrderingArtifact),
					},
				],
				generationIdentities: [
					{ generation: 1, targetId: g1.vmId, targetKind: 'gateway' },
					{ generation: 2, targetId: g2.vmId, targetKind: 'gateway' },
				],
				packageIdentities: [packageIdentity],
				processIdentities: [
					{
						bootId: `gateway-${g1.vmId}`,
						kind: 'gateway-qemu',
						processId: g1.qemuPid,
						startIdentity: `process-${hashControlLeaseReliabilityArtifact(
							g1RuntimeRecord.processIdentity.lstart,
						).slice(0, 32)}`,
					},
					{
						bootId: `gateway-${g2.vmId}`,
						kind: 'gateway-qemu',
						processId: g2.qemuPid,
						startIdentity: `process-${hashControlLeaseReliabilityArtifact(
							g2RuntimeRecord?.processIdentity.lstart ?? 'unknown',
						).slice(0, 32)}`,
					},
				],
				runtimeIdentities: [
					{ generation: 1, id: g1.vmId, kind: 'gateway-vm' },
					{ generation: 2, id: g2.vmId, kind: 'gateway-vm' },
					...freshResults.map((result) => ({
						generation: 2,
						id: result.runtimeId,
						kind: 'tool-vm-lease' as const,
					})),
				],
			},
		});
		expect(evidenceWriteResult.kind).toBe(expectedControlLeaseReliabilityEvidenceWriteKind());
	}, 600_000);
});
