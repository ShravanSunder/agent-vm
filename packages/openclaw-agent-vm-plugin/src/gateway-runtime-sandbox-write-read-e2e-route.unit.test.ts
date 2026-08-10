import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER,
	registerGatewayRuntimeSandboxWriteReadE2eRoute,
	type OpenClawGatewayRuntimeSandboxE2eClient,
} from './gateway-runtime-sandbox-write-read-e2e-route.js';
import type { OpenClawHttpRouteRegistration } from './openclaw-sandbox-sdk-contract.js';

const MARKER = 'gateway-runtime-sandbox-marker';
const PROOF_FILE_PATH = 'agent-vm-e2e-proof.txt';
const SENTINEL_FILE_PATH = 'agent-vm-e2e-proof.committed';
const PROJECTION = {
	agentId: 'main',
	frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
	profileAssignmentRevision: 'profile-revision-controller-authored',
	toolPortalNamespaceNames: [],
	toolPortalProfileId: 'profile-controller-authored',
} as const;
const PROBE_IDENTITY = {
	agentId: 'main',
	sessionKey: 'agent:main:gateway-runtime-sandbox:reliability',
} as const;
const PROBE_KEY = 'gateway-runtime-sandbox-write-read-proof-key';
const environment = {
	handleId: 'environment-a',
	kind: 'environment',
	owningGeneration: 'generation-a',
} as const;
const operation = { operationId: 'operation-a', owningGeneration: 'generation-a' } as const;
const stdin = {
	channel: 'stdin',
	handleId: 'stdin-a',
	kind: 'stream',
	owningGeneration: 'generation-a',
} as const;

type EnvironmentOpen = OpenClawGatewayRuntimeSandboxE2eClient['sandbox']['environment']['open'];
type EnvironmentClose = OpenClawGatewayRuntimeSandboxE2eClient['sandbox']['environment']['close'];
type ExecutionCancel = OpenClawGatewayRuntimeSandboxE2eClient['sandbox']['execution']['cancel'];
type ExecutionStart = OpenClawGatewayRuntimeSandboxE2eClient['sandbox']['execution']['start'];
type ExecutionWait = OpenClawGatewayRuntimeSandboxE2eClient['sandbox']['execution']['wait'];
type FilesystemRead = OpenClawGatewayRuntimeSandboxE2eClient['sandbox']['filesystem']['read'];
type FilesystemWrite = OpenClawGatewayRuntimeSandboxE2eClient['sandbox']['filesystem']['write'];
type StreamClose = OpenClawGatewayRuntimeSandboxE2eClient['sandbox']['stream']['close'];

interface MockClientFixture {
	readonly client: OpenClawGatewayRuntimeSandboxE2eClient;
	readonly environmentClose: Mock<EnvironmentClose>;
	readonly environmentOpen: Mock<EnvironmentOpen>;
	readonly executionCancel: Mock<ExecutionCancel>;
	readonly executionStart: Mock<ExecutionStart>;
	readonly executionWait: Mock<ExecutionWait>;
	readonly filesystemRead: Mock<FilesystemRead>;
	readonly filesystemWrite: Mock<FilesystemWrite>;
	readonly streamClose: Mock<StreamClose>;
}

interface CapturedResponse {
	readonly body: unknown;
	readonly statusCode: number;
}

function binaryChunk(content: string): {
	readonly byteLength: number;
	readonly contentBase64: string;
	readonly encoding: 'base64';
} {
	const bytes = Buffer.from(content);
	return {
		byteLength: bytes.byteLength,
		contentBase64: bytes.toString('base64'),
		encoding: 'base64',
	};
}

function signBody(bodyText: string): string {
	return createHmac('sha256', PROBE_KEY).update(bodyText, 'utf8').digest('base64url');
}

function createBody(overrides: Readonly<Record<string, unknown>> = {}): string {
	return JSON.stringify({
		action: 'write-read',
		agentId: PROBE_IDENTITY.agentId,
		filePath: PROOF_FILE_PATH,
		marker: MARKER,
		sessionKey: PROBE_IDENTITY.sessionKey,
		...overrides,
	});
}

