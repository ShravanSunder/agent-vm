import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	GatewayRuntimeFrameDecoder,
	encodeGatewayRuntimeFrame,
	type GatewayRuntimeJsonRpcMessage,
} from './gateway-runtime-protocol.js';
import { GatewayRuntimeClient } from './index.js';

const temporaryRoots: string[] = [];

const sampledTraceContext = {
	traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
	tracestate: 'vendor=opaque-value',
} as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createResponseForRequest(
	request: GatewayRuntimeJsonRpcMessage,
): GatewayRuntimeJsonRpcMessage {
	const requestId = request['id'];
	if (request['method'] === 'managed-plugin.handshake') {
		return { id: requestId, jsonrpc: '2.0', result: { kind: 'accepted' } };
	}
	if (request['method'] === 'portal.call') {
		return {
			id: requestId,
			jsonrpc: '2.0',
			result: {
				items: [
					{
						id: 'call-1',
						operationId: 'operation-1',
						outcome: {
							certainty: 'proven',
							completion: 'succeeded',
							kind: 'completed',
							retryClass: 'forbidden',
						},
						owningGeneration: 'tool-vm-generation-1',
						status: 'ok',
						value: { echoed: 'hello' },
					},
				],
				ok: true,
			},
		};
	}
	return {
		error: { code: -32601, message: 'Method not found.' },
		id: requestId,
		jsonrpc: '2.0',
	};
}

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { force: true, recursive: true })),
	);
});

