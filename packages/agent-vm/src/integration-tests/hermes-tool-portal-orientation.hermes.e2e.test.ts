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
	renderHermesManagedE2eConfiguration,
	scaffoldHermesE2eProject,
	useLocalHermesGatewayImagePackages,
	type HermesE2eProject,
} from './hermes-e2e-harness.js';

const architecture = currentE2eArchitecture();
const runHermesToolPortalOrientationE2e =
	process.env.AGENT_VM_HERMES_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeHermesToolPortalOrientationE2e = runHermesToolPortalOrientationE2e
	? describe
	: describe.skip;

const agentId = 'main';
const discordSecretEnvironmentName = 'DISCORD_BOT_TOKEN_MAIN';
const availableUpstreamHost = 'orientation-available-mcp.vm.host';
const unavailableUpstreamHost = 'orientation-unavailable-mcp.vm.host';
const unavailableNamespace = 'orientation-unavailable';
const modelHost = 'orientation-model.provider.test';
const modelName = 'hermes-orientation-e2e';
const sessionId = 'hermes-orientation-session';
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
	if (!isObjectRecord(parsed) || !Array.isArray(parsed.messages)) {
		throw new Error('Hermes recording provider expected an OpenAI messages array.');
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
	return { messages };
}

function writeServerSentCompletion(response: ServerResponse): void {
	const chunks = [
		{
			choices: [
				{
					delta: { content: 'orientation-e2e-response', role: 'assistant' },
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

async function startRecordingProvider(): Promise<RecordingProvider> {
	const observations: ProviderObservation[] = [];
	// oxlint-disable-next-line typescript/no-misused-promises -- request body consumption is async
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
			response.writeHead(404).end();
			return;
		}
		observations.push(parseProviderObservation(await readRequestBody(request)));
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
							discovery: { summary: 'Available orientation E2E upstream' },
							kind: 'mcp',
							namespace: fakeUpstreamNamespace,
							transport: { kind: 'streamable-http', url: options.availableUpstreamUrl },
						},
						unavailable: {
							discovery: { summary: 'Unavailable orientation E2E upstream' },
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
								[fakeUpstreamNamespace]: {
									backend: { kind: 'mcp_provider' },
									calls: {
										requiresApproval: { allow: [] },
										withoutApproval: { allow: ['read_thing'] },
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

async function waitForRootApiHealth(gatewayPort: number): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${String(gatewayPort)}/health`, {
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) return;
		} catch {}
		await waitForProtocolRetryInterval(250);
	}
	throw new Error('Timed out waiting for the Hermes orientation E2E health endpoint.');
}

async function requestHermesTurn(options: {
	readonly gatewayPort: number;
	readonly prompt: string;
}): Promise<void> {
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
	await response.text();
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
			startFakeUpstreamMcpServer(),
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
		systemZone.secrets[discordSecretEnvironmentName] = {
			audience: 'gateway',
			envVar: discordSecretEnvironmentName,
			injection: 'env',
			source: 'environment',
		};
		systemZone.toolPortal = {
			configDir: toolPortalConfigDirectory,
			surfaceEligibilityByProfile: {
				[agentId]: {
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
		await useLocalHermesGatewayImagePackages({
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
				[discordSecretEnvironmentName]: 'unused-hermes-orientation-e2e-discord-token',
				GITHUB_TOKEN: 'unused-hermes-orientation-e2e-github-token',
			},
			startGatewayZone: async (startOptions, dependencies) => {
				const result = await startGatewayZone(startOptions, {
					...dependencies,
					gatewayRuntimeArtifactLimits: controllerFixedGatewayRuntimeArtifactLimits,
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
		await waitForRootApiHealth(project.gatewayPort);
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

		if (gatewayVm === undefined) throw new Error('Hermes orientation E2E did not capture its VM.');

		await requestHermesTurn({ gatewayPort: project.gatewayPort, prompt: 'orientation-final-turn' });
		const finalObservation = provider.observations().at(-1);
		if (finalObservation === undefined) throw new Error('Expected final provider observation.');
		expect(requireLatestUserContent(finalObservation)).not.toContain(orientationMarker);
		const orientationBearingObservations = provider
			.observations()
			.filter((observation) => requireLatestUserContent(observation).includes(orientationMarker));
		expect(orientationBearingObservations).toEqual([orientedObservation]);
		const expectedSystemContents = systemContents(firstObservation);
		expect(expectedSystemContents.length).toBeGreaterThan(0);
		for (const observation of provider.observations()) {
			expect(systemContents(observation)).toEqual(expectedSystemContents);
			for (const content of systemContents(observation))
				expect(content).not.toContain(orientationMarker);
		}
	}, 900_000);
});
