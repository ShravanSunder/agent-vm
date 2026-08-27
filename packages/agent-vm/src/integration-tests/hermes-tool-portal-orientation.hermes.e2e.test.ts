/* oxlint-disable eslint/no-await-in-loop -- live protocol observations must remain sequential */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import {
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
	type StartedFakeUpstreamMcpServer,
} from '@agent-vm/mcp-portal/testing/fake-upstream-mcp-server';
import { afterAll, describe, expect, it } from 'vitest';

import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';
import { controllerFixedGatewayRuntimeArtifactLimits } from '../gateway/managed-gateway-runtime-input-builders.js';
import {
	canRunManagedVmE2e,
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	startE2eControllerRuntime,
	type E2eHarnessRuntime,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import {
	buildHermesE2eProfileApiServerKeySecrets,
	hermesE2eProfileApiServerKey,
	hermesE2eProfileApiServerKeyEnvironmentName,
	renderHermesManagedE2eConfiguration,
	scaffoldHermesE2eProject,
	materializeLocalHermesGatewayImagePackages,
	type HermesE2eProject,
} from './hermes-e2e-harness.js';

const architecture = currentE2eArchitecture();
const runHermesToolPortalOrientationE2e =
	process.env.AGENT_VM_HERMES_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeHermesToolPortalOrientationE2e = runHermesToolPortalOrientationE2e
	? describe
	: describe.skip;

const agentId = 'main';
const availableUpstreamHost = 'orientation-available-mcp.vm.host';
const unavailableUpstreamHost = 'orientation-unavailable-mcp.vm.host';
const unavailableNamespace = 'orientation-unavailable';
const controllerExecutionNamespace = 'controller_execution';
const availableNamespaceSummary = 'Available orientation E2E upstream';
const unavailableNamespaceSummary = 'Unavailable orientation E2E upstream';
const controllerExecutionSummary = 'Controller-owned orientation E2E operations';
const modelHost = 'orientation-model.provider.test';
const modelName = 'hermes-orientation-e2e';
const sessionId = 'hermes-orientation-session';
const describePrompt = 'describe-remote-tool-without-output-schema';
const describeSuccessMarker = 'hermes-remote-describe-succeeded';
const authenticationPrompt = 'call-remote-tool-with-rejected-credential';
const authenticationSuccessMarker = 'hermes-remote-authentication-error-visible';
const localSchemaErrorPrompt = 'call-remote-tool-with-locally-invalid-schema';
const localSchemaErrorSuccessMarker = 'hermes-local-schema-error-visible';
const remoteSchemaErrorPrompt = 'call-remote-tool-returning-schema-error';
const remoteSchemaErrorSuccessMarker = 'hermes-remote-schema-error-visible';
const controllerExecutionPrompt = 'call-controller-host-probe-through-tool-portal';
const controllerExecutionSuccessMarker = 'hermes-controller-execution-succeeded';
const remoteProviderErrorCanary = 'provider response detail must not escape';
const remoteSchemaSecretCanary = 'schema-secret-must-not-escape';
const orientationMarker =
	'Tool Portal exposes profile-authorized capabilities through four operations:';
const operationNames = [
	'tool_portal_list',
	'tool_portal_search',
	'tool_portal_describe',
	'tool_portal_call',
] as const;

interface ProviderMessage {
	readonly content: string;
	readonly role: string;
}

interface ProviderObservation {
	readonly messages: readonly ProviderMessage[];
	readonly tools: readonly unknown[];
}

interface RecordingProvider {
	readonly close: () => Promise<void>;
	readonly observations: () => readonly ProviderObservation[];
	readonly port: number;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

function parseProviderObservation(requestBody: string): ProviderObservation {
	const parsed: unknown = JSON.parse(requestBody);
	if (!isObjectRecord(parsed) || !Array.isArray(parsed.messages) || !Array.isArray(parsed.tools)) {
		throw new Error('Hermes recording provider expected OpenAI messages and tools arrays.');
	}
	const messages = parsed.messages.flatMap((message): readonly ProviderMessage[] => {
		if (
			!isObjectRecord(message) ||
			typeof message.role !== 'string' ||
			typeof message.content !== 'string'
		) {
			return [];
		}
		return [{ content: message.content, role: message.role }];
	});
	return { messages, tools: parsed.tools };
}

function writeServerSentCompletion(
	response: ServerResponse,
	content = 'orientation-e2e-response',
): void {
	const chunks = [
		{
			choices: [
				{
					delta: { content, role: 'assistant' },
					finish_reason: null,
					index: 0,
				},
			],
			created: 1,
			id: 'hermes-orientation-e2e-response',
			model: modelName,
			object: 'chat.completion.chunk',
		},
		{
			choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
			created: 1,
			id: 'hermes-orientation-e2e-response',
			model: modelName,
			object: 'chat.completion.chunk',
		},
	] as const;
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end('data: [DONE]\n\n');
}

function writeServerSentToolCall(
	response: ServerResponse,
	options: { readonly argumentsValue: unknown; readonly id: string; readonly name: string },
): void {
	const toolCall = {
		function: { arguments: JSON.stringify(options.argumentsValue), name: options.name },
		id: options.id,
		index: 0,
		type: 'function',
	} as const;
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	response.write(
		`data: ${JSON.stringify({
			choices: [
				{
					delta: { content: null, role: 'assistant', tool_calls: [toolCall] },
					finish_reason: null,
					index: 0,
				},
			],
			created: 1,
			id: options.id,
			model: modelName,
			object: 'chat.completion.chunk',
		})}\n\n`,
	);
	response.write(
		`data: ${JSON.stringify({
			choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
			created: 1,
			id: options.id,
			model: modelName,
			object: 'chat.completion.chunk',
		})}\n\n`,
	);
	response.end('data: [DONE]\n\n');
}

function messagesAfterLatestUser(observation: ProviderObservation): readonly ProviderMessage[] {
	const latestUserIndex = observation.messages.findLastIndex(({ role }) => role === 'user');
	return latestUserIndex < 0 ? [] : observation.messages.slice(latestUserIndex + 1);
}

async function startRecordingProvider(): Promise<RecordingProvider> {
	const observations: ProviderObservation[] = [];
	// oxlint-disable-next-line typescript/no-misused-promises -- request body consumption is async
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
			response.writeHead(404).end();
			return;
		}
		const observation = parseProviderObservation(await readRequestBody(request));
		observations.push(observation);
		const latestUserContent = observation.messages.findLast(({ role }) => role === 'user')?.content;
		const latestToolResult = messagesAfterLatestUser(observation).find(
			({ role }) => role === 'tool',
		)?.content;
		if (latestUserContent === controllerExecutionPrompt) {
			if (latestToolResult === undefined) {
				writeServerSentToolCall(response, {
					argumentsValue: {
						arguments: {
							calls: [
								{
									arguments: {},
									id: 'controller-host-probe',
									name: 'controller_host_probe',
									namespace: 'controller_execution',
								},
							],
						},
						name: 'tool_portal_call',
					},
					id: 'hermes-controller-execution-call',
					name: 'tool_call',
				});
				return;
			}
			const controllerExecutionSucceeded =
				/"status"\s*:\s*"ok"/u.test(latestToolResult) &&
				latestToolResult.includes('controller_cache_dir_listing') &&
				latestToolResult.includes('agent-vm-host-probe.txt');
			writeServerSentCompletion(
				response,
				controllerExecutionSucceeded
					? controllerExecutionSuccessMarker
					: 'hermes-controller-execution-failed',
			);
			return;
		}
		if (latestUserContent === describePrompt) {
			if (latestToolResult === undefined) {
				writeServerSentToolCall(response, {
					argumentsValue: {
						arguments: {
							requests: [
								{
									id: 'describe-read',
									includeJsonSchema: true,
									tools: [{ name: 'read_thing', namespace: fakeUpstreamNamespace }],
								},
							],
						},
						name: 'tool_portal_describe',
					},
					id: 'hermes-remote-describe-call',
					name: 'tool_call',
				});
				return;
			}
			const describeSucceeded =
				/"status"\s*:\s*"ok"/u.test(latestToolResult) &&
				/"inputSchema"\s*:/u.test(latestToolResult) &&
				!/"outputSchema"\s*:/u.test(latestToolResult);
			writeServerSentCompletion(
				response,
				describeSucceeded ? describeSuccessMarker : 'hermes-remote-describe-failed',
			);
			return;
		}
		if (latestUserContent === authenticationPrompt) {
			if (latestToolResult === undefined) {
				writeServerSentToolCall(response, {
					argumentsValue: {
						arguments: {
							calls: [
								{
									arguments: { title: 'hello' },
									id: 'remote-authentication',
									name: 'read_thing',
									namespace: fakeUpstreamNamespace,
								},
							],
						},
						name: 'tool_portal_call',
					},
					id: 'hermes-remote-authentication-call',
					name: 'tool_call',
				});
				return;
			}
			const authenticationFailureIsVisible =
				/"code"\s*:\s*"not_authorized"/u.test(latestToolResult) &&
				latestToolResult.includes('Remote capability authentication failed.') &&
				!latestToolResult.includes(remoteProviderErrorCanary);
			writeServerSentCompletion(
				response,
				authenticationFailureIsVisible
					? authenticationSuccessMarker
					: 'hermes-remote-authentication-error-hidden',
			);
			return;
		}
		if (latestUserContent === localSchemaErrorPrompt) {
			if (latestToolResult === undefined) {
				writeServerSentToolCall(response, {
					argumentsValue: {
						arguments: {
							calls: [
								{
									arguments: { title: 42 },
									id: 'local-schema-error',
									name: 'read_thing',
									namespace: fakeUpstreamNamespace,
								},
							],
						},
						name: 'tool_portal_call',
					},
					id: 'hermes-local-schema-error-call',
					name: 'tool_call',
				});
				return;
			}
			const localSchemaFailureIsVisible =
				/"code"\s*:\s*"validation_failed"/u.test(latestToolResult) &&
				latestToolResult.includes('title: expected string');
			writeServerSentCompletion(
				response,
				localSchemaFailureIsVisible
					? localSchemaErrorSuccessMarker
					: 'hermes-local-schema-error-hidden',
			);
			return;
		}
		if (latestUserContent === remoteSchemaErrorPrompt) {
			if (latestToolResult === undefined) {
				writeServerSentToolCall(response, {
					argumentsValue: {
						arguments: {
							calls: [
								{
									arguments: { title: 'schema probe' },
									id: 'remote-schema-error',
									name: 'write_thing',
									namespace: fakeUpstreamNamespace,
								},
							],
						},
						name: 'tool_portal_call',
					},
					id: 'hermes-remote-schema-error-call',
					name: 'tool_call',
				});
				return;
			}
			const remoteSchemaFailureIsVisible =
				/"code"\s*:\s*"execution_failed"/u.test(latestToolResult) &&
				latestToolResult.includes(
					'Input validation failed at $.search_recency: expected day, week, or month.',
				) &&
				!latestToolResult.includes(remoteSchemaSecretCanary);
			writeServerSentCompletion(
				response,
				remoteSchemaFailureIsVisible
					? remoteSchemaErrorSuccessMarker
					: 'hermes-remote-schema-error-hidden',
			);
			return;
		}
		writeServerSentCompletion(response);
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
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error('Hermes orientation recording provider did not bind a loopback port.');
	}
	return {
		close: async () =>
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
		observations: () => observations,
		port: address.port,
	};
}

