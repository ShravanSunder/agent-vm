import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	type PortalArtifactReadRequest,
	type PortalArtifactReadResult,
} from '../artifact-surface/index.js';
import {
	DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
	GatewayRuntimeClient,
	type GatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeClientTrustedInvocationContext,
	type GatewayRuntimePortalRequestOptions,
} from '../gateway-runtime-client/index.js';
import type {
	PortalCallRequest,
	PortalCallResult,
	PortalDescribeRequest,
	PortalDescribeResult,
	PortalListRequest,
	PortalListResult,
	PortalSearchRequest,
	PortalSearchResult,
} from '../portal-call-surface/index.js';
import {
	ToolPortalMcpClient,
	type ToolPortalMcpResourceContent,
} from '../tool-portal-mcp-client/index.js';

const clientSourceRoot = path.dirname(fileURLToPath(import.meta.url));
const agentPortalSdkSourceRoot = path.dirname(clientSourceRoot);

const CURRENT_ATTACHMENT_METADATA = Object.freeze({
	attachmentGeneration: 7,
	clientKind: 'openclaw-managed-plugin' as const,
	configuredAgentIds: Object.freeze(['agent-a', 'agent-b']),
	frameworkEpoch: 'framework-epoch-1',
	gatewayEpoch: 'gateway-epoch-1',
	protocolVersion: 1,
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	runtimeEpoch: 'runtime-epoch-1',
	schemaVersion: 1,
});

const CURRENT_TRUSTED_INVOCATION_CONTEXT = Object.freeze({
	correlation: Object.freeze({
		runId: 'run-a',
		sessionId: 'session-a',
		sessionKey: 'session-key-a',
		toolCallId: 'tool-call-a',
	}),
	principal: Object.freeze({
		agentId: 'agent-a',
		frameworkIdentity: Object.freeze({ agentId: 'agent-a', kind: 'openclaw' }),
		profileAssignmentRevision: 'profile-assignment:agent-a:1',
		toolPortalProfileId: 'profile-a',
	}),
	requester: Object.freeze({
		authenticatedSubjectId: 'subject-a',
	}),
} satisfies GatewayRuntimeClientTrustedInvocationContext);

const PORTAL_CALL_REQUEST = {
	calls: [
		{
			arguments: { text: 'hello' },
			id: 'call-1',
			namespace: 'testing',
			name: 'echo',
		},
	],
} satisfies PortalCallRequest;

const PORTAL_LIST_REQUEST = {
	requests: [{ id: 'list-1', limit: 20 }],
} satisfies PortalListRequest;

const PORTAL_SEARCH_REQUEST = {
	requests: [{ id: 'search-1', limit: 10, schemaDetail: 'summary' as const }],
} satisfies PortalSearchRequest;

const PORTAL_DESCRIBE_REQUEST = {
	requests: [
		{
			id: 'describe-1',
			includeJsonSchema: true,
			includeRelated: true,
			includeTypescriptHelper: false,
			includeZod: false,
		},
	],
} satisfies PortalDescribeRequest;

const PORTAL_ARTIFACT_READ_REQUEST = {
	maxBytes: 5,
	offsetBytes: 0,
	reference: {
		byteLength: 11,
		expiresAt: '2030-01-02T03:04:05.000Z',
		fingerprint: `sha256:${'a'.repeat(64)}`,
		id: 'artifact-1',
		mediaType: 'text/plain',
	},
} satisfies PortalArtifactReadRequest;

const PORTAL_ARTIFACT_READ_RESULT = {
	contentBase64: 'aGVsbG8=',
	mediaType: 'text/plain',
	offsetBytes: 0,
	reference: PORTAL_ARTIFACT_READ_REQUEST.reference,
	truncated: true,
} satisfies PortalArtifactReadResult;

const PORTAL_ARTIFACT_MCP_RESOURCE_REQUEST = {
	_meta: {
		'agent-vm/artifact-read-request': PORTAL_ARTIFACT_READ_REQUEST,
	},
	uri: 'agent-vm-artifact://read?id=artifact-1',
} satisfies FakeMcpArtifactReadResourceRequest;

const SUCCESSFUL_EMPTY_PORTAL_RESULT = { items: [], ok: true } satisfies PortalCallResult;

const INVALID_OPERATION_PORTAL_RESULT = {
	items: [{ id: 'invalid-result-1', status: 'ok', value: {} }],
	ok: true,
};

