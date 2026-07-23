/* oxlint-disable eslint/no-await-in-loop -- E2E steps are sequential against live VMs */
import fs, { watch } from 'node:fs/promises';
import path from 'node:path';

import type { AgentVmHealthEvent, ZoneHealthSnapshot } from '@agent-vm/gateway-lifecycle';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	controllerHealthEventLogPath,
	readDurableHealthEvents,
} from '../controller/health/durable-health-event-log.js';
import {
	readManagedGatewaySiblingProcessIdentity,
	terminateManagedGatewaySibling,
} from '../controller/reliability/testing/gateway-reliability-fault-adapter.js';
import {
	canRunManagedVmE2e,
	currentE2eArchitecture,
	disableOpenClawMcpPortalPlugin,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	startE2eControllerRuntime,
	startE2eGatewayZone as startGatewayZone,
	type OpenClawE2eProject,
	type E2eHarnessRuntime,
	useLocalOpenClawPluginGatewayImage,
	useLocalToolVmMcpPortalPackage,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';

const architecture = currentE2eArchitecture();
const runOpenClawControlLinkSmoke =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeOpenClawControlLinkSmoke = runOpenClawControlLinkSmoke ? describe : describe.skip;
const agentId = 'smoke';
const gatewayToken = 'control-session-smoke-gateway-token';
const zoneId = 'control-session-smoke';
type ManagedGatewayStartResult = Extract<
	Awaited<ReturnType<typeof startGatewayZone>>,
	{ readonly executionModel: 'managed-gateway' }
>;

interface GatewayStartObservation {
	readonly qemuPid: number;
	readonly result: ManagedGatewayStartResult;
	readonly vmId: string;
}

const smokeGatewayServiceAutoRestart = {
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

function latestEvents(snapshot: ZoneHealthSnapshot): readonly AgentVmHealthEvent[] {
	return 'latestEvents' in snapshot ? snapshot.latestEvents : [];
}

class E2eTimeoutError extends Error {}

function withTimeout<TValue>(
	promise: Promise<TValue>,
	timeoutMs: number,
	message: string,
): Promise<TValue> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new E2eTimeoutError(message)), timeoutMs);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	});
}

async function readHealthSnapshot(controllerUrl: string): Promise<ZoneHealthSnapshot> {
	const response = await fetch(
		`${controllerUrl}/zones/${encodeURIComponent(zoneId)}/health-snapshot`,
	);
	if (!response.ok) {
		throw new Error(`Health snapshot returned HTTP ${String(response.status)}.`);
	}
	return (await response.json()) as ZoneHealthSnapshot;
}

async function waitForHealthEvent(options: {
	readonly controllerUrl: string;
	readonly describeEvent: string;
	readonly matches: (event: AgentVmHealthEvent) => boolean;
	readonly controllerRuntimeDir: string;
	readonly timeoutMs: number;
}): Promise<AgentVmHealthEvent> {
	const eventLogPath = controllerHealthEventLogPath(options.controllerRuntimeDir);
	await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
	await fs.appendFile(eventLogPath, '', 'utf8');
	const watcher = watch(eventLogPath, { persistent: false });
	const deadlineMs = Date.now() + options.timeoutMs;
	try {
		while (true) {
			const nextLogChange = watcher.next();
			const event = (
				await readDurableHealthEvents({
					controllerRuntimeDir: options.controllerRuntimeDir,
				})
			)
				.map((record) => record.body)
				.find(options.matches);
			if (event !== undefined) {
				return event;
			}
			const remainingTimeoutMs = deadlineMs - Date.now();
			if (remainingTimeoutMs <= 0) {
				break;
			}
			let nextResult: Awaited<ReturnType<typeof watcher.next>>;
			try {
				nextResult = await withTimeout(
					nextLogChange,
					remainingTimeoutMs,
					`Timed out waiting for ${options.describeEvent}`,
				);
			} catch (error) {
				if (error instanceof E2eTimeoutError) {
					break;
				}
				throw error;
			}
			if (nextResult.done === true) {
				break;
			}
		}
	} finally {
		await watcher.return?.();
	}
	const lastSnapshot = await readHealthSnapshot(options.controllerUrl).catch(() => undefined);
	if (lastSnapshot !== undefined) {
		const event = latestEvents(lastSnapshot).find(options.matches);
		if (event !== undefined) {
			return event;
		}
	}
	throw new Error(
		`Timed out waiting for ${options.describeEvent}; last snapshot: ${JSON.stringify(lastSnapshot)}`,
	);
}

