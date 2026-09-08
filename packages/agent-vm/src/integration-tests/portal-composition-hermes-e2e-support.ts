/* oxlint-disable eslint/no-await-in-loop -- readiness probes must remain sequential */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';

interface PortalCompositionModelServer {
	readonly close: () => Promise<void>;
	readonly executeCodeRequestCount: () => number;
	readonly latestExecuteCodeResult: () => string | undefined;
	readonly port: number;
}

function completionChunk(
	delta: Readonly<Record<string, unknown>>,
	finishReason: string | null,
): Readonly<Record<string, unknown>> {
	return {
		choices: [{ delta, finish_reason: finishReason, index: 0 }],
		created: 1,
		id: 'portal-composition-hermes-e2e',
		model: 'portal-composition-hermes-e2e',
		object: 'chat.completion.chunk',
	};
}

function writeServerSentEvents(
	response: ServerResponse,
	chunks: readonly Readonly<Record<string, unknown>>[],
): void {
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end('data: [DONE]\n\n');
}

async function readRequestBody(
	request: IncomingMessage,
): Promise<Readonly<Record<string, unknown>>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Portal composition model expected an object request.');
	}
	return value as Readonly<Record<string, unknown>>;
}

function latestToolResult(requestBody: Readonly<Record<string, unknown>>): string | undefined {
	if (!Array.isArray(requestBody.messages)) return undefined;
	const messages = requestBody.messages as readonly unknown[];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== 'object' || message === null || Array.isArray(message)) continue;
		const record = message as Readonly<Record<string, unknown>>;
		if (record.role === 'user') return undefined;
		if (record.role === 'tool') {
			return typeof record.content === 'string' ? record.content : JSON.stringify(record.content);
		}
	}
	return undefined;
}

function latestUserContent(requestBody: Readonly<Record<string, unknown>>): string | undefined {
	if (!Array.isArray(requestBody.messages)) return undefined;
	const messages = requestBody.messages as readonly unknown[];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== 'object' || message === null || Array.isArray(message)) continue;
		const record = message as Readonly<Record<string, unknown>>;
		if (record.role === 'user' && typeof record.content === 'string') return record.content;
	}
	return undefined;
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});
}