interface PortalOperations {
	readonly call: (request: PortalCallRequest) => Promise<PortalCallResult>;
	readonly describe: (request: PortalDescribeRequest) => Promise<PortalDescribeResult>;
	readonly list: (request: PortalListRequest) => Promise<PortalListResult>;
	readonly search: (request: PortalSearchRequest) => Promise<PortalSearchResult>;
}

interface GatewayRuntimePortalOperations {
	readonly call: (
		request: PortalCallRequest,
		options: GatewayRuntimePortalRequestOptions,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: PortalDescribeRequest,
		options: GatewayRuntimePortalRequestOptions,
	) => Promise<PortalDescribeResult>;
	readonly list: (
		request: PortalListRequest,
		options: GatewayRuntimePortalRequestOptions,
	) => Promise<PortalListResult>;
	readonly search: (
		request: PortalSearchRequest,
		options: GatewayRuntimePortalRequestOptions,
	) => Promise<PortalSearchResult>;
}

function invokeAllPortalOperations(portal: PortalOperations): readonly Promise<unknown>[] {
	return [
		portal.list(PORTAL_LIST_REQUEST),
		portal.search(PORTAL_SEARCH_REQUEST),
		portal.describe(PORTAL_DESCRIBE_REQUEST),
		portal.call(PORTAL_CALL_REQUEST),
	];
}

async function settleInvalidPortalRequests(
	portal: PortalOperations,
): Promise<readonly PromiseSettledResult<unknown>[]> {
	return await Promise.allSettled([
		portal.list({ requests: [] }),
		portal.search({ requests: [] }),
		portal.describe({ requests: [] }),
		portal.call({ calls: [] }),
	]);
}

function invokeAllGatewayRuntimePortalOperations(
	portal: GatewayRuntimePortalOperations,
): readonly Promise<unknown>[] {
	const options = { trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT };
	return [
		portal.list(PORTAL_LIST_REQUEST, options),
		portal.search(PORTAL_SEARCH_REQUEST, options),
		portal.describe(PORTAL_DESCRIBE_REQUEST, options),
		portal.call(PORTAL_CALL_REQUEST, options),
	];
}

async function settleInvalidGatewayRuntimePortalRequests(
	portal: GatewayRuntimePortalOperations,
): Promise<readonly PromiseSettledResult<unknown>[]> {
	const options = { trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT };
	return await Promise.allSettled([
		portal.list({ requests: [] }, options),
		portal.search({ requests: [] }, options),
		portal.describe({ requests: [] }, options),
		portal.call({ calls: [] }, options),
	]);
}

const FAILED_PORTAL_CALL_RESULT = {
	items: [
		{
			error: {
				code: 'capability_denied' as const,
				message: 'The requested capability is not available to this attachment.',
			},
			id: 'call-1',
			operationId: 'operation-1',
			outcome: {
				certainty: 'proven' as const,
				kind: 'not-dispatched' as const,
				retryClass: 'safe-before-dispatch' as const,
			},
			owningGeneration: 'gateway-epoch-1',
			status: 'error' as const,
		},
	],
	ok: false,
} satisfies PortalCallResult;

interface FakeMcpToolCall {
	readonly approvalToken?: string;
	readonly arguments: unknown;
	readonly name: string;
}

type FakeRequestOptions = Readonly<{ signal?: AbortSignal }>;

class FakeToolPortalMcpTransport {
	readonly calls: FakeMcpToolCall[] = [];
	readonly cancelledToolNames: string[] = [];
	#connected = false;
	#result: unknown;

	constructor(result: unknown = SUCCESSFUL_EMPTY_PORTAL_RESULT) {
		this.#result = result;
	}

	async connect(): Promise<void> {
		this.#connected = true;
	}

	async close(): Promise<void> {
		this.#connected = false;
	}

