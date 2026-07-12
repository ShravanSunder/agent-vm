/* oxlint-disable eslint/no-await-in-loop -- E2E steps are sequential against live VMs */
import fs, { watch } from 'node:fs/promises';
import path from 'node:path';

import type { AgentVmHealthEvent, ZoneHealthSnapshot } from '@agent-vm/gateway-lifecycle';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	controllerHealthEventLogPath,
	readDurableHealthEvents,
} from '../controller/health/durable-health-event-log.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type {
	OpenClawGatewayProcessEpochBinding,
	OpenClawGatewayProcessEpochOwner,
} from '../gateway/openclaw-gateway-process-epoch-owner.js';
import {
	canRunGondolinE2e,
	currentE2eArchitecture,
	disableOpenClawMcpPortalPlugin,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	startE2eControllerRuntime,
	type OpenClawE2eProject,
	type E2eHarnessRuntime,
	useLocalOpenClawPluginGatewayImage,
	useLocalToolVmMcpPortalPackage,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';

const architecture = currentE2eArchitecture();
const runOpenClawControlLinkSmoke =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeOpenClawControlLinkSmoke = runOpenClawControlLinkSmoke ? describe : describe.skip;
const agentId = 'smoke';
const gatewayToken = 'control-session-smoke-gateway-token';
const zoneId = 'control-session-smoke';
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
	readonly runtimeDir: string;
	readonly timeoutMs: number;
}): Promise<AgentVmHealthEvent> {
	const eventLogPath = controllerHealthEventLogPath(options.runtimeDir);
	await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
	await fs.appendFile(eventLogPath, '', 'utf8');
	const watcher = watch(eventLogPath, { persistent: false });
	const deadlineMs = Date.now() + options.timeoutMs;
	try {
		while (true) {
			const nextLogChange = watcher.next();
			const event = (await readDurableHealthEvents({ runtimeDir: options.runtimeDir }))
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

async function waitForSuccessorProcessBinding(options: {
	readonly previousBinding: OpenClawGatewayProcessEpochBinding;
	readonly processEpochOwner: OpenClawGatewayProcessEpochOwner;
	readonly timeoutMs: number;
}): Promise<OpenClawGatewayProcessEpochBinding> {
	const deadlineMs = Date.now() + options.timeoutMs;
	while (Date.now() < deadlineMs) {
		const currentBinding = options.processEpochOwner.getCurrentBinding();
		const diagnostics = currentBinding.controlSession.getDiagnostics();
		if (
			currentBinding.material.processEpoch !== options.previousBinding.material.processEpoch &&
			currentBinding.controlSession !== options.previousBinding.controlSession &&
			diagnostics.accepted &&
			diagnostics.connected &&
			diagnostics.ready &&
			diagnostics.lastHelloResponse?.outcome === 'accepted' &&
			diagnostics.transportName === 'websocket'
		) {
			return currentBinding;
		}
		await waitForProtocolRetryInterval(1_000);
	}
	const currentBinding = options.processEpochOwner.getCurrentBinding();
	throw new Error(
		`Timed out waiting for a distinct accepted OpenClaw process binding after '${options.previousBinding.material.processEpoch}'; current process '${currentBinding.material.processEpoch}', diagnostics: ${JSON.stringify(currentBinding.controlSession.getDiagnostics())}`,
	);
}

describeOpenClawControlLinkSmoke('smoke: OpenClaw agent-vm controller control session', () => {
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	let systemConfig: E2eHarnessRuntime['systemConfig'] | undefined;
	let gatewayVm: ManagedVm | undefined;
	let gatewayProcessEpochOwner: OpenClawGatewayProcessEpochOwner | undefined;
	const gatewayStarts: ManagedVm[] = [];

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
		harness = await startE2eControllerRuntime({
			secrets: {
				GITHUB_TOKEN: 'unused-control-session-smoke-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-control-session-smoke-perplexity-token',
			},
			startGatewayZone: async (startGatewayOptions) => {
				const result = await startGatewayZone(startGatewayOptions);
				gatewayStarts.push(result.vm);
				gatewayVm = result.vm;
				gatewayProcessEpochOwner = result.openClawProcessEpochOwner;
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

	it('records control-session and gateway-service health through a real OpenClaw zone', async () => {
		if (
			gatewayVm === undefined ||
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
			runtimeDir: harness.systemConfig.runtimeDir,
			timeoutMs: 60_000,
		});
		expect(gatewayServiceEvent).toMatchObject({ kind: 'gateway-service-health', result: 'ok' });

		const gatewayControlSessionEvent = await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'gateway-control-session ok',
			matches: (event) => event.kind === 'gateway-control-session' && event.result === 'ok',
			runtimeDir: harness.systemConfig.runtimeDir,
			timeoutMs: 60_000,
		});
		expect(gatewayControlSessionEvent).toMatchObject({
			kind: 'gateway-control-session',
			operation: 'control-session-heartbeat',
			result: 'ok',
		});
	});

	it('restarts the OpenClaw gateway process in the same VM after child process exit', async () => {
		if (gatewayVm === undefined || gatewayProcessEpochOwner === undefined) {
			throw new Error('Expected OpenClaw control-session smoke harness to be initialized.');
		}
		const initialGatewayVmId = gatewayVm.id;
		const gatewayStartCountBeforeCrash = gatewayStarts.length;
		const previousBinding = gatewayProcessEpochOwner.getCurrentBinding();
		const crashResult = await gatewayVm.exec(`
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
if [ -z "$gateway_pid" ]; then
  echo "no openclaw gateway process found" >&2
  exit 1
fi
kill -KILL "$gateway_pid"
echo "terminated openclaw gateway pid $gateway_pid"
`);
		expect(crashResult.exitCode, crashResult.stderr).toBe(0);
		expect(crashResult.stdout).toContain('terminated openclaw gateway pid');
		const successorBinding = await waitForSuccessorProcessBinding({
			previousBinding,
			processEpochOwner: gatewayProcessEpochOwner,
			timeoutMs: 120_000,
		});
		expect(previousBinding.controlSession.getDiagnostics()).toMatchObject({
			accepted: false,
			connected: false,
			ready: false,
		});
		expect(successorBinding.material.processEpoch).not.toBe(previousBinding.material.processEpoch);
		expect(successorBinding.controlSession).not.toBe(previousBinding.controlSession);
		expect(successorBinding.controlSession.getDiagnostics()).toMatchObject({
			accepted: true,
			connected: true,
			lastHelloResponse: { outcome: 'accepted' },
			ready: true,
			transportName: 'websocket',
		});
		expect(gatewayVm.id).toBe(initialGatewayVmId);
		expect(gatewayStarts).toHaveLength(gatewayStartCountBeforeCrash);
	});

	it('auto restarts the live OpenClaw gateway VM after repeated gateway-service failures', async () => {
		if (gatewayVm === undefined || harness === undefined) {
			throw new Error('Expected OpenClaw control-session smoke harness to be initialized.');
		}
		const initialGatewayVmId = gatewayVm.id;
		const killResult = await gatewayVm.exec(`
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
if [ -z "$gateway_pid" ]; then
  echo "no openclaw gateway process found" >&2
  exit 1
fi
kill -STOP "$gateway_pid"
readyz_code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/readyz 2>/dev/null || true)"
if [ "$readyz_code" != "000" ]; then
  echo "readyz still returned $readyz_code after stopping pid $gateway_pid" >&2
  exit 1
fi
echo "stopped openclaw gateway pid $gateway_pid"
`);
		expect(killResult.exitCode, killResult.stderr).toBe(0);

		const recoveryEvent = await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'gateway-recovery ok',
			matches: (event) =>
				event.kind === 'gateway-recovery' &&
				event.result === 'ok' &&
				event.oldVmId === initialGatewayVmId,
			runtimeDir: harness.systemConfig.runtimeDir,
			timeoutMs: 300_000,
		});

		expect(recoveryEvent).toMatchObject({
			kind: 'gateway-recovery',
			oldVmId: initialGatewayVmId,
			result: 'ok',
			zoneId,
		});
		if (recoveryEvent.kind !== 'gateway-recovery' || recoveryEvent.result !== 'ok') {
			throw new Error('Expected gateway-recovery event.');
		}
		expect(gatewayStarts.map((startedGatewayVm) => startedGatewayVm.id)).toContain(
			recoveryEvent.newVmId,
		);
		expect(recoveryEvent.newVmId).not.toBe(initialGatewayVmId);
	});
});