export async function startPortalCompositionModelServer(options: {
	readonly compositionProgram: string;
	readonly finalMarker: string;
	readonly promptMarker: string;
	readonly programResultMarker: string;
}): Promise<PortalCompositionModelServer> {
	let executeCodeRequestCount = 0;
	let latestExecuteCodeResult: string | undefined;
	const server = createServer((request, response) => {
		void (async () => {
			if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
				response.writeHead(404).end();
				return;
			}
			const body = await readRequestBody(request);
			if (!Array.isArray(body.tools)) {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify({
						choices: [
							{
								finish_reason: 'stop',
								index: 0,
								message: {
									content: JSON.stringify({ title: 'Portal composition E2E' }),
									role: 'assistant',
								},
							},
						],
						created: 1,
						id: 'portal-composition-title',
						model: 'portal-composition-hermes-e2e',
						object: 'chat.completion',
						usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
					}),
				);
				return;
			}
			if (!latestUserContent(body)?.includes(options.promptMarker)) {
				writeServerSentEvents(response, [
					completionChunk(
						{ content: 'portal-composition-auxiliary-complete', role: 'assistant' },
						null,
					),
					completionChunk({}, 'stop'),
				]);
				return;
			}
			const toolResult = latestToolResult(body);
			if (toolResult === undefined) {
				const instructions = JSON.stringify(body.messages) ?? '';
				for (const required of [
					'connect_tool_portal()',
					'connectToolPortal()',
					'/agent-vm/tool-portal.md',
					'the endpoint expires when it ends',
				]) {
					if (!instructions.includes(required)) {
						throw new Error(`Hermes omitted composition guidance before execution: ${required}`);
					}
				}
				if (instructions.includes('portal-composition-fixture-token')) {
					throw new Error('Hermes exposed the fixture credential value in model instructions.');
				}
				const hasExecuteCode = body.tools.some(
					(tool) =>
						typeof tool === 'object' &&
						tool !== null &&
						!Array.isArray(tool) &&
						typeof (tool as { readonly function?: unknown }).function === 'object' &&
						(tool as { readonly function: { readonly name?: unknown } }).function.name ===
							'execute_code',
				);
				if (!hasExecuteCode)
					throw new Error('Hermes omitted execute_code from the model tool set.');
				executeCodeRequestCount += 1;
				const toolCall = {
					function: {
						arguments: JSON.stringify({ code: options.compositionProgram }),
						name: 'execute_code',
					},
					id: 'portal-composition-execute-code',
					index: 0,
					type: 'function',
				};
				writeServerSentEvents(response, [
					completionChunk({ role: 'assistant', tool_calls: [toolCall] }, null),
					completionChunk({}, 'tool_calls'),
				]);
				return;
			}
			latestExecuteCodeResult = toolResult;
			if (!toolResult.includes(options.programResultMarker)) {
				throw new Error(
					`execute_code omitted the portal composition marker: ${toolResult.slice(0, 2_000)}`,
				);
			}
			writeServerSentEvents(response, [
				completionChunk({ content: options.finalMarker, role: 'assistant' }, null),
				completionChunk({}, 'stop'),
			]);
		})().catch((error: unknown) => {
			if (response.headersSent) {
				response.destroy(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			response.writeHead(500, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({
					error: { message: error instanceof Error ? error.message : String(error) },
				}),
			);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		await closeServer(server);
		throw new Error('Portal composition model server did not bind a loopback port.');
	}
	return {
		close: async () => closeServer(server),
		executeCodeRequestCount: () => executeCodeRequestCount,
		latestExecuteCodeResult: () => latestExecuteCodeResult,
		port: address.port,
	};
}

export async function waitForPortalCompositionHermesHealth(options: {
	readonly controllerUrl: string;
	readonly gatewayPort: number;
	readonly resolveVm: () => Pick<GatewayZoneVmOperations, 'exec'> | undefined;
	readonly zoneId: string;
}): Promise<void> {
	const deadline = Date.now() + 60_000;
	let lastError: string | undefined;
	let lastStatus: number | undefined;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${String(options.gatewayPort)}/health`, {
				signal: AbortSignal.timeout(2_000),
			});
			lastStatus = response.status;
			if (response.ok) return;
		} catch (error: unknown) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await waitForProtocolRetryInterval(250);
	}
	const serviceLog = await options
		.resolveVm()
		?.exec('tail -n 200 /var/log/agent-vm/hermes-service.log 2>&1 || true');
	const [zoneStatus, zoneLogs] = await Promise.all(
		['status', 'logs'].map(async (operation) => {
			try {
				const response = await fetch(
					`${options.controllerUrl}/zones/${encodeURIComponent(options.zoneId)}/${operation}`,
					{ signal: AbortSignal.timeout(5_000) },
				);
				return `${String(response.status)} ${await response.text()}`;
			} catch (error: unknown) {
				return error instanceof Error ? error.message : String(error);
			}
		}),
	);
	throw new Error(
		`Timed out waiting for portal composition Hermes health: ${JSON.stringify({ lastError, lastStatus, serviceLog: serviceLog?.stdout.toString(), zoneLogs, zoneStatus })}`,
	);
}

export async function requestPortalCompositionHermesTurn(options: {
	readonly agentId: string;
	readonly apiServerKey: string;
	readonly gatewayPort: number;
	readonly modelName: string;
	readonly prompt: string;
	readonly sessionId: string;
}): Promise<string> {
	const response = await fetch(
		`http://127.0.0.1:${String(options.gatewayPort)}/p/${options.agentId}/v1/chat/completions`,
		{
			body: JSON.stringify({
				messages: [{ content: options.prompt, role: 'user' }],
				model: options.modelName,
				stream: false,
			}),
			headers: {
				authorization: `Bearer ${options.apiServerKey}`,
				'content-type': 'application/json',
				'x-hermes-session-id': options.sessionId,
			},
			method: 'POST',
			signal: AbortSignal.timeout(180_000),
		},
	);
	if (!response.ok) {
		throw new Error(
			`Portal composition Hermes turn failed with HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
	return await response.text();
}