async function waitForGatewayServiceFailureCount(options: {
	readonly expectedCount: number;
	readonly controllerRuntimeDir: string;
	readonly timeoutMs: number;
}): Promise<readonly Extract<AgentVmHealthEvent, { readonly kind: 'gateway-service-health' }>[]> {
	const deadlineMs = Date.now() + options.timeoutMs;
	let failures: readonly Extract<
		AgentVmHealthEvent,
		{ readonly kind: 'gateway-service-health' }
	>[] = [];
	while (Date.now() < deadlineMs) {
		failures = (
			await readDurableHealthEvents({
				controllerRuntimeDir: options.controllerRuntimeDir,
			})
		)
			.map((record) => record.body)
			.filter(
				(
					event,
				): event is Extract<AgentVmHealthEvent, { readonly kind: 'gateway-service-health' }> =>
					event.kind === 'gateway-service-health' && event.result === 'failed',
			);
		if (failures.length >= options.expectedCount) return failures;
		await waitForProtocolRetryInterval(250);
	}
	throw new Error(
		`Timed out waiting for ${String(options.expectedCount)} Gateway service failures; observed ${String(failures.length)}.`,
	);
}

function isProcessAbsent(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return false;
	} catch (error) {
		return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
	}
}

async function waitForSuccessorGatewayStart(options: {
	readonly gatewayStarts: readonly GatewayStartObservation[];
	readonly predecessor: GatewayStartObservation;
	readonly timeoutMs: number;
}): Promise<GatewayStartObservation> {
	const deadlineMs = Date.now() + options.timeoutMs;
	while (Date.now() < deadlineMs) {
		const successor = options.gatewayStarts.find(
			(start) =>
				start.vmId !== options.predecessor.vmId &&
				start.result.expectedCohort.fence.gatewayEpoch !==
					options.predecessor.result.expectedCohort.fence.gatewayEpoch,
		);
		const diagnostics = successor?.result.controlSession?.getDiagnostics();
		if (
			successor !== undefined &&
			diagnostics !== undefined &&
			diagnostics.accepted &&
			diagnostics.connected &&
			diagnostics.ready &&
			diagnostics.lastHelloResponse?.outcome === 'accepted' &&
			diagnostics.transportName === 'websocket'
		) {
			return successor;
		}
		await waitForProtocolRetryInterval(1_000);
	}
	const latestGatewayStart = options.gatewayStarts.at(-1);
	throw new Error(
		`Timed out waiting for a distinct accepted Gateway VM after '${options.predecessor.vmId}'; latest Gateway '${latestGatewayStart?.vmId ?? 'none'}', diagnostics: ${JSON.stringify(latestGatewayStart?.result.controlSession?.getDiagnostics())}`,
	);
}

