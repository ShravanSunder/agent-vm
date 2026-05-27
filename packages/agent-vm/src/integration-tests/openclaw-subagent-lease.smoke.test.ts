/* oxlint-disable eslint/no-await-in-loop -- E2E smoke steps are sequential against live VMs */
import fs from 'node:fs/promises';
import path from 'node:path';

import { type ManagedVm } from '@agent-vm/gondolin-adapter';
import { buildOpenClawRuntimeStatusReport } from '@agent-vm/openclaw-agent-vm-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBuildCommand } from '../cli/build-command.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import {
	canRunGondolinSmoke,
	currentSmokeArchitecture,
	rebuildWorkspacePackages,
	removeSmokeTempRoot,
	scaffoldOpenClawSmokeProject,
	startSmokeControllerRuntime,
	type OpenClawSmokeProject,
	type SmokeHarnessRuntime,
	useLocalOpenClawGatewayImagePackages,
} from './smoke-harness.js';

const architecture = currentSmokeArchitecture();
const runOpenClawSubagentSmoke =
	process.env.AGENT_VM_OPENCLAW_SMOKE === '1' && (await canRunGondolinSmoke({ architecture }));
const describeOpenClawSubagentSmoke = runOpenClawSubagentSmoke ? describe : describe.skip;
const agentId = 'smoke';
const gatewayToken = 'subagent-lease-smoke-gateway-token';
const mockOpenAiPort = 18231;
const subagentSmokeResultPrefix = 'AGENT_VM_SUBAGENT_SMOKE_RESULT ';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface OpenClawSubagentSpawnProbeResult {
	readonly childSessionKey: string;
	readonly contextWorkspaceDir: string;
	readonly error?: string;
	readonly historyResponse: unknown;
	readonly runId: string;
	readonly waitResponse: unknown;
	readonly status: 'accepted' | 'error';
}

