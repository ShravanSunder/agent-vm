/* oxlint-disable eslint/no-await-in-loop -- E2E steps are sequential against live VMs */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { type AgentVmHealthEvent, type ZoneHealthSnapshot } from '@agent-vm/gateway-interface';
import { type ManagedVm } from '@agent-vm/gondolin-adapter';
import {
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_AGENT_ID_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SESSION_KEY_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER,
	testExports as toolVmWriteReadE2eToolTestExports,
} from '@agent-vm/openclaw-agent-vm-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ControlSessionClient } from '../controller/control-session/control-session-client.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import {
	canRunGondolinE2e,
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	startE2eControllerRuntime,
	type OpenClawE2eProject,
	type E2eHarnessRuntime,
	useLocalOpenClawGatewayImagePackages,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';

const architecture = currentE2eArchitecture();
const runOpenClawSubagentE2e =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeOpenClawSubagentE2e = runOpenClawSubagentE2e ? describe : describe.skip;
const mainAgentId = 'main';
const betaAgentId = 'beta';
const agentIds = [mainAgentId, betaAgentId] as const;
const gatewayToken = 'subagent-lease-smoke-gateway-token';
const zoneId = 'subagent-lease-smoke';
const toolVmWriteReadProbeKey = 'subagent-e2e-tool-vm-write-read-proof-key';
const toolVmWriteReadProbeSessionKey = 'agent:beta:tool-vm-write-read:e2e-configured-session';
const mockOpenAiPort = 18231;
const subagentE2eResultPrefix = 'AGENT_VM_SUBAGENT_E2E_RESULT ';
const defaultFlapCount = 3;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface OpenClawSubagentSpawnProbeResult {
	readonly agentResponse: unknown;
	readonly childSessionKey: string;
	readonly contextWorkspaceDir: string;
	readonly diagnostics?: OpenClawSubagentSpawnProbeDiagnostics;
	readonly error?: string;
	readonly historyResponse: unknown;
	readonly runId: string;
	readonly waitResponse: unknown;
	readonly status: 'accepted' | 'error';
}

interface OpenClawSubagentSpawnProbeDiagnostics {
	readonly gatewayErrLogTail?: string;
	readonly gatewayLogTail?: string;
	readonly mockOpenAiRequestLog?: string;
	readonly mockOpenAiServerLog?: string;
}

interface ObservedLeaseCreateRequest {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}

interface OpenClawToolVmWriteReadProbeResult {
	readonly agentId: string;
	readonly filePath: string;
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
	readonly sessionKey: string;
	readonly status: 'ok';
	readonly workdir: string;
}

interface OpenClawToolVmStaleReacquireProbeStepResult {
	readonly filePath: string;
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
}

interface OpenClawToolVmStaleReacquireProbeResult {
	readonly agentId: string;
	readonly first: OpenClawToolVmStaleReacquireProbeStepResult;
	readonly newRuntimeId: string;
	readonly oldRuntimeId: string;
	readonly sameHandle: true;
	readonly scenario: 'stale-reacquire';
	readonly second: OpenClawToolVmStaleReacquireProbeStepResult;
	readonly sessionKey: string;
	readonly staleTrigger: 'finalize-timeout';
	readonly status: 'ok';
	readonly workdir: string;
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function positiveIntegerFromEnv(envName: string, defaultValue: number): number {
	const rawValue = process.env[envName];
	if (rawValue === undefined || rawValue.length === 0) {
		return defaultValue;
	}
	const parsedValue = Number(rawValue);
	if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
		throw new Error(`${envName} must be a positive integer.`);
	}
	return parsedValue;
}

function parseSubagentSpawnProbeResult(stdout: string): OpenClawSubagentSpawnProbeResult {
	const resultLine = stdout.split('\n').find((line) => line.startsWith(subagentE2eResultPrefix));
	if (resultLine === undefined) {
		throw new Error(`OpenClaw subagent e2e did not emit ${subagentE2eResultPrefix.trim()}.`);
	}
	const parsed: unknown = JSON.parse(resultLine.slice(subagentE2eResultPrefix.length));
	if (!isObjectRecord(parsed)) {
		throw new Error('OpenClaw subagent e2e result was not a JSON object.');
	}
	if (
		(parsed.status !== 'accepted' && parsed.status !== 'error') ||
		typeof parsed.childSessionKey !== 'string' ||
		typeof parsed.runId !== 'string' ||
		(parsed.error !== undefined && typeof parsed.error !== 'string') ||
		!('agentResponse' in parsed) ||
		!('historyResponse' in parsed) ||
		!('waitResponse' in parsed)
	) {
		throw new Error(`Unexpected OpenClaw subagent e2e result: ${JSON.stringify(parsed)}`);
	}
	return {
		agentResponse: parsed.agentResponse,
		childSessionKey: parsed.childSessionKey,
		contextWorkspaceDir:
			typeof parsed.contextWorkspaceDir === 'string' ? parsed.contextWorkspaceDir : '',
		...(isObjectRecord(parsed.diagnostics)
			? { diagnostics: parsed.diagnostics as OpenClawSubagentSpawnProbeDiagnostics }
			: {}),
		...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
		historyResponse: parsed.historyResponse,
		runId: parsed.runId,
		waitResponse: parsed.waitResponse,
		status: parsed.status,
	};
}

function parseToolVmWriteReadProbeResult(value: unknown): OpenClawToolVmWriteReadProbeResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error(
			`Expected successful OpenClaw Tool VM write/read route result: ${JSON.stringify(value)}`,
		);
	}
	const parsed = value.details;
	if (!isObjectRecord(parsed)) {
		throw new Error('OpenClaw Tool VM write/read e2e result was not a JSON object.');
	}
	if (
		parsed.status !== 'ok' ||
		typeof parsed.agentId !== 'string' ||
		typeof parsed.filePath !== 'string' ||
		typeof parsed.marker !== 'string' ||
		typeof parsed.readBack !== 'string' ||
		typeof parsed.runtimeId !== 'string' ||
		typeof parsed.sessionKey !== 'string' ||
		typeof parsed.workdir !== 'string'
	) {
		throw new Error(`Unexpected OpenClaw Tool VM write/read e2e result: ${JSON.stringify(parsed)}`);
	}
	return {
		agentId: parsed.agentId,
		filePath: parsed.filePath,
		marker: parsed.marker,
		readBack: parsed.readBack,
		runtimeId: parsed.runtimeId,
		sessionKey: parsed.sessionKey,
		status: parsed.status,
		workdir: parsed.workdir,
	};
}