describeOpenClawControlLinkSmoke('smoke: OpenClaw agent-vm controller control session', () => {
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	let systemConfig: E2eHarnessRuntime['systemConfig'] | undefined;
	let gatewayStart: ManagedGatewayStartResult | undefined;
	const gatewayStarts: GatewayStartObservation[] = [];

	const startControlLinkHarness = async (): Promise<E2eHarnessRuntime> => {
		const activeSystemConfig = systemConfig;
		const systemZone = activeSystemConfig?.zones[0];
		if (activeSystemConfig === undefined || !systemZone || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected prepared OpenClaw control-session smoke configuration.');
		}
		return await startE2eControllerRuntime({
			secrets: {
				GITHUB_TOKEN: 'unused-control-session-smoke-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-control-session-smoke-perplexity-token',
			},
			startGatewayZone: async (startGatewayOptions) => {
				const result = await startGatewayZone(startGatewayOptions);
				if (result.executionModel !== 'managed-gateway') {
					throw new Error('OpenClaw control-link proof requires managed Gateway image boot.');
				}
				const qemuPid = result.vm.getHostProcessId();
				if (qemuPid === null) {
					throw new Error('Managed Gateway start omitted its host QEMU pid.');
				}
				gatewayStarts.push({ qemuPid, result, vmId: result.vm.id });
				gatewayStart = result;
				return result;
			},
			startOptions: {
				systemConfig: activeSystemConfig,
				zoneIds: [systemZone.id],
			},
		});
	};

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: [agentId],
			architecture,
			prefix: 'openclaw-control-session-e2e-',
			zoneId,
		});
		systemConfig = {
			...project.systemConfig,
			controller: {
				health: {
					...project.systemConfig.controller?.health,
					controlSessionDeathGraceMs: 30_000,
					enabled: true,
					eventHistoryLimit: 100,
					gatewayServiceIntervalMs: 1_000,
					gatewayServiceAutoRestart: {
						...smokeGatewayServiceAutoRestart,
					},
					staleAfterMs: 20_000,
				},
			},
		};
		const loadedSystemConfig = systemConfig;
		const systemZone = loadedSystemConfig.zones[0];
		if (!systemZone || systemZone.gateway.type !== 'openclaw') {
			throw new Error(
				'Expected OpenClaw control-session smoke project to contain an OpenClaw zone.',
			);
		}
		await disableOpenClawMcpPortalPlugin(systemZone.gateway.config);
		await fs.mkdir(path.join(systemZone.gateway.zoneFilesDir, 'agents', agentId), {
			recursive: true,
		});
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
		harness = await startControlLinkHarness();
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

	it('records control-session and gateway-service health through a real OpenClaw zone', async () => {
		if (
			gatewayStart === undefined ||
			harness === undefined ||
			project === undefined ||
			systemConfig === undefined
		) {
			throw new Error('Expected OpenClaw control-session smoke harness to be initialized.');
		}
		const openClawZone = systemConfig.zones[0];
		if (!openClawZone || openClawZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw zone config.');
		}

		const gatewayServiceEvent = await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'gateway-service-health ok',
			matches: (event) => event.kind === 'gateway-service-health' && event.result === 'ok',
			controllerRuntimeDir: harness.systemConfig.controllerRuntimeDir,
			timeoutMs: 60_000,
		});
		expect(gatewayServiceEvent).toMatchObject({ kind: 'gateway-service-health', result: 'ok' });

		const gatewayControlSessionEvent = await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'gateway-control-session ok',
			matches: (event) => event.kind === 'gateway-control-session' && event.result === 'ok',
			controllerRuntimeDir: harness.systemConfig.controllerRuntimeDir,
			timeoutMs: 60_000,
		});
		expect(gatewayControlSessionEvent).toMatchObject({
			kind: 'gateway-control-session',
			operation: 'control-session-heartbeat',
			result: 'ok',
		});
	});

	it('contains the predecessor and replaces the whole Gateway VM after fatal framework exit', async () => {
		if (gatewayStart === undefined || harness === undefined) {
			throw new Error('Expected OpenClaw control-session smoke harness to be initialized.');
		}
		const predecessor = gatewayStarts.at(-1);
		if (predecessor === undefined || predecessor.result.controlSession === undefined) {
			throw new Error('Expected an accepted managed Gateway predecessor control session.');
		}
		const initialGatewayVmId = predecessor.vmId;
		const gatewayStartCountBeforeCrash = gatewayStarts.length;
		const predecessorControlSession = predecessor.result.controlSession;
		const frameworkIdentity = await readManagedGatewaySiblingProcessIdentity({
			gatewayVm: predecessor.result.vm,
			guestPort: predecessor.result.expectedCohort.ingressIntent.frameworkRootRoute.guestPort,
			role: 'framework',
		});
		await terminateManagedGatewaySibling({
			gatewayVm: predecessor.result.vm,
			identity: frameworkIdentity,
			role: 'framework',
		});

		const recoveryEvent = await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'whole-Gateway-VM recovery after fatal framework exit',
			matches: (event) =>
				event.kind === 'gateway-recovery' &&
				event.result === 'ok' &&
				event.oldVmId === initialGatewayVmId,
			controllerRuntimeDir: harness.systemConfig.controllerRuntimeDir,
			timeoutMs: 300_000,
		});
		const successor = await waitForSuccessorGatewayStart({
			gatewayStarts,
			predecessor,
			timeoutMs: 120_000,
		});

		expect(predecessorControlSession.getDiagnostics()).toMatchObject({
			accepted: false,
			connected: false,
			ready: false,
		});
		expect(successor.result.controlSession).not.toBe(predecessorControlSession);
		expect(successor.result.controlSession?.getDiagnostics()).toMatchObject({
			accepted: true,
			connected: true,
			lastHelloResponse: { outcome: 'accepted' },
			ready: true,
			transportName: 'websocket',
		});
		expect(recoveryEvent).toMatchObject({
			kind: 'gateway-recovery',
			newVmId: successor.vmId,
			oldVmId: initialGatewayVmId,
			result: 'ok',
			zoneId,
		});
		expect(gatewayStarts).toHaveLength(gatewayStartCountBeforeCrash + 1);
		expect(successor.vmId).not.toBe(initialGatewayVmId);
		expect(successor.result.vm).not.toBe(predecessor.result.vm);
		expect(isProcessAbsent(predecessor.qemuPid)).toBe(true);
		expect(predecessor.result.expectedCohort.fence.vmId).toBe(initialGatewayVmId);
		expect(successor.result.expectedCohort.fence.vmId).toBe(successor.vmId);
		expect(successor.result.expectedCohort.fence.gatewayEpoch).not.toBe(
			predecessor.result.expectedCohort.fence.gatewayEpoch,
		);
		expect(successor.result.expectedCohort.controlIdentity.generationId).not.toBe(
			predecessor.result.expectedCohort.controlIdentity.generationId,
		);
		expect(successor.result.expectedCohort.controlIdentity.processEpoch).not.toBe(
			predecessor.result.expectedCohort.controlIdentity.processEpoch,
		);
		expect(successor.result.expectedCohort.frameworkIdentity.frameworkEpoch).not.toBe(
			predecessor.result.expectedCohort.frameworkIdentity.frameworkEpoch,
		);
	});

	it('does not replace a hung framework while its current control attachment remains healthy', async () => {
		if (
			gatewayStart === undefined ||
			harness === undefined ||
			project === undefined ||
			systemConfig === undefined
		) {
			throw new Error('Expected OpenClaw control-session smoke harness to be initialized.');
		}
		await harness.close({ preserveTempRoot: true });
		gatewayStarts.length = 0;
		gatewayStart = undefined;
		systemConfig = {
			...systemConfig,
			controllerStateDir: path.join(project.tempRoot, 'controller-state-service-recovery'),
			controllerRuntimeDir: path.join(project.tempRoot, 'controller-runtime-service-recovery'),
		};
		harness = await startControlLinkHarness();
		const predecessor = gatewayStarts.at(-1);
		if (predecessor === undefined) {
			throw new Error('Expected a managed Gateway predecessor.');
		}
		await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'gateway-service-health readiness before framework hang',
			matches: (event) => event.kind === 'gateway-service-health' && event.result === 'ok',
			controllerRuntimeDir: harness.systemConfig.controllerRuntimeDir,
			timeoutMs: 60_000,
		});
		const initialGatewayVmId = predecessor.vmId;
		const stopResult = await predecessor.result.vm.exec(`
set -eu
port_hex="$(printf '%04X' ${String(predecessor.result.expectedCohort.ingressIntent.frameworkRootRoute.guestPort)})"
socket_inode="$(awk -v port=":$port_hex" '$2 ~ port && $4 == "0A" { print $10; exit }' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)"
process_id=""
if [ -n "$socket_inode" ]; then
  for fd in /proc/[0-9]*/fd/*; do
    target="$(readlink "$fd" 2>/dev/null || true)"
    if [ "$target" = "socket:[$socket_inode]" ]; then
      process_id="$(echo "$fd" | cut -d / -f 3)"
      break
    fi
  done
fi
test -n "$process_id"
observed_start_identity="$(sed -E 's/^[0-9]+ \\(.*\\) //' "/proc/$process_id/stat" | awk '{ print $20 }')"
kill -STOP "$process_id"
printf '%s %s\\n' "$process_id" "$observed_start_identity"
`);
		expect(stopResult.exitCode, stopResult.stderr).toBe(0);
		const [stoppedProcessIdText, stoppedProcessStartIdentity] = stopResult.stdout
			.trim()
			.split(/\s+/u);
		const stoppedProcessId = Number(stoppedProcessIdText);
		if (
			!Number.isSafeInteger(stoppedProcessId) ||
			stoppedProcessId <= 0 ||
			stoppedProcessStartIdentity === undefined ||
			!/^\d+$/u.test(stoppedProcessStartIdentity)
		) {
			throw new Error(`Stopped OpenClaw framework identity was invalid: ${stopResult.stdout}`);
		}
		const serviceFailures = await waitForGatewayServiceFailureCount({
			expectedCount: smokeGatewayServiceAutoRestart.consecutiveFailureThreshold,
			controllerRuntimeDir: harness.systemConfig.controllerRuntimeDir,
			timeoutMs: 60_000,
		});
		const healthEvents = (
			await readDurableHealthEvents({
				controllerRuntimeDir: harness.systemConfig.controllerRuntimeDir,
			})
		).map((record) => record.body);
		expect(
			healthEvents.some(
				(event) => event.kind === 'gateway-recovery' && event.oldVmId === initialGatewayVmId,
			),
		).toBe(false);
		expect(predecessor.result.controlSession?.getDiagnostics()).toMatchObject({
			accepted: true,
			connected: true,
			ready: true,
		});
		expect(gatewayStarts).toHaveLength(1);
		expect(predecessor.result.vm.getHostProcessId()).toBe(predecessor.qemuPid);

		const resumeResult = await predecessor.result.vm.exec(`
set -eu
process_id=${String(stoppedProcessId)}
expected_start_identity=${stoppedProcessStartIdentity}
observed_start_identity="$(sed -E 's/^[0-9]+ \\(.*\\) //' "/proc/$process_id/stat" | awk '{ print $20 }')"
test "$observed_start_identity" = "$expected_start_identity"
kill -CONT "$process_id"
printf '%s %s\\n' "$process_id" "$observed_start_identity"
`);
		expect(resumeResult.exitCode, resumeResult.stderr).toBe(0);
		const lastFailure = serviceFailures.at(-1);
		if (lastFailure === undefined) throw new Error('Expected repeated Gateway service failures.');
		await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'gateway-service-health recovery after framework resume',
			matches: (event) =>
				event.kind === 'gateway-service-health' &&
				event.result === 'ok' &&
				event.observedAtMs > lastFailure.observedAtMs,
			controllerRuntimeDir: harness.systemConfig.controllerRuntimeDir,
			timeoutMs: 60_000,
		});
		expect(gatewayStarts).toHaveLength(1);
		expect(gatewayStarts[0]?.vmId).toBe(initialGatewayVmId);
	});
});