async function writeToolPortalConfiguration(options: {
	readonly availableUpstreamUrl: string;
	readonly configDirectory: string;
	readonly unavailableUpstreamUrl: string;
}): Promise<void> {
	await Promise.all([
		writeFile(
			path.join(options.configDirectory, 'mcp.config.jsonc'),
			`${JSON.stringify(
				{
					$schema: '../../schemas/mcp.schema.json',
					providers: {
						available: {
							discovery: { summary: availableNamespaceSummary },
							kind: 'mcp',
							namespace: fakeUpstreamNamespace,
							transport: { kind: 'streamable-http', url: options.availableUpstreamUrl },
						},
						unavailable: {
							discovery: { summary: unavailableNamespaceSummary },
							kind: 'mcp',
							namespace: unavailableNamespace,
							transport: { kind: 'streamable-http', url: options.unavailableUpstreamUrl },
						},
					},
					schemaVersion: 1,
				},
				null,
				'\t',
			)}\n`,
			'utf8',
		),
		writeFile(
			path.join(options.configDirectory, 'tool-portal.config.jsonc'),
			`${JSON.stringify(
				{
					$schema: '../../schemas/tool-portal.schema.json',
					agents: { [agentId]: { profile: agentId } },
					mode: 'managed',
					profiles: {
						[agentId]: {
							namespaces: {
								[controllerExecutionNamespace]: {
									backend: {
										kind: 'controller_execution',
										operations: {
											controller_host_probe: { kind: 'registered_action' },
										},
									},
									calls: {
										requiresApproval: { allow: [] },
										withoutApproval: { allow: ['controller_host_probe'] },
									},
									discovery: { summary: controllerExecutionSummary },
									tools: { allow: ['controller_host_probe'] },
								},
								[fakeUpstreamNamespace]: {
									backend: { kind: 'mcp_provider' },
									calls: {
										requiresApproval: { allow: [] },
										withoutApproval: { allow: ['read_thing', 'write_thing'] },
									},
									tools: { allow: ['read_thing', 'write_thing'] },
								},
								[unavailableNamespace]: {
									backend: { kind: 'mcp_provider' },
									calls: {
										requiresApproval: { allow: [] },
										withoutApproval: { allow: ['read_thing'] },
									},
									tools: { allow: ['read_thing'] },
								},
							},
						},
					},
					schemaVersion: 1,
				},
				null,
				'\t',
			)}\n`,
			'utf8',
		),
	]);
}

