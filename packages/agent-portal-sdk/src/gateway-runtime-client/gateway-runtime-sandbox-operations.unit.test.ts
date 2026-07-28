import { describe, expect, it, vi } from 'vitest';

import {
	SANDBOX_METHOD_CONTRACTS,
	type GatewayRuntimeTrustedInvocationContext,
} from '../contracts/index.js';
import {
	GatewayRuntimeClient,
	type GatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeConnection,
	type GatewayRuntimeRequestOptions,
	type GatewayRuntimeTransportFactory,
	type GatewayRuntimeTrustedRequestOptions,
} from './index.js';

const ATTACHMENT = {
	attachmentGeneration: 3,
	clientKind: 'hermes-managed-plugin',
	configuredAgentIds: ['agent-a'],
	frameworkEpoch: 'framework-epoch-1',
	gatewayEpoch: 'gateway-epoch-1',
	protocolVersion: 1,
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	runtimeEpoch: 'runtime-epoch-1',
	schemaVersion: 1,
} satisfies GatewayRuntimeAttachmentMetadata;

const TRUSTED_CONTEXT = {
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
		profileAssignmentRevision: 'profile-assignment:agent-a:1',
		toolPortalProfileId: 'profile-a',
	},
} satisfies GatewayRuntimeTrustedInvocationContext;

const ENVIRONMENT = {
	handleId: 'environment-1',
	kind: 'environment',
	owningGeneration: 'generation-1',
} as const;
const OPERATION = { operationId: 'operation-1', owningGeneration: 'generation-1' } as const;
const PROCESS = {
	handleId: 'process-1',
	kind: 'process',
	owningGeneration: 'generation-1',
} as const;
const STANDARD_INPUT = {
	channel: 'stdin',
	handleId: 'stdin-1',
	kind: 'stream',
	owningGeneration: 'generation-1',
} as const;
const STANDARD_OUTPUT = {
	channel: 'stdout',
	handleId: 'stdout-1',
	kind: 'stream',
	owningGeneration: 'generation-1',
} as const;
const TERMINAL = {
	handleId: 'terminal-1',
	kind: 'terminal',
	owningGeneration: 'generation-1',
} as const;
const TERMINAL_SIZE = { columns: 100, rows: 30 } as const;
const EMPTY_BINARY_CHUNK = { byteLength: 0, contentBase64: '', encoding: 'base64' } as const;
const EMPTY_CONTENT_DIGEST = `sha256:${'0'.repeat(64)}`;
const SUCCEEDED_OUTCOME = {
	certainty: 'proven',
	completion: 'succeeded',
	kind: 'completed',
	retryClass: 'forbidden',
} as const;

type SandboxMethodName = keyof typeof SANDBOX_METHOD_CONTRACTS;

