import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';

export async function startHermesDeterministicToolCallModelServer(options: {
	readonly frameworkMarker: string;
	readonly port: number;
	readonly toolVmMarker: string;
	readonly vm: Pick<GatewayZoneVmOperations, 'exec'>;
}): Promise<void> {
	const result = await options.vm.exec(`
set -eu
cat >/tmp/agent-vm-hermes-recovery-model.mjs <<'NODE'
import http from 'node:http';
import fs from 'node:fs';

const port = ${String(options.port)};
const frameworkMarker = ${JSON.stringify(options.frameworkMarker)};
const toolVmMarker = ${JSON.stringify(options.toolVmMarker)};
const readyPath = '/tmp/agent-vm-hermes-recovery-model.ready';

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function completionChunk(delta, finishReason = null) {
  return {
    id: 'chatcmpl-hermes-recovery',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'hermes-e2e',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeSse(response, chunks) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) response.write('data: ' + JSON.stringify(chunk) + '\\n\\n');
  response.end('data: [DONE]\\n\\n');
}

function writeJson(response, message, finishReason) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    id: 'chatcmpl-hermes-recovery',
    object: 'chat.completion',
    created: 1,
    model: 'hermes-e2e',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await readBody(request));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolResult = messages.find((message) => message?.role === 'tool');
  const wantsToolVm = messages.some(
    (message) => typeof message?.content === 'string' && message.content.includes('RUN_TOOL_VM_RECOVERY_PROBE'),
  );
  if (toolResult !== undefined) {
    const serializedToolResult = typeof toolResult.content === 'string'
      ? toolResult.content
      : JSON.stringify(toolResult.content);
    if (!serializedToolResult.includes(toolVmMarker)) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: 'Tool VM marker was absent from Hermes tool output: ' + serializedToolResult.slice(0, 1000),
        },
      }));
      return;
    }
    const message = { role: 'assistant', content: toolVmMarker };
    if (body.stream === true) {
      writeSse(response, [completionChunk({ role: 'assistant', content: toolVmMarker }), completionChunk({}, 'stop')]);
    } else {
      writeJson(response, message, 'stop');
    }
    return;
  }
  if (wantsToolVm) {
    const argumentsJson = JSON.stringify({
      command: "printf '%s' '" + toolVmMarker + "'",
      workdir: '/work',
    });
    const toolCall = {
      id: 'call-hermes-tool-vm-recovery',
      type: 'function',
      function: { name: 'terminal', arguments: argumentsJson },
    };
    if (body.stream === true) {
      writeSse(response, [
        completionChunk({ role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }),
        completionChunk({}, 'tool_calls'),
      ]);
    } else {
      writeJson(response, { role: 'assistant', content: null, tool_calls: [toolCall] }, 'tool_calls');
    }
    return;
  }
  const message = { role: 'assistant', content: frameworkMarker };
  if (body.stream === true) {
    writeSse(response, [completionChunk({ role: 'assistant', content: frameworkMarker }), completionChunk({}, 'stop')]);
  } else {
    writeJson(response, message, 'stop');
  }
});

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(readyPath, 'ready\\n', 'utf8');
  process.stdout.write('ready\\n');
});
NODE
rm -f /tmp/agent-vm-hermes-recovery-model.ready
node /tmp/agent-vm-hermes-recovery-model.mjs >/tmp/agent-vm-hermes-recovery-model.log 2>&1 &
echo "$!" >/tmp/agent-vm-hermes-recovery-model.pid
node --input-type=module <<'NODE'
import { once } from 'node:events';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';

const readyPath = '/tmp/agent-vm-hermes-recovery-model.ready';
const logPath = '/tmp/agent-vm-hermes-recovery-model.log';
const readinessDeadlineMs = Date.now() + 60000;
if (!fs.existsSync(readyPath)) {
  const watcher = fs.watch('/tmp');
  try {
    while (!fs.existsSync(readyPath)) {
      if (Date.now() >= readinessDeadlineMs) {
        const startupLog = await readFile(logPath, 'utf8').catch(() => '(missing)');
        throw new Error('Hermes deterministic model server did not become ready:\\n' + startupLog);
      }
      await once(watcher, 'change', { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
    }
  } finally {
    watcher.close();
  }
}
NODE
`);
	if (!result.ok) {
		throw new Error(
			`Hermes deterministic model server failed to start: exit=${String(result.exitCode)} stderr=${result.stderr}`,
		);
	}
}