function createClient(): MockClientFixture {
	const environmentOpen = vi.fn<EnvironmentOpen>(async () => ({
		environment,
		kind: 'opened',
	}));
	const environmentClose = vi.fn<EnvironmentClose>(async () => ({
		environment,
		kind: 'closed',
	}));
	const executionStart = vi.fn<ExecutionStart>(async () => ({
		kind: 'started',
		mode: 'direct',
		operation,
		streams: [stdin],
	}));
	const executionWait = vi.fn<ExecutionWait>(async () => ({
		operation,
		outcome: {
			certainty: 'side-effects-and-termination-unknown',
			kind: 'ambiguous',
			retryClass: 'forbidden',
		},
	}));
	const executionCancel = vi.fn<ExecutionCancel>(async () => ({
		kind: 'cancel-request-accepted',
		operation,
	}));
	const filesystemWrite = vi.fn<FilesystemWrite>(async (request) => ({
		bytesWritten: Buffer.byteLength(MARKER),
		contentDigest: `sha256:${'0'.repeat(64)}`,
		kind: 'written',
		path: request.path,
	}));
	const filesystemRead = vi.fn<FilesystemRead>(async (request) => ({
		chunk: binaryChunk(MARKER),
		eof: true,
		kind: 'read',
		nextOffsetBytes: Buffer.byteLength(MARKER),
		path: request.path,
	}));
	const streamClose = vi.fn<StreamClose>(async () => ({ kind: 'closed', stream: stdin }));
	const client = {
		sandbox: {
			environment: { close: environmentClose, open: environmentOpen },
			execution: { cancel: executionCancel, start: executionStart, wait: executionWait },
			filesystem: { read: filesystemRead, write: filesystemWrite },
			stream: { close: streamClose },
		},
	} satisfies OpenClawGatewayRuntimeSandboxE2eClient;
	return {
		client,
		environmentClose,
		environmentOpen,
		executionCancel,
		executionStart,
		executionWait,
		filesystemRead,
		filesystemWrite,
		streamClose,
	};
}

function enableRoute(): void {
	vi.stubEnv(AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV, '1');
	vi.stubEnv(AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV, PROBE_KEY);
	vi.stubEnv(
		AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV,
		JSON.stringify([PROBE_IDENTITY]),
	);
}

function registerRoute(clientFixture = createClient()): {
	readonly clientFixture: MockClientFixture;
	readonly route: OpenClawHttpRouteRegistration;
} {
	const registerHttpRoute = vi.fn();
	registerGatewayRuntimeSandboxWriteReadE2eRoute({
		agentProjections: { main: PROJECTION },
		api: { registerHttpRoute },
		client: clientFixture.client,
	});
	const route = registerHttpRoute.mock.calls[0]?.[0] as OpenClawHttpRouteRegistration | undefined;
	if (route === undefined) throw new Error('Expected the private Sandbox E2E route to register.');
	return { clientFixture, route };
}

