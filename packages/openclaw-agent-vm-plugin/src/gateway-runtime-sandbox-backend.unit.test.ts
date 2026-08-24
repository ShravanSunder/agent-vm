import type {
	GatewayRuntimeTrustedInvocationContext,
	ManagedAgentProjection,
	SandboxEnvironmentHandle,
	SandboxOperationIdentity,
	SandboxStreamHandle,
} from '@agent-vm/agent-portal-sdk/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
	createOpenClawGatewayRuntimeSandboxRegistration,
	type OpenClawGatewayRuntimeSandboxClient,
	type OpenClawGatewayRuntimeSandboxLocalExecTransport,
} from './gateway-runtime-sandbox-backend.js';

const environment = {
	handleId: 'environment-a',
	kind: 'environment',
	owningGeneration: 'generation-a',
} satisfies SandboxEnvironmentHandle;
const operation = {
	operationId: 'operation-a',
	owningGeneration: 'generation-a',
} satisfies SandboxOperationIdentity;

function stream(channel: 'stdin' | 'stdout' | 'stderr'): SandboxStreamHandle {
	return {
		channel,
		handleId: `stream-${channel}`,
		kind: 'stream',
		owningGeneration: 'generation-a',
	};
}

const stdin = stream('stdin');
const stdout = stream('stdout');
const stderr = stream('stderr');

const agentProjections = {
	'agent-a': {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'revision-a',
		toolPortalNamespaces: [],
		toolPortalProfileId: 'profile-a',
	},
	'agent-b': {
		agentId: 'agent-b',
		frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
		profileAssignmentRevision: 'revision-b',
		toolPortalNamespaces: [],
		toolPortalProfileId: 'profile-b',
	},
} as const satisfies Readonly<Record<string, ManagedAgentProjection>>;

const managedSandboxConfig = {
	backend: 'gondolin',
	mode: 'all',
	scope: 'agent',
	workspaceAccess: 'rw',
} as const;

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

function createFakeClient(): OpenClawGatewayRuntimeSandboxClient {
	return {
		sandbox: {
			environment: {
				close: vi.fn(async () => ({ environment, kind: 'closed' as const })),
				open: vi.fn(async () => ({ environment, kind: 'opened' as const })),
			},
			execution: {
				cancel: vi.fn(async () => ({ kind: 'cancel-request-accepted' as const, operation })),
				start: vi.fn(async () => ({
					kind: 'started' as const,
					mode: 'direct' as const,
					operation,
					streams: [stdin, stdout, stderr],
				})),
				wait: vi.fn(async () => ({
					exitCode: 17,
					operation,
					outcome: {
						certainty: 'proven' as const,
						completion: 'failed' as const,
						kind: 'completed' as const,
						retryClass: 'forbidden' as const,
					},
				})),
			},
			filesystem: {
				mkdir: vi.fn(async (request) => ({
					created: true,
					kind: 'directory-ready' as const,
					path: request.path,
				})),
				read: vi.fn(async (request) => ({
					chunk: binaryChunk('durable'),
					eof: true,
					kind: 'read' as const,
					nextOffsetBytes: request.offsetBytes + 7,
					path: request.path,
				})),
				remove: vi.fn(async (request) => ({
					kind: 'removed' as const,
					path: request.path,
					removed: true,
				})),
				rename: vi.fn(async (request) => ({
					destinationPath: request.destinationPath,
					kind: 'renamed' as const,
					sourcePath: request.sourcePath,
				})),
				stat: vi.fn(async (request) => ({
					entry: { byteLength: 7, kind: 'file' as const, path: request.path },
					kind: 'stat' as const,
				})),
				write: vi.fn(async (request) => ({
					bytesWritten: request.content.byteLength,
					contentDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					kind: 'written' as const,
					path: request.path,
				})),
			},
			stream: {
				close: vi.fn(async (request) => ({ kind: 'closed' as const, stream: request.stream })),
				read: vi.fn(async (request) => ({
					chunk: binaryChunk(''),
					eof: true,
					kind: 'read' as const,
					sequence: 0,
					stream: request.stream,
				})),
				write: vi.fn(async (request) => ({
					bytesWritten: request.content.byteLength,
					kind: 'written' as const,
					sequence: request.sequence,
					stream: request.stream,
				})),
			},
		},
	};
}