interface ObservedLeaseCreateRequest {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseSubagentSpawnProbeResult(stdout: string): OpenClawSubagentSpawnProbeResult {
	const resultLine = stdout.split('\n').find((line) => line.startsWith(subagentSmokeResultPrefix));
	if (resultLine === undefined) {
		throw new Error(`OpenClaw subagent smoke did not emit ${subagentSmokeResultPrefix.trim()}.`);
	}
	const parsed: unknown = JSON.parse(resultLine.slice(subagentSmokeResultPrefix.length));
	if (!isObjectRecord(parsed)) {
		throw new Error('OpenClaw subagent smoke result was not a JSON object.');
	}
	if (
		(parsed.status !== 'accepted' && parsed.status !== 'error') ||
		typeof parsed.childSessionKey !== 'string' ||
		typeof parsed.runId !== 'string' ||
		(parsed.error !== undefined && typeof parsed.error !== 'string') ||
		!('historyResponse' in parsed) ||
		!('waitResponse' in parsed)
	) {
		throw new Error(`Unexpected OpenClaw subagent smoke result: ${JSON.stringify(parsed)}`);
	}
	return {
		childSessionKey: parsed.childSessionKey,
		contextWorkspaceDir:
			typeof parsed.contextWorkspaceDir === 'string' ? parsed.contextWorkspaceDir : '',
		...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
		historyResponse: parsed.historyResponse,
		runId: parsed.runId,
		waitResponse: parsed.waitResponse,
		status: parsed.status,
	};
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
	const existingTools = isObjectRecord(config.tools) ? config.tools : {};
	const smokeTools = { ...existingTools };
	delete smokeTools.allow;
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
	config.tools = smokeTools;
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
	console.log(\`mock-openai listening on \${port}\`);
});
NODE
MOCK_OPENAI_PORT=${shellSingleQuote(String(options.port))} node /tmp/agent-vm-subagent-mock-openai.mjs >/tmp/agent-vm-subagent-mock-openai.log 2>&1 &
echo "$!" >/tmp/agent-vm-subagent-mock-openai.pid
MOCK_OPENAI_PORT=${shellSingleQuote(String(options.port))} node --input-type=module <<'NODE'
const port = Number(process.env.MOCK_OPENAI_PORT);
const deadline = Date.now() + 10_000;
let lastError;
while (Date.now() < deadline) {
	try {
		const response = await fetch(\`http://127.0.0.1:\${port}/health\`);
		if (response.ok) {
			process.exit(0);
		}
		lastError = new Error(\`HTTP \${response.status}\`);
	} catch (error) {
		lastError = error;
	}
	await new Promise((resolve) => setTimeout(resolve, 100));
}
throw lastError ?? new Error('mock OpenAI server did not become ready');
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

async function readControllerLeases(controllerUrl: string): Promise<unknown> {
	const response = await fetch(`${controllerUrl}/leases`);
	if (!response.ok) {
		throw new Error(`Controller /leases returned HTTP ${String(response.status)}.`);
	}
	return await response.json();
}

async function requestControllerLease(options: {
	readonly controllerUrl: string;
	readonly zoneId: string;
}): Promise<void> {
	const response = await fetch(`${options.controllerUrl}/lease`, {
		body: JSON.stringify({
			agentId,
			agentWorkspaceDir: '/zone/agents/smoke',
			profileId: 'standard',
			sessionKey: `agent:${agentId}:parent-smoke`,
			workMountDir: '/zone/agents/smoke',
			zoneId: options.zoneId,
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});
	if (!response.ok) {
		throw new Error(
			`Parent lease request failed HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
}

async function publishOpenClawRuntimeStatus(options: {
	readonly controllerUrl: string;
	readonly openClawConfigPath: string;
	readonly zoneId: string;
}): Promise<void> {
	const parsedConfig: unknown = JSON.parse(await fs.readFile(options.openClawConfigPath, 'utf8'));
	if (!isObjectRecord(parsedConfig)) {
		throw new Error(`Expected OpenClaw smoke config at ${options.openClawConfigPath}.`);
	}
	const response = await fetch(
		`${options.controllerUrl}/zones/${encodeURIComponent(options.zoneId)}/openclaw-runtime-status`,
		{
			body: JSON.stringify(
				buildOpenClawRuntimeStatusReport({
					config: parsedConfig,
					zoneId: options.zoneId,
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

async function waitForControllerLease(options: {
	readonly agentId: string;
	readonly controllerUrl: string;
	readonly diagnostic: string;
	readonly timeoutMs: number;
}): Promise<unknown> {
	const deadline = Date.now() + options.timeoutMs;
	let lastPayload: unknown;
	while (Date.now() < deadline) {
		lastPayload = await readControllerLeases(options.controllerUrl);
		if (JSON.stringify(lastPayload).includes(`"agentId":"${options.agentId}"`)) {
			return lastPayload;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(
		`Timed out waiting for controller lease for agent ${options.agentId}; last /leases payload: ${JSON.stringify(
			lastPayload,
		)}; diagnostic: ${options.diagnostic}`,
	);
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
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT;
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
const guestPort = process.env.OPENCLAW_GUEST_PORT;
const agentId = process.env.OPENCLAW_SUBAGENT_SMOKE_AGENT;
const contextWorkspaceDir = process.env.OPENCLAW_SUBAGENT_SMOKE_CONTEXT_WORKSPACE;
const marker = process.env.OPENCLAW_SUBAGENT_SMOKE_MARKER;

if (!packageRoot || !gatewayToken || !guestPort || !agentId || !contextWorkspaceDir || !marker) {
	throw new Error('Missing OpenClaw subagent smoke environment.');
}

const configPath = process.env.OPENCLAW_CONFIG_PATH ?? '/home/openclaw/.openclaw/state/effective-openclaw.json';
const parsedConfig = JSON.parse(await readFile(configPath, 'utf8'));
const distDir = path.join(packageRoot, 'dist');
const distFiles = await readdir(distDir);
const subagentChunk = distFiles.find((fileName) =>
	fileName.startsWith('subagent-spawn-') && fileName.endsWith('.js')
);
if (!subagentChunk) {
	throw new Error('Unable to locate OpenClaw subagent-spawn chunk.');
}

const subagentModule = await import(pathToFileURL(path.join(distDir, subagentChunk)).href);
const { callGateway } = await import('openclaw/plugin-sdk/testing');
void gatewayToken;
void guestPort;
void parsedConfig;
const spawnSubagentDirect = subagentModule.spawnSubagentDirect ?? subagentModule.t;
if (typeof spawnSubagentDirect !== 'function') {
	throw new Error('OpenClaw subagent-spawn chunk does not export spawnSubagentDirect.');
}
const spawnResult = await spawnSubagentDirect({
	agentId,
	cleanup: 'keep',
	context: 'isolated',
	expectsCompletionMessage: false,
	mode: 'run',
	runTimeoutSeconds: 120,
	task: \`Reply exactly \${marker} and nothing else.\`,
	thinking: 'low',
}, {
	agentSessionKey: \`agent:\${agentId}:main\`,
	workspaceDir: contextWorkspaceDir,
});
let waitResponse = null;
let historyResponse = null;
if (spawnResult.status === 'accepted') {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		waitResponse = await callGateway({
			method: 'agent.wait',
			mode: 'backend',
			params: {
				runId: spawnResult.runId,
				timeoutMs: 15000,
			},
			timeoutMs: 20000,
			token: gatewayToken,
			url: \`ws://127.0.0.1:\${guestPort}\`,
		});
		historyResponse = await callGateway({
			method: 'chat.history',
			mode: 'backend',
			params: {
				limit: 20,
				maxChars: 20000,
				sessionKey: spawnResult.childSessionKey,
			},
			timeoutMs: 20000,
			token: gatewayToken,
			url: \`ws://127.0.0.1:\${guestPort}\`,
		});
		if (JSON.stringify(historyResponse).includes(marker)) {
			break;
		}
		if (waitResponse && typeof waitResponse === 'object' && waitResponse.status === 'error') {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}
console.log('AGENT_VM_SUBAGENT_SMOKE_RESULT ' + JSON.stringify({
	childSessionKey: spawnResult.childSessionKey,
	contextWorkspaceDir,
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
			`OpenClaw subagent smoke probe failed with exit ${String(result.exitCode)}.\nstdout:\n${
				result.stdout
			}\nstderr:\n${result.stderr}`,
		);
	}
	return parseSubagentSpawnProbeResult(result.stdout);
}

describeOpenClawSubagentSmoke('smoke: OpenClaw subagent Tool VM lease path', () => {
	let harness: SmokeHarnessRuntime | undefined;
	let project: OpenClawSmokeProject | undefined;
	let gatewayVm: ManagedVm | undefined;
	let gatewayGuestListenPort: number | undefined;
	const observedLeaseRequests: ObservedLeaseCreateRequest[] = [];

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		rebuildWorkspacePackages(repoRoot);
		project = await scaffoldOpenClawSmokeProject({
			agents: [agentId],
			architecture,
			prefix: 'openclaw-subagent-lease-smoke-',
			zoneId: 'subagent-lease-smoke',
		});
		const systemZone = project.systemConfig.zones[0];
		if (!systemZone || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw subagent smoke project to contain an OpenClaw zone.');
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
		systemZone.gateway.rawEnvSecrets = [
			...(systemZone.gateway.rawEnvSecrets ?? []),
			'OPENAI_API_KEY',
		];
		await fs.mkdir(path.join(systemZone.gateway.zoneFilesDir, 'agents', agentId), {
			recursive: true,
		});
		await useLocalOpenClawGatewayImagePackages({
			profileName: systemZone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		await runBuildCommand({
			forceRebuild: true,
			systemConfig: project.systemConfig,
		});
		harness = await startSmokeControllerRuntime({
			onLeaseCreateRequest: (request) => {
				observedLeaseRequests.push({
					agentId: request.agentId,
					agentWorkspaceDir: request.agentWorkspaceDir,
					workMountDir: request.workMountDir,
					zoneId: request.zoneId,
				});
			},
			secrets: {
				GITHUB_TOKEN: 'unused-subagent-smoke-token',
				OPENAI_API_KEY: 'subagent-smoke-mock-openai-token',
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-subagent-smoke-perplexity-token',
			},
			startGatewayZone: async (startGatewayOptions) => {
				const result = await startGatewayZone(startGatewayOptions);
				gatewayVm = result.vm;
				gatewayGuestListenPort = result.processSpec.guestListenPort;
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
				await removeSmokeTempRoot(project.tempRoot);
			}
		}
	});

	it('runs a same-agent subagent without sending /workspace as controller workMountDir', async () => {
		if (gatewayVm === undefined || gatewayGuestListenPort === undefined || harness === undefined) {
			throw new Error('Expected smoke harness to be initialized.');
		}
		await startMockOpenAiServerInGateway({
			gatewayVm,
			port: mockOpenAiPort,
		});
		await publishOpenClawRuntimeStatus({
			controllerUrl: harness.controllerUrl,
			openClawConfigPath: harness.systemConfig.zones[0]?.gateway.config ?? '',
			zoneId: 'subagent-lease-smoke',
		});
		await requestControllerLease({
			controllerUrl: harness.controllerUrl,
			zoneId: 'subagent-lease-smoke',
		});
		observedLeaseRequests.length = 0;

		const spawnResults: OpenClawSubagentSpawnProbeResult[] = [];
		for (const contextWorkspaceDir of ['/workspace', '/workspace/subdir', '/work/tmp']) {
			spawnResults.push(
				await runOpenClawSubagentSpawnProbe({
					agentId,
					contextWorkspaceDir,
					gatewayVm,
					guestListenPort: gatewayGuestListenPort,
					marker: 'SUBAGENT_LEASE_SMOKE_OK',
				}),
			);
		}

		for (const spawnResult of spawnResults) {
			expect(spawnResult.childSessionKey).toContain(`agent:${agentId}:subagent:`);
			expect(spawnResult.error ?? '').not.toContain('outside-allowed-roots');
			expect(spawnResult.error ?? '').not.toContain('/workspace');
			expect(JSON.stringify(spawnResult.historyResponse)).toContain('SUBAGENT_LEASE_SMOKE_OK');
		}

		const leasePayload = await waitForControllerLease({
			agentId,
			controllerUrl: harness.controllerUrl,
			diagnostic: JSON.stringify(spawnResults),
			timeoutMs: 120_000,
		});
		expect(JSON.stringify(leasePayload)).toContain(`"agentId":"${agentId}"`);
		expect(
			Array.isArray(leasePayload)
				? leasePayload.filter((lease) => isObjectRecord(lease) && lease.agentId === agentId)
				: [],
		).toHaveLength(1);
		expect(observedLeaseRequests).toEqual(
			Array.from({ length: spawnResults.length }, () => ({
				agentId,
				agentWorkspaceDir: '/zone/agents/smoke',
				workMountDir: '/zone/agents/smoke',
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
});