async function invokeRoute(options: {
	readonly bodyText: string;
	readonly route: OpenClawHttpRouteRegistration;
	readonly signature?: string;
}): Promise<CapturedResponse> {
	const request = Readable.from([Buffer.from(options.bodyText)]) as Readable & {
		headers: Readonly<Record<string, string>>;
		method: string;
	};
	request.headers =
		options.signature === undefined
			? {}
			: { [AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER]: options.signature };
	request.method = 'POST';
	let responseText = '';
	let statusCode = 200;
	const response = {
		get statusCode(): number {
			return statusCode;
		},
		set statusCode(value: number) {
			statusCode = value;
		},
		end: (chunk?: string | Buffer): void => {
			responseText = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : (chunk ?? '');
		},
		setHeader: vi.fn(),
	};
	await options.route.handler(
		request as Parameters<OpenClawHttpRouteRegistration['handler']>[0],
		response as unknown as Parameters<OpenClawHttpRouteRegistration['handler']>[1],
	);
	return { body: JSON.parse(responseText) as unknown, statusCode };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('Gateway Runtime direct Sandbox E2E route', () => {
	it('registers only with the private E2E opt-in', () => {
		const registerHttpRoute = vi.fn();
		const fixture = createClient();
		registerGatewayRuntimeSandboxWriteReadE2eRoute({
			agentProjections: { main: PROJECTION },
			api: { registerHttpRoute },
			client: fixture.client,
		});
		expect(registerHttpRoute).not.toHaveBeenCalled();
		enableRoute();
		registerGatewayRuntimeSandboxWriteReadE2eRoute({
			agentProjections: { main: PROJECTION },
			api: { registerHttpRoute },
			client: fixture.client,
		});
		expect(registerHttpRoute).toHaveBeenCalledWith(
			expect.objectContaining({
				auth: 'plugin',
				match: 'exact',
				path: AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH,
			}),
		);
	});

	it('rejects missing authentication and foreign identity before opening a Sandbox environment', async () => {
		enableRoute();
		const { clientFixture, route } = registerRoute();
		const unsigned = await invokeRoute({ bodyText: createBody(), route });
		expect(unsigned.statusCode).toBe(401);
		const foreignBody = createBody({
			agentId: 'beta',
			sessionKey: 'agent:beta:gateway-runtime-sandbox:foreign',
		});
		const foreign = await invokeRoute({
			bodyText: foreignBody,
			route,
			signature: signBody(foreignBody),
		});
		expect(foreign.statusCode).toBe(403);
		expect(clientFixture.environmentOpen).not.toHaveBeenCalled();
	});

	it('rejects signed nested proof paths before opening a Sandbox environment', async () => {
		enableRoute();
		const { clientFixture, route } = registerRoute();
		const bodyText = createBody({ filePath: 'agent-vm-e2e-parent/proof.txt' });
		const response = await invokeRoute({ bodyText, route, signature: signBody(bodyText) });

		expect(response.statusCode).toBe(400);
		expect(clientFixture.environmentOpen).not.toHaveBeenCalled();
	});

	it('writes and reads through direct Sandbox operations with trusted per-agent context', async () => {
		enableRoute();
		const { clientFixture, route } = registerRoute();
		clientFixture.filesystemWrite.mockImplementationOnce(async (request) => ({
			bytesWritten: Buffer.byteLength(MARKER),
			contentDigest: `sha256:${createHash('sha256').update(MARKER).digest('hex')}`,
			kind: 'written',
			path: request.path,
		}));
		const bodyText = createBody();
		const response = await invokeRoute({ bodyText, route, signature: signBody(bodyText) });
		expect(response).toEqual({
			body: {
				details: {
					agentId: 'main',
					filePath: PROOF_FILE_PATH,
					kind: 'write-read',
					marker: MARKER,
					readBack: MARKER,
					status: 'ok',
				},
				ok: true,
			},
			statusCode: 200,
		});
		const trustedContext = clientFixture.environmentOpen.mock.calls[0]?.[1]?.trustedContext;
		expect(trustedContext).toEqual({
			correlation: { sessionKey: PROBE_IDENTITY.sessionKey },
			principal: {
				agentId: PROJECTION.agentId,
				frameworkIdentity: PROJECTION.frameworkIdentity,
				profileAssignmentRevision: PROJECTION.profileAssignmentRevision,
				toolPortalProfileId: PROJECTION.toolPortalProfileId,
			},
		});
		expect(clientFixture.filesystemWrite.mock.calls[0]?.[0]).toMatchObject({
			atomic: true,
			environment,
			path: `/workspace/${PROOF_FILE_PATH}`,
		});
		expect(clientFixture.filesystemRead).toHaveBeenCalledWith(
			{
				environment,
				maxBytes: Buffer.byteLength(MARKER),
				offsetBytes: 0,
				path: `/workspace/${PROOF_FILE_PATH}`,
			},
			{ trustedContext },
		);
		expect(clientFixture.environmentClose).toHaveBeenCalledWith(
			{ environment },
			{ trustedContext },
		);
		expect('portal' in clientFixture.client).toBe(false);
	});

	it('reads an existing marker through the authenticated Sandbox path without writing', async () => {
		enableRoute();
		const { clientFixture, route } = registerRoute();
		const bodyText = JSON.stringify({
			action: 'read-existing',
			...PROBE_IDENTITY,
			filePath: PROOF_FILE_PATH,
			marker: MARKER,
		});
		const response = await invokeRoute({ bodyText, route, signature: signBody(bodyText) });
		expect(response).toEqual({
			body: {
				details: {
					agentId: 'main',
					filePath: PROOF_FILE_PATH,
					kind: 'read-existing',
					marker: MARKER,
					readBack: MARKER,
					status: 'ok',
				},
				ok: true,
			},
			statusCode: 200,
		});
		expect(clientFixture.filesystemWrite).not.toHaveBeenCalled();
		expect(clientFixture.filesystemRead).toHaveBeenCalledTimes(1);
		expect(clientFixture.environmentClose).toHaveBeenCalledTimes(1);
	});

	it('runs reset through the direct Sandbox execution handle without a capability call', async () => {
		enableRoute();
		const { clientFixture, route } = registerRoute();
		clientFixture.streamClose.mockRejectedValueOnce(new Error('SSH transport closed during EOF'));
		const bodyText = JSON.stringify({ action: 'reset-connection', ...PROBE_IDENTITY });
		const response = await invokeRoute({ bodyText, route, signature: signBody(bodyText) });
		expect(response).toEqual({
			body: {
				details: { agentId: 'main', kind: 'reset-connection', status: 'ambiguous' },
				ok: true,
			},
			statusCode: 200,
		});
		expect(clientFixture.executionStart.mock.calls[0]?.[0]).toMatchObject({
			cwd: '/work',
			environment,
			mode: { kind: 'direct' },
		});
		expect(clientFixture.executionWait).toHaveBeenCalledWith(
			{ operation, timeoutMs: 60_000 },
			expect.objectContaining({ trustedContext: expect.any(Object) }),
		);
		expect(clientFixture.streamClose).toHaveBeenCalledWith(
			{ stream: stdin },
			expect.objectContaining({ trustedContext: expect.any(Object) }),
		);
		expect(clientFixture.executionWait.mock.invocationCallOrder[0]).toBeLessThan(
			clientFixture.streamClose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(clientFixture.executionCancel).not.toHaveBeenCalled();
		expect('portal' in clientFixture.client).toBe(false);
	});

	it('closes the reset environment when execution start rejects', async () => {
		enableRoute();
		const fixture = createClient();
		fixture.executionStart.mockRejectedValueOnce(new Error('start rejected'));
		const { route } = registerRoute(fixture);
		const bodyText = JSON.stringify({ action: 'reset-connection', ...PROBE_IDENTITY });
		const response = await invokeRoute({ bodyText, route, signature: signBody(bodyText) });

		expect(response.statusCode).toBe(503);
		expect(fixture.executionCancel).not.toHaveBeenCalled();
		expect(fixture.environmentClose).toHaveBeenCalledOnce();
	});

	it('cancels an unexpected reset operation mode and closes its environment', async () => {
		enableRoute();
		const fixture = createClient();
		const unexpectedModeResult = {
			kind: 'started',
			mode: 'direct',
			operation,
			streams: [stdin],
		} satisfies Awaited<ReturnType<ExecutionStart>>;
		Reflect.set(unexpectedModeResult, 'mode', 'unexpected');
		fixture.executionStart.mockResolvedValueOnce(unexpectedModeResult);
		const { route } = registerRoute(fixture);
		const bodyText = JSON.stringify({ action: 'reset-connection', ...PROBE_IDENTITY });
		const response = await invokeRoute({ bodyText, route, signature: signBody(bodyText) });

		expect(response.statusCode).toBe(503);
		expect(fixture.executionCancel).toHaveBeenCalledWith(
			{ operation },
			expect.objectContaining({ trustedContext: expect.any(Object) }),
		);
		expect(fixture.environmentClose).toHaveBeenCalledOnce();
	});

	it('starts active containment through an exact direct operation and cancels that handle on exit', async () => {
		enableRoute();
		const { clientFixture, route } = registerRoute();
		clientFixture.executionWait.mockResolvedValueOnce({
			exitCode: 0,
			operation,
			outcome: {
				certainty: 'proven',
				completion: 'succeeded',
				kind: 'completed',
				retryClass: 'forbidden',
			},
		});
		const bodyText = JSON.stringify({
			action: 'active-operation-containment',
			...PROBE_IDENTITY,
			filePath: PROOF_FILE_PATH,
			marker: MARKER,
			sentinelFilePath: SENTINEL_FILE_PATH,
		});
		const response = await invokeRoute({ bodyText, route, signature: signBody(bodyText) });
		expect(response).toMatchObject({
			body: {
				error: {
					diagnostic: { code: 'active-operation-ended' },
				},
				ok: false,
			},
			statusCode: 503,
		});
		expect(clientFixture.executionStart.mock.calls[0]?.[0]).toMatchObject({
			command: expect.stringContaining(
				`printf '%s\\n' '${MARKER}' >> '/workspace/${SENTINEL_FILE_PATH}'`,
			),
			cwd: '/work',
			environment,
			mode: { kind: 'direct' },
		});
		expect(clientFixture.streamClose).toHaveBeenCalledWith(
			{ stream: stdin },
			expect.objectContaining({ trustedContext: expect.any(Object) }),
		);
		expect(clientFixture.executionCancel).toHaveBeenCalledWith(
			{ operation },
			expect.objectContaining({ trustedContext: expect.any(Object) }),
		);
		expect(clientFixture.environmentClose).toHaveBeenCalled();
	});

	it('closes the environment and returns bounded diagnostics when direct filesystem write fails', async () => {
		enableRoute();
		const fixture = createClient();
		fixture.filesystemWrite.mockRejectedValueOnce(
			Object.assign(new Error('private details'), { code: 'handshake-required' }),
		);
		const { route } = registerRoute(fixture);
		const bodyText = createBody();
		const response = await invokeRoute({ bodyText, route, signature: signBody(bodyText) });
		expect(response).toMatchObject({
			body: {
				error: {
					diagnostic: {
						code: 'filesystem-write-failed',
						kind: 'coded-error',
						name: 'GatewayRuntimeSandboxE2eActuatorError',
					},
				},
				ok: false,
			},
			statusCode: 503,
		});
		expect(JSON.stringify(response.body)).not.toContain('private details');
		expect(fixture.filesystemRead).not.toHaveBeenCalled();
		expect(fixture.environmentClose).toHaveBeenCalled();
	});
});
