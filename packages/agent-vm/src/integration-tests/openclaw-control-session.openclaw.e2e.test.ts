/* oxlint-disable eslint/no-await-in-loop -- E2E probes are sequential against one live OpenClaw VM. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import {
	CONTROL_PROTOCOL_VERSION,
	ControlEnvelopeSchema,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlRpcCommandResultMessageSchema,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';

const architecture = currentE2eArchitecture();
const runOpenClawControlSession =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeOpenClawControlSession = runOpenClawControlSession ? describe : describe.skip;
const agentId = 'control-session';
const gatewayToken = 'openclaw-control-session-gateway-token';
const zoneId = 'openclaw-control-session';
const gatewayControlPath = '/__agent-vm/gateway-control';

function waitForNodeEvent(emitter: NodeJS.EventEmitter, eventName: string): Promise<void> {
	return new Promise((resolve) => {
		emitter.once(eventName, () => resolve());
	});
}

async function readRawGatewayControlUpgradeResponse(options: {
	readonly host: string;
	readonly port: number;
	readonly query?: string;
}): Promise<string> {
	const query = options.query ?? 'EIO=4&transport=websocket';
	const socket = net.connect({ host: options.host, port: options.port });
	socket.setEncoding('utf8');
	await waitForNodeEvent(socket, 'connect');
	socket.write(
		[
			`GET ${gatewayControlPath}?${query} HTTP/1.1`,
			`Host: ${options.host}:${String(options.port)}`,
			'Connection: Upgrade',
			'Upgrade: websocket',
			'Sec-WebSocket-Version: 13',
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
			'\r\n',
		].join('\r\n'),
	);
	let response = '';
	socket.on('data', (chunk) => {
		response += chunk;
	});
	await waitForNodeEvent(socket, 'close');
	return response;
}

async function restartOpenClawGatewayProcess(gatewayVm: ManagedVm): Promise<void> {
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
if [ -z "$gateway_pid" ]; then
  echo "no openclaw gateway process found" >&2
  exit 1
fi
kill -KILL "$gateway_pid"
for _attempt in $(seq 1 90); do
  readyz_code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/readyz 2>/dev/null || true)"
  if [ "$readyz_code" = "200" ] && grep -q 'gateway-supervisor: starting openclaw gateway attempt=2' /agent-vm/logs/gateway-boot-latest.log; then
    echo "supervisor restarted openclaw gateway after pid $gateway_pid"
    exit 0
  fi
  sleep 1
done
echo "openclaw gateway did not restart after killing pid $gateway_pid" >&2
tail -n 80 /agent-vm/logs/gateway-boot-latest.log >&2 || true
exit 1
`);
	if (result.exitCode !== 0) {
		throw new Error(
			`OpenClaw gateway process restart failed with exit ${String(result.exitCode)}.\nstdout:\n${
				result.stdout
			}\nstderr:\n${result.stderr}`,
		);
	}
}

async function sendControllerOriginatedGatewayControlPing(options: {
	readonly gatewayStart: Awaited<ReturnType<typeof startGatewayZone>>;
	readonly sequence: number;
}): Promise<{
	readonly requestMessageId: string;
	readonly response: unknown;
}> {
	const controlSession = options.gatewayStart.controlSession;
	const recoverySourceKey = options.gatewayStart.controlSessionRecoverySourceKey;
	if (controlSession === undefined || recoverySourceKey === undefined) {
		throw new Error('Expected OpenClaw gateway start to expose a control session.');
	}
	const diagnostics = controlSession.getDiagnostics();
	const helloResponse = diagnostics.lastHelloResponse;
	if (helloResponse === undefined || helloResponse.outcome !== 'accepted') {
		throw new Error(
			`Expected accepted control-session hello before sending controller control_ping: ${JSON.stringify(diagnostics)}`,
		);
	}
	const envelope: ControlEnvelope = ControlEnvelopeSchema.parse({
		bootId: recoverySourceKey.bootId,
		connectionId: helloResponse.connectionId,
		controllerEpoch: helloResponse.controllerEpoch,
		createdAtMs: Date.now(),
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation.control_ping,
		domain: 'gateway_control',
		kind: 'command',
		messageId: randomUUID(),
		operation: 'control_ping',
		peerId: `gateway-${recoverySourceKey.zoneId}`,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: options.sequence,
		sessionId: helloResponse.sessionId,
		zoneId: recoverySourceKey.zoneId,
	});
	return {
		requestMessageId: envelope.messageId,
		response: await controlSession.emitApplicationMessage(
			envelope,
			{ kind: 'command', operation: 'control_ping' },
			{
				kind: 'command',
				operation: 'control_ping',
				payload: {},
			},
		),
	};
}

async function waitForControlSessionReconnected(options: {
	readonly controlSession: NonNullable<
		Awaited<ReturnType<typeof startGatewayZone>>['controlSession']
	>;
	readonly minimumHelloCount: number;
	readonly timeoutMs: number;
}): Promise<void> {
	const deadlineMs = Date.now() + options.timeoutMs;
	while (Date.now() < deadlineMs) {
		const diagnostics = options.controlSession.getDiagnostics();
		if (
			diagnostics.connected &&
			diagnostics.helloCount >= options.minimumHelloCount &&
			diagnostics.lastHelloResponse?.outcome === 'accepted' &&
			diagnostics.transportName === 'websocket'
		) {
			return;
		}
		await waitForProtocolRetryInterval(1_000);
	}
	throw new Error(
		`Timed out waiting for control-session accepted reconnect hello count >= ${String(options.minimumHelloCount)}; diagnostics: ${JSON.stringify(options.controlSession.getDiagnostics())}`,
	);
}

describeOpenClawControlSession(
	'e2e: OpenClaw private control session over Gondolin ingress',
	() => {
		let harness: E2eHarnessRuntime | undefined;
		let project: OpenClawE2eProject | undefined;
		let gatewayStart: Awaited<ReturnType<typeof startGatewayZone>> | undefined;

		beforeAll(async () => {
			const repoRoot = path.resolve(process.cwd());
			project = await scaffoldOpenClawE2eProject({
				agents: [agentId],
				architecture,
				prefix: 'openclaw-control-session-e2e-',
				zoneId,
			});
			const systemZone = project.systemConfig.zones[0];
			if (!systemZone || systemZone.gateway.type !== 'openclaw') {
				throw new Error('Expected OpenClaw control-session project to contain an OpenClaw zone.');
			}
			await disableOpenClawMcpPortalPlugin(systemZone.gateway.config);
			await fs.mkdir(path.join(systemZone.gateway.zoneFilesDir, 'agents', agentId), {
				recursive: true,
			});
			await useLocalOpenClawPluginGatewayImage({
				profileName: systemZone.gateway.imageProfile,
				projectRoot: project.tempRoot,
				repoRoot,
				systemConfig: project.systemConfig,
			});
			await prepareGatewayE2eProjectImages({ project });
			harness = await startE2eControllerRuntime({
				secrets: {
					GITHUB_TOKEN: 'unused-openclaw-control-session-token',
					OPENCLAW_GATEWAY_TOKEN: gatewayToken,
					PERPLEXITY_API_KEY: 'unused-openclaw-control-session-perplexity-token',
				},
				startGatewayZone: async (startGatewayOptions) => {
					const result = await startGatewayZone(startGatewayOptions);
					gatewayStart = result;
					return result;
				},
				startOptions: {
					systemConfig: project.systemConfig,
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

		it('rejects bad upgrades before 101, connects websocket-only, and reconnects after gateway flap', async () => {
			if (gatewayStart?.controlSession === undefined || harness === undefined) {
				throw new Error('Expected OpenClaw control-session harness to be initialized.');
			}
			const badUpgradeResponse = await readRawGatewayControlUpgradeResponse({
				host: gatewayStart.ingress.host,
				port: gatewayStart.ingress.port,
			});
			expect(badUpgradeResponse).toMatch(/^HTTP\/1\.1 400 Bad Request/u);
			expect(badUpgradeResponse).not.toContain('101 Switching Protocols');

			const queryCredentialResponse = await readRawGatewayControlUpgradeResponse({
				host: gatewayStart.ingress.host,
				port: gatewayStart.ingress.port,
				query: 'EIO=4&transport=websocket&x-agent-vm-control-signature=leak',
			});
			expect(queryCredentialResponse).toMatch(/^HTTP\/1\.1 400 Bad Request/u);
			expect(queryCredentialResponse).not.toContain('101 Switching Protocols');

			const connectedDiagnostics = gatewayStart.controlSession.getDiagnostics();
			expect(connectedDiagnostics).toMatchObject({
				connected: true,
				endpointPath: gatewayControlPath,
				transportName: 'websocket',
			});
			expect(connectedDiagnostics.helloCount).toBeGreaterThanOrEqual(1);

			const helloCountBeforeFlap = connectedDiagnostics.helloCount;
			await restartOpenClawGatewayProcess(gatewayStart.vm);
			await waitForControlSessionReconnected({
				controlSession: gatewayStart.controlSession,
				minimumHelloCount: helloCountBeforeFlap + 1,
				timeoutMs: 120_000,
			});

			const reconnectDiagnostics = gatewayStart.controlSession.getDiagnostics();
			expect(reconnectDiagnostics).toMatchObject({
				connected: true,
				endpointPath: gatewayControlPath,
				transportName: 'websocket',
			});
			expect(reconnectDiagnostics.helloCount).toBeGreaterThan(helloCountBeforeFlap);
			expect(reconnectDiagnostics.lastHelloResponse).toMatchObject({
				outcome: 'accepted',
			});

			const pingResult = await sendControllerOriginatedGatewayControlPing({
				gatewayStart,
				sequence: 1,
			});
			const pingResponse = GatewayControlRpcCommandResultMessageSchema.parse(pingResult.response);
			expect(pingResponse).toMatchObject({
				kind: 'command_result',
				operation: 'control_ping',
				payload: {
					responseToMessageId: pingResult.requestMessageId,
					result: 'ok',
				},
			});
		});
	},
);