describe('Node Gateway runtime UDS transport', () => {
	it('negotiates and calls over a real fragmented full-duplex Unix socket', async () => {
		// Arrange
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-sdk-uds-'));
		temporaryRoots.push(temporaryRoot);
		const socketPath = path.join(temporaryRoot, 'managed-plugin.sock');
		const observedRequests: GatewayRuntimeJsonRpcMessage[] = [];
		const server = net.createServer((socket) => {
			const decoder = new GatewayRuntimeFrameDecoder();
			socket.on('data', (chunk: Buffer) => {
				for (const request of decoder.push(chunk)) {
					observedRequests.push(request);
					const responseFrame = encodeGatewayRuntimeFrame(createResponseForRequest(request));
					const splitOffset = Math.max(1, Math.floor(responseFrame.byteLength / 2));
					socket.write(responseFrame.subarray(0, splitOffset));
					socket.write(responseFrame.subarray(splitOffset));
				}
			});
		});
		server.listen(socketPath);
		await once(server, 'listening', { signal: AbortSignal.timeout(5_000) });
		const client = new GatewayRuntimeClient({
			attachment: {
				attachmentGeneration: 1,
				clientKind: 'openclaw-managed-plugin',
				configuredAgentIds: ['main'],
				frameworkEpoch: 'framework-epoch-1',
				gatewayEpoch: 'gateway-epoch-1',
				protocolVersion: 1,
				projectionCohortDigest:
					'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				runtimeEpoch: 'runtime-epoch-1',
				schemaVersion: 1,
			},
			socketPath,
			traceContextProvider: () => sampledTraceContext,
		});

		try {
			// Act
			await client.connect();
			const result = await client.portal.call(
				{
					calls: [
						{
							arguments: { text: 'hello' },
							id: 'call-1',
							name: 'echo',
							namespace: 'testing',
						},
					],
				},
				{
					trustedContext: {
						correlation: {
							runId: 'run-a',
							sessionId: 'session-a',
							sessionKey: 'session-key-a',
							toolCallId: 'tool-call-a',
						},
						principal: {
							agentId: 'agent-a',
							frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
							profileAssignmentRevision: 'profile-assignment:agent-a:1',
							toolPortalProfileId: 'profile-a',
						},
						requester: {
							authenticatedSubjectId: 'subject-a',
						},
					},
				},
			);

			// Assert
			expect(result).toMatchObject({ items: [{ status: 'ok' }], ok: true });
			expect(observedRequests.map((request) => request['method'])).toEqual([
				'managed-plugin.handshake',
				'portal.call',
			]);
			const handshakeParams = observedRequests[0]?.['params'];
			const portalParams = observedRequests[1]?.['params'];
			expect(isRecord(handshakeParams)).toBe(true);
			expect(handshakeParams).not.toHaveProperty('connectionId');
			expect(handshakeParams).not.toHaveProperty('authority');
			expect(portalParams).toMatchObject({ traceContext: sampledTraceContext });
			expect(portalParams).not.toHaveProperty('publicRequest.traceContext');
		} finally {
			await client.disconnect();
			server.close();
			await once(server, 'close', { signal: AbortSignal.timeout(5_000) });
		}
	});

	it('classifies a missing pre-publication socket as the only retryable startup failure', async () => {
		// Arrange
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-sdk-uds-missing-'));
		temporaryRoots.push(temporaryRoot);
		const client = new GatewayRuntimeClient({
			attachment: {
				attachmentGeneration: 1,
				clientKind: 'hermes-managed-plugin',
				configuredAgentIds: ['main'],
				frameworkEpoch: 'framework-epoch-1',
				gatewayEpoch: 'gateway-epoch-1',
				protocolVersion: 1,
				projectionCohortDigest:
					'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				runtimeEpoch: 'runtime-epoch-1',
				schemaVersion: 1,
			},
			socketPath: path.join(temporaryRoot, 'not-yet-published.sock'),
			startupRetryPolicy: { maxAttempts: 1 },
		});

		// Act
		const connectionAttempt = client.connect();

		// Assert
		await expect(connectionAttempt).rejects.toMatchObject({
			cause: { code: 'startup-unavailable', kind: 'socket-absent' },
			code: 'startup-retry-exhausted',
		});
	});

	it('bounds socket error listeners while writing concurrent requests', async () => {
		// Arrange
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-sdk-uds-pressure-'));
		temporaryRoots.push(temporaryRoot);
		const socketPath = path.join(temporaryRoot, 'managed-plugin.sock');
		const server = net.createServer((socket) => {
			const decoder = new GatewayRuntimeFrameDecoder();
			socket.on('data', (chunk: Buffer) => {
				for (const request of decoder.push(chunk)) {
					socket.write(encodeGatewayRuntimeFrame(createResponseForRequest(request)));
				}
			});
		});
		server.listen(socketPath);
		await once(server, 'listening', { signal: AbortSignal.timeout(5_000) });
		const client = new GatewayRuntimeClient({
			attachment: {
				attachmentGeneration: 1,
				clientKind: 'openclaw-managed-plugin',
				configuredAgentIds: ['main'],
				frameworkEpoch: 'framework-epoch-1',
				gatewayEpoch: 'gateway-epoch-1',
				protocolVersion: 1,
				projectionCohortDigest:
					'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				runtimeEpoch: 'runtime-epoch-1',
				schemaVersion: 1,
			},
			socketPath,
		});
		const socketListenerWarnings: Error[] = [];
		const captureSocketListenerWarning = (warning: Error): void => {
			if (
				warning.name === 'MaxListenersExceededWarning' &&
				warning.message.includes('error listeners added to [Socket]')
			) {
				socketListenerWarnings.push(warning);
			}
		};
		process.on('warning', captureSocketListenerWarning);

		try {
			await client.connect();

			// Act
			await Promise.all(
				Array.from(
					{ length: 12 },
					async (_, requestIndex) =>
						await client.portal.call(
							{
								calls: [
									{
										arguments: { text: `request-${String(requestIndex)}` },
										id: 'call-1',
										name: 'echo',
										namespace: 'testing',
									},
								],
							},
							{
								trustedContext: {
									principal: {
										agentId: 'main',
										frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
										profileAssignmentRevision: 'profile-assignment:main:1',
										toolPortalProfileId: 'profile-main',
									},
								},
							},
						),
				),
			);
			await new Promise<void>((resolve) => setImmediate(resolve));

			// Assert
			expect(socketListenerWarnings).toEqual([]);
		} finally {
			process.off('warning', captureSocketListenerWarning);
			await client.disconnect();
			server.close();
			await once(server, 'close', { signal: AbortSignal.timeout(5_000) });
		}
	});

	it('propagates cancellation and discards a late response without poisoning the connection', async () => {
		// Arrange
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-sdk-uds-cancel-'));
		temporaryRoots.push(temporaryRoot);
		const socketPath = path.join(temporaryRoot, 'managed-plugin.sock');
		const firstPortalRequestObserved = Promise.withResolvers<void>();
		const cancellationObserved = Promise.withResolvers<GatewayRuntimeJsonRpcMessage>();
		let firstPortalRequestId: unknown;
		let portalRequestCount = 0;
		const server = net.createServer((socket) => {
			const decoder = new GatewayRuntimeFrameDecoder();
			socket.on('data', (chunk: Buffer) => {
				for (const request of decoder.push(chunk)) {
					if (request['method'] === 'managed-plugin.handshake') {
						socket.write(encodeGatewayRuntimeFrame(createResponseForRequest(request)));
						continue;
					}
					if (request['method'] === 'portal.call') {
						portalRequestCount += 1;
						if (portalRequestCount === 1) {
							firstPortalRequestId = request['id'];
							firstPortalRequestObserved.resolve();
							continue;
						}
						socket.write(encodeGatewayRuntimeFrame(createResponseForRequest(request)));
						continue;
					}
					if (request['method'] === 'notifications/cancelled') {
						cancellationObserved.resolve(request);
						socket.write(
							encodeGatewayRuntimeFrame({
								id: firstPortalRequestId,
								jsonrpc: '2.0',
								result: {
									items: [
										{
											error: { code: 'cancelled', message: 'Cancellation is pending.' },
											id: 'call-1',
											operationId: 'operation-1',
											outcome: {
												certainty: 'side-effects-and-termination-unknown',
												kind: 'ambiguous',
												retryClass: 'forbidden',
											},
											owningGeneration: 'tool-vm-generation-1',
											status: 'error',
										},
									],
									ok: false,
								},
							}),
						);
					}
				}
			});
		});
		server.listen(socketPath);
		await once(server, 'listening', { signal: AbortSignal.timeout(5_000) });
		const client = new GatewayRuntimeClient({
			attachment: {
				attachmentGeneration: 1,
				clientKind: 'openclaw-managed-plugin',
				configuredAgentIds: ['main'],
				frameworkEpoch: 'framework-epoch-1',
				gatewayEpoch: 'gateway-epoch-1',
				protocolVersion: 1,
				projectionCohortDigest:
					'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				runtimeEpoch: 'runtime-epoch-1',
				schemaVersion: 1,
			},
			socketPath,
		});
		const request = {
			calls: [
				{
					arguments: { text: 'hello' },
					id: 'call-1',
					name: 'echo',
					namespace: 'testing',
				},
			],
		};
		const requestOptions = {
			trustedContext: {
				principal: {
					agentId: 'main',
					frameworkIdentity: { agentId: 'main', kind: 'openclaw' as const },
					profileAssignmentRevision: 'profile-assignment:main:1',
					toolPortalProfileId: 'profile-main',
				},
			},
		};

		try {
			await client.connect();
			const cancellation = new AbortController();
			const firstCall = client.portal.call(request, {
				...requestOptions,
				signal: cancellation.signal,
			});
			await firstPortalRequestObserved.promise;

			// Act
			cancellation.abort(new Error('framework cancelled'));

			// Assert
			await expect(firstCall).rejects.toMatchObject({ code: 'request-aborted' });
			await expect(cancellationObserved.promise).resolves.toMatchObject({
				method: 'notifications/cancelled',
				params: { requestId: firstPortalRequestId },
			});
			await expect(client.portal.call(request, requestOptions)).resolves.toMatchObject({
				items: [{ status: 'ok' }],
				ok: true,
			});
		} finally {
			await client.disconnect();
			server.close();
			await once(server, 'close', { signal: AbortSignal.timeout(5_000) });
		}
	});
});