	async callTool(
		call: FakeMcpToolCall,
		options: FakeRequestOptions = {},
	): Promise<{ readonly structuredContent: unknown }> {
		if (!this.#connected) throw new Error('MCP transport is not connected.');
		this.calls.push(call);

		if (options.signal?.aborted === true) {
			this.cancelledToolNames.push(call.name);
			throw options.signal.reason;
		}

		return await new Promise((resolve, reject) => {
			const cancel = (): void => {
				this.cancelledToolNames.push(call.name);
				reject(options.signal?.reason ?? new Error('MCP request cancelled.'));
			};
			options.signal?.addEventListener('abort', cancel, { once: true });
			queueMicrotask(() => {
				options.signal?.removeEventListener('abort', cancel);
				resolve({ structuredContent: this.#result });
			});
		});
	}

	async readResource(
		_request: { readonly uri: string },
		_options: FakeRequestOptions = {},
	): Promise<{ readonly contents: readonly ToolPortalMcpResourceContent[] }> {
		throw new Error('Portal operation test transport does not accept resource reads.');
	}
}

type FakeMcpArtifactResourceBody =
	| {
			readonly blob: string;
			readonly kind: 'blob';
			readonly mimeType?: string;
	  }
	| {
			readonly kind: 'text';
			readonly mimeType?: string;
			readonly text: string;
	  };

type FakeMcpArtifactResourceContents = FakeMcpArtifactResourceBody & {
	readonly uri: string;
};

interface FakeMcpArtifactResourceRead {
	readonly options: FakeRequestOptions;
	readonly request: FakeMcpArtifactReadResourceRequest;
}

interface FakeMcpArtifactReadResourceRequest {
	readonly _meta: Readonly<{
		readonly 'agent-vm/artifact-read-request': PortalArtifactReadRequest;
	}>;
	readonly uri: string;
}

class FakeArtifactToolPortalMcpTransport {
	readonly calls: FakeMcpToolCall[] = [];
	readonly resourceReads: FakeMcpArtifactResourceRead[] = [];
	readonly #resourceBodies: readonly FakeMcpArtifactResourceBody[];
	#connected = false;

	constructor(resourceBodies: readonly FakeMcpArtifactResourceBody[]) {
		this.#resourceBodies = resourceBodies;
	}

	async connect(): Promise<void> {
		this.#connected = true;
	}

	async close(): Promise<void> {
		this.#connected = false;
	}

	async callTool(
		call: FakeMcpToolCall,
		_options: FakeRequestOptions = {},
	): Promise<{ readonly structuredContent: unknown }> {
		this.calls.push(call);
		throw new Error('Artifact client test transport does not accept tool calls.');
	}

	async readResource(
		request: FakeMcpArtifactReadResourceRequest,
		options: FakeRequestOptions = {},
	): Promise<{ readonly contents: readonly FakeMcpArtifactResourceContents[] }> {
		if (!this.#connected) throw new Error('MCP transport is not connected.');
		this.resourceReads.push({ options, request });
		return {
			contents: this.#resourceBodies.map((resourceBody) =>
				resourceBody.kind === 'blob'
					? {
							blob: resourceBody.blob,
							kind: resourceBody.kind,
							mediaType: resourceBody.mimeType,
							uri: request.uri,
						}
					: {
							kind: resourceBody.kind,
							mediaType: resourceBody.mimeType,
							text: resourceBody.text,
							uri: request.uri,
						},
			),
		};
	}
}

type AttachmentRejectionCode =
	| 'protocol-version-mismatch'
	| 'replayed-connection'
	| 'schema-version-mismatch'
	| 'stale-attachment-generation'
	| 'stale-framework-epoch'
	| 'stale-gateway-epoch'
	| 'stale-runtime-epoch'
	| 'wrong-client-kind'
	| 'wrong-configured-agent-set';

class FakeAttachmentRejection extends Error {
	readonly code: AttachmentRejectionCode;

	constructor(code: AttachmentRejectionCode) {
		super(`Gateway runtime rejected the managed-plugin attachment: ${code}.`);
		this.name = 'FakeAttachmentRejection';
		this.code = code;
	}
}

interface RecordedGatewayRuntimeHandshake extends GatewayRuntimeAttachmentMetadata {
	readonly connectionId: string;
}

type RecordedGatewayRuntimeRequest = Readonly<{ method: string; params: unknown }>;

interface FakeGatewayRuntimeConnectionOptions {
	readonly connectionId: string;
	readonly handshakeRejection?: AttachmentRejectionCode;
	readonly portalCallResult?: unknown;
}

class FakeGatewayRuntimeConnection {
	readonly connectionId: string;
	readonly handshakes: RecordedGatewayRuntimeHandshake[] = [];
	readonly requests: RecordedGatewayRuntimeRequest[] = [];
	readonly cancelledMethods: string[] = [];
	#handshakeRejection: AttachmentRejectionCode | undefined;
	#portalCallResult: unknown;

	constructor(options: FakeGatewayRuntimeConnectionOptions) {
		this.connectionId = options.connectionId;
		this.#handshakeRejection = options.handshakeRejection;
		this.#portalCallResult = options.portalCallResult ?? SUCCESSFUL_EMPTY_PORTAL_RESULT;
	}

	async handshake(handshake: Omit<RecordedGatewayRuntimeHandshake, 'connectionId'>): Promise<void> {
		this.handshakes.push({ ...handshake, connectionId: this.connectionId });
		if (this.#handshakeRejection !== undefined) {
			throw new FakeAttachmentRejection(this.#handshakeRejection);
		}
	}

	async request(
		method: string,
		params: unknown,
		options: FakeRequestOptions = {},
	): Promise<unknown> {
		this.requests.push({ method, params });
		if (options.signal?.aborted === true) {
			this.cancelledMethods.push(method);
			throw options.signal.reason;
		}

		return await new Promise((resolve, reject) => {
			const cancel = (): void => {
				this.cancelledMethods.push(method);
				reject(options.signal?.reason ?? new Error('Gateway runtime request cancelled.'));
			};
			options.signal?.addEventListener('abort', cancel, { once: true });
			queueMicrotask(() => {
				options.signal?.removeEventListener('abort', cancel);
				resolve(this.#portalCallResult);
			});
		});
	}

	async close(): Promise<void> {}
}

class FakeGatewayRuntimeTransportFactory {
	readonly connections: FakeGatewayRuntimeConnection[] = [];
	readonly socketPaths: string[] = [];
	#connectionOptions: FakeGatewayRuntimeConnectionOptions[];

	constructor(connectionOptions: readonly FakeGatewayRuntimeConnectionOptions[]) {
		this.#connectionOptions = [...connectionOptions];
	}

	async connect(options: { readonly socketPath: string }): Promise<FakeGatewayRuntimeConnection> {
		this.socketPaths.push(options.socketPath);
		const connectionOptions = this.#connectionOptions.shift();
		if (connectionOptions === undefined) {
			throw new Error('No fake Gateway runtime connection remains.');
		}
		const connection = new FakeGatewayRuntimeConnection(connectionOptions);
		this.connections.push(connection);
		return connection;
	}
}

async function listTypeScriptSourceFiles(directoryPath: string): Promise<readonly string[]> {
	const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
	const nestedSourceFiles = await Promise.all(
		directoryEntries.map(async (directoryEntry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, directoryEntry.name);
			if (directoryEntry.isDirectory()) return await listTypeScriptSourceFiles(entryPath);
			if (!directoryEntry.isFile() || !directoryEntry.name.endsWith('.ts')) return [];
			if (/\.(?:integration|unit)\.test\.ts$/u.test(directoryEntry.name)) return [];
			return [entryPath];
		}),
	);
	return nestedSourceFiles.flat();
}

function extractImportSpecifiers(sourceText: string): readonly string[] {
	const importPattern = /(?:from\s+|import\s*)['"]([^'"]+)['"]/gu;
	return [...sourceText.matchAll(importPattern)].map((match) => match[1] ?? '');
}

async function readClientImportSpecifiers(clientDirectoryName: string): Promise<readonly string[]> {
	const sourceFiles = await listTypeScriptSourceFiles(
		path.join(agentPortalSdkSourceRoot, clientDirectoryName),
	);
	const sourceTexts = await Promise.all(
		sourceFiles.map(async (sourceFile) => await readFile(sourceFile, 'utf8')),
	);
	return sourceTexts.flatMap((sourceText) => extractImportSpecifiers(sourceText));
}

describe('isolated agent portal clients', () => {
	it('keeps the MCP client independent from UDS, Gateway runtime, VM, and controller code', async () => {
		// Arrange
		const forbiddenDependencyPattern =
			/(?:gateway-runtime|gondolin|managed-vm|\/uds(?:\/|$)|ssh|controller)/u;

		// Act
		const importSpecifiers = await readClientImportSpecifiers('tool-portal-mcp-client');

		// Assert
		expect(importSpecifiers).not.toEqual([]);
		expect(
			importSpecifiers.filter((specifier) => forbiddenDependencyPattern.test(specifier)),
		).toEqual([]);
	});

	it('keeps the portable MCP client entrypoint independent from Node and the MCP SDK transport', async () => {
		// Arrange
		const entrypointPath = path.join(
			agentPortalSdkSourceRoot,
			'tool-portal-mcp-client',
			'index.ts',
		);

		// Act
		const importSpecifiers = extractImportSpecifiers(await readFile(entrypointPath, 'utf8'));

		// Assert
		expect(importSpecifiers).not.toEqual([]);
		expect(
			importSpecifiers.filter((specifier) =>
				/(?:^node:|@modelcontextprotocol|node-tool-portal-mcp-transport)/u.test(specifier),
			),
		).toEqual([]);
	});

	it('keeps the UDS client independent from MCP, SSH, VM, Gondolin, and controller code', async () => {
		// Arrange
		const forbiddenDependencyPattern = /(?:mcp|ssh|gondolin|managed-vm|agent-vm\/src|controller)/u;

		// Act
		const importSpecifiers = await readClientImportSpecifiers('gateway-runtime-client');

		// Assert
		expect(importSpecifiers).not.toEqual([]);
		expect(
			importSpecifiers.filter((specifier) => forbiddenDependencyPattern.test(specifier)),
		).toEqual([]);
	});

	it('maps and validates all four Tool Portal operations and canonical item errors', async () => {
		// Arrange
		const transport = new FakeToolPortalMcpTransport(SUCCESSFUL_EMPTY_PORTAL_RESULT);
		const errorTransport = new FakeToolPortalMcpTransport(FAILED_PORTAL_CALL_RESULT);
		const invalidResultTransport = new FakeToolPortalMcpTransport(INVALID_OPERATION_PORTAL_RESULT);
		const client = new ToolPortalMcpClient({ transport });
		const errorClient = new ToolPortalMcpClient({ transport: errorTransport });
		const invalidResultClient = new ToolPortalMcpClient({ transport: invalidResultTransport });
		await Promise.all([client.connect(), errorClient.connect(), invalidResultClient.connect()]);

		// Act
		const successfulResults = await Promise.all(invokeAllPortalOperations(client));
		const errorResult = await errorClient.call(PORTAL_CALL_REQUEST);
		const invalidRequestSettlements = await settleInvalidPortalRequests(client);
		const invalidResultSettlements = await Promise.allSettled(
			invokeAllPortalOperations(invalidResultClient),
		);

		// Assert
		expect(successfulResults).toEqual([
			SUCCESSFUL_EMPTY_PORTAL_RESULT,
			SUCCESSFUL_EMPTY_PORTAL_RESULT,
			SUCCESSFUL_EMPTY_PORTAL_RESULT,
			SUCCESSFUL_EMPTY_PORTAL_RESULT,
		]);
		expect(errorResult).toEqual(FAILED_PORTAL_CALL_RESULT);
		expect(invalidRequestSettlements.every((result) => result.status === 'rejected')).toBe(true);
		expect(invalidResultSettlements.every((result) => result.status === 'rejected')).toBe(true);
		expect(transport.calls).toEqual([
			{ arguments: PORTAL_LIST_REQUEST, name: 'tool_portal_list' },
			{ arguments: PORTAL_SEARCH_REQUEST, name: 'tool_portal_search' },
			{ arguments: PORTAL_DESCRIBE_REQUEST, name: 'tool_portal_describe' },
			{ arguments: PORTAL_CALL_REQUEST, name: 'tool_portal_call' },
		]);
		expect(errorTransport.calls).toEqual([
			{ arguments: PORTAL_CALL_REQUEST, name: 'tool_portal_call' },
		]);
		expect(invalidResultTransport.calls.map((call) => call.name)).toEqual([
			'tool_portal_list',
			'tool_portal_search',
			'tool_portal_describe',
			'tool_portal_call',
		]);
	});

	it('maps MCP call cancellation to the standard transport request signal', async () => {
		// Arrange
		const transport = new FakeToolPortalMcpTransport();
		const client = new ToolPortalMcpClient({ transport });
		const cancellation = new AbortController();
		await client.connect();
		cancellation.abort(new Error('operator cancelled'));

		// Act
		const cancelledCall = client.call(PORTAL_CALL_REQUEST, { signal: cancellation.signal });

		// Assert
		await expect(cancelledCall).rejects.toThrow('operator cancelled');
		expect(transport.cancelledToolNames).toEqual(['tool_portal_call']);
	});

	it('forwards one exact-batch approval token as transport metadata without changing public arguments', async () => {
		const transport = new FakeToolPortalMcpTransport();
		const client = new ToolPortalMcpClient({ transport });
		await client.connect();

		await client.call(PORTAL_CALL_REQUEST, { approvalToken: 'signed-exact-batch-token' });

		expect(transport.calls).toEqual([
			{
				approvalToken: 'signed-exact-batch-token',
				arguments: PORTAL_CALL_REQUEST,
				name: 'tool_portal_call',
			},
		]);
		expect(PORTAL_CALL_REQUEST).not.toHaveProperty('approvalToken');
	});

	it('reads and validates one bounded artifact from one MCP blob resource', async () => {
		// Arrange
		const transport = new FakeArtifactToolPortalMcpTransport([
			{
				blob: PORTAL_ARTIFACT_READ_RESULT.contentBase64,
				kind: 'blob',
				mimeType: 'text/plain',
			},
		]);
		const client = new ToolPortalMcpClient({ transport });
		await client.connect();

		// Act
		const result = await client.artifacts.read(PORTAL_ARTIFACT_READ_REQUEST);

		// Assert
		expect(result).toEqual(PORTAL_ARTIFACT_READ_RESULT);
		expect(transport.calls).toEqual([]);
		expect(transport.resourceReads).toEqual([
			{ options: {}, request: PORTAL_ARTIFACT_MCP_RESOURCE_REQUEST },
		]);
	});

	it.each([
		['missing resource', []],
		[
			'multiple resources',
			[
				{
					blob: PORTAL_ARTIFACT_READ_RESULT.contentBase64,
					kind: 'blob',
					mimeType: 'text/plain',
				},
				{
					blob: PORTAL_ARTIFACT_READ_RESULT.contentBase64,
					kind: 'blob',
					mimeType: 'text/plain',
				},
			],
		],
		['text resource', [{ kind: 'text', mimeType: 'text/plain', text: 'hello' }]],
	] satisfies readonly (readonly [string, readonly FakeMcpArtifactResourceBody[]])[])(
		'rejects a malformed MCP artifact read with %s',
		async (_caseName, resourceBodies) => {
			// Arrange
			const transport = new FakeArtifactToolPortalMcpTransport(resourceBodies);
			const client = new ToolPortalMcpClient({ transport });
			await client.connect();

			// Act
			const readAttempt = client.artifacts.read(PORTAL_ARTIFACT_READ_REQUEST);

			// Assert
			await expect(readAttempt).rejects.toThrow();
			expect(transport.calls).toEqual([]);
			expect(transport.resourceReads).toHaveLength(1);
		},
	);

	it.each([
		['ID-only reference', { maxBytes: 5, offsetBytes: 0, reference: { id: 'artifact-1' } }],
		[
			'authority field',
			{ ...PORTAL_ARTIFACT_READ_REQUEST, authority: 'client-authored-authority' },
		],
	] as const)(
		'rejects an MCP artifact read with a public %s before transport',
		async (_caseName, request) => {
			// Arrange
			const transport = new FakeArtifactToolPortalMcpTransport([
				{
					blob: PORTAL_ARTIFACT_READ_RESULT.contentBase64,
					kind: 'blob',
					mimeType: 'text/plain',
				},
			]);
			const client = new ToolPortalMcpClient({ transport });
			await client.connect();

			// Act
			// @ts-expect-error Deliberately exercise runtime validation of an invalid public request.
			const readAttempt = client.artifacts.read(request);

			// Assert
			await expect(readAttempt).rejects.toThrow();
			expect(transport.calls).toEqual([]);
			expect(transport.resourceReads).toEqual([]);
		},
	);
});

describe('GatewayRuntimeClient attachment lifecycle', () => {
	it('rejects client-authored envelope and unknown attachment fields before transport connect', () => {
		// Arrange
		const clientAuthoredFields = [
			['connectionId', 'client-authored-connection'],
			['kind', 'handshake'],
			['unexpectedField', 'unexpected-value'],
		] as const;

		for (const [fieldName, value] of clientAuthoredFields) {
			// Act
			const transportFactory = new FakeGatewayRuntimeTransportFactory([]);
			const attachment = { ...CURRENT_ATTACHMENT_METADATA, [fieldName]: value };

			// Assert
			expect(() => new GatewayRuntimeClient({ attachment, transportFactory })).toThrow(
				/attachment metadata/iu,
			);
			expect(transportFactory.socketPaths).toEqual([]);
		}
	});

	it('uses the one fixed VM-local socket and rejects methods before handshake', async () => {
		// Arrange
		const transportFactory = new FakeGatewayRuntimeTransportFactory([
			{ connectionId: 'connection-1' },
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT_METADATA,
			transportFactory,
		});

		// Act
		const callBeforeConnect = client.portal.call(PORTAL_CALL_REQUEST, {
			trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
		});

		// Assert
		expect(DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH).toBe(
			'/run/agent-vm/gateway-runtime/managed-plugin.sock',
		);
		await expect(callBeforeConnect).rejects.toThrow(/handshake/iu);
		expect(transportFactory.socketPaths).toEqual([]);
	});

	it('maps and validates all four Gateway runtime portal operations', async () => {
		// Arrange
		const transportFactory = new FakeGatewayRuntimeTransportFactory([
			{ connectionId: 'connection-1', portalCallResult: SUCCESSFUL_EMPTY_PORTAL_RESULT },
		]);
		const invalidResultTransportFactory = new FakeGatewayRuntimeTransportFactory([
			{ connectionId: 'connection-2', portalCallResult: INVALID_OPERATION_PORTAL_RESULT },
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT_METADATA,
			transportFactory,
		});
		const invalidResultClient = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT_METADATA,
			transportFactory: invalidResultTransportFactory,
		});
		await Promise.all([client.connect(), invalidResultClient.connect()]);

		// Act
		const successfulResults = await Promise.all(
			invokeAllGatewayRuntimePortalOperations(client.portal),
		);
		const invalidRequestSettlements = await settleInvalidGatewayRuntimePortalRequests(
			client.portal,
		);
		const invalidResultSettlements = await Promise.allSettled(
			invokeAllGatewayRuntimePortalOperations(invalidResultClient.portal),
		);

		// Assert
		expect(successfulResults).toEqual([
			SUCCESSFUL_EMPTY_PORTAL_RESULT,
			SUCCESSFUL_EMPTY_PORTAL_RESULT,
			SUCCESSFUL_EMPTY_PORTAL_RESULT,
			SUCCESSFUL_EMPTY_PORTAL_RESULT,
		]);
		expect(invalidRequestSettlements.every((result) => result.status === 'rejected')).toBe(true);
		expect(invalidResultSettlements.every((result) => result.status === 'rejected')).toBe(true);
		expect(transportFactory.socketPaths).toEqual([DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH]);
		expect(transportFactory.connections[0]?.handshakes).toEqual([
			{ ...CURRENT_ATTACHMENT_METADATA, connectionId: 'connection-1' },
		]);
		expect(transportFactory.connections[0]?.handshakes[0]).not.toHaveProperty('authority');
		expect(transportFactory.connections[0]?.handshakes[0]).not.toHaveProperty(
			'allowedOperationGroups',
		);
		expect(transportFactory.connections[0]?.requests).toEqual([
			{
				method: 'portal.list',
				params: {
					publicRequest: PORTAL_LIST_REQUEST,
					trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
				},
			},
			{
				method: 'portal.search',
				params: {
					publicRequest: PORTAL_SEARCH_REQUEST,
					trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
				},
			},
			{
				method: 'portal.describe',
				params: {
					publicRequest: PORTAL_DESCRIBE_REQUEST,
					trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
				},
			},
			{
				method: 'portal.call',
				params: {
					publicRequest: PORTAL_CALL_REQUEST,
					trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
				},
			},
		]);
		expect(
			invalidResultTransportFactory.connections[0]?.requests.map((request) => request.method),
		).toEqual(['portal.list', 'portal.search', 'portal.describe', 'portal.call']);
	});

	it('preserves canonical portal item errors and request cancellation', async () => {
		// Arrange
		const transportFactory = new FakeGatewayRuntimeTransportFactory([
			{ connectionId: 'connection-1', portalCallResult: FAILED_PORTAL_CALL_RESULT },
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT_METADATA,
			transportFactory,
		});
		await client.connect();
		const errorResult: PortalCallResult = await client.portal.call(PORTAL_CALL_REQUEST, {
			trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
		});
		const cancellation = new AbortController();
		cancellation.abort(new Error('framework cancelled'));

		// Act
		const cancelledCall = client.portal.call(PORTAL_CALL_REQUEST, {
			signal: cancellation.signal,
			trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
		});

		// Assert
		expect(errorResult).toEqual(FAILED_PORTAL_CALL_RESULT);
		await expect(cancelledCall).rejects.toThrow('framework cancelled');
		expect(transportFactory.connections[0]?.cancelledMethods).toEqual(['portal.call']);
	});

	it('reads an artifact through the exact private UDS method and authority-separated params', async () => {
		// Arrange
		const transportFactory = new FakeGatewayRuntimeTransportFactory([
			{ connectionId: 'connection-1', portalCallResult: PORTAL_ARTIFACT_READ_RESULT },
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT_METADATA,
			transportFactory,
		});
		await client.connect();

		// Act
		const result = await client.artifacts.read(PORTAL_ARTIFACT_READ_REQUEST, {
			trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
		});

		// Assert
		expect(result).toEqual(PORTAL_ARTIFACT_READ_RESULT);
		expect(transportFactory.connections[0]?.requests).toEqual([
			{
				method: 'artifact.read',
				params: {
					publicRequest: PORTAL_ARTIFACT_READ_REQUEST,
					trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
				},
			},
		]);
	});

	it.each([
		['ID-only reference', { maxBytes: 5, offsetBytes: 0, reference: { id: 'artifact-1' } }],
		[
			'authority field',
			{ ...PORTAL_ARTIFACT_READ_REQUEST, authority: 'client-authored-authority' },
		],
	] as const)(
		'rejects a UDS artifact read with a public %s before transport',
		async (_caseName, request) => {
			// Arrange
			const transportFactory = new FakeGatewayRuntimeTransportFactory([
				{ connectionId: 'connection-1', portalCallResult: PORTAL_ARTIFACT_READ_RESULT },
			]);
			const client = new GatewayRuntimeClient({
				attachment: CURRENT_ATTACHMENT_METADATA,
				transportFactory,
			});
			await client.connect();

			// Act
			// @ts-expect-error Deliberately exercise runtime validation of an invalid public request.
			const readAttempt = client.artifacts.read(request, {
				trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
			});

			// Assert
			await expect(readAttempt).rejects.toThrow();
			expect(transportFactory.connections[0]?.requests).toEqual([]);
		},
	);

	it('reconnects with a fresh connection id inside the same valid attachment generation', async () => {
		// Arrange
		const transportFactory = new FakeGatewayRuntimeTransportFactory([
			{ connectionId: 'connection-1' },
			{ connectionId: 'connection-2' },
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT_METADATA,
			transportFactory,
		});
		await client.connect();

		// Act
		await client.reconnect();
		const callResult = await client.portal.call(PORTAL_CALL_REQUEST, {
			trustedContext: CURRENT_TRUSTED_INVOCATION_CONTEXT,
		});

		// Assert
		expect(transportFactory.connections.map((connection) => connection.connectionId)).toEqual([
			'connection-1',
			'connection-2',
		]);
		expect(
			transportFactory.connections.map(
				(connection) => connection.handshakes[0]?.attachmentGeneration,
			),
		).toEqual([
			CURRENT_ATTACHMENT_METADATA.attachmentGeneration,
			CURRENT_ATTACHMENT_METADATA.attachmentGeneration,
		]);
		expect(callResult).toEqual(SUCCESSFUL_EMPTY_PORTAL_RESULT);
	});

	it.each([
		'protocol-version-mismatch',
		'schema-version-mismatch',
		'stale-gateway-epoch',
		'stale-runtime-epoch',
		'stale-framework-epoch',
		'stale-attachment-generation',
		'wrong-client-kind',
		'wrong-configured-agent-set',
	] as const)('fails closed when the server rejects %s', async (rejectionCode) => {
		// Arrange
		const transportFactory = new FakeGatewayRuntimeTransportFactory([
			{ connectionId: 'connection-1', handshakeRejection: rejectionCode },
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT_METADATA,
			transportFactory,
		});

		// Act
		const connectionAttempt = client.connect();

		// Assert
		await expect(connectionAttempt).rejects.toMatchObject({ code: rejectionCode });
		expect(transportFactory.connections[0]?.requests).toEqual([]);
	});

	it('rejects a replayed connection id instead of resuming it on reconnect', async () => {
		// Arrange
		const transportFactory = new FakeGatewayRuntimeTransportFactory([
			{ connectionId: 'connection-1' },
			{
				connectionId: 'connection-1',
				handshakeRejection: 'replayed-connection',
			},
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT_METADATA,
			transportFactory,
		});
		await client.connect();

		// Act
		const reconnectAttempt = client.reconnect();

		// Assert
		await expect(reconnectAttempt).rejects.toMatchObject({ code: 'replayed-connection' });
		expect(transportFactory.connections[1]?.requests).toEqual([]);
	});
});