async function waitForRootApiHealth(options: {
	readonly controllerUrl: string;
	readonly gatewayPort: number;
	readonly resolveVm: () => Pick<GatewayZoneVmOperations, 'exec'> | undefined;
	readonly zoneId: string;
}): Promise<void> {
	const deadline = Date.now() + 60_000;
	let lastStatus: number | undefined;
	let lastError: string | undefined;
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
	const vm = options.resolveVm();
	const serviceLogResult = await vm?.exec(
		'tail -n 200 /var/log/agent-vm/hermes-service.log 2>&1 || true',
	);
	const serviceLog = serviceLogResult?.stdout.toString();
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
		`Timed out waiting for the Hermes orientation E2E health endpoint: ${JSON.stringify({ lastError, lastStatus, serviceLog, zoneLogs, zoneStatus })}`,
	);
}

async function requestHermesTurn(options: {
	readonly gatewayPort: number;
	readonly prompt: string;
}): Promise<string> {
	const response = await fetch(
		`http://127.0.0.1:${String(options.gatewayPort)}/p/${agentId}/v1/chat/completions`,
		{
			body: JSON.stringify({
				messages: [{ content: options.prompt, role: 'user' }],
				model: modelName,
				stream: false,
			}),
			headers: {
				authorization: `Bearer ${hermesE2eProfileApiServerKey(agentId)}`,
				'content-type': 'application/json',
				'x-hermes-session-id': sessionId,
			},
			method: 'POST',
			signal: AbortSignal.timeout(120_000),
		},
	);
	if (!response.ok) {
		throw new Error(
			`Hermes orientation turn failed with HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
	return await response.text();
}

function requireLatestUserContent(observation: ProviderObservation): string {
	const latestUserMessage = observation.messages.findLast(({ role }) => role === 'user');
	if (latestUserMessage === undefined) {
		throw new Error('Hermes provider observation did not contain a user message.');
	}
	return latestUserMessage.content;
}

function systemContents(observation: ProviderObservation): readonly string[] {
	return observation.messages.filter(({ role }) => role === 'system').map(({ content }) => content);
}

async function readInventoryAttemptDiagnostics(
	vm: Pick<GatewayZoneVmOperations, 'exec'>,
): Promise<string> {
	const result = await vm.exec([
		'/bin/sh',
		'-lc',
		"grep 'managed Tool Portal inventory attempt failed' /var/log/agent-vm/hermes-service.log || true",
	]);
	return result.stdout.toString().trim();
}

describeHermesToolPortalOrientationE2e('e2e: Hermes Tool Portal session orientation', () => {
	let availableUpstream: StartedFakeUpstreamMcpServer | undefined;
	let unavailableUpstream: StartedFakeUpstreamMcpServer | undefined;
	let provider: RecordingProvider | undefined;
	let harness: E2eHarnessRuntime | undefined;
	let project: HermesE2eProject | undefined;

	afterAll(async () => {
		await harness?.close({ preserveTempRoot: true });
		await Promise.allSettled([
			availableUpstream?.close(),
			unavailableUpstream?.close(),
			provider?.close(),
		]);
		if (project !== undefined) await removeE2eTempRoot(project.tempRoot);
	});

	it('starts eager inventory before messages and injects exact user context at most once', async () => {
		const repoRoot = path.resolve(process.cwd());
		[availableUpstream, unavailableUpstream, provider] = await Promise.all([
			startFakeUpstreamMcpServer({
				callHttpStatusCode: 401,
				callHttpStatusToolName: 'read_thing',
				toolErrorMessageByToolName: {
					write_thing: `Input validation failed at $.search_recency: expected day, week, or month. Authorization: Bearer ${remoteSchemaSecretCanary}`,
				},
			}),
			startFakeUpstreamMcpServer({ emptyTools: true }),
			startRecordingProvider(),
		]);
		project = await scaffoldHermesE2eProject({
			agents: [agentId],
			architecture,
			prefix: 'hermes-tool-portal-orientation-e2e-',
			zoneId: 'hermes-tool-portal-orientation-e2e',
		});
		const systemZone = project.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'hermes') {
			throw new Error('Expected the Hermes Tool Portal orientation E2E zone.');
		}
		// This proof drives Hermes through its HTTP API and must not activate a channel transport.
		Object.assign(systemZone.gateway.profileSecretProjectionsByAgent, {
			[agentId]: {
				API_SERVER_KEY: hermesE2eProfileApiServerKeyEnvironmentName(agentId),
			},
		});
		const toolPortalConfigDirectory = path.join(project.tempRoot, 'config', 'tool-portal');
		await mkdir(toolPortalConfigDirectory, { recursive: true });
		const availableUpstreamUrl = `http://${availableUpstreamHost}:${String(availableUpstream.port)}/mcp`;
		const unavailableUpstreamUrl = `http://${unavailableUpstreamHost}:${String(unavailableUpstream.port)}/mcp`;
		systemZone.egressHosts = [
			...(systemZone.egressHosts ?? []),
			{ audience: 'gateway', host: availableUpstreamHost },
			{ audience: 'gateway', host: unavailableUpstreamHost },
			{ audience: 'gateway', host: modelHost },
		];
		systemZone.toolPortal = {
			configDir: toolPortalConfigDirectory,
			surfaceEligibilityByProfile: {
				[agentId]: {
					[controllerExecutionNamespace]: ['protected_uds'],
					[fakeUpstreamNamespace]: ['mcp', 'protected_uds'],
					[unavailableNamespace]: ['mcp', 'protected_uds'],
				},
			},
		};
		await Promise.all([
			writeToolPortalConfiguration({
				availableUpstreamUrl,
				configDirectory: toolPortalConfigDirectory,
				unavailableUpstreamUrl,
			}),
			writeFile(
				systemZone.gateway.config,
				renderHermesManagedE2eConfiguration({
					contextLength: 65_536,
					fakeModelBaseUrl: `http://${modelHost}:${String(provider.port)}/v1`,
					fakeModelHost: modelHost,
					fakeModelName: modelName,
				}),
				'utf8',
			),
		]);
		await materializeLocalHermesGatewayImagePackages({
			architecture,
			profileName: project.zone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		await prepareGatewayE2eProjectImages({ project });
		let gatewayVm: Pick<GatewayZoneVmOperations, 'exec'> | undefined;
		harness = await startE2eControllerRuntime({
			secrets: {
				...buildHermesE2eProfileApiServerKeySecrets([agentId]),
				AGENT_VM_E2E_CONTROLLER_HOST_PROBE: '1',
				GITHUB_TOKEN: 'unused-hermes-orientation-e2e-github-token',
			},
			startGatewayZone: async (startOptions, dependencies) => {
				const result = await startGatewayZone(startOptions, {
					...dependencies,
					gatewayRuntimeArtifactLimits: controllerFixedGatewayRuntimeArtifactLimits,
					managedVmFactory: {
						createManagedVm: async (request) => {
							const vm = await dependencies.managedVmFactory.createManagedVm(request);
							gatewayVm = vm;
							return vm;
						},
					},
				});
				if (result.executionModel !== 'managed-gateway') {
					throw new Error('Hermes orientation E2E requires a managed Gateway VM.');
				}
				gatewayVm = result.vm;
				return result;
			},
			startOptions: { systemConfig: project.systemConfig, zoneIds: [systemZone.id] },
			tcpHostsOverride: {
				[`${availableUpstreamHost}:${String(availableUpstream.port)}`]: `127.0.0.1:${String(availableUpstream.port)}`,
				[`${unavailableUpstreamHost}:${String(unavailableUpstream.port)}`]: `127.0.0.1:${String(unavailableUpstream.port)}`,
				[`${modelHost}:${String(provider.port)}`]: `127.0.0.1:${String(provider.port)}`,
			},
		});
		await waitForRootApiHealth({
			controllerUrl: harness.controllerUrl,
			gatewayPort: project.gatewayPort,
			resolveVm: () => gatewayVm,
			zoneId: systemZone.id,
		});
		await availableUpstream.firstListToolsRequest;

		const firstPrompt = 'orientation-turn-one';
		await requestHermesTurn({ gatewayPort: project.gatewayPort, prompt: firstPrompt });
		const firstObservation = provider.observations().at(-1);
		if (firstObservation === undefined) throw new Error('Expected first provider observation.');

		let orientedObservation = requireLatestUserContent(firstObservation).includes(orientationMarker)
			? firstObservation
			: undefined;
		for (let attempt = 1; attempt <= 10; attempt += 1) {
			const prompt = `orientation-ready-turn-${String(attempt)}`;
			await requestHermesTurn({ gatewayPort: project.gatewayPort, prompt });
			const observation = provider.observations().at(-1);
			if (
				observation !== undefined &&
				requireLatestUserContent(observation).includes(orientationMarker)
			) {
				orientedObservation = observation;
				break;
			}
		}
		if (orientedObservation === undefined) {
			throw new Error('Hermes did not deliver Tool Portal orientation after inventory resolved.');
		}
		const orientedUserContent = requireLatestUserContent(orientedObservation);
		for (const operationName of operationNames)
			expect(orientedUserContent).toContain(operationName);
		if (!orientedUserContent.includes(`"${fakeUpstreamNamespace}": available`)) {
			if (gatewayVm === undefined)
				throw new Error('Hermes orientation E2E did not capture its VM.');
			throw new Error(
				`Available namespace was not classified as available. Inventory diagnostics:\n${await readInventoryAttemptDiagnostics(gatewayVm)}`,
			);
		}
		expect(orientedUserContent).toContain(`"${unavailableNamespace}": unavailable`);
		expect(orientedUserContent).toContain(`"${controllerExecutionNamespace}": available`);
		expect(orientedUserContent).toContain(`summary: ${JSON.stringify(availableNamespaceSummary)}`);
		expect(orientedUserContent).toContain(
			`summary: ${JSON.stringify(unavailableNamespaceSummary)}`,
		);
		expect(orientedUserContent).toContain(`summary: ${JSON.stringify(controllerExecutionSummary)}`);

		if (gatewayVm === undefined) throw new Error('Hermes orientation E2E did not capture its VM.');

		await requestHermesTurn({ gatewayPort: project.gatewayPort, prompt: 'orientation-final-turn' });
		const finalObservation = provider.observations().at(-1);
		if (finalObservation === undefined) throw new Error('Expected final provider observation.');
		expect(requireLatestUserContent(finalObservation)).not.toContain(orientationMarker);

		const describeResponse = await requestHermesTurn({
			gatewayPort: project.gatewayPort,
			prompt: describePrompt,
		});
		expect(describeResponse).toContain(describeSuccessMarker);

		const authenticationResponse = await requestHermesTurn({
			gatewayPort: project.gatewayPort,
			prompt: authenticationPrompt,
		});
		expect(authenticationResponse).toContain(authenticationSuccessMarker);
		expect(authenticationResponse).not.toContain(remoteProviderErrorCanary);

		const localSchemaErrorResponse = await requestHermesTurn({
			gatewayPort: project.gatewayPort,
			prompt: localSchemaErrorPrompt,
		});
		expect(localSchemaErrorResponse).toContain(localSchemaErrorSuccessMarker);

		const remoteSchemaErrorResponse = await requestHermesTurn({
			gatewayPort: project.gatewayPort,
			prompt: remoteSchemaErrorPrompt,
		});
		expect(remoteSchemaErrorResponse).toContain(remoteSchemaErrorSuccessMarker);
		expect(remoteSchemaErrorResponse).not.toContain(remoteSchemaSecretCanary);

		const controllerExecutionResponse = await requestHermesTurn({
			gatewayPort: project.gatewayPort,
			prompt: controllerExecutionPrompt,
		});
		expect(controllerExecutionResponse).toContain(controllerExecutionSuccessMarker);

		const orientationBearingObservations = provider
			.observations()
			.filter((observation) => requireLatestUserContent(observation).includes(orientationMarker));
		expect(orientationBearingObservations).toEqual([orientedObservation]);
		const expectedSystemContents = systemContents(firstObservation);
		const expectedTools = firstObservation.tools;
		expect(expectedSystemContents.length).toBeGreaterThan(0);
		expect(expectedTools.length).toBeGreaterThan(0);
		for (const observation of provider.observations()) {
			expect(systemContents(observation)).toEqual(expectedSystemContents);
			expect(observation.tools).toEqual(expectedTools);
			for (const content of systemContents(observation))
				expect(content).not.toContain(orientationMarker);
			expect(JSON.stringify(observation.tools)).not.toContain(orientationMarker);
		}
	}, 900_000);
});
