/* oxlint-disable eslint/no-await-in-loop -- Stability probes are sequential against one live gateway VM. */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentVmHealthEvent, ZoneHealthSnapshot } from '@agent-vm/gateway-interface';
import { buildOpenClawRuntimeStatusReport } from '@agent-vm/openclaw-agent-vm-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDurableHealthEvents } from '../controller/health/durable-health-event-log.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import {
	canRunGondolinE2e,
	currentE2eArchitecture,
	disableOpenClawMcpPortalPlugin,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	startE2eControllerRuntime,
	type E2eHarnessRuntime,
	type OpenClawE2eProject,
	useLocalOpenClawPluginGatewayImage,
	useLocalToolVmMcpPortalPackage,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import {
	scanOpenClawStabilityEvents,
	scanOpenClawStabilityLogs,
} from './openclaw-stability-classification.js';

const architecture = currentE2eArchitecture();
const runOpenClawStability =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeOpenClawStability = runOpenClawStability ? describe : describe.skip;
const agentId = 'stability';
const gatewayToken = 'openclaw-stability-gateway-token';
const zoneId = 'openclaw-stability';
const defaultStabilityDurationMs = 180_000;
const defaultStabilityIntervalMs = 3_000;
const stabilityGatewayServiceAutoRestart = {
	channelProviderHealth: {
		consecutiveFailureThreshold: 3,
		enabled: true,
		restartGatewayOnRecoverable: true,
		restartGatewayOnUnrecoverable: false,
		transitioningTimeoutMs: 120_000,
	},
	cooldownMs: 61 * 60 * 1000,
	consecutiveFailureThreshold: 10,
	enabled: true,
	failedRecoveryResetMs: 24 * 60 * 60 * 1000,
	maxConsecutiveFailedRecoveries: 3,
	restartTimeoutMs: 120_000,
} as const;

interface StabilityProbeResult {
	readonly controllerOk: boolean;
	readonly elapsedMs: number;
	readonly iteration: number;
	readonly serviceOk: boolean;
	readonly snapshotOk: boolean;
	readonly zoneOk: boolean;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveIntegerFromEnv(envName: string, defaultValue: number): number {
	const rawValue = process.env[envName];
	if (rawValue === undefined || rawValue.length === 0) {
		return defaultValue;
	}
	const parsedValue = Number(rawValue);
	if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
		throw new Error(`${envName} must be a positive integer number of milliseconds.`);
	}
	return parsedValue;
}

function optionalPositiveIntegerFromEnv(envName: string): number | undefined {
	const rawValue = process.env[envName];
	if (rawValue === undefined || rawValue.length === 0) {
		return undefined;
	}
	const parsedValue = Number(rawValue);
	if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
		throw new Error(`${envName} must be a positive integer.`);
	}
	return parsedValue;
}

async function fetchJsonRecord(props: {
	readonly expectedOk?: boolean;
	readonly timeoutMs: number;
	readonly url: string;
}): Promise<Record<string, unknown>> {
	const response = await fetch(props.url, { signal: AbortSignal.timeout(props.timeoutMs) });
	const responseText = await response.text();
	let parsedBody: unknown;
	try {
		parsedBody = responseText.length === 0 ? {} : JSON.parse(responseText);
	} catch (error) {
		throw new Error(`Expected JSON from ${props.url}, got ${responseText}: ${String(error)}`, {
			cause: error,
		});
	}
	if (!response.ok) {
		throw new Error(`GET ${props.url} returned HTTP ${String(response.status)}: ${responseText}`);
	}
	if (!isObjectRecord(parsedBody)) {
		throw new Error(`Expected object JSON from ${props.url}, got ${responseText}`);
	}
	if (props.expectedOk !== undefined && parsedBody.ok !== props.expectedOk) {
		throw new Error(`GET ${props.url} returned ok=${String(parsedBody.ok)}: ${responseText}`);
	}
	return parsedBody;
}

async function readHealthSnapshot(controllerUrl: string): Promise<ZoneHealthSnapshot> {
	const snapshot = await fetchJsonRecord({
		timeoutMs: 5_000,
		url: `${controllerUrl}/zones/${encodeURIComponent(zoneId)}/health-snapshot`,
	});
	if (snapshot.kind !== 'ok') {
		throw new Error(`Expected health snapshot kind ok, got ${JSON.stringify(snapshot)}`);
	}
	return snapshot as unknown as ZoneHealthSnapshot;
}

