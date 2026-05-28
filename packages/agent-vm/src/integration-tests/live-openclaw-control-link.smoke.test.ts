/* oxlint-disable eslint/no-await-in-loop -- E2E smoke steps are sequential against live VMs */
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	createToolVmActiveUseId,
	type AgentVmHealthEvent,
	type ZoneHealthSnapshot,
} from '@agent-vm/gateway-interface';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import {
	buildOpenClawRuntimeStatusReport,
	createLeaseClient,
} from '@agent-vm/openclaw-agent-vm-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBuildCommand } from '../cli/build-command.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import {
	canRunGondolinSmoke,
	currentSmokeArchitecture,
	disableOpenClawMcpPortalPlugin,
	rebuildWorkspacePackages,
	removeSmokeTempRoot,
	scaffoldOpenClawSmokeProject,
	startSmokeControllerRuntime,
	type OpenClawSmokeProject,
	type SmokeHarnessRuntime,
	useLocalOpenClawPluginGatewayImage,
} from './smoke-harness.js';

const architecture = currentSmokeArchitecture();
const runOpenClawControlLinkSmoke =
	process.env.AGENT_VM_OPENCLAW_SMOKE === '1' && (await canRunGondolinSmoke({ architecture }));
const describeOpenClawControlLinkSmoke = runOpenClawControlLinkSmoke ? describe : describe.skip;
const agentId = 'smoke';
const gatewayToken = 'control-link-smoke-gateway-token';
const zoneId = 'control-link-smoke';
const boundedProbePrefix = 'AGENT_VM_CONTROL_LINK_BOUNDED_PROBE ';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function latestEvents(snapshot: ZoneHealthSnapshot): readonly AgentVmHealthEvent[] {
	return 'latestEvents' in snapshot ? snapshot.latestEvents : [];
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
	readonly timeoutMs: number;
}): Promise<AgentVmHealthEvent> {
	const deadline = Date.now() + options.timeoutMs;
	let lastSnapshot: ZoneHealthSnapshot | undefined;
	while (Date.now() < deadline) {
		lastSnapshot = await readHealthSnapshot(options.controllerUrl);
		const event = latestEvents(lastSnapshot).find(options.matches);
		if (event !== undefined) {
			return event;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(
		`Timed out waiting for ${options.describeEvent}; last snapshot: ${JSON.stringify(lastSnapshot)}`,
	);
}

async function publishOpenClawRuntimeStatus(options: {
	readonly controllerUrl: string;
	readonly openClawConfigPath: string;
}): Promise<void> {
	const parsedConfig: unknown = JSON.parse(await fs.readFile(options.openClawConfigPath, 'utf8'));
	if (!isObjectRecord(parsedConfig)) {
		throw new Error(`Expected OpenClaw smoke config at ${options.openClawConfigPath}.`);
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
		},
	);
	if (!response.ok) {
		throw new Error(
			`OpenClaw runtime status publish failed HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
}

async function runToolVmSshSmoke(options: {
	readonly gatewayVm: ManagedVm;
	readonly host: string;
	readonly identityPem: string;
	readonly port: number;
	readonly user: string;
}): Promise<string> {
	const command = `set -eu
cat >/tmp/agent-vm-control-link-smoke-key.pem <<'EOF'
${options.identityPem}
EOF
chmod 600 /tmp/agent-vm-control-link-smoke-key.pem
ssh -i /tmp/agent-vm-control-link-smoke-key.pem \\
	-o UserKnownHostsFile=/dev/null \\
	-o StrictHostKeyChecking=no \\
	-o BatchMode=yes \\
	-p ${shellSingleQuote(String(options.port))} \\
	${shellSingleQuote(`${options.user}@${options.host}`)} \\
	'cd /work && printf "TOOL_VM_SSH_OK "; pwd; test -d /work'`;
	const result = await options.gatewayVm.exec(command);
	if (result.exitCode !== 0) {
		throw new Error(
			`Tool VM SSH smoke failed with exit ${String(result.exitCode)}.\nstdout:\n${
				result.stdout
			}\nstderr:\n${result.stderr}`,
		);
	}
	return result.stdout;
}

async function runBoundedControllerRequestProbe(gatewayVm: ManagedVm): Promise<{
	readonly elapsedMs: number;
	readonly errorCode: string;
	readonly logLines: readonly string[];
}> {
	const command = `set -eu
node --input-type=module <<'NODE'
const {
	createGatewayControlLinkMonitor,
	fetchControllerWithPolicy,
} = await import('/home/openclaw/.openclaw/extensions/gondolin/index.js');

const timeoutMs = 500;
const startedAtMs = Date.now();
let errorCode = 'missing-error';
try {
	await fetchControllerWithPolicy({
		fetchImpl: (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
			}),
		input: 'http://controller.vm.host:18800/health',
		operation: 'controller-health',
		policy: {
			idempotency: 'read',
			maxAttempts: 1,
			retryBaseDelayMs: 0,
			retryEnabled: false,
			retryStatuses: [],
			timeoutMs,
		},
	});
} catch (error) {
	errorCode = error?.code ?? error?.constructor?.name ?? 'unknown-error';
}
const logLines = [];
const monitor = createGatewayControlLinkMonitor({
	baseIntervalMs: 1000,
	controllerUrl: 'http://127.0.0.1:1',
	fetchImpl: async (input) => {
		if (String(input).endsWith('/health')) {
			return new Response('ok', { status: 200 });
		}
		throw new Error('synthetic publish failure');
	},
	maxIntervalMs: 1000,
	now: () => Date.now(),
	writeLog: (message) => logLines.push(message),
	zoneId: '${zoneId}',
});
await monitor.tick();
console.log('${boundedProbePrefix}' + JSON.stringify({
	elapsedMs: Date.now() - startedAtMs,
	errorCode,
	logLines,
}));
NODE`;
	const result = await gatewayVm.exec(command);
	if (result.exitCode !== 0) {
		throw new Error(
			`Bounded controller request probe failed with exit ${String(result.exitCode)}.\nstdout:\n${
				result.stdout
			}\nstderr:\n${result.stderr}`,
		);
	}
	const resultLine = result.stdout.split('\n').find((line) => line.startsWith(boundedProbePrefix));
	if (resultLine === undefined) {
		throw new Error(`Bounded controller request probe did not emit ${boundedProbePrefix.trim()}.`);
	}
	const parsed: unknown = JSON.parse(resultLine.slice(boundedProbePrefix.length));
	if (
		!isObjectRecord(parsed) ||
		typeof parsed.elapsedMs !== 'number' ||
		typeof parsed.errorCode !== 'string' ||
		!Array.isArray(parsed.logLines) ||
		!parsed.logLines.every((line) => typeof line === 'string')
	) {
		throw new Error(`Unexpected bounded probe result: ${JSON.stringify(parsed)}`);
	}
	return {
		elapsedMs: parsed.elapsedMs,
		errorCode: parsed.errorCode,
		logLines: parsed.logLines,
	};
}

describeOpenClawControlLinkSmoke('smoke: OpenClaw agent-vm controller control link', () => {
	let harness: SmokeHarnessRuntime | undefined;
	let project: OpenClawSmokeProject | undefined;
	let systemConfig: SmokeHarnessRuntime['systemConfig'] | undefined;
	let gatewayVm: ManagedVm | undefined;
	const gatewayStarts: ManagedVm[] = [];

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		rebuildWorkspacePackages(repoRoot);
		project = await scaffoldOpenClawSmokeProject({
			agents: [agentId],
			architecture,
			prefix: 'openclaw-control-link-smoke-',
			zoneId,
		});
		systemConfig = {
			...project.systemConfig,
			controller: {
				health: {
					...project.systemConfig.controller?.health,
					enabled: true,
					eventHistoryLimit: 100,
					gatewayControlLinkBackoffCeilingMs: 2_000,
					gatewayControlLinkIntervalMs: 1_000,
					gatewayServiceIntervalMs: 1_000,
					gatewayServiceAutoRestart: {
						cooldownMs: 61 * 60 * 1000,
						consecutiveFailureThreshold: 2,
						enabled: true,
						restartTimeoutMs: 120_000,
					},
					staleAfterMs: 20_000,
				},
			},
		};
		const systemZone = systemConfig.zones[0];
		if (!systemZone || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw control-link smoke project to contain an OpenClaw zone.');
		}
		await disableOpenClawMcpPortalPlugin(systemZone.gateway.config);
		await fs.mkdir(path.join(systemZone.gateway.zoneFilesDir, 'agents', agentId), {
			recursive: true,
		});
		await useLocalOpenClawPluginGatewayImage({
			profileName: systemZone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig,
		});
		await runBuildCommand({
			forceRebuild: true,
			systemConfig,
		});
		harness = await startSmokeControllerRuntime({
			secrets: {
				GITHUB_TOKEN: 'unused-control-link-smoke-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-control-link-smoke-perplexity-token',
			},
			startGatewayZone: async (startGatewayOptions) => {
				const result = await startGatewayZone(startGatewayOptions);
				gatewayStarts.push(result.vm);
				gatewayVm = result.vm;
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
				systemConfig,
				zoneIds: [systemZone.id],
			},
		});
	}, 900_000);

	afterAll(async () => {
		try {
			await harness?.close();
		} finally {
			if (project) {
				await removeSmokeTempRoot(project.tempRoot);
			}
		}
	});

	it('records control-link, gateway-service, lease, and Tool VM SSH health through a real OpenClaw zone', async () => {
		if (
			gatewayVm === undefined ||
			harness === undefined ||
			project === undefined ||
			systemConfig === undefined
		) {
			throw new Error('Expected OpenClaw control-link smoke harness to be initialized.');
		}
		const openClawZone = systemConfig.zones[0];
		if (!openClawZone || openClawZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw zone config.');
		}

		const gatewayServiceEvent = await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'gateway-service-health ok',
			matches: (event) => event.kind === 'gateway-service-health' && event.result === 'ok',
			timeoutMs: 60_000,
		});
		expect(gatewayServiceEvent).toMatchObject({ kind: 'gateway-service-health', result: 'ok' });

		const gatewayControlLinkEvent = await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'gateway-control-link ok',
			matches: (event) => event.kind === 'gateway-control-link' && event.result === 'ok',
			timeoutMs: 60_000,
		});
		expect(gatewayControlLinkEvent).toMatchObject({
			controllerHost: 'controller.vm.host',
			kind: 'gateway-control-link',
			operation: 'controller-health',
			result: 'ok',
		});

		await publishOpenClawRuntimeStatus({
			controllerUrl: harness.controllerUrl,
			openClawConfigPath: openClawZone.gateway.config,
		});
		const leaseClient = createLeaseClient({ controllerUrl: harness.controllerUrl });
		const lease = await leaseClient.requestLease({
			agentId,
			agentWorkspaceDir: '/zone/agents/smoke',
			profileId: 'standard',
			sessionKey: `agent:${agentId}:control-link-smoke`,
			workMountDir: '/zone/agents/smoke',
			zoneId,
		});
		const useId = createToolVmActiveUseId();
		await leaseClient.startActiveUse(lease.leaseId, {
			report: {
				observedAtMs: Date.now(),
				phase: 'starting',
			},
			useId,
		});
		await leaseClient.heartbeatActiveUse(lease.leaseId, useId, {
			report: {
				observedAtMs: Date.now(),
				phase: 'running',
			},
		});
		await leaseClient.renewLease(lease.leaseId);

		const sshOutput = await runToolVmSshSmoke({
			gatewayVm,
			host: lease.ssh.host,
			identityPem: lease.ssh.identityPem,
			port: lease.ssh.port,
			user: lease.ssh.user,
		});
		expect(sshOutput).toContain('TOOL_VM_SSH_OK /work');

		await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'lease-heartbeat ok',
			matches: (event) =>
				event.kind === 'lease-heartbeat' &&
				event.leaseId === lease.leaseId &&
				event.useId === useId &&
				event.result === 'ok',
			timeoutMs: 30_000,
		});
		await waitForHealthEvent({
			controllerUrl: harness.controllerUrl,
			describeEvent: 'lease-renew ok',
			matches: (event) =>
				event.kind === 'lease-renew' && event.leaseId === lease.leaseId && event.result === 'ok',
			timeoutMs: 30_000,
		});

		const boundedProbe = await runBoundedControllerRequestProbe(gatewayVm);
		expect(boundedProbe.errorCode).toBe('controller-request-timeout');
		expect(boundedProbe.elapsedMs).toBeLessThan(5_000);
		expect(boundedProbe.logLines.join('\n')).toContain('gateway-control-link publish failed');
	});

	it('auto restarts the live OpenClaw gateway VM after repeated gateway-service failures', async () => {
		if (gatewayVm === undefined || harness === undefined) {
			throw new Error('Expected OpenClaw control-link smoke harness to be initialized.');
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
			timeoutMs: 180_000,
		});

		expect(recoveryEvent).toMatchObject({
			kind: 'gateway-recovery',
			oldVmId: initialGatewayVmId,
			result: 'ok',
			zoneId,
		});
		if (recoveryEvent.kind !== 'gateway-recovery') {
			throw new Error('Expected gateway-recovery event.');
		}
		expect(gatewayStarts.map((startedGatewayVm) => startedGatewayVm.id)).toContain(
			recoveryEvent.newVmId,
		);
		expect(recoveryEvent.newVmId).not.toBe(initialGatewayVmId);
	});
});