const RESPONSES = {
	'sandbox.environment.close': { environment: ENVIRONMENT, kind: 'closed' },
	'sandbox.environment.open': {
		environment: ENVIRONMENT,
		kind: 'opened',
		logicalCwd: 'workspace',
	},
	'sandbox.environment.status': {
		environment: ENVIRONMENT,
		kind: 'active',
		logicalCwd: 'workspace',
	},
	'sandbox.exec.cancel': { kind: 'cancel-request-accepted', operation: OPERATION },
	'sandbox.exec.start': {
		kind: 'started',
		mode: 'direct',
		operation: OPERATION,
		streams: [STANDARD_OUTPUT],
	},
	'sandbox.exec.wait': { exitCode: 0, operation: OPERATION, outcome: SUCCEEDED_OUTCOME },
	'sandbox.retained-result.lookup': {
		kind: 'retained',
		operation: OPERATION,
		outcome: SUCCEEDED_OUTCOME,
	},
	'sandbox.fs.list': { entries: [], kind: 'listed' },
	'sandbox.fs.mkdir': { created: true, kind: 'directory-ready', path: 'new-directory' },
	'sandbox.fs.read': {
		chunk: EMPTY_BINARY_CHUNK,
		eof: true,
		kind: 'read',
		nextOffsetBytes: 0,
		path: 'file.txt',
	},
	'sandbox.fs.remove': { kind: 'removed', path: 'old-file.txt', removed: true },
	'sandbox.fs.rename': {
		destinationPath: 'new-file.txt',
		kind: 'renamed',
		sourcePath: 'old-file.txt',
	},
	'sandbox.fs.stat': {
		entry: { byteLength: 0, kind: 'file', path: 'file.txt' },
		kind: 'stat',
	},
	'sandbox.fs.write': {
		bytesWritten: 0,
		contentDigest: EMPTY_CONTENT_DIGEST,
		kind: 'written',
		path: 'file.txt',
	},
	'sandbox.process.cancel': { kind: 'cancel-request-accepted', operation: OPERATION },
	'sandbox.process.logs': {
		chunks: [],
		kind: 'logs',
		process: PROCESS,
		truncated: false,
	},
	'sandbox.process.start': {
		kind: 'started',
		operation: OPERATION,
		process: PROCESS,
		streams: [STANDARD_OUTPUT],
	},
	'sandbox.process.status': { kind: 'running', operation: OPERATION, process: PROCESS },
	'sandbox.process.wait': {
		kind: 'terminal',
		operation: OPERATION,
		outcome: SUCCEEDED_OUTCOME,
		process: PROCESS,
	},
	'sandbox.stream.close': { kind: 'closed', stream: STANDARD_INPUT },
	'sandbox.stream.read': {
		chunk: EMPTY_BINARY_CHUNK,
		eof: true,
		kind: 'read',
		sequence: 0,
		stream: STANDARD_OUTPUT,
	},
	'sandbox.stream.write': {
		bytesWritten: 0,
		kind: 'written',
		sequence: 0,
		stream: STANDARD_INPUT,
	},
	'sandbox.terminal.attach': {
		input: STANDARD_INPUT,
		kind: 'attached',
		output: STANDARD_OUTPUT,
		terminal: TERMINAL,
	},
	'sandbox.terminal.resize': {
		kind: 'resized',
		size: TERMINAL_SIZE,
		terminal: TERMINAL,
	},
} as const satisfies Readonly<Record<SandboxMethodName, unknown>>;

interface RecordedSandboxRequest {
	readonly method: string;
	readonly options: GatewayRuntimeRequestOptions;
	readonly params: unknown;
}

class RecordingGatewayRuntimeConnection implements GatewayRuntimeConnection {
	readonly requests: RecordedSandboxRequest[] = [];
	readonly #responseOverrides: Readonly<Partial<Record<SandboxMethodName, unknown>>>;

	constructor(responseOverrides: Readonly<Partial<Record<SandboxMethodName, unknown>>> = {}) {
		this.#responseOverrides = responseOverrides;
	}

	async close(): Promise<void> {}

	async handshake(_attachment: GatewayRuntimeAttachmentMetadata): Promise<void> {}

	async request(
		method: string,
		params: unknown,
		options: GatewayRuntimeRequestOptions = {},
	): Promise<unknown> {
		this.requests.push({ method, options, params });
		if (Object.hasOwn(this.#responseOverrides, method)) {
			return this.#responseOverrides[method as SandboxMethodName];
		}
		return RESPONSES[method as SandboxMethodName];
	}
}

class RecordingGatewayRuntimeTransportFactory implements GatewayRuntimeTransportFactory {
	readonly connection: RecordingGatewayRuntimeConnection;

	constructor(responseOverrides: Readonly<Partial<Record<SandboxMethodName, unknown>>> = {}) {
		this.connection = new RecordingGatewayRuntimeConnection(responseOverrides);
	}