function createFakeLocalExecTransport(): OpenClawGatewayRuntimeSandboxLocalExecTransport {
	return {
		close: vi.fn(async () => {}),
		finalize: vi.fn(async () => {}),
		reserve: vi.fn(async () => ({
			argv: [process.execPath, '/internal/helper.js'],
			env: { AGENT_VM_LOCAL_EXEC_SOCKET: '/tmp/private.sock' },
			finalizeToken: {
				kind: 'gateway-runtime-local-exec' as const,
				reservationId: 'reservation-a',
			},
			stdinMode: 'pipe-open' as const,
		})),
	};
}

function createBackendFixture(
	options: {
		readonly traceContextProvider?: () =>
			| {
					readonly traceparent: string;
			  }
			| undefined;
	} = {},
): {
	readonly client: OpenClawGatewayRuntimeSandboxClient;
	readonly factory: ReturnType<typeof createOpenClawGatewayRuntimeSandboxRegistration>['factory'];
	readonly localExecTransport: OpenClawGatewayRuntimeSandboxLocalExecTransport;
} {
	const client = createFakeClient();
	const localExecTransport = createFakeLocalExecTransport();
	const registration = createOpenClawGatewayRuntimeSandboxRegistration({
		agentProjections,
		client,
		localExecTransport,
		...(options.traceContextProvider === undefined
			? {}
			: { traceContextProvider: options.traceContextProvider }),
	});
	return { client, factory: registration.factory, localExecTransport };
}

