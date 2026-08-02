import fs from 'node:fs/promises';

import {
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER,
	gatewayRuntimeSandboxWriteReadE2eTestExports,
} from '@agent-vm/openclaw-agent-vm-plugin';

import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';
import type { E2eHarnessRuntime } from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';

type GatewayCommandExecutor = Pick<GatewayZoneVmOperations, 'exec'>;

export const openClawControlRecoveryFrameworkResponseMarker = 'OPENCLAW_CONTROL_RECOVERY_MODEL_OK';
export const openClawControlRecoverySandboxExecOutputMarker =
	'OPENCLAW_CONTROL_RECOVERY_SANDBOX_EXEC_OK';

interface ActiveOperationConnectionLoss {
	readonly kind: 'connection-loss';
	readonly message: string;
}

interface ActiveOperationResponse {
	readonly bodyText: string;
	readonly kind: 'response';
	readonly status: number;
}

export type OpenClawActiveOperationOutcome =
	| ActiveOperationConnectionLoss
	| ActiveOperationResponse;

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function startOpenClawControlRecoveryActiveOperation(options: {
	readonly agentId: string;
	readonly filePath: string;
	readonly gatewayToken: string;
	readonly harness: E2eHarnessRuntime;
	readonly marker: string;
	readonly probeSigningKey: string;
	readonly sentinelFilePath: string;
	readonly sessionKey: string;
}): Promise<OpenClawActiveOperationOutcome> {
	const ingress = options.harness.runtime.zones[0]?.gateway?.ingress;
	if (ingress === undefined) {
		throw new Error('Control-session recovery E2E did not expose Gateway ingress.');
	}
	const bodyText = JSON.stringify({
		action: 'active-operation-containment',
		agentId: options.agentId,
		filePath: options.filePath,
		marker: options.marker,
		sentinelFilePath: options.sentinelFilePath,
		sessionKey: options.sessionKey,
	});
	return fetch(
		`http://${ingress.host}:${String(ingress.port)}${AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH}`,
		{
			body: bodyText,
			headers: {
				authorization: `Bearer ${options.gatewayToken}`,
				'content-type': 'application/json',
				[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER]:
					gatewayRuntimeSandboxWriteReadE2eTestExports.signBody(bodyText, options.probeSigningKey),
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

export async function waitForOpenClawCommittedSentinelWhileRequestIsActive(options: {
	readonly expectedMarker: string;
	readonly requestOutcome: Promise<OpenClawActiveOperationOutcome>;
	readonly sentinelPath: string;
}): Promise<void> {
	const waitForSentinel = async (): Promise<void> => {
		const deadlineMs = Date.now() + 60_000;
		while (Date.now() < deadlineMs) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- the sentinel has no event source outside the Tool VM
				const markerLines = (await fs.readFile(options.sentinelPath, 'utf8'))
					.split('\n')
					.filter((line) => line.length > 0);
				if (markerLines.includes(options.expectedMarker)) return;
			} catch (error: unknown) {
				if (!isObjectRecord(error) || error.code !== 'ENOENT') throw error;
			}
			// oxlint-disable-next-line no-await-in-loop -- named protocol retry keeps this polling bounded
			await waitForProtocolRetryInterval(100);
		}
		throw new Error(`Timed out waiting for committed sentinel '${options.sentinelPath}'.`);
	};
	await Promise.race([
		waitForSentinel(),
		options.requestOutcome.then((outcome) => {
			const details =
				outcome.kind === 'response'
					? `HTTP ${String(outcome.status)}: ${outcome.bodyText}`
					: `connection loss: ${outcome.message}`;
			throw new Error(
				`Active operation completed before its committed sentinel was visible (${details}).`,
			);
		}),
	]);
}

export async function runOpenClawControlRecoveryAgentRequest(options: {
	readonly expectedHistoryMarker: string;
	readonly gatewayVm: GatewayCommandExecutor;
	readonly message: string;
	readonly requiredToolOutputMarker?: string;
}): Promise<void> {
	const result = await options.gatewayVm.exec(`
set -eu
. /run/agent-vm/managed-gateway-environment/openclaw-all-secrets.environment.sh
OPENCLAW_PROOF_EXPECTED_HISTORY_MARKER=${shellSingleQuote(options.expectedHistoryMarker)} \\
OPENCLAW_PROOF_MESSAGE=${shellSingleQuote(options.message)} \\
OPENCLAW_PROOF_REQUIRED_TOOL_OUTPUT_MARKER=${shellSingleQuote(options.requiredToolOutputMarker ?? '')} \\
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
if (!gatewayToken) throw new Error('missing OpenClaw Gateway token');
const expectedHistoryMarker = process.env.OPENCLAW_PROOF_EXPECTED_HISTORY_MARKER;
const proofMessage = process.env.OPENCLAW_PROOF_MESSAGE;
	const requiredToolOutputMarker = process.env.OPENCLAW_PROOF_REQUIRED_TOOL_OUTPUT_MARKER;
	if (!expectedHistoryMarker || !proofMessage) throw new Error('missing OpenClaw proof request inputs');
	const requireSandboxAdapter = Boolean(requiredToolOutputMarker);
const socket = new WebSocket('ws://127.0.0.1:18789');
const pending = new Map();
let nextId = 1;
const timeout = setTimeout(() => {
  socket.close();
  process.exitCode = 1;
}, 90000);
function request(method, params, timeoutMs = 20000) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    const requestTimeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('OpenClaw request timed out: ' + method));
    }, timeoutMs);
    pending.set(id, { resolve, reject, requestTimeout });
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}
socket.addEventListener('message', async (event) => {
  const frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
  if (frame.type === 'event' && frame.event === 'connect.challenge') {
    try {
      await request('connect', {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: 'gateway-client',
          displayName: 'agent-vm-control-recovery',
          version: 'agent-vm-e2e',
          platform: process.platform,
          mode: 'backend',
          instanceId: crypto.randomUUID(),
        },
        caps: [],
        commands: [],
        permissions: {},
        auth: { token: gatewayToken },
        role: 'operator',
        scopes: ['operator.read', 'operator.write', 'operator.admin'],
      });
	      const sessionKey = requireSandboxAdapter
	        ? 'agent:main:subagent:control-recovery-tool-' + Date.now().toString(36)
	        : 'agent:main:control-recovery:model-request-' + Date.now().toString(36);
	      if (requireSandboxAdapter) {
	        const lineagePatchResult = await request('sessions.patch', {
	          key: sessionKey,
	          spawnDepth: 1,
	          spawnedBy: 'agent:main:main',
	          spawnedWorkspaceDir: '/workspace',
	          subagentControlScope: 'none',
	          subagentRole: 'leaf',
	        });
	        if (!lineagePatchResult || typeof lineagePatchResult !== 'object' || lineagePatchResult.ok !== true) {
	          throw new Error('OpenClaw sessions.patch did not admit the sandboxed proof session');
	        }
	      }
	      const agentResult = await request('agent', {
        agentId: 'main',
        cleanupBundleMcpOnRunEnd: true,
        idempotencyKey: 'control-recovery-' + crypto.randomUUID(),
        label: 'agent-vm-control-recovery-model-proof',
	        lane: requireSandboxAdapter ? 'subagent' : 'main',
        message: proofMessage,
        sessionKey,
        thinking: 'off',
        timeout: 60,
      }, 65000);
      if (!agentResult || typeof agentResult !== 'object' || typeof agentResult.runId !== 'string') {
        throw new Error('OpenClaw agent request did not return a run id');
      }
      const runId = agentResult.runId;
      const deadline = Date.now() + 60000;
      let history;
      while (Date.now() < deadline) {
        await request('agent.wait', { runId, timeoutMs: 10000 }, 15000);
        history = await request('chat.history', { limit: 20, maxChars: 20000, sessionKey });
        if (JSON.stringify(history).includes(expectedHistoryMarker)) break;
      }
	      const requestLog = await readFile('/tmp/agent-vm-control-recovery-mock-openai-requests.jsonl', 'utf8');
	      if (!JSON.stringify(history).includes(expectedHistoryMarker)) {
	        throw new Error('OpenClaw model marker was absent from production chat history; model request log:\\n' + requestLog);
	      }
      if (!requestLog.includes('"path":"/v1/responses"')) throw new Error('mock provider did not observe a responses request');
	      if (requiredToolOutputMarker && !requestLog.split('\\n').some((line) =>
        line.includes('"hasFunctionCallOutput":true') && line.includes(requiredToolOutputMarker)
      )) {
        throw new Error('normal OpenClaw Sandbox adapter output was absent from the model continuation');
      }
      clearTimeout(timeout);
      console.log('OPENCLAW_FRAMEWORK_MODEL_OK');
      socket.close();
    } catch (error) {
      clearTimeout(timeout);
      console.error(error);
      socket.close();
      process.exitCode = 1;
    }
    return;
  }
  if (frame.type !== 'res' || typeof frame.id !== 'string') return;
  const waiter = pending.get(frame.id);
  if (!waiter) return;
  pending.delete(frame.id);
  clearTimeout(waiter.requestTimeout);
  if (frame.ok === true) waiter.resolve(frame.payload);
  else waiter.reject(new Error(frame.error?.message ?? 'OpenClaw framework request failed'));
});
socket.addEventListener('error', () => {
  clearTimeout(timeout);
  process.exitCode = 1;
});
NODE
`);
	if (result.exitCode !== 0 || !result.stdout.includes('OPENCLAW_FRAMEWORK_MODEL_OK')) {
		throw new Error(
			`OpenClaw framework model interaction failed with exit ${String(result.exitCode)}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
}

export async function configureOpenClawControlRecoveryModel(options: {
	readonly configPath: string;
	readonly mockPort: number;
}): Promise<void> {
	const config = JSON.parse(await fs.readFile(options.configPath, 'utf8')) as Record<
		string,
		unknown
	>;
	const existingAgents = isObjectRecord(config.agents) ? config.agents : {};
	const existingDefaults = isObjectRecord(existingAgents.defaults) ? existingAgents.defaults : {};
	const existingModels = isObjectRecord(config.models) ? config.models : {};
	const existingProviders = isObjectRecord(existingModels.providers)
		? existingModels.providers
		: {};
	config.models = {
		...existingModels,
		mode: 'merge',
		providers: {
			...existingProviders,
			openai: {
				api: 'openai-responses',
				apiKey: { id: 'OPENAI_API_KEY', provider: 'default', source: 'env' },
				baseUrl: `http://127.0.0.1:${String(options.mockPort)}/v1`,
				models: [
					{
						api: 'openai-responses',
						contextTokens: 96_000,
						contextWindow: 128_000,
						cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
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
				...(isObjectRecord(existingDefaults.models) ? existingDefaults.models : {}),
				'openai/gpt-5.5': {
					params: { openaiWsWarmup: false, transport: 'sse' },
				},
			},
		},
	};
	await fs.writeFile(options.configPath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
}

export async function startOpenClawControlRecoveryModelServer(options: {
	readonly gatewayVm: GatewayCommandExecutor;
	readonly port: number;
}): Promise<void> {
	const result = await options.gatewayVm.exec(`
set -eu
cat >/tmp/agent-vm-control-recovery-mock-openai.mjs <<'NODE'
import { appendFile, writeFile } from 'node:fs/promises';
import http from 'node:http';

	const port = Number(process.env.MOCK_OPENAI_PORT);
	const requestLog = '/tmp/agent-vm-control-recovery-mock-openai-requests.jsonl';
	const readyPath = '/tmp/agent-vm-control-recovery-mock-openai.ready';
	const frameworkResponseMarker = ${JSON.stringify(openClawControlRecoveryFrameworkResponseMarker)};
	const sandboxExecOutputMarker = ${JSON.stringify(openClawControlRecoverySandboxExecOutputMarker)};
	const sandboxExecCallId = 'call_control_recovery_sandbox_exec';
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
function writeJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
function writeSse(response, events) {
	  response.writeHead(200, { 'cache-control': 'no-store', connection: 'keep-alive', 'content-type': 'text/event-stream' });
	  for (const event of events) response.write('data: ' + JSON.stringify(event) + '\\n\\n');
	  response.write('data: [DONE]\\n\\n');
	  response.end();
	}
	function writeModelResponse(response) {
  const events = [
    {
      type: 'response.output_item.added',
      item: { type: 'message', id: 'msg_control_recovery', role: 'assistant', content: [], status: 'in_progress' },
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message', id: 'msg_control_recovery', role: 'assistant', status: 'completed',
	        content: [{ type: 'output_text', text: frameworkResponseMarker, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_control_recovery', status: 'completed',
        usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18, input_tokens_details: { cached_tokens: 0 } },
      },
    },
  ];
	  writeSse(response, events);
	}
	function writeSandboxExecRequest(response) {
	  const itemId = 'fc_' + sandboxExecCallId;
	  const encodedMarker = Buffer.from(sandboxExecOutputMarker, 'utf8').toString('base64');
	  const argumentsJson = JSON.stringify({
	    command: "printf '%s' '" + encodedMarker + "' | base64 -d",
	  });
	  writeSse(response, [
	    {
	      type: 'response.output_item.added',
	      item: {
	        type: 'function_call', id: itemId, call_id: sandboxExecCallId,
	        name: 'exec', arguments: '',
	      },
	    },
	    { type: 'response.function_call_arguments.delta', delta: argumentsJson },
	    {
	      type: 'response.output_item.done',
	      item: {
	        type: 'function_call', id: itemId, call_id: sandboxExecCallId,
	        name: 'exec', arguments: argumentsJson,
	      },
	    },
	    {
	      type: 'response.completed',
	      response: { id: 'resp_control_recovery_tool_call', status: 'completed' },
	    },
	  ]);
	}
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') {
    writeJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    writeJson(response, 200, { object: 'list', data: [{ id: 'gpt-5.5', object: 'model', owned_by: 'agent-vm-e2e' }] });
    return;
  }
	  const body = await readBody(request);
	  let requestBody;
	  try {
	    requestBody = JSON.parse(body);
	  } catch {
	    requestBody = undefined;
	  }
	  const functionCallOutput = Array.isArray(requestBody?.input)
	    ? requestBody.input.find((item) => item?.type === 'function_call_output')
	    : undefined;
	  await appendFile(requestLog, JSON.stringify({
	    method: request.method,
	    path: url.pathname,
	    bodyBytes: body.length,
	    hasFunctionCallOutput: functionCallOutput !== undefined,
	    functionCallOutputCallId:
	      typeof functionCallOutput?.call_id === 'string' ? functionCallOutput.call_id : undefined,
	    functionCallOutput:
	      typeof functionCallOutput?.output === 'string'
	        ? functionCallOutput.output.slice(0, 4000)
	        : undefined,
	  }) + '\\n');
	  if (request.method === 'POST' && url.pathname === '/v1/responses') {
	    if (functionCallOutput !== undefined) {
	      if (
	        functionCallOutput.call_id !== sandboxExecCallId ||
	        typeof functionCallOutput.output !== 'string' ||
	        !functionCallOutput.output.includes(sandboxExecOutputMarker)
	      ) {
	        writeJson(response, 500, {
	          error: { message: 'sandbox exec continuation identity or output marker was invalid' },
	        });
	        return;
	      }
	      writeModelResponse(response);
	      return;
	    }
	    if (body.includes(sandboxExecOutputMarker)) {
	      writeSandboxExecRequest(response);
	      return;
	    }
	    writeModelResponse(response);
	    return;
  }
  writeJson(response, 404, { error: { message: 'unhandled mock route' } });
});
server.listen(port, '127.0.0.1', () => {
  void writeFile(readyPath, 'ready\\n', 'utf8').catch((error) => {
    console.error(error);
    process.exitCode = 1;
    server.close();
  });
});
NODE
rm -f /tmp/agent-vm-control-recovery-mock-openai.ready /tmp/agent-vm-control-recovery-mock-openai-requests.jsonl
MOCK_OPENAI_PORT=${shellSingleQuote(String(options.port))} node /tmp/agent-vm-control-recovery-mock-openai.mjs >/tmp/agent-vm-control-recovery-mock-openai.log 2>&1 &
echo "$!" >/tmp/agent-vm-control-recovery-mock-openai.pid
MOCK_OPENAI_PORT=${shellSingleQuote(String(options.port))} node --input-type=module <<'NODE'
import { access, readFile, watch } from 'node:fs/promises';
const readyPath = '/tmp/agent-vm-control-recovery-mock-openai.ready';
const logPath = '/tmp/agent-vm-control-recovery-mock-openai.log';
const readyFileExists = () => access(readyPath).then(() => true, () => false);
if (!(await readyFileExists())) {
  const readinessDeadlineSignal = AbortSignal.timeout(30000);
  try {
    for await (const _event of watch('/tmp', { signal: readinessDeadlineSignal })) {
      if (await readyFileExists()) break;
    }
  } catch (error) {
    if (!readinessDeadlineSignal.aborted) throw error;
  }
  if (!(await readyFileExists())) {
    const startupLog = await readFile(logPath, 'utf8').catch(() => '(missing)');
    throw new Error('mock OpenAI server did not become ready:\\n' + startupLog);
  }
}
const response = await fetch('http://127.0.0.1:' + process.env.MOCK_OPENAI_PORT + '/health');
if (!response.ok) throw new Error('mock OpenAI health returned HTTP ' + response.status);
NODE
`);
	if (result.exitCode !== 0) {
		throw new Error(
			`Mock OpenAI server failed to start with exit ${String(result.exitCode)}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
}