	async connect(): Promise<GatewayRuntimeConnection> {
		return this.connection;
	}
}

interface SandboxProjectionCase {
	readonly invoke: (
		client: GatewayRuntimeClient,
		options: GatewayRuntimeTrustedRequestOptions,
	) => Promise<unknown>;
	readonly method: SandboxMethodName;
	readonly path: string;
	readonly publicRequest: unknown;
}

const DIRECT_SHELL_INPUT = {
	command: 'printf "%s\\n" "$GREETING" && pwd',
	cwd: '/workspace',
	environmentVariables: [{ name: 'GREETING', value: 'hello world' }],
} as const;

const SANDBOX_PROJECTION_CASES = [
	{
		invoke: (client, options) =>
			client.sandbox.environment.open({ logicalCwd: 'workspace' }, options),
		method: 'sandbox.environment.open',
		path: 'sandbox.environment.open',
		publicRequest: { logicalCwd: 'workspace' },
	},
	{
		invoke: (client, options) =>
			client.sandbox.environment.close({ environment: ENVIRONMENT }, options),
		method: 'sandbox.environment.close',
		path: 'sandbox.environment.close',
		publicRequest: { environment: ENVIRONMENT },
	},
	{
		invoke: (client, options) =>
			client.sandbox.environment.status({ environment: ENVIRONMENT }, options),
		method: 'sandbox.environment.status',
		path: 'sandbox.environment.status',
		publicRequest: { environment: ENVIRONMENT },
	},
	{
		invoke: (client, options) =>
			client.sandbox.execution.start(
				{
					...DIRECT_SHELL_INPUT,
					environment: ENVIRONMENT,
					mode: { kind: 'direct' },
					timeoutMs: 1_000,
				},
				options,
			),
		method: 'sandbox.exec.start',
		path: 'sandbox.execution.start',
		publicRequest: {
			...DIRECT_SHELL_INPUT,
			environment: ENVIRONMENT,
			mode: { kind: 'direct' },
			timeoutMs: 1_000,
		},
	},
	{
		invoke: (client, options) =>
			client.sandbox.execution.wait({ operation: OPERATION, timeoutMs: 1_000 }, options),
		method: 'sandbox.exec.wait',
		path: 'sandbox.execution.wait',
		publicRequest: { operation: OPERATION, timeoutMs: 1_000 },
	},
	{
		invoke: (client, options) => client.sandbox.execution.cancel({ operation: OPERATION }, options),
		method: 'sandbox.exec.cancel',
		path: 'sandbox.execution.cancel',
		publicRequest: { operation: OPERATION },
	},
	{
		invoke: (client, options) =>
			client.sandbox.retainedResults.lookup({ operation: OPERATION }, options),
		method: 'sandbox.retained-result.lookup',
		path: 'sandbox.retainedResults.lookup',
		publicRequest: { operation: OPERATION },
	},
	{
		invoke: (client, options) =>
			client.sandbox.filesystem.stat({ environment: ENVIRONMENT, path: 'file.txt' }, options),
		method: 'sandbox.fs.stat',
		path: 'sandbox.filesystem.stat',
		publicRequest: { environment: ENVIRONMENT, path: 'file.txt' },
	},
	{
		invoke: (client, options) =>
			client.sandbox.filesystem.list(
				{ environment: ENVIRONMENT, maxDepth: 1, maxEntries: 10, path: 'workspace' },
				options,
			),
		method: 'sandbox.fs.list',
		path: 'sandbox.filesystem.list',
		publicRequest: { environment: ENVIRONMENT, maxDepth: 1, maxEntries: 10, path: 'workspace' },
	},
	{
		invoke: (client, options) =>
			client.sandbox.filesystem.read(
				{ environment: ENVIRONMENT, maxBytes: 1_024, offsetBytes: 0, path: 'file.txt' },
				options,
			),
		method: 'sandbox.fs.read',
		path: 'sandbox.filesystem.read',
		publicRequest: {
			environment: ENVIRONMENT,
			maxBytes: 1_024,
			offsetBytes: 0,
			path: 'file.txt',
		},
	},
	{
		invoke: (client, options) =>
			client.sandbox.filesystem.write(
				{ atomic: true, content: EMPTY_BINARY_CHUNK, environment: ENVIRONMENT, path: 'file.txt' },
				options,
			),
		method: 'sandbox.fs.write',
		path: 'sandbox.filesystem.write',
		publicRequest: {
			atomic: true,
			content: EMPTY_BINARY_CHUNK,
			environment: ENVIRONMENT,
			path: 'file.txt',
		},
	},
	{
		invoke: (client, options) =>
			client.sandbox.filesystem.mkdir(
				{ environment: ENVIRONMENT, path: 'new-directory', recursive: true },
				options,
			),
		method: 'sandbox.fs.mkdir',
		path: 'sandbox.filesystem.mkdir',
		publicRequest: { environment: ENVIRONMENT, path: 'new-directory', recursive: true },
	},
	{
		invoke: (client, options) =>
			client.sandbox.filesystem.rename(
				{
					destinationPath: 'new-file.txt',
					environment: ENVIRONMENT,
					replace: false,
					sourcePath: 'old-file.txt',
				},
				options,
			),
		method: 'sandbox.fs.rename',
		path: 'sandbox.filesystem.rename',
		publicRequest: {
			destinationPath: 'new-file.txt',
			environment: ENVIRONMENT,
			replace: false,
			sourcePath: 'old-file.txt',
		},
	},
	{
		invoke: (client, options) =>
			client.sandbox.filesystem.remove(
				{ environment: ENVIRONMENT, path: 'old-file.txt', recursive: false },
				options,
			),
		method: 'sandbox.fs.remove',
		path: 'sandbox.filesystem.remove',
		publicRequest: { environment: ENVIRONMENT, path: 'old-file.txt', recursive: false },
	},
	{
		invoke: (client, options) =>
			client.sandbox.process.start(
				{
					...DIRECT_SHELL_INPUT,
					environment: ENVIRONMENT,
					maxRuntimeMs: 1_000,
					retainOutputBytes: 1_024,
				},
				options,
			),
		method: 'sandbox.process.start',
		path: 'sandbox.process.start',
		publicRequest: {
			...DIRECT_SHELL_INPUT,
			environment: ENVIRONMENT,
			maxRuntimeMs: 1_000,
			retainOutputBytes: 1_024,
		},
	},
	{
		invoke: (client, options) => client.sandbox.process.status({ process: PROCESS }, options),
		method: 'sandbox.process.status',
		path: 'sandbox.process.status',
		publicRequest: { process: PROCESS },
	},
	{
		invoke: (client, options) =>
			client.sandbox.process.wait({ process: PROCESS, timeoutMs: 1_000 }, options),
		method: 'sandbox.process.wait',
		path: 'sandbox.process.wait',
		publicRequest: { process: PROCESS, timeoutMs: 1_000 },
	},
	{
		invoke: (client, options) =>
			client.sandbox.process.logs(
				{ channels: ['stdout'], maxBytes: 1_024, process: PROCESS },
				options,
			),
		method: 'sandbox.process.logs',
		path: 'sandbox.process.logs',
		publicRequest: { channels: ['stdout'], maxBytes: 1_024, process: PROCESS },
	},
	{
		invoke: (client, options) => client.sandbox.process.cancel({ process: PROCESS }, options),
		method: 'sandbox.process.cancel',
		path: 'sandbox.process.cancel',
		publicRequest: { process: PROCESS },
	},
	{
		invoke: (client, options) =>
			client.sandbox.stream.read({ maxBytes: 1_024, stream: STANDARD_OUTPUT }, options),
		method: 'sandbox.stream.read',
		path: 'sandbox.stream.read',
		publicRequest: { maxBytes: 1_024, stream: STANDARD_OUTPUT },
	},
	{
		invoke: (client, options) =>
			client.sandbox.stream.write(
				{
					content: EMPTY_BINARY_CHUNK,
					contentDigest: EMPTY_CONTENT_DIGEST,
					sequence: 0,
					stream: STANDARD_INPUT,
				},
				options,
			),
		method: 'sandbox.stream.write',
		path: 'sandbox.stream.write',
		publicRequest: {
			content: EMPTY_BINARY_CHUNK,
			contentDigest: EMPTY_CONTENT_DIGEST,
			sequence: 0,
			stream: STANDARD_INPUT,
		},
	},
	{
		invoke: (client, options) => client.sandbox.stream.close({ stream: STANDARD_INPUT }, options),
		method: 'sandbox.stream.close',
		path: 'sandbox.stream.close',
		publicRequest: { stream: STANDARD_INPUT },
	},
	{
		invoke: (client, options) =>
			client.sandbox.terminal.attach({ operation: OPERATION, size: TERMINAL_SIZE }, options),
		method: 'sandbox.terminal.attach',
		path: 'sandbox.terminal.attach',
		publicRequest: { operation: OPERATION, size: TERMINAL_SIZE },
	},
	{
		invoke: (client, options) =>
			client.sandbox.terminal.resize({ size: TERMINAL_SIZE, terminal: TERMINAL }, options),
		method: 'sandbox.terminal.resize',
		path: 'sandbox.terminal.resize',
		publicRequest: { size: TERMINAL_SIZE, terminal: TERMINAL },
	},
] as const satisfies readonly SandboxProjectionCase[];

function getPublicCallableMethodNames(group: object): readonly string[] {
	const prototype = Object.getPrototypeOf(group);
	return Object.getOwnPropertyNames(prototype)
		.filter(
			(propertyName) =>
				propertyName !== 'constructor' &&
				typeof Object.getOwnPropertyDescriptor(prototype, propertyName)?.value === 'function',
		)
		.toSorted();
}

describe('GatewayRuntimeClient sandbox projection', () => {
	it('prefers an explicit trace context and strips it from transport request options', async () => {
		// Arrange
		const explicitTraceContext = {
			traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
		} as const;
		const providerTraceContext = {
			traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
		} as const;
		const traceContextProvider = vi.fn(() => providerTraceContext);
		const transportFactory = new RecordingGatewayRuntimeTransportFactory();
		const client = new GatewayRuntimeClient({
			attachment: ATTACHMENT,
			traceContextProvider,
			transportFactory,
		});
		const cancellation = new AbortController();
		await client.connect();

		// Act
		await client.sandbox.environment.open(
			{ logicalCwd: 'workspace' },
			{
				signal: cancellation.signal,
				traceContext: explicitTraceContext,
				trustedContext: TRUSTED_CONTEXT,
			},
		);

		// Assert
		expect(traceContextProvider).not.toHaveBeenCalled();
		expect(transportFactory.connection.requests).toEqual([
			{
				method: 'sandbox.environment.open',
				options: { signal: cancellation.signal },
				params: {
					publicRequest: { logicalCwd: 'workspace' },
					traceContext: explicitTraceContext,
					trustedContext: TRUSTED_CONTEXT,
				},
			},
		]);
	});

	it('rejects an invalid explicit trace context without consulting the provider or transport', async () => {
		// Arrange
		const traceContextProvider = vi.fn(() => ({
			traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
		}));
		const transportFactory = new RecordingGatewayRuntimeTransportFactory();
		const client = new GatewayRuntimeClient({
			attachment: ATTACHMENT,
			traceContextProvider,
			transportFactory,
		});
		await client.connect();

		// Act
		const requestAttempt = client.sandbox.environment.open(
			{ logicalCwd: 'workspace' },
			{
				traceContext: { traceparent: 'invalid' },
				trustedContext: TRUSTED_CONTEXT,
			},
		);

		// Assert
		await expect(requestAttempt).rejects.toThrow();
		expect(traceContextProvider).not.toHaveBeenCalled();
		expect(transportFactory.connection.requests).toEqual([]);
	});

	it('adds trace context outside the validated sandbox public request', async () => {
		// Arrange
		const traceContext = {
			traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
		} as const;
		const traceContextProvider = vi.fn(() => traceContext);
		const transportFactory = new RecordingGatewayRuntimeTransportFactory();
		const client = new GatewayRuntimeClient({
			attachment: ATTACHMENT,
			traceContextProvider,
			transportFactory,
		});
		await client.connect();

		// Act
		await client.sandbox.environment.open(
			{ logicalCwd: 'workspace' },
			{ trustedContext: TRUSTED_CONTEXT },
		);

		// Assert
		expect(traceContextProvider).toHaveBeenCalledOnce();
		expect(transportFactory.connection.requests).toEqual([
			{
				method: 'sandbox.environment.open',
				options: {},
				params: {
					publicRequest: { logicalCwd: 'workspace' },
					traceContext,
					trustedContext: TRUSTED_CONTEXT,
				},
			},
		]);
	});

	it('projects every frozen sandbox method once with exact paths, envelopes, and typed results', async () => {
		// Arrange
		const transportFactory = new RecordingGatewayRuntimeTransportFactory();
		const client = new GatewayRuntimeClient({ attachment: ATTACHMENT, transportFactory });
		const cancellation = new AbortController();
		const options = {
			signal: cancellation.signal,
			trustedContext: TRUSTED_CONTEXT,
		} satisfies GatewayRuntimeTrustedRequestOptions;
		await client.connect();

		// Act
		const results = await Promise.all(
			SANDBOX_PROJECTION_CASES.map(
				async (projectionCase) => await projectionCase.invoke(client, options),
			),
		);

		// Assert
		const projectedMethods = SANDBOX_PROJECTION_CASES.map(({ method }) => method).toSorted();
		const projectedPaths = SANDBOX_PROJECTION_CASES.map(({ path }) => path).toSorted();
		const registryMethods = Object.keys(SANDBOX_METHOD_CONTRACTS).toSorted();
		const expectedPaths = registryMethods
			.map((method) =>
				method
					.replace('sandbox.exec.', 'sandbox.execution.')
					.replace('sandbox.fs.', 'sandbox.filesystem.')
					.replace('sandbox.retained-result.lookup', 'sandbox.retainedResults.lookup'),
			)
			.toSorted();
		expect(SANDBOX_PROJECTION_CASES).toHaveLength(24);
		expect(new Set(projectedMethods)).toHaveLength(24);
		expect(new Set(projectedPaths)).toHaveLength(24);
		expect(projectedMethods).toEqual(registryMethods);
		expect(projectedPaths).toEqual(expectedPaths);
		expect(results).toEqual(SANDBOX_PROJECTION_CASES.map(({ method }) => RESPONSES[method]));
		expect(transportFactory.connection.requests).toEqual(
			SANDBOX_PROJECTION_CASES.map(({ method, publicRequest }) => ({
				method,
				options: { signal: cancellation.signal },
				params: { publicRequest, trustedContext: TRUSTED_CONTEXT },
			})),
		);
	});

	it('rejects an invalid method result after exactly one transport request', async () => {
		// Arrange
		const transportFactory = new RecordingGatewayRuntimeTransportFactory({
			'sandbox.fs.stat': { kind: 'stat' },
		});
		const client = new GatewayRuntimeClient({ attachment: ATTACHMENT, transportFactory });
		await client.connect();

		// Act
		const requestAttempt = client.sandbox.filesystem.stat(
			{ environment: ENVIRONMENT, path: 'file.txt' },
			{ trustedContext: TRUSTED_CONTEXT },
		);

		// Assert
		await expect(requestAttempt).rejects.toThrow();
		expect(transportFactory.connection.requests).toEqual([
			{
				method: 'sandbox.fs.stat',
				options: {},
				params: {
					publicRequest: { environment: ENVIRONMENT, path: 'file.txt' },
					trustedContext: TRUSTED_CONTEXT,
				},
			},
		]);
	});

	it('exposes exactly seven sandbox groups and the frozen 24-method public surface', () => {
		// Arrange
		const client = new GatewayRuntimeClient({
			attachment: ATTACHMENT,
			transportFactory: new RecordingGatewayRuntimeTransportFactory(),
		});

		// Act
		const groupNames = Object.keys(client.sandbox).toSorted();
		const callableMethodsByGroup = {
			environment: getPublicCallableMethodNames(client.sandbox.environment),
			execution: getPublicCallableMethodNames(client.sandbox.execution),
			filesystem: getPublicCallableMethodNames(client.sandbox.filesystem),
			process: getPublicCallableMethodNames(client.sandbox.process),
			retainedResults: getPublicCallableMethodNames(client.sandbox.retainedResults),
			stream: getPublicCallableMethodNames(client.sandbox.stream),
			terminal: getPublicCallableMethodNames(client.sandbox.terminal),
		};

		// Assert
		expect(groupNames).toEqual([
			'environment',
			'execution',
			'filesystem',
			'process',
			'retainedResults',
			'stream',
			'terminal',
		]);
		expect(callableMethodsByGroup).toEqual({
			environment: ['close', 'open', 'status'],
			execution: ['cancel', 'start', 'wait'],
			filesystem: ['list', 'mkdir', 'read', 'remove', 'rename', 'stat', 'write'],
			process: ['cancel', 'logs', 'start', 'status', 'wait'],
			retainedResults: ['lookup'],
			stream: ['close', 'read', 'write'],
			terminal: ['attach', 'resize'],
		});
		expect(Object.values(callableMethodsByGroup).flat()).toHaveLength(24);
	});

	it('looks up one retained result without replaying execution', async () => {
		// Arrange
		const transportFactory = new RecordingGatewayRuntimeTransportFactory({
			'sandbox.retained-result.lookup': {
				kind: 'unavailable',
				reason: 'not-retained-or-not-authorized',
			},
		});
		const client = new GatewayRuntimeClient({ attachment: ATTACHMENT, transportFactory });
		await client.connect();

		// Act
		const result = await client.sandbox.retainedResults.lookup(
			{ operation: OPERATION },
			{ trustedContext: TRUSTED_CONTEXT },
		);

		// Assert
		expect(result).toEqual({
			kind: 'unavailable',
			reason: 'not-retained-or-not-authorized',
		});
		expect(transportFactory.connection.requests).toEqual([
			{
				method: 'sandbox.retained-result.lookup',
				options: {},
				params: {
					publicRequest: { operation: OPERATION },
					trustedContext: TRUSTED_CONTEXT,
				},
			},
		]);
		expect(
			transportFactory.connection.requests.some(({ method }) =>
				['portal.call', 'sandbox.exec.start', 'sandbox.process.start'].includes(method),
			),
		).toBe(false);
	});

	it('rejects an invalid retained lookup request before transport', async () => {
		// Arrange
		const transportFactory = new RecordingGatewayRuntimeTransportFactory();
		const client = new GatewayRuntimeClient({ attachment: ATTACHMENT, transportFactory });
		await client.connect();
		const invalidRequest = { authority: 'client-authored', operation: OPERATION };

		// Act
		const requestAttempt = client.sandbox.retainedResults.lookup(invalidRequest, {
			trustedContext: TRUSTED_CONTEXT,
		});

		// Assert
		await expect(requestAttempt).rejects.toThrow();
		expect(transportFactory.connection.requests).toEqual([]);
	});

	it('rejects an invalid retained lookup result after one request', async () => {
		// Arrange
		const transportFactory = new RecordingGatewayRuntimeTransportFactory({
			'sandbox.retained-result.lookup': { kind: 'unavailable', reason: 'not-found' },
		});
		const client = new GatewayRuntimeClient({ attachment: ATTACHMENT, transportFactory });
		await client.connect();

		// Act
		const requestAttempt = client.sandbox.retainedResults.lookup(
			{ operation: OPERATION },
			{ trustedContext: TRUSTED_CONTEXT },
		);

		// Assert
		await expect(requestAttempt).rejects.toThrow();
		expect(transportFactory.connection.requests).toHaveLength(1);
		expect(transportFactory.connection.requests[0]?.method).toBe('sandbox.retained-result.lookup');
	});

	it.each([
		[
			'invalid public request',
			(client: GatewayRuntimeClient, options: GatewayRuntimeTrustedRequestOptions) => {
				const invalidRequest = { logicalCwd: 'workspace', unexpectedField: true };
				return client.sandbox.environment.open(invalidRequest, options);
			},
		],
		[
			'invalid trusted context',
			(client: GatewayRuntimeClient, options: GatewayRuntimeTrustedRequestOptions) => {
				const invalidTrustedContext = {
					...TRUSTED_CONTEXT,
					authority: 'client-authored',
				};
				return client.sandbox.environment.open(
					{ logicalCwd: 'workspace' },
					{ ...options, trustedContext: invalidTrustedContext },
				);
			},
		],
	] as const)('rejects an %s before transport', async (_caseName, invoke) => {
		// Arrange
		const transportFactory = new RecordingGatewayRuntimeTransportFactory();
		const client = new GatewayRuntimeClient({ attachment: ATTACHMENT, transportFactory });
		const options = {
			trustedContext: TRUSTED_CONTEXT,
		} satisfies GatewayRuntimeTrustedRequestOptions;
		await client.connect();

		// Act
		const requestAttempt = invoke(client, options);

		// Assert
		await expect(requestAttempt).rejects.toThrow();
		expect(transportFactory.connection.requests).toEqual([]);
	});
});