describe('OpenClaw Gateway Runtime SandboxBackend', () => {
	it.each([
		['backend', { ...managedSandboxConfig, backend: 'docker' }],
		['mode', { ...managedSandboxConfig, mode: 'non-main' }],
		['scope', { ...managedSandboxConfig, scope: 'session' }],
		['workspaceAccess', { ...managedSandboxConfig, workspaceAccess: 'ro' }],
	] as const)('rejects a non-managed %s setting before any UDS request', async (_field, cfg) => {
		const fixture = createBackendFixture();
		await expect(
			fixture.factory({
				agentWorkspaceDir: '/ignored',
				cfg,
				scopeKey: 'scope-a',
				sessionKey: 'agent:agent-a:session-a',
				workspaceDir: '/ignored',
			}),
		).rejects.toThrow(/requires/u);
		expect(fixture.client.sandbox.environment.open).not.toHaveBeenCalled();
	});

	it('fails closed before a Sandbox request for malformed, unconfigured, or mismatched identity', async () => {
		const fixture = createBackendFixture();
		await Promise.all(
			(['main', 'agent:unknown:session'] as const).map(async (sessionKey) =>
				expect(
					fixture.factory({
						agentWorkspaceDir: '/gateway/private/agent',
						cfg: managedSandboxConfig,
						scopeKey: 'scope-a',
						sessionKey,
						workspaceDir: '/gateway/private/workspace',
					}),
				).rejects.toThrow(),
			),
		);
		expect(fixture.client.sandbox.environment.open).not.toHaveBeenCalled();

		const mismatchedProjections = {
			'agent-a': { ...agentProjections['agent-a'], agentId: 'agent-b' },
		};
		const mismatchedRegistration = createOpenClawGatewayRuntimeSandboxRegistration({
			agentProjections: mismatchedProjections,
			client: fixture.client,
			localExecTransport: fixture.localExecTransport,
		});
		await expect(
			mismatchedRegistration.factory({
				agentWorkspaceDir: '/ignored',
				cfg: managedSandboxConfig,
				scopeKey: 'scope-a',
				sessionKey: 'agent:agent-a:session',
				workspaceDir: '/ignored',
			}),
		).rejects.toThrow(/projection identity/u);
		expect(fixture.client.sandbox.environment.open).not.toHaveBeenCalled();
	});

	it('opens one operation-scoped /work environment for shell and closes it in finally', async () => {
		const fixture = createBackendFixture();
		const backend = await fixture.factory({
			agentWorkspaceDir: '/gateway/private/agent-a',
			cfg: managedSandboxConfig,
			scopeKey: 'scope-a',
			sessionKey: 'agent:agent-a:session-a',
			workspaceDir: '/gateway/private/workspace-a',
		});

		await expect(
			backend.runShellCommand({ allowFailure: true, script: 'exit 17' }),
		).resolves.toMatchObject({ code: 17 });
		expect(fixture.client.sandbox.environment.open).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				trustedContext: expect.objectContaining({
					principal: expect.objectContaining({ agentId: 'agent-a' }),
				}),
			}),
		);
		expect(fixture.client.sandbox.execution.start).toHaveBeenCalledWith(
			expect.objectContaining({ command: 'exit 17', cwd: '/work', mode: { kind: 'direct' } }),
			expect.any(Object),
		);
		expect(fixture.client.sandbox.environment.close).toHaveBeenCalledOnce();
	});

	it('preserves shell args, stdin, signal, and allowFailure through the Sandbox API', async () => {
		const fixture = createBackendFixture();
		const backend = await fixture.factory({
			agentWorkspaceDir: '/ignored',
			cfg: managedSandboxConfig,
			scopeKey: 'scope-a',
			sessionKey: 'agent:agent-a:session-a',
			workspaceDir: '/ignored',
		});
		const signal = new AbortController().signal;
		await backend.runShellCommand({
			allowFailure: true,
			args: ['value with spaces'],
			script: 'printf "%s" "$1"',
			signal,
			stdin: 'input',
		});

		expect(fixture.client.sandbox.execution.start).toHaveBeenCalledWith(
			expect.objectContaining({
				command: expect.stringContaining("'value with spaces'"),
			}),
			expect.objectContaining({ signal }),
		);
		expect(fixture.client.sandbox.stream.write).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					contentBase64: Buffer.from('input').toString('base64'),
				}),
				stream: stdin,
			}),
			expect.objectContaining({ signal }),
		);
		expect(fixture.client.sandbox.stream.close).toHaveBeenCalledWith(
			{ stream: stdin },
			expect.objectContaining({ signal }),
		);
	});

	it('maps the selected OpenClaw workspace to /workspace and rejects sibling agent roots', async () => {
		const fixture = createBackendFixture();
		vi.mocked(fixture.client.sandbox.filesystem.read)
			.mockResolvedValueOnce({
				chunk: binaryChunk('dur'),
				eof: false,
				kind: 'read',
				nextOffsetBytes: 3,
				path: '/workspace/memory/notes.md',
			})
			.mockResolvedValueOnce({
				chunk: binaryChunk('able'),
				eof: true,
				kind: 'read',
				nextOffsetBytes: 7,
				path: '/workspace/memory/notes.md',
			});
		const backend = await fixture.factory({
			agentWorkspaceDir: '/gateway/private/agent-a',
			cfg: managedSandboxConfig,
			scopeKey: 'scope-a',
			sessionKey: 'agent:agent-a:session-a',
			workspaceDir: '/gateway/private/workspace-a',
		});
		expect(backend.createFsBridge).toBeTypeOf('function');
		const bridge = backend.createFsBridge?.({ sandbox: {} });
		if (bridge === undefined) throw new Error('Expected the required filesystem bridge.');

		expect(bridge.resolvePath({ cwd: '/work', filePath: 'notes.txt' })).toEqual({
			containerPath: '/work/notes.txt',
			relativePath: 'notes.txt',
		});
		expect(
			bridge.resolvePath({
				cwd: '/gateway/private/workspace-a',
				filePath: '/gateway/private/workspace-a/HEARTBEAT.md',
			}),
		).toEqual({
			containerPath: '/workspace/HEARTBEAT.md',
			relativePath: 'HEARTBEAT.md',
		});
		await expect(
			bridge.readFile({
				cwd: '/gateway/private/workspace-a',
				filePath: 'memory/notes.md',
			}),
		).resolves.toEqual(Buffer.from('durable'));
		expect(() =>
			bridge.resolvePath({
				cwd: '/gateway/private/workspace-b',
				filePath: '/gateway/private/workspace-b/HEARTBEAT.md',
			}),
		).toThrow(/outside Tool VM guest roots/u);
		expect(fixture.client.sandbox.filesystem.read).toHaveBeenCalledWith(
			expect.objectContaining({ path: '/workspace/memory/notes.md' }),
			expect.any(Object),
		);
		expect(fixture.client.sandbox.filesystem.read).toHaveBeenCalledTimes(2);
		expect(fixture.client.sandbox.environment.close).toHaveBeenCalledOnce();
	});

	it('closes non-PTY stdin so native exec can reach an authoritative exit status', async () => {
		const fixture = createBackendFixture();
		const backend = await fixture.factory({
			agentWorkspaceDir: '/gateway/private/agent-a',
			cfg: managedSandboxConfig,
			scopeKey: 'scope-a',
			sessionKey: 'agent:agent-a:session-a',
			workspaceDir: '/gateway/private/workspace-a',
		});
		const execSpec = await backend.buildExecSpec({
			command: 'printf native',
			env: { LANG: 'C' },
			usePty: false,
		});

		expect(fixture.localExecTransport.reserve).toHaveBeenCalledOnce();
		expect(fixture.client.sandbox.stream.close).toHaveBeenCalledWith(
			expect.objectContaining({ stream: expect.objectContaining({ channel: 'stdin' }) }),
			expect.any(Object),
		);
		expect(vi.mocked(fixture.client.sandbox.stream.close).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(fixture.localExecTransport.reserve).mock.invocationCallOrder[0] ?? 0,
		);
		expect(execSpec).toMatchObject({
			argv: [process.execPath, '/internal/helper.js'],
			stdinMode: 'pipe-closed',
		});
		const reservedOperation = vi.mocked(fixture.localExecTransport.reserve).mock.calls[0]?.[0];
		if (reservedOperation === undefined) throw new Error('Expected one reserved operation.');
		await expect(reservedOperation.wait()).resolves.toEqual({ exitCode: 17 });
		await reservedOperation.readStdout(1024);
		await reservedOperation.readStderr(1024);
		expect(fixture.client.sandbox.environment.close).toHaveBeenCalledOnce();

		await backend.finalizeExec?.({
			exitCode: 17,
			status: 'completed',
			timedOut: false,
			token: execSpec.finalizeToken,
		});
		expect(fixture.localExecTransport.finalize).toHaveBeenCalledWith(execSpec.finalizeToken);
	});

	it('snapshots one trace context for every request emitted by a native exec relay', async () => {
		// Arrange
		const capturedTraceContext = {
			traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
		} as const;
		let activeTraceContext: typeof capturedTraceContext | undefined = capturedTraceContext;
		const traceContextProvider = vi.fn(() => activeTraceContext);
		const fixture = createBackendFixture({ traceContextProvider });
		const backend = await fixture.factory({
			agentWorkspaceDir: '/gateway/private/agent-a',
			cfg: managedSandboxConfig,
			scopeKey: 'scope-a',
			sessionKey: 'agent:agent-a:session-a',
			workspaceDir: '/gateway/private/workspace-a',
		});

		// Act
		await backend.buildExecSpec({ command: 'cat', env: {}, usePty: false });
		activeTraceContext = undefined;
		const reservedOperation = vi.mocked(fixture.localExecTransport.reserve).mock.calls[0]?.[0];
		if (reservedOperation === undefined) throw new Error('Expected one reserved operation.');
		await reservedOperation.writeStdin(Buffer.from('input'));
		await reservedOperation.closeStdin();
		await reservedOperation.readStdout(1_024);
		await reservedOperation.readStderr(1_024);
		await reservedOperation.wait();
		await reservedOperation.cancel();

		// Assert
		expect(traceContextProvider).toHaveBeenCalledOnce();
		const requestOptions = [
			vi.mocked(fixture.client.sandbox.environment.open).mock.calls[0]?.[1],
			vi.mocked(fixture.client.sandbox.execution.start).mock.calls[0]?.[1],
			vi.mocked(fixture.client.sandbox.execution.wait).mock.calls[0]?.[1],
			vi.mocked(fixture.client.sandbox.execution.cancel).mock.calls[0]?.[1],
			...vi.mocked(fixture.client.sandbox.stream.read).mock.calls.map((call) => call[1]),
			vi.mocked(fixture.client.sandbox.stream.write).mock.calls[0]?.[1],
			vi.mocked(fixture.client.sandbox.stream.close).mock.calls[0]?.[1],
			vi.mocked(fixture.client.sandbox.environment.close).mock.calls[0]?.[1],
		];
		expect(requestOptions).toHaveLength(9);
		const firstRequestOptions = requestOptions[0];
		expect(firstRequestOptions).toBeDefined();
		for (const operationRequestOptions of requestOptions) {
			expect(operationRequestOptions).toBe(firstRequestOptions);
			expect(operationRequestOptions).toMatchObject({ traceContext: capturedTraceContext });
		}
	});

	it('fails closed when a completed native exec omits its exact exit code', async () => {
		const fixture = createBackendFixture();
		vi.mocked(fixture.client.sandbox.execution.wait).mockResolvedValueOnce({
			operation,
			outcome: {
				certainty: 'proven',
				completion: 'succeeded',
				kind: 'completed',
				retryClass: 'forbidden',
			},
		});
		const backend = await fixture.factory({
			agentWorkspaceDir: '/ignored',
			cfg: managedSandboxConfig,
			scopeKey: 'scope-a',
			sessionKey: 'agent:agent-a:session-a',
			workspaceDir: '/ignored',
		});
		await backend.buildExecSpec({ command: 'true', env: {}, usePty: false });
		const reservedOperation = vi.mocked(fixture.localExecTransport.reserve).mock.calls[0]?.[0];
		if (reservedOperation === undefined) throw new Error('Expected one reserved operation.');

		await expect(reservedOperation.wait()).rejects.toThrow(/exact exit code/u);
	});

	it('cancels a started operation when local-exec reservation fails', async () => {
		const fixture = createBackendFixture();
		vi.mocked(fixture.localExecTransport.reserve).mockRejectedValueOnce(
			new Error('local socket unavailable'),
		);
		const backend = await fixture.factory({
			agentWorkspaceDir: '/ignored',
			cfg: managedSandboxConfig,
			scopeKey: 'scope-a',
			sessionKey: 'agent:agent-a:session-a',
			workspaceDir: '/ignored',
		});

		await expect(
			backend.buildExecSpec({ command: 'sleep 60', env: {}, usePty: false }),
		).rejects.toThrow('local socket unavailable');
		expect(fixture.client.sandbox.execution.cancel).toHaveBeenCalledWith(
			{ operation },
			expect.any(Object),
		);
		expect(fixture.client.sandbox.environment.close).toHaveBeenCalledOnce();
	});

	it('rejects a non-advancing filesystem read offset and closes its environment', async () => {
		const fixture = createBackendFixture();
		vi.mocked(fixture.client.sandbox.filesystem.read).mockResolvedValueOnce({
			chunk: binaryChunk(''),
			eof: false,
			kind: 'read',
			nextOffsetBytes: 0,
			path: '/workspace/file.txt',
		});
		const backend = await fixture.factory({
			agentWorkspaceDir: '/ignored',
			cfg: managedSandboxConfig,
			scopeKey: 'scope-a',
			sessionKey: 'agent:agent-a:session-a',
			workspaceDir: '/ignored',
		});
		const bridge = backend.createFsBridge({ sandbox: {} });

		await expect(bridge.readFile({ filePath: '/workspace/file.txt' })).rejects.toThrow(
			/non-advancing offset/u,
		);
		expect(fixture.client.sandbox.environment.close).toHaveBeenCalledOnce();
	});

	it('closes the operation environment when a shell request fails', async () => {
		const fixture = createBackendFixture();
		vi.mocked(fixture.client.sandbox.execution.start).mockRejectedValueOnce(
			new Error('service unavailable'),
		);
		const backend = await fixture.factory({
			agentWorkspaceDir: '/ignored',
			cfg: managedSandboxConfig,
			scopeKey: 'scope-a',
			sessionKey: 'agent:agent-a:session-a',
			workspaceDir: '/ignored',
		});

		await expect(backend.runShellCommand({ script: 'pwd' })).rejects.toThrow('service unavailable');
		expect(fixture.client.sandbox.environment.close).toHaveBeenCalledOnce();
	});

	it('does not derive identity or path authority from OpenClaw workspace fields', async () => {
		const fixture = createBackendFixture();
		const backend = await fixture.factory({
			agentWorkspaceDir: '/gateway/private/agent-b',
			cfg: managedSandboxConfig,
			scopeKey: 'agent:agent-b:forged',
			sessionKey: 'agent:agent-a:session-a',
			workspaceDir: '/gateway/private/workspace-b',
		});
		await backend.runShellCommand({ allowFailure: true, script: 'true' });

		const requestOptions = vi.mocked(fixture.client.sandbox.environment.open).mock.calls[0]?.[1];
		const trustedContext = requestOptions?.trustedContext as
			| GatewayRuntimeTrustedInvocationContext
			| undefined;
		expect(trustedContext?.principal.agentId).toBe('agent-a');
		expect(
			JSON.stringify(vi.mocked(fixture.client.sandbox.execution.start).mock.calls),
		).not.toContain('/gateway/private');
	});

	it('closes outstanding local-exec reservations through the registration lifecycle', async () => {
		const client = createFakeClient();
		const localExecTransport = createFakeLocalExecTransport();
		const registration = createOpenClawGatewayRuntimeSandboxRegistration({
			agentProjections,
			client,
			localExecTransport,
		});

		await registration.close();

		expect(localExecTransport.close).toHaveBeenCalledOnce();
	});
});
