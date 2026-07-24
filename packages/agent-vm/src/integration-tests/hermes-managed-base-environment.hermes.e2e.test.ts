/* oxlint-disable eslint/no-await-in-loop -- live profile turns are serialized to make isolation evidence deterministic */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import type { AgentVmHealthEvent, ZoneHealthSnapshot } from '@agent-vm/gateway-lifecycle';
import type { ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import { afterAll, describe, expect, it } from 'vitest';

import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../controller/durable-state/controller-state-paths.js';
import { resolveControllerGatewayRecordTargets } from '../controller/durable-state/controller-state-record-paths.js';
import { createControllerClient } from '../controller/http/controller-client.js';
import type { ObservedControllerLeaseCreateRequest } from '../controller/leases/observed-lease-create-request.js';
import {
	loadAllToolVmRuntimeRecords,
	type ToolVmRuntimeRecord,
} from '../controller/leases/tool-vm-runtime-record.js';
import {
	readManagedGatewaySiblingProcessIdentity,
	terminateManagedGatewaySibling,
} from '../controller/reliability/testing/gateway-reliability-fault-adapter.js';
import type { GatewayExpectedAdmissionCohort } from '../gateway/gateway-aggregate-admission-state.js';
import { loadManagedGatewayRuntimeRecord } from '../gateway/gateway-runtime-record.js';
import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';
import {
	canRunManagedVmE2e,
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	startE2eControllerRuntime,
	startE2eGatewayZoneForController as startGatewayZone,
	type E2eHarnessRuntime,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import {
	renderHermesManagedE2eConfiguration,
	scaffoldHermesE2eProject,
	useLocalHermesGatewayImagePackages,
	type HermesE2eProject,
} from './hermes-e2e-harness.js';

const architecture = currentE2eArchitecture();
const runHermesManagedEnvironmentE2e =
	process.env.AGENT_VM_HERMES_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeHermesManagedEnvironmentE2e = runHermesManagedEnvironmentE2e
	? describe
	: describe.skip;
const agentIds = ['main', 'beta'] as const;
const discordSecretEnvironmentNames = {
	beta: 'DISCORD_BOT_TOKEN_BETA_E2E',
	main: 'DISCORD_BOT_TOKEN_MAIN_E2E',
} as const;
const discordSecretCanaries = {
	beta: 'synthetic-beta-discord-tool-vm-exclusion-canary',
	main: 'synthetic-main-discord-tool-vm-exclusion-canary',
} as const;
const fakeModelContextLength = 65_536;
const fakeModelHost = 'hermes-model.vm.host';
const fakeModelName = 'hermes-e2e';
const webhookPort = 8644;
const webhookRoute = 'managed-environment-e2e';
const webhookSecret = 'hermes-managed-environment-e2e-secret';
const hermesPostStartupLogMarker = 'Press Ctrl+C to stop';
const requiredStockToolNames = [
	'execute_code',
	'process',
	'read_file',
	'terminal',
	'write_file',
] as const;

type AgentId = (typeof agentIds)[number];

const toolVmForbiddenEnvironmentDigests = [
	...Object.values(discordSecretEnvironmentNames),
	...Object.values(discordSecretCanaries),
].map((value) => createHash('sha256').update(value).digest('hex'));

interface OpenAiCompatibleToolCall {
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly name: (typeof requiredStockToolNames)[number];
}

interface FakeModelRequestObservation {
	readonly agentId: AgentId;
	readonly messageSnapshot: string;
	readonly toolMessageCount: number;
	readonly toolMessageContents: readonly string[];
	readonly toolNames: readonly string[];
}

interface FakeHermesModelServer {
	readonly port: number;
	readonly requests: readonly FakeModelRequestObservation[];
	close(): Promise<void>;
}

interface ZoneExecResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

interface ManagedGatewayStartObservation {
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly qemuPid: number;
	readonly vm: Pick<GatewayZoneVmOperations, 'exec' | 'getHostProcessId' | 'id'>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentId(value: string): value is AgentId {
	return agentIds.some((agentId) => agentId === value);
}

function requireZoneExecResult(value: unknown): ZoneExecResult {
	if (
		!isObjectRecord(value) ||
		typeof value.exitCode !== 'number' ||
		typeof value.stderr !== 'string' ||
		typeof value.stdout !== 'string'
	) {
		throw new Error(`Unexpected controller execute-command result: ${JSON.stringify(value)}`);
	}
	return {
		exitCode: value.exitCode,
		stderr: value.stderr,
		stdout: value.stdout,
	};
}

function latestHealthEvents(snapshot: ZoneHealthSnapshot): readonly AgentVmHealthEvent[] {
	return 'latestEvents' in snapshot ? snapshot.latestEvents : [];
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

function requireAgentId(messageSnapshot: string): AgentId {
	for (const agentId of agentIds) {
		if (messageSnapshot.includes(`PROFILE=${agentId}`)) {
			return agentId;
		}
	}
	throw new Error(`Hermes model request did not identify an admitted profile: ${messageSnapshot}`);
}

function openAiToolNames(requestBody: Record<string, unknown>): readonly string[] {
	if (!Array.isArray(requestBody.tools)) return [];
	return requestBody.tools.flatMap((tool): readonly string[] => {
		if (!isObjectRecord(tool) || !isObjectRecord(tool.function)) return [];
		return typeof tool.function.name === 'string' ? [tool.function.name] : [];
	});
}

function countToolMessages(requestBody: Record<string, unknown>): number {
	if (!Array.isArray(requestBody.messages)) return 0;
	return requestBody.messages.filter(
		(message) => isObjectRecord(message) && message.role === 'tool',
	).length;
}

function toolMessageContents(requestBody: Record<string, unknown>): readonly string[] {
	if (!Array.isArray(requestBody.messages)) return [];
	return requestBody.messages.flatMap((message): readonly string[] => {
		if (
			!isObjectRecord(message) ||
			message.role !== 'tool' ||
			typeof message.content !== 'string'
		) {
			return [];
		}
		return [message.content];
	});
}

function scriptedToolCall(agentId: AgentId, toolMessageCount: number): OpenAiCompatibleToolCall {
	const upperAgentId = agentId.toUpperCase();
	switch (toolMessageCount) {
		case 0:
			return {
				arguments: {
					command: [
						`python3 - ${toolVmForbiddenEnvironmentDigests.join(' ')} <<'PY'`,
						'import hashlib',
						'import os',
						'import sys',
						'forbidden = set(sys.argv[1:])',
						'observed = {hashlib.sha256(value.encode()).hexdigest() for item in os.environ.items() for value in item}',
						'if observed.intersection(forbidden):',
						'    raise SystemExit("forbidden Tool VM environment material")',
						'print("TOOL_VM_DISCORD_ENV_CLEAN")',
						'PY',
						`pwd && printf '%s\\n' 'TERMINAL_${upperAgentId}' > /workspace/${agentId}-terminal.txt`,
					].join('\n'),
				},
				name: 'terminal',
			};
		case 1:
			return {
				arguments: {
					content: `FILE_${upperAgentId}\n`,
					path: `/workspace/${agentId}-file.txt`,
				},
				name: 'write_file',
			};
		case 2:
			return {
				arguments: { path: `/workspace/${agentId}-file.txt` },
				name: 'read_file',
			};
		case 3:
			return {
				arguments: {
					code: [
						'from pathlib import Path',
						`Path("/workspace/${agentId}-code.txt").write_text("CODE_${upperAgentId}\\n")`,
						`print("CODE_${upperAgentId}")`,
					].join('\n'),
				},
				name: 'execute_code',
			};
		case 4:
			return {
				arguments: {
					background: true,
					command: `printf '%s\\n' 'BACKGROUND_${upperAgentId}' > /workspace/${agentId}-background.txt; sleep 120`,
				},
				name: 'terminal',
			};
		case 5:
			return {
				arguments: { action: 'list' },
				name: 'process',
			};
		default:
			throw new Error(`No scripted Hermes tool call exists for stage ${String(toolMessageCount)}.`);
	}
}

function writeSseData(response: ServerResponse, payload: unknown): void {
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeToolCallStream(options: {
	readonly agentId: AgentId;
	readonly response: ServerResponse;
	readonly toolCall: OpenAiCompatibleToolCall;
	readonly toolMessageCount: number;
}): void {
	const completionId = `chatcmpl-${options.agentId}-${String(options.toolMessageCount)}`;
	const baseChunk = {
		created: 0,
		id: completionId,
		model: fakeModelName,
		object: 'chat.completion.chunk',
	};
	writeSseData(options.response, {
		...baseChunk,
		choices: [
			{
				delta: { content: '', role: 'assistant' },
				finish_reason: null,
				index: 0,
			},
		],
	});
	writeSseData(options.response, {
		...baseChunk,
		choices: [
			{
				delta: {
					tool_calls: [
						{
							function: {
								arguments: JSON.stringify(options.toolCall.arguments),
								name: options.toolCall.name,
							},
							id: `call-${options.agentId}-${String(options.toolMessageCount)}`,
							index: 0,
							type: 'function',
						},
					],
				},
				finish_reason: null,
				index: 0,
			},
		],
	});
	writeSseData(options.response, {
		...baseChunk,
		choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
	});
	writeSseData(options.response, {
		...baseChunk,
		choices: [],
		usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
	});
	options.response.end('data: [DONE]\n\n');
}

function writeFinalTextStream(options: {
	readonly agentId: AgentId;
	readonly response: ServerResponse;
}): void {
	const baseChunk = {
		created: 0,
		id: `chatcmpl-${options.agentId}-complete`,
		model: fakeModelName,
		object: 'chat.completion.chunk',
	};
	writeSseData(options.response, {
		...baseChunk,
		choices: [
			{
				delta: { content: '', role: 'assistant' },
				finish_reason: null,
				index: 0,
			},
		],
	});
	writeSseData(options.response, {
		...baseChunk,
		choices: [
			{
				delta: { content: `PROFILE_COMPLETE=${options.agentId}` },
				finish_reason: null,
				index: 0,
			},
		],
	});
	writeSseData(options.response, {
		...baseChunk,
		choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
	});
	options.response.end('data: [DONE]\n\n');
}

async function handleFakeModelRequest(options: {
	readonly observations: FakeModelRequestObservation[];
	readonly request: IncomingMessage;
	readonly response: ServerResponse;
}): Promise<void> {
	if (options.request.method === 'GET' && options.request.url === '/v1/models') {
		options.response.writeHead(200, { 'content-type': 'application/json' });
		options.response.end(
			JSON.stringify({
				data: [
					{
						context_length: fakeModelContextLength,
						id: fakeModelName,
						object: 'model',
						owned_by: 'agent-vm-e2e',
					},
				],
				object: 'list',
			}),
		);
		return;
	}
	if (options.request.method !== 'POST' || options.request.url !== '/v1/chat/completions') {
		options.response.writeHead(404, { 'content-type': 'application/json' });
		options.response.end(JSON.stringify({ error: 'not found' }));
		return;
	}
	const rawRequestBody = await readRequestBody(options.request);
	const parsedRequestBody: unknown = JSON.parse(rawRequestBody);
	if (
		!isObjectRecord(parsedRequestBody) ||
		parsedRequestBody.stream !== true ||
		!isObjectRecord(parsedRequestBody.stream_options) ||
		parsedRequestBody.stream_options.include_usage !== true
	) {
		throw new Error(`Expected one streaming OpenAI-compatible request: ${rawRequestBody}`);
	}
	const messageSnapshot = JSON.stringify(parsedRequestBody.messages ?? []);
	const agentId = requireAgentId(messageSnapshot);
	const toolNames = openAiToolNames(parsedRequestBody);
	for (const requiredToolName of requiredStockToolNames) {
		if (!toolNames.includes(requiredToolName)) {
			throw new Error(
				`Hermes profile '${agentId}' omitted required stock tool '${requiredToolName}': ${JSON.stringify(toolNames)}`,
			);
		}
	}
	const toolMessageCount = countToolMessages(parsedRequestBody);
	options.observations.push({
		agentId,
		messageSnapshot,
		toolMessageContents: toolMessageContents(parsedRequestBody),
		toolMessageCount,
		toolNames,
	});
	options.response.writeHead(200, {
		'cache-control': 'no-cache',
		connection: 'keep-alive',
		'content-type': 'text/event-stream',
	});
	if (toolMessageCount < 6) {
		writeToolCallStream({
			agentId,
			response: options.response,
			toolCall: scriptedToolCall(agentId, toolMessageCount),
			toolMessageCount,
		});
		return;
	}
	writeFinalTextStream({ agentId, response: options.response });
}

async function startFakeHermesModelServer(): Promise<FakeHermesModelServer> {
	const observations: FakeModelRequestObservation[] = [];
	const server: Server = createServer((request, response) => {
		void handleFakeModelRequest({ observations, request, response }).catch((error: unknown) => {
			response.writeHead(500, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
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
		throw new Error('Fake Hermes model server did not bind a TCP port.');
	}
	return {
		port: address.port,
		requests: observations,
		close: async (): Promise<void> => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)));
			});
		},
	};
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function dispatchProfileWebhook(options: {
	readonly agentId: AgentId;
	readonly controllerUrl: string;
	readonly zoneId: string;
}): Promise<string> {
	const body = JSON.stringify({ profile: options.agentId });
	const signature = createHmac('sha256', webhookSecret).update(body).digest('hex');
	const requestId = `hermes-e2e-${options.agentId}-${randomUUID()}`;
	const encodedBody = Buffer.from(body, 'utf8').toString('base64');
	const curlCommand = [
		'curl --silent --show-error --fail-with-body',
		`  --request POST ${shellSingleQuote(`http://127.0.0.1:${String(webhookPort)}/p/${options.agentId}/webhooks/${webhookRoute}`)}`,
		"  --header 'Content-Type: application/json'",
		`  --header ${shellSingleQuote(`X-Hub-Signature-256: sha256=${signature}`)}`,
		`  --header ${shellSingleQuote(`X-Request-ID: ${requestId}`)}`,
		'  --data-binary "$body"',
	].join(' \\\n');
	const command = [
		'set -eu',
		`body="$(printf '%s' ${shellSingleQuote(encodedBody)} | base64 -d)"`,
		curlCommand,
	].join('\n');
	const controllerClient = createControllerClient({ baseUrl: options.controllerUrl });
	if (controllerClient.execInZone === undefined) {
		throw new Error('Hermes E2E requires controller execute-command support.');
	}
	const result = requireZoneExecResult(await controllerClient.execInZone(options.zoneId, command));
	if (result.exitCode !== 0 || !result.stdout.includes('"status": "accepted"')) {
		throw new Error(
			`Hermes webhook dispatch failed for '${options.agentId}': ${JSON.stringify(result)}`,
		);
	}
	const responseBody: unknown = JSON.parse(result.stdout);
	if (
		!isObjectRecord(responseBody) ||
		responseBody.status !== 'accepted' ||
		responseBody.delivery_id !== requestId
	) {
		throw new Error(
			`Hermes webhook dispatch returned an unexpected receipt for '${options.agentId}': ${JSON.stringify(responseBody)}`,
		);
	}
	return requestId;
}

async function waitForHermesWebhookTurnCompletion(options: {
	readonly agentId: AgentId;
	readonly controllerUrl: string;
	readonly deliveryId: string;
	readonly zoneId: string;
}): Promise<void> {
	const controllerClient = createControllerClient({ baseUrl: options.controllerUrl });
	if (controllerClient.execInZone === undefined) {
		throw new Error('Hermes E2E requires controller execute-command support.');
	}
	const sessionChatId = `webhook:${webhookRoute}:${options.deliveryId}`;
	const gatewayStateDatabasePath = '/home/hermes/.hermes/state.db';
	const expectedFinalMarker = `PROFILE_COMPLETE=${options.agentId}`;
	const completionProbe = [
		'python3 - "$@" <<\'PY\'',
		'import sqlite3',
		'import sys',
		'database_path, chat_id, final_marker = sys.argv[1:]',
		'try:',
		'    connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)',
		'except sqlite3.OperationalError:',
		'    print("pending")',
		'    raise SystemExit(0)',
		'try:',
		'    row = connection.execute(',
		'        """SELECT sessions.ended_at, sessions.end_reason, EXISTS (',
		'               SELECT 1 FROM messages',
		'               WHERE messages.session_id = sessions.id',
		"                 AND messages.role = 'assistant'",
		'                 AND instr(messages.content, ?) > 0',
		'           )',
		'           FROM sessions',
		'           WHERE sessions.chat_id = ?',
		'           ORDER BY sessions.started_at DESC',
		'           LIMIT 1""",',
		'        (final_marker, chat_id),',
		'    ).fetchone()',
		'finally:',
		'    connection.close()',
		'print("complete" if row is not None and row[0] is not None and row[1] == "webhook_complete" and row[2] == 1 else "pending")',
		'PY',
	].join('\n');
	const command = `set -- ${shellSingleQuote(gatewayStateDatabasePath)} ${shellSingleQuote(sessionChatId)} ${shellSingleQuote(expectedFinalMarker)}\n${completionProbe}`;
	const deadlineMs = Date.now() + 120_000;
	let lastResult: ZoneExecResult | undefined;
	while (Date.now() < deadlineMs) {
		lastResult = requireZoneExecResult(await controllerClient.execInZone(options.zoneId, command));
		if (lastResult.exitCode === 0 && lastResult.stdout.trim() === 'complete') return;
		await waitForProtocolRetryInterval(250);
	}
	throw new Error(
		`Timed out waiting for completed Hermes webhook turn '${options.deliveryId}': ${JSON.stringify(lastResult)}`,
	);
}

async function waitForHermesWebhookDispatchReady(options: {
	readonly controllerUrl: string;
	readonly minimumPostStartupMarkerCount?: number;
	readonly zoneId: string;
}): Promise<number> {
	const controllerClient = createControllerClient({ baseUrl: options.controllerUrl });
	if (controllerClient.execInZone === undefined) {
		throw new Error('Hermes E2E requires controller execute-command support.');
	}
	const deadlineMs = Date.now() + 60_000;
	let lastGatewayLogResult: ZoneExecResult | undefined;
	let lastHealthResult: ZoneExecResult | undefined;
	let lastPostStartupMarkerCount = 0;
	const minimumPostStartupMarkerCount = options.minimumPostStartupMarkerCount ?? 1;
	while (Date.now() < deadlineMs) {
		lastHealthResult = requireZoneExecResult(
			await controllerClient.execInZone(
				options.zoneId,
				`curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 http://127.0.0.1:${String(webhookPort)}/health`,
			),
		);
		if (lastHealthResult.exitCode === 0 && lastHealthResult.stdout.startsWith('2')) {
			const markerCountResult = requireZoneExecResult(
				await controllerClient.execInZone(
					options.zoneId,
					`if [ -n "\${HERMES_HOME:-}" ]; then grep -F -c -- ${shellSingleQuote(hermesPostStartupLogMarker)} "$HERMES_HOME/logs/gateway.log" 2>/dev/null || true; else printf '0\\n'; fi`,
				),
			);
			lastPostStartupMarkerCount = Number.parseInt(markerCountResult.stdout.trim(), 10) || 0;
			lastGatewayLogResult = requireZoneExecResult(
				await controllerClient.execInZone(
					options.zoneId,
					'if [ -n "${HERMES_HOME:-}" ]; then tail -n 200 "$HERMES_HOME/logs/gateway.log" 2>&1 || true; else printf "%s\\n" "HERMES_HOME is unset"; fi',
				),
			);
			if (
				lastPostStartupMarkerCount >= minimumPostStartupMarkerCount &&
				lastGatewayLogResult.stdout.includes(hermesPostStartupLogMarker)
			) {
				return lastPostStartupMarkerCount;
			}
		}
		await waitForProtocolRetryInterval(250);
	}
	const serviceLog = await controllerClient
		.execInZone(options.zoneId, 'tail -n 200 /var/log/agent-vm/hermes-service.log 2>&1 || true')
		.then(requireZoneExecResult)
		.catch((error: unknown) => ({
			exitCode: -1,
			stderr: error instanceof Error ? error.message : String(error),
			stdout: '',
		}));
	throw new Error(
		`Timed out waiting for Hermes webhook and post-startup readiness: ${JSON.stringify({ lastGatewayLogResult, lastHealthResult, lastPostStartupMarkerCount, minimumPostStartupMarkerCount, serviceLog })}`,
	);
}

async function waitForGatewayReplacementEvent(options: {
	readonly controllerUrl: string;
	readonly oldVmId: string;
	readonly timeoutMs: number;
	readonly zoneId: string;
}): Promise<
	Extract<AgentVmHealthEvent, { readonly kind: 'gateway-recovery'; readonly result: 'ok' }>
> {
	const deadlineMs = Date.now() + options.timeoutMs;
	let lastSnapshot: ZoneHealthSnapshot | undefined;
	while (Date.now() < deadlineMs) {
		const response = await fetch(
			`${options.controllerUrl}/zones/${encodeURIComponent(options.zoneId)}/health-snapshot`,
		);
		if (response.ok) {
			lastSnapshot = (await response.json()) as ZoneHealthSnapshot;
			const event = latestHealthEvents(lastSnapshot).find(
				(
					candidate,
				): candidate is Extract<
					AgentVmHealthEvent,
					{ readonly kind: 'gateway-recovery'; readonly result: 'ok' }
				> =>
					candidate.kind === 'gateway-recovery' &&
					candidate.result === 'ok' &&
					candidate.action === 'gateway-vm-restart' &&
					candidate.oldVmId === options.oldVmId,
			);
			if (event !== undefined) return event;
		}
		await waitForProtocolRetryInterval(250);
	}
	throw new Error(
		`Timed out waiting for Hermes Gateway replacement of '${options.oldVmId}': ${JSON.stringify(lastSnapshot)}`,
	);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
	return await readFile(filePath, 'utf8').catch((error: unknown): undefined => {
		if (isObjectRecord(error) && error.code === 'ENOENT') return undefined;
		throw error;
	});
}

async function readHermesToolVmRuntimeRecords(options: {
	readonly controllerStateDirectoryPath: string;
	readonly zoneId: string;
}): Promise<ReadonlyMap<AgentId, ToolVmRuntimeRecord>> {
	const gatewayStateRoot = resolveControllerGatewayStateRoot({
		controllerStateRoot: createControllerStateRoot({
			controllerStateDirectoryPath: options.controllerStateDirectoryPath,
		}),
		zoneId: options.zoneId,
	});
	const recordsTarget = resolveControllerGatewayRecordTargets({
		gatewayStateRoot,
	}).toolLeaseRecords;
	const loadResults = await loadAllToolVmRuntimeRecords(recordsTarget);
	const parseError = loadResults.find((result) => result.kind === 'parse-error');
	if (parseError !== undefined) {
		throw new Error(`Hermes Tool VM runtime record failed to parse: ${parseError.path}`);
	}
	const records = loadResults
		.filter((result) => result.kind === 'loaded')
		.map((result) => result.record)
		.filter(
			(record): record is ToolVmRuntimeRecord & { readonly agentId: AgentId } =>
				record.zoneId === options.zoneId && isAgentId(record.agentId),
		);
	if (
		records.length !== agentIds.length ||
		new Set(records.map((record) => record.agentId)).size !== agentIds.length
	) {
		throw new Error(
			`Expected one current Hermes Tool VM runtime record per profile, found ${String(records.length)}.`,
		);
	}
	return new Map(records.map((record) => [record.agentId, record] as const));
}

async function waitForProfileEvidence(options: {
	readonly agentId: AgentId;
	readonly modelServer: FakeHermesModelServer;
	readonly zoneFilesDir: string;
}): Promise<Readonly<Record<string, string>>> {
	const agentWorkspaceDirectory = path.join(options.zoneFilesDir, 'agents', options.agentId);
	const expectedFiles = {
		background: path.join(agentWorkspaceDirectory, `${options.agentId}-background.txt`),
		code: path.join(agentWorkspaceDirectory, `${options.agentId}-code.txt`),
		file: path.join(agentWorkspaceDirectory, `${options.agentId}-file.txt`),
		terminal: path.join(agentWorkspaceDirectory, `${options.agentId}-terminal.txt`),
	} as const;
	const deadline = Date.now() + 120_000;
	let latestFiles: Readonly<Record<string, string | undefined>> = {};
	while (Date.now() < deadline) {
		latestFiles = Object.fromEntries(
			await Promise.all(
				Object.entries(expectedFiles).map(async ([label, filePath]) => [
					label,
					await readOptionalFile(filePath),
				]),
			),
		);
		const completedRequest = options.modelServer.requests.some(
			(request) => request.agentId === options.agentId && request.toolMessageCount === 6,
		);
		if (
			completedRequest &&
			Object.values(latestFiles).every((content) => typeof content === 'string')
		) {
			return Object.fromEntries(
				Object.entries(latestFiles).map(([label, content]) => [label, content ?? '']),
			);
		}
		await waitForProtocolRetryInterval(250);
	}
	throw new Error(
		`Timed out waiting for Hermes profile '${options.agentId}' evidence: ${JSON.stringify({ latestFiles, requests: options.modelServer.requests })}`,
	);
}

describeHermesManagedEnvironmentE2e(
	'e2e: Hermes managed BaseEnvironment routes profiles through separate Tool VMs',
	() => {
		let harness: E2eHarnessRuntime | undefined;
		let modelServer: FakeHermesModelServer | undefined;
		let project: HermesE2eProject | undefined;
		const gatewayStarts: ManagedGatewayStartObservation[] = [];
		const observedLeaseRequests: ObservedControllerLeaseCreateRequest[] = [];
		const toolVmCreateRequests: ManagedVmCreateRequest[] = [];

		afterAll(async () => {
			try {
				await harness?.close();
			} finally {
				try {
					await modelServer?.close();
				} finally {
					if (project) await removeE2eTempRoot(project.tempRoot);
				}
			}
		});

		it('uses stock profile webhook dispatch and stock tools through isolated managed environments', async () => {
			const repoRoot = path.resolve(process.cwd());
			modelServer = await startFakeHermesModelServer();
			project = await scaffoldHermesE2eProject({
				agents: agentIds,
				architecture,
				prefix: 'hermes-managed-base-environment-e2e-',
				zoneId: 'hermes-managed-environment-e2e',
			});
			Object.assign(project.zone.gateway, {
				discordBotTokenSecretsByAgent: discordSecretEnvironmentNames,
			});
			for (const agentId of agentIds) {
				const secretEnvironmentName = discordSecretEnvironmentNames[agentId];
				project.zone.secrets[secretEnvironmentName] = {
					audience: 'gateway',
					envVar: secretEnvironmentName,
					injection: 'env',
					source: 'environment',
				};
			}
			await writeFile(
				project.zone.gateway.config,
				`${renderHermesManagedE2eConfiguration({
					contextLength: fakeModelContextLength,
					fakeModelHost,
					fakeModelName,
					webhookPort,
					webhookRoute,
					webhookSecret,
				})}secrets:\n  preserve_existing:\n    - DISCORD_BOT_TOKEN\n`,
				'utf8',
			);
			project.zone.egressHosts = [
				...(project.zone.egressHosts ?? []),
				{ audience: 'gateway', host: fakeModelHost },
			];
			await useLocalHermesGatewayImagePackages({
				architecture,
				profileName: project.zone.gateway.imageProfile,
				projectRoot: project.tempRoot,
				repoRoot,
				systemConfig: project.systemConfig,
			});
			await prepareGatewayE2eProjectImages({ project });
			harness = await startE2eControllerRuntime({
				onControllerManagedVmCreateRequest: (request) => {
					toolVmCreateRequests.push(request);
				},
				onLeaseCreateRequest: (request) => {
					observedLeaseRequests.push({
						agentId: request.agentId,
						profileId: request.profileId,
						zoneId: request.zoneId,
					});
				},
				secrets: {
					[discordSecretEnvironmentNames.beta]: discordSecretCanaries.beta,
					[discordSecretEnvironmentNames.main]: discordSecretCanaries.main,
					GITHUB_TOKEN: 'unused-hermes-managed-environment-token',
				},
				startGatewayZone: async (startOptions) => {
					const result = await startGatewayZone(startOptions);
					if (result.executionModel !== 'managed-gateway') {
						throw new Error('Hermes recovery proof requires managed Gateway image boot.');
					}
					const qemuPid = result.vm.getHostProcessId();
					if (qemuPid === null)
						throw new Error('Managed Hermes Gateway start omitted its QEMU pid.');
					gatewayStarts.push({ expectedCohort: result.expectedCohort, qemuPid, vm: result.vm });
					return result;
				},
				startOptions: {
					systemConfig: project.systemConfig,
					zoneIds: [project.zone.id],
				},
				tcpHostsOverride: {
					[`${fakeModelHost}:80`]: `127.0.0.1:${String(modelServer.port)}`,
				},
			});
			const predecessorPostStartupMarkerCount = await waitForHermesWebhookDispatchReady({
				controllerUrl: harness.controllerUrl,
				zoneId: project.zone.id,
			});

			const evidenceByAgent = new Map<AgentId, Readonly<Record<string, string>>>();
			for (const agentId of agentIds) {
				await dispatchProfileWebhook({
					agentId,
					controllerUrl: harness.controllerUrl,
					zoneId: project.zone.id,
				});
				evidenceByAgent.set(
					agentId,
					await waitForProfileEvidence({
						agentId,
						modelServer,
						zoneFilesDir: project.zone.gateway.zoneFilesDir,
					}),
				);
			}

			for (const agentId of agentIds) {
				const upperAgentId = agentId.toUpperCase();
				const evidence = evidenceByAgent.get(agentId);
				expect(evidence).toEqual({
					background: `BACKGROUND_${upperAgentId}\n`,
					code: `CODE_${upperAgentId}\n`,
					file: `FILE_${upperAgentId}\n`,
					terminal: `TERMINAL_${upperAgentId}\n`,
				});
				const profileRequests = modelServer.requests.filter(
					(request) => request.agentId === agentId,
				);
				expect(profileRequests.map((request) => request.toolMessageCount)).toEqual([
					0, 1, 2, 3, 4, 5, 6,
				]);
				expect(profileRequests[1]?.messageSnapshot).toContain('/work');
				expect(profileRequests[1]?.messageSnapshot).toContain('TOOL_VM_DISCORD_ENV_CLEAN');
				expect(profileRequests[3]?.messageSnapshot).toContain(`FILE_${upperAgentId}`);
				expect(profileRequests[4]?.messageSnapshot).toContain(`CODE_${upperAgentId}`);
				const processResult = profileRequests[6]?.toolMessageContents.join('\n') ?? '';
				expect(processResult).toContain(`${agentId}-background.txt`);
				expect(processResult).toContain('"status": "running"');
				expect(processResult).toMatch(/proc_[a-zA-Z0-9_-]+/u);
				expect(processResult).toContain(`BACKGROUND_${upperAgentId}`);
				const otherAgentId = agentId === 'main' ? 'beta' : 'main';
				expect(processResult).not.toContain(`BACKGROUND_${otherAgentId.toUpperCase()}`);
			}
			expect(toolVmCreateRequests).toHaveLength(agentIds.length);
			for (const request of toolVmCreateRequests) {
				expect(request.sessionLabel).toMatch(/:tool:\d+$/u);
				expect(Object.keys(request.environment)).not.toEqual(
					expect.arrayContaining(Object.values(discordSecretEnvironmentNames)),
				);
				expect(Object.values(request.environment)).not.toEqual(
					expect.arrayContaining(Object.values(discordSecretCanaries)),
				);
				expect(request.mediatedSecrets.map((secret) => secret.environmentVariable)).not.toEqual(
					expect.arrayContaining(Object.values(discordSecretEnvironmentNames)),
				);
				expect(request.mediatedSecrets.map((secret) => secret.value)).not.toEqual(
					expect.arrayContaining(Object.values(discordSecretCanaries)),
				);
			}

			const activeProject = project;
			if (activeProject === undefined) {
				throw new Error('Expected the active Hermes E2E project.');
			}
			expect(observedLeaseRequests).toEqual(
				agentIds.map((agentId) => ({
					agentId,
					profileId: 'standard',
					zoneId: activeProject.zone.id,
				})),
			);
			const toolVmRecords = await readHermesToolVmRuntimeRecords({
				controllerStateDirectoryPath: activeProject.systemConfig.controllerStateDir,
				zoneId: activeProject.zone.id,
			});
			const distinctRuntimeIdentities = Array.from(toolVmRecords.values());
			for (const identityField of ['leaseId', 'vmId', 'qemuPid', 'tcpSlot'] as const) {
				expect(new Set(distinctRuntimeIdentities.map((record) => record[identityField])).size).toBe(
					agentIds.length,
				);
			}

			for (const agentId of agentIds) {
				const otherAgentId = agentId === 'main' ? 'beta' : 'main';
				const ownWorkspace = path.join(project.zone.gateway.zoneFilesDir, 'agents', agentId);
				expect(await readOptionalFile(path.join(ownWorkspace, `${otherAgentId}-file.txt`))).toBe(
					undefined,
				);
			}

			const predecessor = gatewayStarts[0];
			if (predecessor === undefined) {
				throw new Error('Expected the initial managed Hermes Gateway.');
			}
			const frameworkIdentity = await readManagedGatewaySiblingProcessIdentity({
				gatewayVm: predecessor.vm,
				guestPort: predecessor.expectedCohort.ingressIntent.frameworkRootRoute.guestPort,
				role: 'framework',
			});
			await terminateManagedGatewaySibling({
				gatewayVm: predecessor.vm,
				identity: frameworkIdentity,
				role: 'framework',
			});
			const recoveryEvent = await waitForGatewayReplacementEvent({
				controllerUrl: harness.controllerUrl,
				oldVmId: predecessor.vm.id,
				timeoutMs: 300_000,
				zoneId: project.zone.id,
			});
			const successor = gatewayStarts.find((start) => start.vm.id === recoveryEvent.newVmId);
			if (successor === undefined) {
				throw new Error(`Hermes Gateway replacement '${recoveryEvent.newVmId}' was not observed.`);
			}
			expect(recoveryEvent).toMatchObject({
				action: 'gateway-vm-restart',
				oldVmId: predecessor.vm.id,
				result: 'ok',
				zoneId: project.zone.id,
			});
			expect(successor.vm.id).not.toBe(predecessor.vm.id);
			expect(successor.qemuPid).not.toBe(predecessor.qemuPid);
			expect(predecessor.vm.getHostProcessId()).toBeNull();
			expect(successor.vm.getHostProcessId()).toBe(successor.qemuPid);
			expect(successor.expectedCohort.frameworkIdentity.frameworkKind).toBe('hermes');
			expect(successor.expectedCohort.fence.gatewayEpoch).not.toBe(
				predecessor.expectedCohort.fence.gatewayEpoch,
			);
			expect(successor.expectedCohort.frameworkIdentity.frameworkEpoch).not.toBe(
				predecessor.expectedCohort.frameworkIdentity.frameworkEpoch,
			);
			expect(successor.expectedCohort.toolPortalIdentity.processEpoch).not.toBe(
				predecessor.expectedCohort.toolPortalIdentity.processEpoch,
			);
			expect(successor.expectedCohort.toolPortalIdentity.runtimeEpoch).not.toBe(
				predecessor.expectedCohort.toolPortalIdentity.runtimeEpoch,
			);
			const successorRuntimeRecord = await loadManagedGatewayRuntimeRecord(
				resolveControllerGatewayRecordTargets({
					gatewayStateRoot: resolveControllerGatewayStateRoot({
						controllerStateRoot: createControllerStateRoot({
							controllerStateDirectoryPath: project.systemConfig.controllerStateDir,
						}),
						zoneId: project.zone.id,
					}),
				}).managedGatewayRuntimeRecord,
			);
			if (successorRuntimeRecord === null) {
				throw new Error('Hermes Gateway replacement omitted its published runtime record.');
			}
			expect(successorRuntimeRecord.vmId).toBe(successor.vm.id);
			expect(successorRuntimeRecord.expectedCohort).toEqual(successor.expectedCohort);
			await waitForHermesWebhookDispatchReady({
				controllerUrl: harness.controllerUrl,
				minimumPostStartupMarkerCount: predecessorPostStartupMarkerCount + 1,
				zoneId: project.zone.id,
			});
			const successorRequestCount = modelServer.requests.length;
			const successorDeliveryId = await dispatchProfileWebhook({
				agentId: 'main',
				controllerUrl: harness.controllerUrl,
				zoneId: project.zone.id,
			});
			const successorTurnDeadlineMs = Date.now() + 120_000;
			while (Date.now() < successorTurnDeadlineMs) {
				const successorRequests = modelServer.requests.slice(successorRequestCount);
				if (
					successorRequests.some(
						(request) => request.agentId === 'main' && request.toolMessageCount === 6,
					)
				) {
					break;
				}
				await waitForProtocolRetryInterval(250);
			}
			const successorRequests = modelServer.requests.slice(successorRequestCount);
			expect(
				successorRequests.some(
					(request) => request.agentId === 'main' && request.toolMessageCount === 6,
				),
			).toBe(true);
			await waitForHermesWebhookTurnCompletion({
				agentId: 'main',
				controllerUrl: harness.controllerUrl,
				deliveryId: successorDeliveryId,
				zoneId: project.zone.id,
			});
		}, 900_000);
	},
);
