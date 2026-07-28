import type {
	GatewayRuntimeTrustedInvocationContext,
	SandboxEnvironmentHandle,
	SandboxOperationIdentity,
	SandboxStreamHandle,
} from '@agent-vm/agent-portal-sdk/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { OpenClawGatewayRuntimeSandboxClient } from './gateway-runtime-sandbox-backend.js';
import {
	createOpenClawGatewayRuntimeLocalExecOperation,
	type OpenClawGatewayRuntimeDirectExecution,
} from './gateway-runtime-sandbox-local-exec-operation.js';

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
const execution = {
	environment,
	operation,
	stderr,
	stdin,
	stdout,
} satisfies OpenClawGatewayRuntimeDirectExecution;
const trustedContext = {
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'revision-a',
		toolPortalProfileId: 'profile-a',
	},
} satisfies GatewayRuntimeTrustedInvocationContext;

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

describe('OpenClaw Gateway Runtime local exec operation', () => {
	it('settles an in-flight stdin close before retiring the execution environment', async () => {
		// Arrange
		let resolveStreamClose:
			| ((result: { readonly kind: 'closed'; readonly stream: SandboxStreamHandle }) => void)
			| undefined;
		const streamCloseSettlement = new Promise<{
			readonly kind: 'closed';
			readonly stream: SandboxStreamHandle;
		}>((resolve) => {
			resolveStreamClose = resolve;
		});
		const environmentClose = vi.fn(async () => ({ environment, kind: 'closed' as const }));
		const client = {
			sandbox: {
				environment: { close: environmentClose, open: vi.fn() },
				execution: {
					cancel: vi.fn(),
					start: vi.fn(),
					wait: vi.fn(async () => ({
						exitCode: 0,
						operation,
						outcome: {
							certainty: 'proven' as const,
							completion: 'succeeded' as const,
							kind: 'completed' as const,
							retryClass: 'forbidden' as const,
						},
					})),
				},
				filesystem: {
					mkdir: vi.fn(),
					read: vi.fn(),
					remove: vi.fn(),
					rename: vi.fn(),
					stat: vi.fn(),
					write: vi.fn(),
				},
				stream: {
					close: vi.fn(async () => await streamCloseSettlement),
					read: vi.fn(async ({ stream: requestedStream }) => ({
						chunk: binaryChunk(''),
						eof: true,
						kind: 'read' as const,
						sequence: 0,
						stream: requestedStream,
					})),
					write: vi.fn(),
				},
			},
		} satisfies OpenClawGatewayRuntimeSandboxClient;
		const localExecOperation = createOpenClawGatewayRuntimeLocalExecOperation({
			client,
			execution,
			requestOptions: { trustedContext },
		});

		// Act
		const closeStdinPromise = localExecOperation.closeStdin();
		await vi.waitFor(() => expect(client.sandbox.stream.close).toHaveBeenCalledOnce());
		await Promise.all([
			localExecOperation.wait(),
			localExecOperation.readStdout(1_024),
			localExecOperation.readStderr(1_024),
		]);

		// Assert
		expect(environmentClose).not.toHaveBeenCalled();
		resolveStreamClose?.({ kind: 'closed', stream: stdin });
		await closeStdinPromise;
		expect(environmentClose).toHaveBeenCalledOnce();
		await localExecOperation.closeStdin();
		expect(client.sandbox.stream.close).toHaveBeenCalledOnce();
	});

	it('suppresses empty non-EOF observations before returning output and completion', async () => {
		// Arrange
		vi.useFakeTimers();
		const streamRead = vi.fn<OpenClawGatewayRuntimeSandboxClient['sandbox']['stream']['read']>();
		streamRead
			.mockResolvedValueOnce({
				chunk: binaryChunk(''),
				eof: false,
				kind: 'read',
				nextCursor: 'stdout-cursor-1',
				sequence: 0,
				stream: stdout,
			})
			.mockResolvedValueOnce({
				chunk: binaryChunk('native output'),
				eof: false,
				kind: 'read',
				nextCursor: 'stdout-cursor-2',
				sequence: 1,
				stream: stdout,
			})
			.mockResolvedValueOnce({
				chunk: binaryChunk(''),
				eof: true,
				kind: 'read',
				nextCursor: 'stdout-cursor-2',
				sequence: 2,
				stream: stdout,
			})
			.mockResolvedValueOnce({
				chunk: binaryChunk(''),
				eof: true,
				kind: 'read',
				sequence: 0,
				stream: stderr,
			});
		const environmentClose = vi.fn(async () => ({ environment, kind: 'closed' as const }));
		const client = {
			sandbox: {
				environment: { close: environmentClose, open: vi.fn() },
				execution: {
					cancel: vi.fn(),
					start: vi.fn(),
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
					mkdir: vi.fn(),
					read: vi.fn(),
					remove: vi.fn(),
					rename: vi.fn(),
					stat: vi.fn(),
					write: vi.fn(),
				},
				stream: { close: vi.fn(), read: streamRead, write: vi.fn() },
			},
		} satisfies OpenClawGatewayRuntimeSandboxClient;
		const localExecOperation = createOpenClawGatewayRuntimeLocalExecOperation({
			client,
			execution,
			requestOptions: { trustedContext },
		});

		try {
			// Act
			const waited = await localExecOperation.wait();
			const outputPromise = localExecOperation.readStdout(1_024);
			await vi.advanceTimersByTimeAsync(0);

			// Assert
			expect(streamRead).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(9);
			expect(streamRead).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(1);
			const output = await outputPromise;
			const stdoutEnd = await localExecOperation.readStdout(1_024);
			const stderrEnd = await localExecOperation.readStderr(1_024);

			expect(waited).toEqual({ exitCode: 17 });
			expect(output).toEqual({ content: Buffer.from('native output'), kind: 'chunk' });
			expect(stdoutEnd).toEqual({ kind: 'end' });
			expect(stderrEnd).toEqual({ kind: 'end' });
			expect(streamRead).toHaveBeenCalledTimes(4);
			expect(streamRead.mock.calls[1]?.[0]).toMatchObject({ cursor: 'stdout-cursor-1' });
			expect(streamRead.mock.calls[2]?.[0]).toMatchObject({ cursor: 'stdout-cursor-2' });
			expect(environmentClose).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});
