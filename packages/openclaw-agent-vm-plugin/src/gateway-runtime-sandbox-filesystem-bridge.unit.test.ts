import type {
	GatewayRuntimeTrustedInvocationContext,
	SandboxEnvironmentHandle,
} from '@agent-vm/agent-portal-sdk/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { OpenClawGatewayRuntimeSandboxClient } from './gateway-runtime-sandbox-backend.js';
import { createOpenClawGatewayRuntimeSandboxFilesystemBridge } from './gateway-runtime-sandbox-filesystem-bridge.js';

const environment = {
	handleId: 'environment-concurrent-filesystem',
	kind: 'environment',
	owningGeneration: 'generation-concurrent-filesystem',
} satisfies SandboxEnvironmentHandle;

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

describe('OpenClaw Gateway Runtime Sandbox filesystem bridge', () => {
	it('shares one bounded environment across concurrent filesystem operations', async () => {
		// Arrange
		const concurrentReadCount = 12;
		const maximumAdmittedEnvironmentCount = 8;
		let activeEnvironmentCount = 0;
		let environmentOpenAttemptCount = 0;
		let filesystemReadCount = 0;
		let releaseReads!: () => void;
		const readsMayComplete = new Promise<void>((resolve) => {
			releaseReads = resolve;
		});
		const releaseWhenAllRequestsReachedBackend = (): void => {
			if (
				environmentOpenAttemptCount === concurrentReadCount ||
				filesystemReadCount === concurrentReadCount
			) {
				releaseReads();
			}
		};
		const client = {
			sandbox: {
				environment: {
					close: vi.fn(async () => {
						activeEnvironmentCount -= 1;
						return { environment, kind: 'closed' as const };
					}),
					open: vi.fn(async () => {
						environmentOpenAttemptCount += 1;
						releaseWhenAllRequestsReachedBackend();
						if (activeEnvironmentCount >= maximumAdmittedEnvironmentCount) {
							throw new Error('simulated per-principal authority capacity refusal');
						}
						activeEnvironmentCount += 1;
						return { environment, kind: 'opened' as const };
					}),
				},
				execution: {
					cancel: vi.fn(),
					start: vi.fn(),
					wait: vi.fn(),
				},
				filesystem: {
					mkdir: vi.fn(),
					read: vi.fn(async (request) => {
						filesystemReadCount += 1;
						releaseWhenAllRequestsReachedBackend();
						await readsMayComplete;
						return {
							chunk: binaryChunk(`file-${request.path}`),
							eof: true,
							kind: 'read' as const,
							nextOffsetBytes: request.offsetBytes + 1,
							path: request.path,
						};
					}),
					remove: vi.fn(),
					rename: vi.fn(),
					stat: vi.fn(),
					write: vi.fn(),
				},
				stream: {
					close: vi.fn(),
					read: vi.fn(),
					write: vi.fn(),
				},
			},
		} satisfies OpenClawGatewayRuntimeSandboxClient;
		const bridge = createOpenClawGatewayRuntimeSandboxFilesystemBridge({
			client,
			openClawWorkspaceRoot: '/zone/agents/agent-a',
			trustedContext,
		});

		// Act
		const results = await Promise.allSettled(
			Array.from(
				{ length: concurrentReadCount },
				async (_, index) =>
					await bridge.readFile({ filePath: `/workspace/file-${String(index)}.txt` }),
			),
		);

		// Assert
		expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
		expect(client.sandbox.environment.open).toHaveBeenCalledOnce();
		expect(client.sandbox.filesystem.read).toHaveBeenCalledTimes(concurrentReadCount);
		expect(client.sandbox.environment.close).toHaveBeenCalledOnce();
		expect(activeEnvironmentCount).toBe(0);
	});
});