function parseToolVmStaleReacquireProbeStepResult(
	step: Readonly<Record<string, unknown>>,
	stepName: string,
): OpenClawToolVmStaleReacquireProbeStepResult {
	if (
		typeof step.filePath !== 'string' ||
		typeof step.marker !== 'string' ||
		typeof step.readBack !== 'string' ||
		typeof step.runtimeId !== 'string'
	) {
		throw new Error(
			`Unexpected OpenClaw Tool VM stale-reacquire ${stepName} result: ${JSON.stringify(step)}`,
		);
	}
	return {
		filePath: step.filePath,
		marker: step.marker,
		readBack: step.readBack,
		runtimeId: step.runtimeId,
	};
}

function parseToolVmStaleReacquireProbeResult(
	value: unknown,
): OpenClawToolVmStaleReacquireProbeResult {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.details)) {
		throw new Error(
			`Expected successful OpenClaw Tool VM stale-reacquire route result: ${JSON.stringify(value)}`,
		);
	}
	const parsed = value.details;
	if (
		parsed.status !== 'ok' ||
		parsed.scenario !== 'stale-reacquire' ||
		parsed.sameHandle !== true ||
		parsed.staleTrigger !== 'finalize-timeout' ||
		typeof parsed.agentId !== 'string' ||
		typeof parsed.newRuntimeId !== 'string' ||
		typeof parsed.oldRuntimeId !== 'string' ||
		typeof parsed.sessionKey !== 'string' ||
		typeof parsed.workdir !== 'string' ||
		!isObjectRecord(parsed.first) ||
		!isObjectRecord(parsed.second)
	) {
		throw new Error(
			`Unexpected OpenClaw Tool VM stale-reacquire e2e result: ${JSON.stringify(parsed)}`,
		);
	}
	return {
		agentId: parsed.agentId,
		first: parseToolVmStaleReacquireProbeStepResult(parsed.first, 'first'),
		newRuntimeId: parsed.newRuntimeId,
		oldRuntimeId: parsed.oldRuntimeId,
		sameHandle: parsed.sameHandle,
		scenario: parsed.scenario,
		second: parseToolVmStaleReacquireProbeStepResult(parsed.second, 'second'),
		sessionKey: parsed.sessionKey,
		staleTrigger: parsed.staleTrigger,
		status: parsed.status,
		workdir: parsed.workdir,
	};
}

async function callToolVmWriteReadProbeRoute(options: {
	readonly agentId: string;
	readonly filePath: string;
	readonly harness: E2eHarnessRuntime;
	readonly marker: string;
	readonly scenario?: 'stale-reacquire' | 'write-read';
	readonly secondFilePath?: string;
	readonly secondMarker?: string;
	readonly sessionKey: string;
}): Promise<unknown> {
	const gatewayIngress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (!gatewayIngress) {
		throw new Error('OpenClaw subagent e2e did not expose a gateway ingress URL.');
	}
	const body = JSON.stringify({
		agentId: options.agentId,
		filePath: options.filePath,
		marker: options.marker,
		...(options.scenario === undefined ? {} : { scenario: options.scenario }),
		...(options.secondFilePath === undefined ? {} : { secondFilePath: options.secondFilePath }),
		...(options.secondMarker === undefined ? {} : { secondMarker: options.secondMarker }),
		sessionKey: options.sessionKey,
	});
	const response = await fetch(
		`http://${gatewayIngress.host}:${String(gatewayIngress.port)}${AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH}`,
		{
			body,
			headers: {
				authorization: `Bearer ${gatewayToken}`,
				'content-type': 'application/json',
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER]:
					toolVmWriteReadE2eToolTestExports.signToolVmWriteReadE2eRouteBody(
						body,
						toolVmWriteReadProbeKey,
					),
			},
			method: 'POST',
		},
	);
	const responseBody: unknown = await response.json();
	if (!response.ok) {
		throw new Error(
			`OpenClaw Tool VM write/read route returned HTTP ${String(response.status)}: ${JSON.stringify(responseBody)}`,
		);
	}
	return responseBody;
}

