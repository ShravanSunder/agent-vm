import { writeFile } from 'node:fs/promises';
/* oxlint-disable eslint/no-await-in-loop -- the test waits on external protocol state */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import type { ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it } from 'vitest';

import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { GatewayZoneVmOperations } from '../gateway/gateway-zone-support.js';
import { controllerFixedGatewayRuntimeArtifactLimits } from '../gateway/managed-gateway-runtime-input-builders.js';
import { createObservabilityRuntimeConfig } from '../observability/observability-config.js';
import { prepareObservabilityStack } from '../observability/observability-lifecycle.js';
import {
	currentE2eArchitecture,
	findAvailablePort,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	startE2eControllerRuntime,
	useLocalToolVmMcpPortalPackage,
	type E2eHarnessRuntime,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import {
	buildHermesE2eProfileApiServerKeySecrets,
	hermesE2eProfileApiServerKey,
	hermesE2eProfileApiServerKeyEnvironmentName,
	scaffoldHermesE2eProject,
	shouldRunHermesE2e,
	useLocalHermesGatewayImagePackages,
	type HermesE2eProject,
} from './hermes-e2e-harness.js';
import {
	expectProviderTransitionLogs,
	readObservabilityStackDiagnostics,
	requireTraceIdForSpan,
	selectStoredHermesFrameworkLogs,
	settleCleanupPhases,
	stopObservabilityStack,
	waitForVictoriaMetric,
	waitForVictoriaText,
} from './hermes-framework-observability-e2e-support.js';

const architecture = currentE2eArchitecture();
const runHermesFrameworkObservabilityE2e = await shouldRunHermesE2e({ architecture });
const describeHermesFrameworkObservabilityE2e = runHermesFrameworkObservabilityE2e
	? describe
	: describe.skip;

const primaryModelHost = 'api.openai.com';
const primaryModelName = 'hermes-framework-otel-primary';
const fallbackModelHost = 'openrouter.ai';
const fallbackModelName = 'hermes-framework-otel-fallback';
const discordSecretEnvironmentName = 'DISCORD_BOT_TOKEN_MAIN_E2E';
const forbiddenCanariesByField = {
	command: 'hermes-framework-otel-command-canary',
	discordSecret: 'hermes-framework-otel-discord-secret-canary',
	identity: 'hermes-framework-otel-identity-canary',
	path: '/work/hermes-framework-otel-path-canary',
	prompt: 'hermes-framework-otel-prompt-canary',
	rawError: 'hermes-framework-otel-raw-error-canary',
	response: 'hermes-framework-otel-response-canary',
	toolArgument: 'hermes-framework-otel-tool-argument-canary',
	toolResult: 'hermes-framework-otel-tool-result-canary',
	unapprovedResource: 'hermes-framework-otel-unapproved-resource-canary',
	url: 'https://hermes-framework-otel-url-canary.invalid/private',
} as const satisfies Readonly<Record<string, string>>;
const forbiddenCanaries = Object.values(forbiddenCanariesByField);
const contentCanaries = forbiddenCanaries.filter(
	(canary) => canary !== forbiddenCanariesByField.unapprovedResource,
);

interface FakeProviderRequestObservation {
	readonly host: string | undefined;
	readonly toolNames: readonly string[];
	readonly toolResultContents: readonly string[];
}

interface FakeProvider {
	readonly close: () => Promise<void>;
	readonly observations: () => readonly FakeProviderRequestObservation[];
	readonly port: number;
}

interface CapturedOtlpRequest {
	readonly body: Buffer;
	readonly path: string;
}

function writeJson(response: ServerResponse, statusCode: number, body: object): void {
	response.writeHead(statusCode, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

function writeServerSentEvents(response: ServerResponse, chunks: readonly object[]): void {
	response.writeHead(200, {
		'cache-control': 'no-cache',
		connection: 'keep-alive',
		'content-type': 'text/event-stream',
	});
	for (const chunk of chunks) {
		response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	}
	response.end('data: [DONE]\n\n');
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function observeFakeProviderRequest(
	host: string | undefined,
	requestBody: string,
): FakeProviderRequestObservation {
	const parsed: unknown = JSON.parse(requestBody);
	if (!isObjectRecord(parsed)) {
		return { host, toolNames: [], toolResultContents: [] };
	}
	const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
	const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
	return {
		host,
		toolNames: tools.flatMap((tool) => {
			if (!isObjectRecord(tool) || !isObjectRecord(tool.function)) return [];
			return typeof tool.function.name === 'string' ? [tool.function.name] : [];
		}),
		toolResultContents: messages.flatMap((message) => {
			if (
				!isObjectRecord(message) ||
				message.role !== 'tool' ||
				typeof message.content !== 'string'
			) {
				return [];
			}
			return [message.content];
		}),
	};
}

function captureOtlpMediation(options: {
	readonly capturedRequests: CapturedOtlpRequest[];
	readonly request: ManagedVmCreateRequest;
}): ManagedVmCreateRequest {
	const originalRequestHook = options.request.mediation?.onRequest;
	if (originalRequestHook === undefined) {
		throw new Error('Hermes observability E2E expected the production OTLP mediation hook.');
	}
	return {
		...options.request,
		mediation: {
			...options.request.mediation,
			onRequest: async (request: Request): Promise<Request | Response | void> => {
				const url = new URL(request.url);
				if (
					url.hostname === 'otel-collector.observability.vm.host' &&
					['/v1/logs', '/v1/metrics', '/v1/traces'].includes(url.pathname)
				) {
					options.capturedRequests.push({
						body: Buffer.from(await request.clone().arrayBuffer()),
						path: url.pathname,
					});
				}
				return await originalRequestHook(request);
			},
		},
	};
}

async function startFakeProvider(): Promise<FakeProvider> {
	const observations: FakeProviderRequestObservation[] = [];
	let fallbackRequestCount = 0;
	// oxlint-disable-next-line typescript/no-misused-promises -- request body consumption is async
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
			writeJson(response, 404, { error: 'unhandled fake provider route' });
			return;
		}
		const requestBody = await readRequestBody(request);
		observations.push(observeFakeProviderRequest(request.headers.host, requestBody));
		if (request.headers.host?.startsWith(primaryModelHost) === true) {
			writeJson(response, 500, {
				error: {
					message: forbiddenCanariesByField.rawError,
					type: 'test_provider_failure',
				},
			});
			return;
		}
		fallbackRequestCount += 1;
		if (fallbackRequestCount <= 2) {
			const toolCall =
				fallbackRequestCount === 1
					? {
							function: {
								arguments: JSON.stringify({
									command: `printf '%s %s %s %s' '${forbiddenCanariesByField.command}' '${forbiddenCanariesByField.toolResult}' '${forbiddenCanariesByField.path}' '${forbiddenCanariesByField.url}'`,
								}),
								name: 'terminal',
							},
							id: 'terminal-call',
							index: 0,
							type: 'function',
						}
					: {
							function: {
								arguments: JSON.stringify({
									requests: [{ id: forbiddenCanariesByField.toolArgument }],
								}),
								name: 'tool_portal_list',
							},
							id: 'tool-portal-call',
							index: 0,
							type: 'function',
						};
			writeServerSentEvents(response, [
				{
					choices: [
						{
							delta: {
								content: null,
								role: 'assistant',
								tool_calls: [toolCall],
							},
							finish_reason: null,
							index: 0,
						},
					],
					created: fallbackRequestCount,
					id: `hermes-framework-otel-tool-response-${String(fallbackRequestCount)}`,
					model: fallbackModelName,
					object: 'chat.completion.chunk',
				},
				{
					choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
					created: fallbackRequestCount,
					id: `hermes-framework-otel-tool-response-${String(fallbackRequestCount)}`,
					model: fallbackModelName,
					object: 'chat.completion.chunk',
				},
				{
					choices: [],
					created: fallbackRequestCount,
					id: `hermes-framework-otel-tool-response-${String(fallbackRequestCount)}`,
					model: fallbackModelName,
					object: 'chat.completion.chunk',
					usage: { completion_tokens: 7, prompt_tokens: 11, total_tokens: 18 },
				},
			]);
			return;
		}
		writeServerSentEvents(response, [
			{
				choices: [
					{
						delta: { content: forbiddenCanariesByField.response, role: 'assistant' },
						finish_reason: null,
						index: 0,
					},
				],
				created: 2,
				id: 'hermes-framework-otel-second-provider-response',
				model: fallbackModelName,
				object: 'chat.completion.chunk',
			},
			{
				choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
				created: 2,
				id: 'hermes-framework-otel-second-provider-response',
				model: fallbackModelName,
				object: 'chat.completion.chunk',
			},
			{
				choices: [],
				created: 2,
				id: 'hermes-framework-otel-second-provider-response',
				model: fallbackModelName,
				object: 'chat.completion.chunk',
				usage: { completion_tokens: 5, prompt_tokens: 13, total_tokens: 18 },
			},
		]);
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
		throw new Error('Fake Hermes provider did not bind a loopback port.');
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

function renderHermesFrameworkObservabilityConfiguration(providerPort: number): string {
	return [
		'plugins:',
		'  enabled:',
		'    - agent-vm-tool-portal',
		'  disabled: []',
		'model:',
		`  default: ${primaryModelName}`,
		'  provider: custom:hermes-framework-otel-primary',
		'  context_length: 65536',
		'custom_providers:',
		'  - name: hermes-framework-otel-primary',
		`    base_url: http://${primaryModelHost}:${String(providerPort)}/v1`,
		'    api_mode: chat_completions',
		`    model: ${primaryModelName}`,
		'    models:',
		`      ${primaryModelName}:`,
		'        context_length: 65536',
		'  - name: hermes-framework-otel-fallback',
		`    base_url: http://${fallbackModelHost}:${String(providerPort)}/v1`,
		'    api_mode: chat_completions',
		`    model: ${fallbackModelName}`,
		'    models:',
		`      ${fallbackModelName}:`,
		'        context_length: 65536',
		'fallback_providers:',
		'  - provider: custom:hermes-framework-otel-fallback',
		`    model: ${fallbackModelName}`,
		'provider_routing:',
		'  order:',
		'    - hermes-framework-otel-primary',
		'    - hermes-framework-otel-fallback',
		'approvals:',
		"  mode: 'off'",
		'code_execution:',
		'  mode: project',
		// The fake provider intentionally calls the managed plugin tool by its
		// concrete name. Hermes v0.20 normally defers non-core plugin tools
		// behind tool_search, so disable that progressive-disclosure layer for
		// this direct observability probe.
		'tools:',
		'  tool_search:',
		'    enabled: off',
		'',
	].join('\n');
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
	throw new Error('Timed out waiting for the Hermes root API health endpoint.');
}

async function runSignalNegativeGatewayBoot(options: {
	readonly disabledPath: '/v1/logs' | '/v1/metrics' | '/v1/traces';
	readonly disabledSignal: 'logs' | 'metrics' | 'traces';
}): Promise<void> {
	const repoRoot = process.cwd();
	const provider = await startFakeProvider();
	let harness: E2eHarnessRuntime | undefined;
	let project: HermesE2eProject | undefined;
	let operationFailure: { readonly error: unknown } | undefined;
	const capturedRequests: CapturedOtlpRequest[] = [];
	try {
		const ports = await Promise.all(
			Array.from({ length: 6 }, async () => await findAvailablePort()),
		);
		if (ports.length !== 6) throw new Error('Expected six observability ports.');
		const [collectorGrpc, collectorHttp, collectorHealth, metrics, logs, traces] = ports as [
			number,
			number,
			number,
			number,
			number,
			number,
		];
		project = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture,
			prefix: `hermes-framework-otel-${options.disabledSignal}-disabled-e2e-`,
			zoneId: `hermes-framework-otel-${options.disabledSignal}-disabled-e2e`,
		});
		const systemZone = project.systemConfig.zones[0];
		if (systemZone === undefined || systemZone.gateway.type !== 'hermes') {
			throw new Error('Expected the Hermes signal-negative E2E zone.');
		}
		project.systemConfig.host.observability = {
			bindAddress: '127.0.0.1',
			controllerStartPolicy: 'off',
			enabled: true,
			mode: 'collector',
			ports: { collectorGrpc, collectorHealth, collectorHttp, logs, metrics, traces },
			prepareOnBuild: false,
			projectName: `hermes-otel-${options.disabledSignal}-disabled-${Date.now().toString(36)}`,
			runner: 'docker-compose',
			stack: { mode: 'external', scrubbing: { responsibility: 'external-collector' } },
			startupCheckTimeoutMs: 30_000,
			waitOnBuild: false,
		};
		systemZone.observability = {
			enabled: true,
			services: {
				framework: {
					flushIntervalMs: 1_000,
					logs: options.disabledSignal !== 'logs',
					metrics: options.disabledSignal !== 'metrics',
					sampleRate: 1,
					traces: options.disabledSignal !== 'traces',
				},
				toolPortal: {
					flushIntervalMs: 1_000,
					logs: false,
					metrics: false,
					sampleRate: 1,
					traces: false,
				},
			},
		};
		systemZone.secrets[discordSecretEnvironmentName] = {
			audience: 'gateway',
			envVar: discordSecretEnvironmentName,
			injection: 'env',
			source: 'environment',
		};
		systemZone.gateway.profileSecretProjectionsByAgent.main = {
			API_SERVER_KEY: hermesE2eProfileApiServerKeyEnvironmentName('main'),
			DISCORD_BOT_TOKEN: discordSecretEnvironmentName,
		};
		systemZone.egressHosts = [
			...(systemZone.egressHosts ?? []),
			{ audience: 'gateway', host: primaryModelHost },
			{ audience: 'gateway', host: fallbackModelHost },
		];
		await Promise.all([
			useLocalToolVmMcpPortalPackage({
				projectRoot: project.tempRoot,
				repoRoot,
				systemConfig: project.systemConfig,
			}),
			writeFile(
				systemZone.gateway.config,
				renderHermesFrameworkObservabilityConfiguration(provider.port),
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
		harness = await startE2eControllerRuntime({
			secrets: {
				...buildHermesE2eProfileApiServerKeySecrets(['main']),
				[discordSecretEnvironmentName]: forbiddenCanariesByField.discordSecret,
				GITHUB_TOKEN: 'unused-hermes-framework-otel-github-token',
			},
			startGatewayZone: async (startOptions, dependencies) =>
				await startGatewayZone(startOptions, {
					...dependencies,
					gatewayRuntimeArtifactLimits: controllerFixedGatewayRuntimeArtifactLimits,
					managedVmFactory: {
						createManagedVm: async (request) =>
							await dependencies.managedVmFactory.createManagedVm(
								captureOtlpMediation({ capturedRequests, request }),
							),
					},
				}),
			startOptions: { systemConfig: project.systemConfig, zoneIds: [project.zone.id] },
			tcpHostsOverride: {
				[`${primaryModelHost}:${String(provider.port)}`]: `127.0.0.1:${String(provider.port)}`,
				[`${fallbackModelHost}:${String(provider.port)}`]: `127.0.0.1:${String(provider.port)}`,
			},
		});
		await waitForRootApiHealth(project.gatewayPort);
		const response = await fetch(
			`http://127.0.0.1:${String(project.gatewayPort)}/p/main/v1/chat/completions`,
			{
				body: JSON.stringify({
					messages: [{ content: forbiddenCanariesByField.prompt, role: 'user' }],
					model: primaryModelName,
					stream: false,
				}),
				headers: {
					authorization: `Bearer ${hermesE2eProfileApiServerKey('main')}`,
					'content-type': 'application/json',
					'x-hermes-session-id': `${options.disabledSignal}-signal-negative-session`,
				},
				method: 'POST',
				signal: AbortSignal.timeout(120_000),
			},
		);
		expect(response.ok).toBe(true);
		expect(await response.text()).toContain(forbiddenCanariesByField.response);
		await harness.close({ preserveTempRoot: true });
		harness = undefined;
		const requestPaths = capturedRequests.map(({ path: otlpPath }) => otlpPath);
		expect(requestPaths).not.toContain(options.disabledPath);
		for (const enabledPath of ['/v1/logs', '/v1/metrics', '/v1/traces'] as const) {
			if (enabledPath === options.disabledPath) continue;
			expect(
				requestPaths.filter((requestPath) => requestPath === enabledPath).length,
			).toBeGreaterThanOrEqual(1);
		}
	} catch (error: unknown) {
		operationFailure = { error };
	}
	const cleanupErrors = await settleCleanupPhases([
		() => [harness?.close({ preserveTempRoot: true }) ?? Promise.resolve()],
		() => [provider.close()],
		() => [project === undefined ? Promise.resolve() : removeE2eTempRoot(project.tempRoot)],
	]);
	if (operationFailure !== undefined && cleanupErrors.length > 0) {
		throw new AggregateError(
			[operationFailure.error, ...cleanupErrors],
			'Hermes disabled-signal E2E operation and cleanup failed.',
			{ cause: operationFailure.error },
		);
	}
	if (operationFailure !== undefined) {
		throw operationFailure.error;
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, 'Hermes disabled-signal E2E cleanup failed.');
	}
}

describeHermesFrameworkObservabilityE2e(
	'e2e: Hermes framework OTLP through Gondolin mediation',
	() => {
		let harness: E2eHarnessRuntime | undefined;
		let project: HermesE2eProject | undefined;
		let provider: FakeProvider | undefined;
		let gatewayVm: Pick<GatewayZoneVmOperations, 'exec'> | undefined;
		const capturedOtlpRequests: CapturedOtlpRequest[] = [];

		afterEach(async () => {
			const cleanupHarness = harness;
			const cleanupProvider = provider;
			const cleanupProject = project;
			harness = undefined;
			provider = undefined;
			project = undefined;
			gatewayVm = undefined;
			const cleanupErrors = await settleCleanupPhases([
				() => [cleanupHarness?.close({ preserveTempRoot: true }) ?? Promise.resolve()],
				() => [
					cleanupProvider?.close() ?? Promise.resolve(),
					cleanupProject === undefined ? Promise.resolve() : stopObservabilityStack(cleanupProject),
				],
				() => [
					cleanupProject === undefined
						? Promise.resolve()
						: removeE2eTempRoot(cleanupProject.tempRoot),
				],
			]);
			if (cleanupErrors.length > 0) {
				throw new AggregateError(cleanupErrors, 'Hermes observability E2E cleanup failed.');
			}
		});

		it('exports bounded turn, provider, built-in tool, and Tool Portal telemetry to Victoria', async () => {
			const repoRoot = path.resolve(process.cwd());
			provider = await startFakeProvider();
			const ports = await Promise.all(
				Array.from({ length: 6 }, async () => await findAvailablePort()),
			);
			if (ports.length !== 6) {
				throw new Error('Expected six observability ports.');
			}
			const [collectorGrpc, collectorHttp, collectorHealth, metrics, logs, traces] = ports as [
				number,
				number,
				number,
				number,
				number,
				number,
			];
			project = await scaffoldHermesE2eProject({
				agents: ['main'],
				architecture,
				prefix: 'hermes-framework-observability-e2e-',
				zoneId: 'hermes-framework-observability-e2e',
			});
			const systemZone = project.systemConfig.zones[0];
			if (systemZone === undefined || systemZone.gateway.type !== 'hermes') {
				throw new Error('Expected the Hermes observability E2E zone.');
			}
			const observabilityProjectName = `hermes-otel-${Date.now().toString(36)}`;
			project.systemConfig.host.projectNamespace = observabilityProjectName;
			project.systemConfig.host.observability = {
				bindAddress: '127.0.0.1',
				controllerStartPolicy: 'require-ready',
				dataDir: path.join(project.tempRoot, 'victoria-data'),
				enabled: true,
				mode: 'collector',
				ports: { collectorGrpc, collectorHealth, collectorHttp, logs, metrics, traces },
				prepareOnBuild: true,
				projectName: observabilityProjectName,
				retention: {
					logs: { maxDiskSpaceUsageBytes: '128MiB', period: '1d' },
					metrics: { minFreeDiskSpaceBytes: '1MiB', period: '1d' },
					traces: { maxDiskSpaceUsageBytes: '128MiB', period: '1d' },
				},
				runner: 'docker-compose',
				stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
				startupCheckTimeoutMs: 30_000,
				waitOnBuild: true,
			};
			systemZone.observability = {
				enabled: true,
				services: {
					framework: {
						flushIntervalMs: 1_000,
						logs: true,
						metrics: true,
						sampleRate: 1,
						traces: true,
					},
					toolPortal: {
						flushIntervalMs: 1_000,
						logs: true,
						metrics: true,
						sampleRate: 1,
						traces: true,
					},
				},
			};
			systemZone.secrets[discordSecretEnvironmentName] = {
				audience: 'gateway',
				envVar: discordSecretEnvironmentName,
				injection: 'env',
				source: 'environment',
			};
			systemZone.gateway.profileSecretProjectionsByAgent.main = {
				API_SERVER_KEY: hermesE2eProfileApiServerKeyEnvironmentName('main'),
				DISCORD_BOT_TOKEN: discordSecretEnvironmentName,
			};
			systemZone.egressHosts = [
				...(systemZone.egressHosts ?? []),
				{ audience: 'gateway', host: primaryModelHost },
				{ audience: 'gateway', host: fallbackModelHost },
			];
			await Promise.all([
				useLocalToolVmMcpPortalPackage({
					projectRoot: project.tempRoot,
					repoRoot,
					systemConfig: project.systemConfig,
				}),
				writeFile(
					systemZone.gateway.config,
					renderHermesFrameworkObservabilityConfiguration(provider.port),
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
			const observabilityRuntimeConfig = createObservabilityRuntimeConfig(project.systemConfig);
			if (
				!observabilityRuntimeConfig.enabled ||
				observabilityRuntimeConfig.stackMode !== 'managed'
			) {
				throw new Error('Expected managed observability runtime configuration.');
			}
			await prepareObservabilityStack({ config: observabilityRuntimeConfig, wait: true });
			harness = await startE2eControllerRuntime({
				secrets: {
					...buildHermesE2eProfileApiServerKeySecrets(['main']),
					[discordSecretEnvironmentName]: forbiddenCanariesByField.discordSecret,
					GITHUB_TOKEN: 'unused-hermes-framework-otel-github-token',
				},
				startGatewayZone: async (startOptions, dependencies) => {
					const controllerResourceAttributes =
						startOptions.runtimeEnvironment?.OTEL_RESOURCE_ATTRIBUTES;
					if (controllerResourceAttributes === undefined) {
						throw new Error(
							'Hermes observability E2E requires controller-authored resource attributes.',
						);
					}
					const result = await startGatewayZone(
						{
							...startOptions,
							runtimeEnvironment: {
								...startOptions.runtimeEnvironment,
								OTEL_RESOURCE_ATTRIBUTES: `${controllerResourceAttributes},unapproved.resource=${forbiddenCanariesByField.unapprovedResource}`,
							},
						},
						{
							...dependencies,
							gatewayRuntimeArtifactLimits: controllerFixedGatewayRuntimeArtifactLimits,
							managedVmFactory: {
								createManagedVm: async (request) =>
									await dependencies.managedVmFactory.createManagedVm(
										captureOtlpMediation({ capturedRequests: capturedOtlpRequests, request }),
									),
							},
						},
					);
					if (result.executionModel !== 'managed-gateway') {
						throw new Error('Hermes observability E2E requires a managed Gateway VM.');
					}
					gatewayVm = result.vm;
					return result;
				},
				startOptions: { systemConfig: project.systemConfig, zoneIds: [project.zone.id] },
				tcpHostsOverride: {
					[`${primaryModelHost}:${String(provider.port)}`]: `127.0.0.1:${String(provider.port)}`,
					[`${fallbackModelHost}:${String(provider.port)}`]: `127.0.0.1:${String(provider.port)}`,
				},
			});
			await waitForRootApiHealth(project.gatewayPort);
			const response = await fetch(
				`http://127.0.0.1:${String(project.gatewayPort)}/p/main/v1/chat/completions`,
				{
					body: JSON.stringify({
						messages: [
							{
								content: `${forbiddenCanariesByField.prompt} ${forbiddenCanariesByField.identity}`,
								role: 'user',
							},
						],
						model: primaryModelName,
						stream: false,
					}),
					headers: {
						authorization: `Bearer ${hermesE2eProfileApiServerKey('main')}`,
						'content-type': 'application/json',
						'x-hermes-session-id': forbiddenCanariesByField.identity,
					},
					method: 'POST',
					signal: AbortSignal.timeout(120_000),
				},
			);
			expect(response.ok).toBe(true);
			const responseBody = await response.text();
			expect(responseBody).toContain(forbiddenCanariesByField.response);
			const providerObservations = provider.observations();
			const primaryProviderHost = `${primaryModelHost}:${String(provider.port)}`;
			const fallbackProviderHost = `${fallbackModelHost}:${String(provider.port)}`;
			expect(
				providerObservations.filter(({ host }) => host === primaryProviderHost).length,
			).toBeGreaterThanOrEqual(1);
			expect(
				providerObservations.filter(({ host }) => host === fallbackProviderHost).length,
			).toBeGreaterThanOrEqual(3);
			expect(
				providerObservations.every(
					({ host }) => host === primaryProviderHost || host === fallbackProviderHost,
				),
			).toBe(true);
			const logsEndpoint = `http://127.0.0.1:${String(logs)}/select/logsql/query`;
			const tracesEndpoint = `http://127.0.0.1:${String(traces)}/select/logsql/query`;
			const readTelemetryDiagnostics = async (): Promise<string> => {
				if (gatewayVm === undefined || project === undefined) {
					return 'Gateway VM diagnostics unavailable.';
				}
				return `${(
					await gatewayVm.exec(
						[
							'for process_environment in /proc/[0-9]*/environ; do',
							"tr '\\0' '\\n' < \"$process_environment\" 2>/dev/null",
							"| sed -n '/^OTEL_/s/=.*$/=<set>/p'",
							'done;',
							'tail -n 300 /var/log/agent-vm/hermes-service.log 2>&1',
						].join(' '),
					)
				).toString()}\n${await readObservabilityStackDiagnostics(project)}`;
			};
			const frameworkLogs = await waitForVictoriaText({
				diagnostics: readTelemetryDiagnostics,
				endpoint: logsEndpoint,
				expected: ['"agent_vm.operation.category":"turn"', '"hermes.tool.category"'],
				query: '*',
			});
			const frameworkTraces = await waitForVictoriaText({
				endpoint: tracesEndpoint,
				expected: ['hermes.llm.request', 'hermes.tool.call'],
				query: '"resource_attr:service.name":"agent-vm-hermes"',
			});
			const frameworkToolPortalTraces = await waitForVictoriaText({
				diagnostics: async () =>
					`${JSON.stringify(providerObservations)}\n${await readTelemetryDiagnostics()}`,
				endpoint: tracesEndpoint,
				expected: 'hermes.tool_portal.operation',
				query: '"resource_attr:service.name":"agent-vm-hermes"',
			});
			const toolPortalOperationTraceId = requireTraceIdForSpan(
				frameworkToolPortalTraces,
				'hermes.tool_portal.operation',
			);
			const commonToolPortalTraces = await waitForVictoriaText({
				endpoint: tracesEndpoint,
				expected: toolPortalOperationTraceId,
				query: '"resource_attr:service.name":"agent-vm-tool-portal"',
			});
			const frameworkMetrics = await waitForVictoriaMetric(metrics, 'hermes.turns_total');
			expect(frameworkLogs).toContain('"agent_vm.operation.category":"provider_attempt"');
			expect(frameworkLogs).toContain('"agent_vm.operation.category":"tool"');
			expect(frameworkLogs).toContain('"agent_vm.result.class":"success"');
			expectProviderTransitionLogs({
				fallbackModelName,
				logs: frameworkLogs,
				primaryModelName,
			});
			expect(frameworkTraces).toContain('hermes.tool.call');
			expect(frameworkTraces).toContain('hermes.tool.category');
			expect(frameworkTraces).toContain(primaryModelName);
			expect(frameworkTraces).toContain(fallbackModelName);
			expect(frameworkTraces).toContain('dev.runtime.flavor');
			expect(frameworkMetrics).toContain('hermes.turns_total');
			expect(frameworkToolPortalTraces).toContain('hermes.tool_portal.operation');
			expect(commonToolPortalTraces).toContain(toolPortalOperationTraceId);
			const storedFrameworkLogs = selectStoredHermesFrameworkLogs(frameworkLogs);
			for (const expectedOperationCategory of ['turn', 'provider_attempt', 'tool']) {
				expect(storedFrameworkLogs).toContain(
					`"agent_vm.operation.category":"${expectedOperationCategory}"`,
				);
			}
			expectProviderTransitionLogs({
				fallbackModelName,
				logs: storedFrameworkLogs,
				primaryModelName,
			});
			const capturedFrameworkOtlpRequests = capturedOtlpRequests.filter(({ body }) =>
				body.includes('agent-vm-hermes'),
			);
			expect(capturedFrameworkOtlpRequests.map(({ path: otlpPath }) => otlpPath)).toEqual(
				expect.arrayContaining(['/v1/logs', '/v1/metrics', '/v1/traces']),
			);
			for (const { body } of capturedFrameworkOtlpRequests) {
				for (const canary of forbiddenCanaries) expect(body.includes(canary)).toBe(false);
				expect(body.includes('dev.runtime.flavor')).toBe(true);
			}
			for (const { body } of capturedOtlpRequests) {
				for (const canary of contentCanaries) expect(body.includes(canary)).toBe(false);
			}
			const allStoredFrameworkSignals = [
				storedFrameworkLogs,
				frameworkTraces,
				frameworkToolPortalTraces,
				frameworkMetrics,
			];
			for (const canary of forbiddenCanaries) {
				for (const storedSignal of allStoredFrameworkSignals) {
					expect(storedSignal).not.toContain(canary);
				}
			}
			for (const canary of contentCanaries) {
				expect(frameworkLogs).not.toContain(canary);
				expect(commonToolPortalTraces).not.toContain(canary);
			}
		}, 900_000);

		it.each([
			['traces', '/v1/traces'],
			['metrics', '/v1/metrics'],
			['logs', '/v1/logs'],
		] as const)(
			'does not mediate framework %s OTLP exports when that signal is disabled',
			async (disabledSignal, disabledPath) => {
				await runSignalNegativeGatewayBoot({ disabledPath, disabledSignal });
			},
			900_000,
		);
	},
);