async function publishOpenClawRuntimeStatus(options: {
	readonly controllerUrl: string;
	readonly openClawConfigPath: string;
}): Promise<void> {
	const parsedConfig: unknown = JSON.parse(await fs.readFile(options.openClawConfigPath, 'utf8'));
	if (!isObjectRecord(parsedConfig)) {
		throw new Error(`Expected OpenClaw stability config at ${options.openClawConfigPath}.`);
	}
	const response = await fetch(
		`${options.controllerUrl}/zones/${encodeURIComponent(zoneId)}/openclaw-runtime-status`,
		{
			body: JSON.stringify(
				buildOpenClawRuntimeStatusReport({
					config: parsedConfig,
					zoneId,
				}),
			),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
			signal: AbortSignal.timeout(5_000),
		},
	);
	if (!response.ok) {
		throw new Error(
			`OpenClaw runtime status publish failed HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
}

async function runStabilityProbeIteration(options: {
	readonly controllerUrl: string;
	readonly iteration: number;
}): Promise<StabilityProbeResult> {
	const startedAtMs = Date.now();
	const controllerHealth = await fetchJsonRecord({
		expectedOk: true,
		timeoutMs: 5_000,
		url: `${options.controllerUrl}/health`,
	});
	const zoneHealth = await fetchJsonRecord({
		expectedOk: true,
		timeoutMs: 5_000,
		url: `${options.controllerUrl}/zones/${encodeURIComponent(zoneId)}/health`,
	});
	const serviceHealth = await fetchJsonRecord({
		expectedOk: true,
		timeoutMs: 5_000,
		url: `${options.controllerUrl}/zones/${encodeURIComponent(zoneId)}/service-health`,
	});
	const healthSnapshot = await readHealthSnapshot(options.controllerUrl);
	return {
		controllerOk: controllerHealth.ok === true,
		elapsedMs: Date.now() - startedAtMs,
		iteration: options.iteration,
		serviceOk: serviceHealth.ok === true,
		snapshotOk: healthSnapshot.kind === 'ok',
		zoneOk: zoneHealth.ok === true,
	};
}

async function waitForInitialReadiness(controllerUrl: string): Promise<void> {
	const deadlineMs = Date.now() + 90_000;
	let lastError: Error | undefined;
	while (Date.now() < deadlineMs) {
		try {
			await runStabilityProbeIteration({ controllerUrl, iteration: 0 });
			return;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			await waitForProtocolRetryInterval(1_000);
		}
	}
	throw new Error(`Timed out waiting for OpenClaw stability readiness: ${lastError?.message}`);
}

async function readPostReadinessHealthEvents(options: {
	readonly readyAtMs: number;
	readonly runtimeDir: string;
}): Promise<readonly AgentVmHealthEvent[]> {
	return (await readDurableHealthEvents({ runtimeDir: options.runtimeDir }))
		.map((record) => record.body)
		.filter((event) => event.observedAtMs > options.readyAtMs);
}

async function readGatewayBootLog(options: {
	readonly runtimeDir: string;
	readonly zoneId: string;
}): Promise<string> {
	const bootLogPath = path.join(
		options.runtimeDir,
		'zones',
		options.zoneId,
		'logs',
		'gateway-boot-latest.log',
	);
	return await fs.readFile(bootLogPath, 'utf8').catch((error: unknown) => {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return '';
		}
		throw error;
	});
}

function assertNoPostReadinessInstability(options: {
	readonly events: readonly AgentVmHealthEvent[];
	readonly logText: string;
	readonly readyAtMs: number;
}): { readonly childRestartEvents: number; readonly crashSignatureMatches: number } {
	const eventScan = scanOpenClawStabilityEvents({
		events: options.events,
		readyAtMs: options.readyAtMs,
	});
	const logScan = scanOpenClawStabilityLogs(options.logText);
	const failures = [...eventScan.failures, ...logScan.failures];
	if (failures.length > 0) {
		throw new Error(`OpenClaw stability failures:\n${failures.join('\n')}`);
	}
	return {
		childRestartEvents: logScan.failures.filter((failure) => failure.includes('child exit')).length,
		crashSignatureMatches: logScan.crashSignatureMatches,
	};
}

describeOpenClawStability('e2e: OpenClaw managed gateway stability', () => {
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	let systemConfig: E2eHarnessRuntime['systemConfig'] | undefined;
	let openClawConfigPath: string | undefined;
	const gatewayVmIds: string[] = [];

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: [agentId],
			architecture,
			prefix: 'openclaw-stability-e2e-',
			zoneId,
		});
		const loadedSystemConfig: E2eHarnessRuntime['systemConfig'] = {
			...project.systemConfig,
			controller: {
				health: {
					...project.systemConfig.controller?.health,
					enabled: true,
					eventHistoryLimit: 200,
					gatewayControlLinkBackoffCeilingMs: 2_000,
					gatewayControlLinkIntervalMs: 1_000,
					gatewayServiceAutoRestart: {
						...stabilityGatewayServiceAutoRestart,
					},
					gatewayServiceIntervalMs: 1_000,
					staleAfterMs: 20_000,
				},
			},
		};
		systemConfig = loadedSystemConfig;
		const systemZone = loadedSystemConfig.zones[0];
		if (!systemZone || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw stability project to contain an OpenClaw zone.');
		}
		openClawConfigPath = systemZone.gateway.config;
		await disableOpenClawMcpPortalPlugin(systemZone.gateway.config);
		await useLocalOpenClawPluginGatewayImage({
			profileName: systemZone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: loadedSystemConfig,
		});
		await useLocalToolVmMcpPortalPackage({
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: loadedSystemConfig,
		});
		await prepareGatewayE2eProjectImages({ project });
		harness = await startE2eControllerRuntime({
			secrets: {
				GITHUB_TOKEN: 'unused-openclaw-stability-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-openclaw-stability-perplexity-token',
			},
			startGatewayZone: async (startGatewayOptions) => {
				const result = await startGatewayZone(startGatewayOptions);
				gatewayVmIds.push(result.vm.id);
				result.vm.setIngressRoutes([
					{
						port: result.processSpec.guestListenPort,
						prefix: '/',
						stripPrefix: true,
					},
				]);
				return result;
			},
			startOptions: {
				systemConfig: loadedSystemConfig,
				zoneIds: [systemZone.id],
			},
		});
	}, 900_000);

	afterAll(async () => {
		try {
			await harness?.close();
		} finally {
			if (project) {
				await removeE2eTempRoot(project.tempRoot);
			}
		}
	});

	it('keeps controller health, zone health, service health, and health snapshots stable', async () => {
		if (
			harness === undefined ||
			openClawConfigPath === undefined ||
			project === undefined ||
			systemConfig === undefined
		) {
			throw new Error('Expected OpenClaw stability harness to be initialized.');
		}
		const durationMs = positiveIntegerFromEnv(
			'AGENT_VM_OPENCLAW_STABILITY_DURATION_MS',
			defaultStabilityDurationMs,
		);
		const intervalMs = positiveIntegerFromEnv(
			'AGENT_VM_OPENCLAW_STABILITY_INTERVAL_MS',
			defaultStabilityIntervalMs,
		);
		const iterationLimit =
			optionalPositiveIntegerFromEnv('AGENT_VM_OPENCLAW_STABILITY_ITERATIONS') ??
			Number.MAX_SAFE_INTEGER;
		await waitForInitialReadiness(harness.controllerUrl);
		const readyAtMs = Date.now();
		const startedAtMs = readyAtMs;
		let iterationsAttempted = 0;
		let iterationsPassed = 0;
		while (Date.now() - startedAtMs < durationMs && iterationsAttempted < iterationLimit) {
			iterationsAttempted += 1;
			const probeResult = await runStabilityProbeIteration({
				controllerUrl: harness.controllerUrl,
				iteration: iterationsAttempted,
			});
			expect(probeResult).toMatchObject({
				controllerOk: true,
				serviceOk: true,
				snapshotOk: true,
				zoneOk: true,
			});
			await publishOpenClawRuntimeStatus({
				controllerUrl: harness.controllerUrl,
				openClawConfigPath,
			});
			const postReadinessEvents = await readPostReadinessHealthEvents({
				readyAtMs,
				runtimeDir: harness.systemConfig.runtimeDir,
			});
			const bootLog = await readGatewayBootLog({
				runtimeDir: harness.systemConfig.runtimeDir,
				zoneId,
			});
			assertNoPostReadinessInstability({
				events: postReadinessEvents,
				logText: bootLog,
				readyAtMs,
			});
			iterationsPassed += 1;
			if (iterationsAttempted >= iterationLimit) {
				break;
			}
			if (Date.now() - startedAtMs < durationMs) {
				await waitForProtocolRetryInterval(intervalMs);
			}
		}
		const finalEvents = await readPostReadinessHealthEvents({
			readyAtMs,
			runtimeDir: harness.systemConfig.runtimeDir,
		});
		const finalBootLog = await readGatewayBootLog({
			runtimeDir: harness.systemConfig.runtimeDir,
			zoneId,
		});
		const finalScan = assertNoPostReadinessInstability({
			events: finalEvents,
			logText: finalBootLog,
			readyAtMs,
		});
		await runStabilityProbeIteration({
			controllerUrl: harness.controllerUrl,
			iteration: iterationsAttempted + 1,
		});
		process.stdout.write(
			[
				'OpenClaw stability proof:',
				`  durationMs=${String(Date.now() - startedAtMs)}`,
				`  iterationsAttempted=${String(iterationsAttempted)}`,
				`  iterationsPassed=${String(iterationsPassed)}`,
				`  controllerUrl=${harness.controllerUrl}`,
				`  zoneId=${zoneId}`,
				`  gatewayVmId=${gatewayVmIds.at(-1) ?? 'unknown'}`,
				`  childRestartEvents=${String(finalScan.childRestartEvents)}`,
				'  restartLimitExceeded=false',
				`  crashSignatureMatches=${String(finalScan.crashSignatureMatches)}`,
				'',
			].join('\n'),
		);
		expect(iterationsAttempted).toBeGreaterThan(0);
		expect(iterationsPassed).toBe(iterationsAttempted);
		expect(gatewayVmIds).toHaveLength(1);
	});
});