function latestHealthEvents(snapshot: ZoneHealthSnapshot): readonly AgentVmHealthEvent[] {
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

async function waitForToolVmLifecycleEvent(options: {
	readonly controllerUrl: string;
	readonly matches: (event: AgentVmHealthEvent) => boolean;
	readonly timeoutMs: number;
}): Promise<AgentVmHealthEvent> {
	const deadlineMs = Date.now() + options.timeoutMs;
	let lastSnapshot: ZoneHealthSnapshot | undefined;
	while (Date.now() < deadlineMs) {
		lastSnapshot = await readHealthSnapshot(options.controllerUrl);
		const event = latestHealthEvents(lastSnapshot).find(options.matches);
		if (event !== undefined) {
			return event;
		}
		await waitForProtocolRetryInterval(1_000);
	}
	throw new Error(
		`Timed out waiting for Tool VM lifecycle event; last snapshot: ${JSON.stringify(lastSnapshot)}`,
	);
}

async function configureOpenClawMockModel(options: {
	readonly configPath: string;
	readonly mockPort: number;
}): Promise<void> {
	const config = JSON.parse(await fs.readFile(options.configPath, 'utf8')) as Record<
		string,
		unknown
	>;
	const cost = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };
	const existingAgents = isObjectRecord(config.agents) ? config.agents : {};
	const existingDefaults = isObjectRecord(existingAgents.defaults) ? existingAgents.defaults : {};
	const existingDefaultModels = isObjectRecord(existingDefaults.models)
		? existingDefaults.models
		: {};
	const existingModels = isObjectRecord(config.models) ? config.models : {};
	const existingProviders = isObjectRecord(existingModels.providers)
		? existingModels.providers
		: {};
	const existingOpenAiProvider = isObjectRecord(existingProviders.openai)
		? existingProviders.openai
		: {};
	config.models = {
		...existingModels,
		mode: 'merge',
		providers: {
			...existingProviders,
			openai: {
				...existingOpenAiProvider,
				api: 'openai-responses',
				apiKey: { id: 'OPENAI_API_KEY', provider: 'default', source: 'env' },
				baseUrl: `http://127.0.0.1:${String(options.mockPort)}/v1`,
				models: [
					{
						api: 'openai-responses',
						contextTokens: 96_000,
						contextWindow: 128_000,
						cost,
						id: 'gpt-5.5',
						input: ['text'],
						maxTokens: 4096,
						name: 'gpt-5.5',
						reasoning: false,
					},
				],
				request: { allowPrivateNetwork: true },
			},
		},
	};
	config.agents = {
		...existingAgents,
		defaults: {
			...existingDefaults,
			model: { primary: 'openai/gpt-5.5' },
			models: {
				...existingDefaultModels,
				'openai/gpt-5.5': {
					params: { openaiWsWarmup: false, transport: 'sse' },
				},
			},
		},
	};
	await fs.writeFile(options.configPath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
}

async function startMockOpenAiServerInGateway(options: {
	readonly gatewayVm: ManagedVm;
	readonly port: number;
}): Promise<void> {
	const command = `set -eu
cat >/tmp/agent-vm-subagent-mock-openai.mjs <<'NODE'
import fs from 'node:fs';
import http from 'node:http';

const port = Number(process.env.MOCK_OPENAI_PORT);
const requestLog = '/tmp/agent-vm-subagent-mock-openai-requests.jsonl';
const readyPath = '/tmp/agent-vm-subagent-mock-openai.ready';

function readBody(req) {
	return new Promise((resolve, reject) => {
		let body = '';
		req.setEncoding('utf8');
		req.on('data', (chunk) => {
			body += chunk;
		});
		req.on('end', () => resolve(body));
		req.on('error', reject);
	});
}

function writeJson(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

function responseEvents(text) {
	return [
		{
			type: 'response.output_item.added',
			item: {
				type: 'message',
				id: 'msg_subagent_smoke',
				role: 'assistant',
				content: [],
				status: 'in_progress',
			},
		},
		{
			type: 'response.output_item.done',
			item: {
				type: 'message',
				id: 'msg_subagent_smoke',
				role: 'assistant',
				status: 'completed',
				content: [{ type: 'output_text', text, annotations: [] }],
			},
		},
		{
			type: 'response.completed',
			response: {
				id: 'resp_subagent_smoke',
				status: 'completed',
				usage: {
					input_tokens: 12,
					output_tokens: 6,
					total_tokens: 18,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
}

function writeSse(res, events) {
	res.writeHead(200, {
		'cache-control': 'no-store',
		connection: 'keep-alive',
		'content-type': 'text/event-stream',
	});
	for (const event of events) {
		res.write(\`data: \${JSON.stringify(event)}\\n\\n\`);
	}
	res.write('data: [DONE]\\n\\n');
	res.end();
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://127.0.0.1');
	if (req.method === 'GET' && url.pathname === '/health') {
		writeJson(res, 200, { ok: true });
		return;
	}
	if (req.method === 'GET' && url.pathname === '/v1/models') {
		writeJson(res, 200, {
			object: 'list',
			data: [{ id: 'gpt-5.5', object: 'model', owned_by: 'agent-vm-subagent-smoke' }],
		});
		return;
	}
	const bodyText = await readBody(req);
	fs.appendFileSync(requestLog, JSON.stringify({ method: req.method, path: url.pathname }) + '\\n');
	if (req.method === 'POST' && url.pathname === '/v1/responses') {
		writeSse(res, responseEvents('SUBAGENT_LEASE_SMOKE_OK'));
		return;
	}
	writeJson(res, 404, { error: { message: \`unhandled mock route: \${req.method} \${url.pathname}\` } });
});

server.listen(port, '127.0.0.1', () => {
	fs.writeFileSync(readyPath, 'ready\\n', 'utf8');
	console.log(\`mock-openai listening on \${port}\`);
});
NODE
rm -f /tmp/agent-vm-subagent-mock-openai.ready
MOCK_OPENAI_PORT=${shellSingleQuote(String(options.port))} node /tmp/agent-vm-subagent-mock-openai.mjs >/tmp/agent-vm-subagent-mock-openai.log 2>&1 &
echo "$!" >/tmp/agent-vm-subagent-mock-openai.pid
MOCK_OPENAI_PORT=${shellSingleQuote(String(options.port))} node --input-type=module <<'NODE'
import { once } from 'node:events';
import fs from 'node:fs';

const readyPath = '/tmp/agent-vm-subagent-mock-openai.ready';
if (!fs.existsSync(readyPath)) {
	const watcher = fs.watch('/tmp');
	try {
		while (!fs.existsSync(readyPath)) {
			await once(watcher, 'change');
		}
	} finally {
		watcher.close();
	}
}
const response = await fetch(\`http://127.0.0.1:\${process.env.MOCK_OPENAI_PORT}/health\`);
if (!response.ok) {
	throw new Error(\`mock OpenAI server reported HTTP \${response.status}\`);
}
NODE`;
	const result = await options.gatewayVm.exec(command);
	if (result.exitCode !== 0) {
		throw new Error(
			`Mock OpenAI server failed to start with exit ${String(result.exitCode)}.\nstdout:\n${
				result.stdout
			}\nstderr:\n${result.stderr}`,
		);
	}
}

async function readControllerStatus(controllerUrl: string): Promise<unknown> {
	const response = await fetch(`${controllerUrl}/controller-status`);
	if (!response.ok) {
		throw new Error(`Controller /controller-status returned HTTP ${String(response.status)}.`);
	}
	return await response.json();
}

function activeLeaseCountFromControllerStatus(
	statusPayload: unknown,
	expectedZoneId: string,
): number {
	if (!isObjectRecord(statusPayload) || !Array.isArray(statusPayload.zones)) {
		throw new Error('Expected controller-status response with zones array.');
	}
	const zoneStatus = statusPayload.zones.find(
		(zone): zone is { readonly activeLeaseCount: number; readonly id: string } =>
			isObjectRecord(zone) &&
			zone.id === expectedZoneId &&
			typeof zone.activeLeaseCount === 'number',
	);
	if (zoneStatus === undefined) {
		throw new Error(`Expected controller-status response for zone '${expectedZoneId}'.`);
	}
	return zoneStatus.activeLeaseCount;
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
  if [ "$readyz_code" = "200" ]; then
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

async function waitForControlSessionReconnected(options: {
	readonly controlSession: ControlSessionClient;
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

async function runRepeatedGatewayFlaps(options: {
	readonly controlSession: ControlSessionClient;
	readonly flapCount: number;
	readonly gatewayVm: ManagedVm;
}): Promise<void> {
	for (let flapIndex = 0; flapIndex < options.flapCount; flapIndex += 1) {
		const helloCountBeforeFlap = options.controlSession.getDiagnostics().helloCount;
		await restartOpenClawGatewayProcess(options.gatewayVm);
		await waitForControlSessionReconnected({
			controlSession: options.controlSession,
			minimumHelloCount: helloCountBeforeFlap + 1,
			timeoutMs: 120_000,
		});
	}
}

async function runOpenClawSubagentSpawnProbe(options: {
	readonly agentId: string;
	readonly contextWorkspaceDir: string;
	readonly gatewayVm: ManagedVm;
	readonly guestListenPort: number;
	readonly marker: string;
}): Promise<OpenClawSubagentSpawnProbeResult> {
	const command = `set -eu
. /etc/profile.d/openclaw-env.sh
. /run/openclaw/gateway-token.env
OPENCLAW_PACKAGE_ROOT=""
for candidate in /pnpm/global/*/node_modules/openclaw /usr/local/lib/node_modules/openclaw; do
	if [ -d "$candidate/dist" ]; then
		OPENCLAW_PACKAGE_ROOT="$candidate"
		break
	fi
done
if [ ! -d "$OPENCLAW_PACKAGE_ROOT/dist" ]; then
	echo "OpenClaw package root not found in managed-image global package locations" >&2
	exit 1
fi
export OPENCLAW_PACKAGE_ROOT
export OPENCLAW_GATEWAY_URL=${shellSingleQuote(`ws://127.0.0.1:${String(options.guestListenPort)}`)}
export OPENCLAW_GUEST_PORT=${shellSingleQuote(String(options.guestListenPort))}
export OPENCLAW_SUBAGENT_SMOKE_AGENT=${shellSingleQuote(options.agentId)}
export OPENCLAW_SUBAGENT_SMOKE_CONTEXT_WORKSPACE=${shellSingleQuote(options.contextWorkspaceDir)}
export OPENCLAW_SUBAGENT_SMOKE_MARKER=${shellSingleQuote(options.marker)}
cd "$OPENCLAW_PACKAGE_ROOT"
node --input-type=module <<'NODE'
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT;
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
const guestPort = process.env.OPENCLAW_GUEST_PORT;
const agentId = process.env.OPENCLAW_SUBAGENT_SMOKE_AGENT;
const contextWorkspaceDir = process.env.OPENCLAW_SUBAGENT_SMOKE_CONTEXT_WORKSPACE;
const marker = process.env.OPENCLAW_SUBAGENT_SMOKE_MARKER;

if (!packageRoot || !gatewayToken || !guestPort || !agentId || !contextWorkspaceDir || !marker) {
	throw new Error('Missing OpenClaw subagent e2e environment.');
}

function readTailIfExists(filePath, maxChars = 12000) {
	try {
		const content = fs.readFileSync(filePath, 'utf8');
		return content.length > maxChars ? content.slice(content.length - maxChars) : content;
	} catch {
		return undefined;
	}
}

function collectProbeDiagnostics() {
	const home = process.env.HOME || '/root';
	return {
		gatewayErrLogTail: readTailIfExists(home + '/.openclaw/logs/gateway.err.log'),
		gatewayLogTail: readTailIfExists(home + '/.openclaw/logs/gateway.log'),
		mockOpenAiRequestLog: readTailIfExists('/tmp/agent-vm-subagent-mock-openai-requests.jsonl'),
		mockOpenAiServerLog: readTailIfExists('/tmp/agent-vm-subagent-mock-openai.log'),
	};
}

function readWebSocketText(data) {
	if (typeof data === 'string') {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString('utf8');
	}
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
	}
	return String(data);
}

function createGatewayError(message, details) {
	const error = new Error(message);
	if (details !== undefined) {
		error.details = details;
	}
	return error;
}

function createGatewayClient({ token, url }) {
	let nextId = 1;
	let handshakeComplete = false;
	let connectChallengeSeen = false;
	const pendingRequests = new Map();
	const socket = new WebSocket(url);
	let resolveConnected;
	let rejectConnected;
	const connected = new Promise((resolve, reject) => {
		resolveConnected = resolve;
		rejectConnected = reject;
	});
	const challengeTimer = setTimeout(() => {
		rejectConnected(new Error('gateway connect challenge timeout'));
		try {
			socket.close(1008, 'connect challenge timeout');
		} catch {}
	}, 20000);

	function rejectAll(error) {
		clearTimeout(challengeTimer);
		rejectConnected(error);
		for (const request of pendingRequests.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pendingRequests.clear();
	}

	function request(method, params, options = {}) {
		const id = String(nextId);
		nextId += 1;
		const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingRequests.delete(id);
				reject(new Error('gateway request timeout for ' + method));
			}, timeoutMs);
			pendingRequests.set(id, { method, reject, resolve, timer });
			socket.send(JSON.stringify({ type: 'req', id, method, params }));
		});
	}

	socket.addEventListener('error', () => {
		rejectAll(new Error('gateway websocket error'));
	});
	socket.addEventListener('close', (event) => {
		rejectAll(new Error('gateway websocket closed code=' + String(event.code) + ' reason=' + String(event.reason ?? '')));
	});
	socket.addEventListener('message', (event) => {
		let frame;
		try {
			frame = JSON.parse(readWebSocketText(event.data));
		} catch (error) {
			rejectAll(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		if (!frame || typeof frame !== 'object') {
			return;
		}
		if (frame.type === 'event' && frame.event === 'connect.challenge') {
			if (connectChallengeSeen) {
				return;
			}
			connectChallengeSeen = true;
			clearTimeout(challengeTimer);
			request(
				'connect',
				{
					minProtocol: 4,
					maxProtocol: 4,
					client: {
						id: 'gateway-client',
						displayName: 'agent-vm-subagent-smoke',
						version: 'agent-vm-smoke',
						platform: process.platform,
						mode: 'backend',
						instanceId: randomUUID(),
					},
					caps: [],
					commands: [],
					permissions: {},
					auth: { token },
					role: 'operator',
					scopes: ['operator.read', 'operator.write', 'operator.admin'],
				},
				{ timeoutMs: 20000 },
			)
				.then((helloOk) => {
					handshakeComplete = true;
					resolveConnected(helloOk);
				})
				.catch((error) => {
					rejectConnected(error instanceof Error ? error : new Error(String(error)));
				});
			return;
		}
		if (frame.type !== 'res' || typeof frame.id !== 'string') {
			return;
		}
		const requestEntry = pendingRequests.get(frame.id);
		if (!requestEntry) {
			return;
		}
		pendingRequests.delete(frame.id);
		clearTimeout(requestEntry.timer);
		if (frame.ok === true) {
			requestEntry.resolve(frame.payload);
			return;
		}
		requestEntry.reject(
			createGatewayError(
				frame.error && typeof frame.error.message === 'string'
					? frame.error.message
					: 'gateway request failed for ' + requestEntry.method,
				frame.error,
			),
		);
	});

	return {
		async request(method, params, options = {}) {
			if (!handshakeComplete) {
				await connected;
			}
			return await request(method, params, options);
		},
		close() {
			clearTimeout(challengeTimer);
			socket.close();
		},
		connected,
	};
}

const gatewayClient = createGatewayClient({
	token: gatewayToken,
	url: process.env.OPENCLAW_GATEWAY_URL ?? 'ws://127.0.0.1:' + guestPort,
});
await gatewayClient.connected;

const childSessionKey = 'agent:' + agentId + ':subagent:agent-vm-smoke-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let waitResponse = null;
let historyResponse = null;
let agentResponse = null;
let spawnResult;
try {
	const lineagePatchResponse = await gatewayClient.request(
		'sessions.patch',
		{
			key: childSessionKey,
			spawnDepth: 1,
			spawnedBy: 'agent:' + agentId + ':main',
			spawnedWorkspaceDir: contextWorkspaceDir,
			subagentControlScope: 'none',
			subagentRole: 'leaf',
		},
		{ timeoutMs: 20000 },
	);
	if (!lineagePatchResponse || typeof lineagePatchResponse !== 'object' || lineagePatchResponse.ok !== true) {
		throw new Error('OpenClaw sessions.patch returned an unexpected result: ' + JSON.stringify(lineagePatchResponse));
	}
	agentResponse = await gatewayClient.request(
		'agent',
		{
			agentId,
			cleanupBundleMcpOnRunEnd: true,
			idempotencyKey: 'agent-vm-subagent-smoke-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
			label: 'agent-vm-subagent-lease-smoke',
			lane: 'subagent',
			message: 'Reply exactly ' + marker + ' and nothing else.',
			sessionKey: childSessionKey,
			thinking: 'off',
			timeout: 120,
		},
		{ timeoutMs: 125000 },
	);
	spawnResult = {
		childSessionKey,
		error: agentResponse && typeof agentResponse === 'object' && typeof agentResponse.summary === 'string'
			? agentResponse.summary
			: undefined,
		runId: agentResponse && typeof agentResponse === 'object' && typeof agentResponse.runId === 'string'
			? agentResponse.runId
			: undefined,
		status: agentResponse && typeof agentResponse === 'object' && typeof agentResponse.runId === 'string'
			? 'accepted'
			: 'error',
	};
	if (spawnResult.status === 'accepted') {
		const deadline = Date.now() + 120000;
		while (Date.now() < deadline) {
			waitResponse = await gatewayClient.request(
				'agent.wait',
				{
					runId: spawnResult.runId,
					timeoutMs: 15000,
				},
				{ timeoutMs: 20000 },
			);
			historyResponse = await gatewayClient.request(
				'chat.history',
				{
					limit: 20,
					maxChars: 20000,
					sessionKey: spawnResult.childSessionKey,
				},
				{ timeoutMs: 20000 },
			);
			if (JSON.stringify(historyResponse).includes(marker)) {
				break;
			}
			if (waitResponse && typeof waitResponse === 'object' && waitResponse.status === 'error') {
				break;
			}
		}
	}
} finally {
	gatewayClient.close();
}
console.log('AGENT_VM_SUBAGENT_E2E_RESULT ' + JSON.stringify({
	agentResponse,
	childSessionKey: spawnResult.childSessionKey,
	contextWorkspaceDir,
	diagnostics: collectProbeDiagnostics(),
	error: spawnResult.error,
	historyResponse,
	runId: spawnResult.runId,
	status: spawnResult.status,
	waitResponse,
}));
NODE`;
	const result = await options.gatewayVm.exec(command);
	if (result.exitCode !== 0) {
		throw new Error(
			`OpenClaw subagent e2e probe failed with exit ${String(result.exitCode)}.\nstdout:\n${
				result.stdout
			}\nstderr:\n${result.stderr}`,
		);
	}
	return parseSubagentSpawnProbeResult(result.stdout);
}

describeOpenClawSubagentE2e('e2e: OpenClaw subagent Tool VM lease path', () => {
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	let gatewayVm: ManagedVm | undefined;
	let gatewayGuestListenPort: number | undefined;
	let gatewayControlSession: ControlSessionClient | undefined;
	const observedLeaseRequests: ObservedLeaseCreateRequest[] = [];

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		project = await scaffoldOpenClawE2eProject({
			agents: agentIds,
			architecture,
			prefix: 'openclaw-subagent-lease-e2e-',
			zoneId: 'subagent-lease-smoke',
		});
		const systemZone = project.systemConfig.zones[0];
		if (!systemZone || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw subagent e2e project to contain an OpenClaw zone.');
		}
		await configureOpenClawMockModel({
			configPath: systemZone.gateway.config,
			mockPort: mockOpenAiPort,
		});
		systemZone.secrets.OPENAI_API_KEY = {
			audience: 'gateway',
			envVar: 'OPENAI_API_KEY',
			injection: 'env',
			source: 'environment',
		};
		systemZone.secrets[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV] = {
			audience: 'gateway',
			envVar: AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
			injection: 'env',
			source: 'environment',
		};
		systemZone.secrets[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV] = {
			audience: 'gateway',
			envVar: AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
			injection: 'env',
			source: 'environment',
		};
		systemZone.secrets[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_AGENT_ID_ENV] = {
			audience: 'gateway',
			envVar: AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_AGENT_ID_ENV,
			injection: 'env',
			source: 'environment',
		};
		systemZone.secrets[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SESSION_KEY_ENV] = {
			audience: 'gateway',
			envVar: AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SESSION_KEY_ENV,
			injection: 'env',
			source: 'environment',
		};
		systemZone.gateway.rawEnvSecrets = [
			...(systemZone.gateway.rawEnvSecrets ?? []),
			'OPENAI_API_KEY',
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_AGENT_ID_ENV,
			AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SESSION_KEY_ENV,
		];
		const zoneFilesDir = systemZone.gateway.zoneFilesDir;
		await Promise.all(
			agentIds.map(async (agentId) => {
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
			onLeaseCreateRequest: (request) => {
				observedLeaseRequests.push({
					agentId: request.agentId,
					agentWorkspaceDir: request.agentWorkspaceDir,
					workMountDir: request.workMountDir,
					zoneId: request.zoneId,
				});
			},
			secrets: {
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV]: '1',
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV]: toolVmWriteReadProbeKey,
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_AGENT_ID_ENV]: betaAgentId,
				[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SESSION_KEY_ENV]: toolVmWriteReadProbeSessionKey,
				GITHUB_TOKEN: 'unused-subagent-smoke-token',
				OPENAI_API_KEY: 'subagent-smoke-mock-openai-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-subagent-smoke-perplexity-token',
			},
			startGatewayZone: async (startGatewayOptions) => {
				const result = await startGatewayZone(startGatewayOptions);
				gatewayVm = result.vm;
				gatewayGuestListenPort = result.processSpec.guestListenPort;
				gatewayControlSession = result.controlSession;
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

	it('keeps Tool VM subagent SSH path working after repeated control-session flaps', async () => {
		if (
			gatewayVm === undefined ||
			gatewayGuestListenPort === undefined ||
			gatewayControlSession === undefined ||
			harness === undefined
		) {
			throw new Error('Expected smoke harness to be initialized.');
		}
		await runRepeatedGatewayFlaps({
			controlSession: gatewayControlSession,
			flapCount: positiveIntegerFromEnv('AGENT_VM_OPENCLAW_FLAP_COUNT', defaultFlapCount),
			gatewayVm,
		});
		await startMockOpenAiServerInGateway({
			gatewayVm,
			port: mockOpenAiPort,
		});

		const spawnResults: OpenClawSubagentSpawnProbeResult[] = [];
		for (const contextWorkspaceDir of ['/workspace', '/workspace/subdir', '/work/tmp']) {
			spawnResults.push(
				await runOpenClawSubagentSpawnProbe({
					agentId: mainAgentId,
					contextWorkspaceDir,
					gatewayVm,
					guestListenPort: gatewayGuestListenPort,
					marker: 'SUBAGENT_LEASE_SMOKE_OK',
				}),
			);
		}

		for (const spawnResult of spawnResults) {
			const spawnResultDiagnostic = JSON.stringify(spawnResult);
			expect(spawnResult.childSessionKey).toContain(`agent:${mainAgentId}:subagent:`);
			expect(spawnResult.error ?? '').not.toContain('outside-allowed-roots');
			expect(spawnResult.error ?? '').not.toContain('/workspace');
			expect(JSON.stringify(spawnResult.historyResponse), spawnResultDiagnostic).toContain(
				'SUBAGENT_LEASE_SMOKE_OK',
			);
		}

		const controllerStatusPayload = await readControllerStatus(harness.controllerUrl);
		expect(
			activeLeaseCountFromControllerStatus(controllerStatusPayload, 'subagent-lease-smoke'),
		).toBe(1);
		expect(observedLeaseRequests).toEqual(
			Array.from({ length: spawnResults.length }, () => ({
				agentId: mainAgentId,
				agentWorkspaceDir: '/zone/agents/main',
				workMountDir: '/zone/agents/main',
				zoneId: 'subagent-lease-smoke',
			})),
		);
		for (const request of observedLeaseRequests) {
			expect(request.workMountDir).not.toBe('/workspace');
			expect(request.workMountDir.startsWith('/workspace/')).toBe(false);
			expect(request.workMountDir).not.toBe('/work');
			expect(request.workMountDir.startsWith('/work/')).toBe(false);
		}
	});

	it('creates a beta-agent Tool VM lease and proves file write/read through the registered backend', async () => {
		if (gatewayVm === undefined || harness === undefined) {
			throw new Error('Expected smoke harness to be initialized.');
		}
		const marker = `TOOLVM_BETA_WRITE_READ_${randomUUID()}`;
		const filePath = `.agent-vm/s16-tool-vm-write-read-${randomUUID()}.txt`;
		const result = parseToolVmWriteReadProbeResult(
			await callToolVmWriteReadProbeRoute({
				agentId: betaAgentId,
				filePath,
				harness,
				marker,
				sessionKey: toolVmWriteReadProbeSessionKey,
			}),
		);

		expect(result).toMatchObject({
			agentId: betaAgentId,
			marker,
			readBack: marker,
			status: 'ok',
			workdir: '/workspace',
		});
		expect(result.filePath).toMatch(/^\.agent-vm\/s16-tool-vm-write-read-/u);
		expect(result.sessionKey).toBe(toolVmWriteReadProbeSessionKey);

		const controllerStatusPayload = await readControllerStatus(harness.controllerUrl);
		expect(
			activeLeaseCountFromControllerStatus(controllerStatusPayload, 'subagent-lease-smoke'),
		).toBeGreaterThanOrEqual(1);
		expect(observedLeaseRequests).toContainEqual({
			agentId: betaAgentId,
			agentWorkspaceDir: '/zone/agents/beta',
			workMountDir: '/zone/agents/beta',
			zoneId,
		});
	});

	it('reacquires a stale beta-agent Tool VM lease before the next same-handle write', async () => {
		if (gatewayVm === undefined || harness === undefined) {
			throw new Error('Expected smoke harness to be initialized.');
		}
		const firstMarker = `TOOLVM_BETA_STALE_FIRST_${randomUUID()}`;
		const secondMarker = `TOOLVM_BETA_STALE_SECOND_${randomUUID()}`;
		const firstFilePath = `.agent-vm/s16-tool-vm-stale-first-${randomUUID()}.txt`;
		const secondFilePath = `.agent-vm/s16-tool-vm-stale-second-${randomUUID()}.txt`;

		const result = parseToolVmStaleReacquireProbeResult(
			await callToolVmWriteReadProbeRoute({
				agentId: betaAgentId,
				filePath: firstFilePath,
				harness,
				marker: firstMarker,
				scenario: 'stale-reacquire',
				secondFilePath,
				secondMarker,
				sessionKey: toolVmWriteReadProbeSessionKey,
			}),
		);

		expect(result).toMatchObject({
			agentId: betaAgentId,
			first: {
				filePath: firstFilePath,
				marker: firstMarker,
				readBack: firstMarker,
			},
			sameHandle: true,
			scenario: 'stale-reacquire',
			second: {
				filePath: secondFilePath,
				marker: secondMarker,
				readBack: secondMarker,
			},
			staleTrigger: 'finalize-timeout',
			status: 'ok',
			workdir: '/workspace',
		});
		expect(result.oldRuntimeId).toBe(result.first.runtimeId);
		expect(result.newRuntimeId).toBe(result.second.runtimeId);
		expect(result.newRuntimeId).not.toBe(result.oldRuntimeId);
		expect(result.sessionKey).toBe(toolVmWriteReadProbeSessionKey);

		const lifecycleEvent = await waitForToolVmLifecycleEvent({
			controllerUrl: harness.controllerUrl,
			matches: (event) =>
				event.kind === 'tool-vm-ssh' &&
				event.agentId === betaAgentId &&
				event.lifecycleEventRole === 'controller_final' &&
				event.lifecycleTransition === 'stale_to_reacquired' &&
				event.oldLeaseId === result.oldRuntimeId &&
				event.replacementLeaseId === result.newRuntimeId &&
				event.operation === 'finalize',
			timeoutMs: 60_000,
		});
		expect(lifecycleEvent).toMatchObject({
			agentId: betaAgentId,
			kind: 'tool-vm-ssh',
			leaseId: result.newRuntimeId,
			lifecycleEventRole: 'controller_final',
			lifecycleTransition: 'stale_to_reacquired',
			oldLeaseId: result.oldRuntimeId,
			replacementLeaseId: result.newRuntimeId,
			result: 'ok',
			transitionId: `lease_reacquire:${result.oldRuntimeId}`,
			zoneId,
		});

		const controllerStatusPayload = await readControllerStatus(harness.controllerUrl);
		expect(
			activeLeaseCountFromControllerStatus(controllerStatusPayload, zoneId),
		).toBeGreaterThanOrEqual(1);
	});
});
