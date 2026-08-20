import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
	CONTROL_QUEUE_LIMITS,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_SESSION_TIMING_MS,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	GatewayControlRpcMessageSchema,
	GatewayControlRpcCommandResultMessageSchema,
	deriveGatewayControlStablePrincipal,
	gatewayControlDeliveryPolicyByKind,
	gatewayControlDeliveryPolicyByOperation,
	type GatewayControlHello,
	type GatewayControlRpcMessage,
	type GatewayRuntimeApprovalChallengeIntent,
} from '@agent-vm/gateway-control-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import {
	GATEWAY_CONTROL_READY_PATH,
	GATEWAY_CONTROL_SOCKET_PATH,
	createGatewayControlService,
} from '@agent-vm/gateway-runtime';
import type { WorkerControlHello as ControlHello } from '@agent-vm/worker-control-contracts';
import { Server as SocketIoServer, type Socket as SocketIoServerSocket } from 'socket.io';
import { io as createSocketIoClient } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';

import {
	waitForProtocolRetryInterval,
	withProtocolDeadline,
} from '../../integration-tests/e2e-protocol-wait.js';
import { createControllerApprovalLedger } from '../approval/controller-approval-ledger.js';
import type { ControllerApprovalRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import {
	CONTROL_SESSION_EVENT_NAMES,
	type ControlSessionClient,
	clearControlSessionSendBuffer,
	computeControlSessionManualReconnectDelayMs,
	createControlSessionClient,
} from './control-session-client.js';
import {
	createControlSessionDispatcher,
	createControlSessionFenceRegistry,
	type ControlSessionDispatcher,
} from './control-session-dispatcher.js';
import { createGatewayControlCallerContextRegistry } from './gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	resolveGatewayControlInboundStablePrincipal,
} from './gateway-control-domain-handler.js';
import { createGatewayControlProcessAdmissionCoordinator } from './gateway-control-process-admission-coordinator.js';
import {
	buildGatewayControlEndpoint,
	connectGatewayControlSession,
	createGatewayControlSessionMaterial,
	fetchGatewayControlCredential,
} from './gateway-control-session.js';
import { createGatewayDisposableControlSessionClient } from './gateway-disposable-control-session-client.js';

const controlPath = '/__agent-vm/gateway-control';

function listen(server: HttpServer): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (typeof address === 'object' && address !== null) {
				resolve(address.port);
				return;
			}
			reject(new Error('HTTP server did not expose a TCP address.'));
		});
	});
}

async function closeSocketIoServer(server: SocketIoServer): Promise<void> {
	await server.close();
}

async function closeHttpServer(server: HttpServer): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function waitForProtocolEvent<TValue>(
	register: (resolve: (value: TValue) => void) => void,
): Promise<TValue> {
	return new Promise((resolve) => {
		register(resolve);
	});
}

function deferredProtocolWork(): { readonly promise: Promise<void>; resolve(): void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function waitForClientHelloCount(options: {
	readonly client: ControlSessionClient;
	readonly minimumHelloCount: number;
	readonly timeoutMs: number;
}): Promise<void> {
	const deadlineMs = Date.now() + options.timeoutMs;
	const waitUntilHelloCount = (): Promise<void> => {
		if (options.client.getDiagnostics().helloCount >= options.minimumHelloCount) {
			return Promise.resolve();
		}
		if (Date.now() >= deadlineMs) {
			return Promise.reject(
				new Error(
					`Timed out waiting for control-session hello count >= ${String(options.minimumHelloCount)}; diagnostics: ${JSON.stringify(options.client.getDiagnostics())}`,
				),
			);
		}
		return waitForProtocolRetryInterval(25).then(waitUntilHelloCount);
	};
	await waitUntilHelloCount();
}

async function waitForClientAcceptedSession(options: {
	readonly client: ControlSessionClient;
	readonly sessionId: string;
	readonly timeoutMs: number;
}): Promise<void> {
	const deadlineMs = Date.now() + options.timeoutMs;
	const waitUntilAcceptedSession = (): Promise<void> => {
		const diagnostics = options.client.getDiagnostics();
		if (diagnostics.ready && diagnostics.lastHelloResponse?.sessionId === options.sessionId) {
			return Promise.resolve();
		}
		if (Date.now() >= deadlineMs) {
			return Promise.reject(
				new Error(
					`Timed out waiting for accepted control-session ${options.sessionId}; diagnostics: ${JSON.stringify(diagnostics)}`,
				),
			);
		}
		return waitForProtocolRetryInterval(25).then(waitUntilAcceptedSession);
	};
	await waitUntilAcceptedSession();
}

const validEnvelope = {
	bootId: 'gateway-boot-a',
	commandId: '44444444-4444-4444-8444-444444444444',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	createdAtMs: 1,
	deliveryPolicy: 'single_use_critical',
	domain: 'gateway_control',
	idempotencyKey: 'command-key-a',
	kind: 'command',
	messageId: '22222222-2222-4222-8222-222222222222',
	operation: 'lease_create',
	peerId: 'gateway-zone-a',
	protocolVersion: CONTROL_PROTOCOL_VERSION,
	sequence: 1,
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
} satisfies ControlEnvelope;

const heartbeatEnvelope = {
	...validEnvelope,
	commandId: undefined,
	deliveryPolicy: 'critical_idempotent',
	idempotencyKey: undefined,
	kind: 'heartbeat',
	messageId: '66666666-6666-4666-8666-666666666666',
	operation: undefined,
	sequence: 2,
} satisfies ControlEnvelope;

const latestWinsEventEnvelope = {
	...validEnvelope,
	commandId: undefined,
	deliveryPolicy: 'latest_wins',
	idempotencyKey: undefined,
	kind: 'event',
	messageId: '77777777-7777-4777-8777-777777777777',
	operation: 'runtime_status',
	sequence: 3,
} satisfies ControlEnvelope;

function commandResultEnvelopeFor(requestEnvelope: ControlEnvelope, sequence = 1): ControlEnvelope {
	return {
		...requestEnvelope,
		createdAtMs: requestEnvelope.createdAtMs + 1,
		deliveryPolicy: 'critical_idempotent',
		kind: 'command_result',
		messageId: '99999999-9999-4999-8999-999999999999',
		sequence,
	};
}

function buildLeaseCreateOkCommandResultMessage(
	responseToMessageId: string,
): GatewayControlRpcMessage {
	return GatewayControlRpcMessageSchema.parse({
		kind: 'command_result',
		operation: 'lease_create',
		payload: {
			lease: {
				agentId: 'agent-a',
				idleTtlMs: 120_000,
				leafGeneration: 'leaf-generation-a',
				leaseId: 'lease-a',
				ssh: {
					host: 'tool-0.vm.host',
					identityPem: 'pem',
					knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
					port: 22,
					user: 'sandbox',
				},
				sshBindingId: 'ssh-binding-a',
				state: 'idle',
				tcpSlot: 0,
				transport: 'ssh-sandbox',
				workdir: '/work',
				zoneId: 'zone-a',
			},
			responseToMessageId,
			result: 'ok',
		},
	});
}

function buildOperationCancelOkCommandResultMessage(
	responseToMessageId: string,
): GatewayControlRpcMessage {
	return GatewayControlRpcMessageSchema.parse({
		kind: 'command_result',
		operation: 'operation_cancel',
		payload: {
			activeOperationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			responseToMessageId,
			result: 'ok',
		},
	});
}

describe('control session client', () => {
	it('connects to a Socket.IO server over websocket-only transport and sends hello before messages', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const observedHelloPayloads: ControlHello[] = [];
		const observedTransports: string[] = [];
		const observedMessages: unknown[] = [];

		socketServer.on('connection', (socket) => {
			observedTransports.push(socket.conn.transport.name);
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (payload: ControlHello, ack) => {
				observedHelloPayloads.push(payload);
				ack({
					connectionId: validEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(CONTROL_SESSION_EVENT_NAMES.message, (envelope: unknown, payload: unknown, ack) => {
				observedMessages.push({ envelope, payload });
				ack({ received: true });
				setImmediate(() => {
					const controlEnvelope = envelope as ControlEnvelope;
					socket.emit(
						CONTROL_SESSION_EVENT_NAMES.message,
						commandResultEnvelopeFor(controlEnvelope),
						buildLeaseCreateOkCommandResultMessage(controlEnvelope.messageId),
						() => undefined,
					);
				});
			});
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
		});

		try {
			await expect(client.ready).resolves.toMatchObject({
				controllerEpoch: 'epoch-a',
				outcome: 'accepted',
			});
			await expect(
				client.emitApplicationMessage(
					validEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-a' },
				),
			).resolves.toEqual(buildLeaseCreateOkCommandResultMessage(validEnvelope.messageId));

			expect(observedTransports).toEqual(['websocket']);
			expect(observedHelloPayloads).toEqual([
				{
					bootId: 'gateway-boot-a',
					controllerEpoch: 'epoch-a',
					domain: 'worker_control',
					peerId: 'gateway-zone-a',
					protocolVersion: CONTROL_PROTOCOL_VERSION,
				},
			]);
			expect(observedMessages).toHaveLength(1);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('dispatches a peer-originated gateway heartbeat through the accepted session fence', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'epoch-heartbeat',
			zoneId: 'zone-heartbeat',
		});
		const gatewayControlService = createGatewayControlService({
			identity: {
				bootId: material.bootId,
				controllerEpoch: material.controllerEpoch,
				generationId: material.generationId,
				peerId: material.peerId,
				processEpoch: material.processEpoch,
				zoneId: material.zoneId,
			},
			verifierPublicKeyPem: material.verifierPublicKeyPem,
		});
		const httpServer = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === GATEWAY_CONTROL_READY_PATH) {
				gatewayControlService.handleReadyRequest(req, res);
				return;
			}
			res.statusCode = 404;
			res.end('not found\n');
		});
		httpServer.on('upgrade', (req, socket, head) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === GATEWAY_CONTROL_SOCKET_PATH) {
				gatewayControlService.handleUpgrade(req, socket, head);
				return;
			}
			socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
			socket.destroy();
		});
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		const sessionFenceRegistry = createControlSessionFenceRegistry();
		const dispatcher = createControlSessionDispatcher({ sessionFenceRegistry });
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry({
					agentAuthorityKeys: material.agentAuthorityKeys,
					callerContextProofKey: material.callerContextProofKey,
				}),
				gateway: {
					bootId: material.bootId,
					controllerEpoch: material.controllerEpoch,
					gatewayEpochId: `gateway-epoch:${material.generationId}`,
					gatewayVmId: 'gateway-vm-health-event-test',
					generationId: material.generationId,
					zoneId: material.zoneId,
				},
				recordHealthEvent: (event) => {
					recordedHealthEvents.push(event);
				},
				session: {
					bootId: material.processEpoch,
					controllerEpoch: material.controllerEpoch,
					peerId: material.peerId,
					zoneId: material.zoneId,
				},
			}),
		);
		const port = await listen(httpServer);
		const client = await connectGatewayControlSession({
			dispatcher,
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port }),
			material,
			sessionFenceRegistry,
		});

		try {
			const observedAtMs = Date.now();
			await gatewayControlService.emitApplicationMessage({
				buildEnvelope: ({ acceptedSession, sequence }) => ({
					bootId: acceptedSession.bootId,
					connectionId: acceptedSession.connectionId,
					controllerEpoch: material.controllerEpoch,
					createdAtMs: observedAtMs,
					deliveryPolicy: gatewayControlDeliveryPolicyByKind.heartbeat,
					domain: 'gateway_control',
					kind: 'heartbeat',
					messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
					peerId: material.peerId,
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					sequence,
					sessionId: acceptedSession.sessionId,
					zoneId: material.zoneId,
				}),
				domainMessage: { kind: 'heartbeat' },
				payload: {
					kind: 'heartbeat',
					payload: {
						elapsedMs: 7,
						observedAtMs,
					},
				},
			});

			expect(recordedHealthEvents).toEqual([
				{
					domain: 'gateway_control',
					elapsedMs: 7,
					kind: 'gateway-control-session',
					observedAtMs,
					operation: 'control-session-heartbeat',
					peerId: material.peerId,
					result: 'ok',
					zoneId: material.zoneId,
				},
			]);
		} finally {
			client.close();
			await gatewayControlService.close();
			await closeHttpServer(httpServer);
		}
	});

	it('publishes an authority-fenced Tool VM binding from controller to Gateway', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'epoch-binding-publication',
			zoneId: 'zone-binding-publication',
		});
		const observedMessages: GatewayControlRpcMessage[] = [];
		const bindingObserved = deferredProtocolWork();
		const gatewayControlService = createGatewayControlService({
			applicationMessageHandler: {
				handle: async ({ envelope, payload }) => {
					const message = GatewayControlRpcMessageSchema.parse(payload);
					observedMessages.push(message);
					bindingObserved.resolve();
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'tool_vm_binding_publish',
						payload: {
							responseToMessageId: envelope.messageId,
							result: 'ok',
						},
					});
				},
				messageIdentity: ({ payload }) => {
					const message = GatewayControlRpcMessageSchema.parse(payload);
					return {
						kind: message.kind,
						...(message.operation === undefined ? {} : { operation: message.operation }),
					};
				},
			},
			identity: {
				bootId: material.bootId,
				controllerEpoch: material.controllerEpoch,
				generationId: material.generationId,
				peerId: material.peerId,
				processEpoch: material.processEpoch,
				zoneId: material.zoneId,
			},
			verifierPublicKeyPem: material.verifierPublicKeyPem,
		});
		const httpServer = createServer((request, response) => {
			if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname === GATEWAY_CONTROL_READY_PATH) {
				gatewayControlService.handleReadyRequest(request, response);
				return;
			}
			response.statusCode = 404;
			response.end('not found\n');
		});
		httpServer.on('upgrade', (request, socket, head) => {
			if (
				new URL(request.url ?? '/', 'http://127.0.0.1').pathname === GATEWAY_CONTROL_SOCKET_PATH
			) {
				gatewayControlService.handleUpgrade(request, socket, head);
				return;
			}
			socket.destroy();
		});
		const port = await listen(httpServer);
		const client = await connectGatewayControlSession({
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port }),
			material,
		});

		try {
			const diagnostics = client.getDiagnostics();
			const acceptedSession = diagnostics.lastHelloResponse;
			if (
				diagnostics.attachmentGeneration === undefined ||
				acceptedSession?.outcome !== 'accepted'
			) {
				throw new Error('Expected an accepted Gateway control attachment.');
			}
			const stablePrincipal = 'a'.repeat(64);
			const message = GatewayControlRpcMessageSchema.parse({
				kind: 'command',
				operation: 'tool_vm_binding_publish',
				payload: {
					authority: {
						attachmentGeneration: diagnostics.attachmentGeneration,
						connectionId: acceptedSession.connectionId,
						controllerEpoch: material.controllerEpoch,
						gatewayEpoch: `gateway-epoch:${material.generationId}`,
						processEpoch: material.processEpoch,
						sessionId: acceptedSession.sessionId,
						zoneId: material.zoneId,
					},
					binding: {
						agentId: 'agent-a',
						idleTtlMs: 60_000,
						leafGeneration: 'leaf-a',
						leaseId: 'lease-a',
						profileAssignmentRevision: 'assignment-a',
						ssh: {
							host: 'tool-0.vm.host',
							identityPem: 'private-key',
							knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
							port: 22,
							user: 'root',
						},
						sshBindingId: 'ssh-a',
						stablePrincipal,
						tcpSlot: 0,
						transport: 'ssh-sandbox',
						workdir: '/work',
						zoneId: material.zoneId,
					},
					kind: 'current',
					observedAtMs: 1_000,
				},
			});
			const envelope = {
				bootId: material.processEpoch,
				commandId: '44444444-4444-4444-8444-444444444444',
				connectionId: acceptedSession.connectionId,
				controllerEpoch: material.controllerEpoch,
				createdAtMs: 1_000,
				deliveryPolicy: gatewayControlDeliveryPolicyByOperation.tool_vm_binding_publish,
				domain: 'gateway_control',
				idempotencyKey: 'binding-publication-a',
				kind: 'command',
				messageId: '55555555-5555-4555-8555-555555555555',
				operation: 'tool_vm_binding_publish',
				peerId: material.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				sequence: 1,
				sessionId: acceptedSession.sessionId,
				zoneId: material.zoneId,
			} satisfies ControlEnvelope;

			await expect(
				client.emitApplicationMessage(
					envelope,
					{ kind: 'command', operation: 'tool_vm_binding_publish' },
					message,
				),
			).resolves.toMatchObject({
				kind: 'command_result',
				operation: 'tool_vm_binding_publish',
				payload: { result: 'ok' },
			});
			await withProtocolDeadline(bindingObserved.promise, 'controller binding publication');
			expect(observedMessages).toEqual([message]);
		} finally {
			client.close();
			await gatewayControlService.close();
			await closeHttpServer(httpServer);
		}
	});

	it('carries approval reservation, arm, and replay rejection across the gateway control wire', async () => {
		// Arrange
		const approvalNowMs = Date.parse('2026-07-13T12:00:00.000Z');
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'controller-epoch-approval-wire',
			zoneId: 'zone-approval-wire',
		});
		const gatewayEpochId = `gateway-epoch:${material.generationId}`;
		const approvalAuthorityContext = {
			controllerEpoch: material.controllerEpoch,
			frameworkEpoch: material.processEpoch,
			gatewayEpoch: gatewayEpochId,
			runtimeEpoch: material.generationId,
			zoneId: material.zoneId,
		} as const;
		const approvalIntent = {
			backendKind: 'mcp_provider',
			call: {
				arguments: { issueTitle: 'Require operator approval over the control wire' },
				id: 'github.create_issue',
				name: 'create_issue',
				namespace: 'github',
			},
			operationId: '11111111-1111-4111-8111-111111111111',
			semanticRevisions: {
				activeRevision: 'active-approval-wire',
				bindingRevision: 'binding-approval-wire',
				catalogRevision: 'catalog-approval-wire',
				profilePolicyRevision: 'profile-policy-approval-wire',
				providerRevision: 'provider-approval-wire',
				schemaRevision: 'schema-approval-wire',
			},
			surfaceClass: 'mcp',
			trustedContext: {
				correlation: {
					runId: 'run-approval-wire',
					sessionId: 'session-approval-wire',
					toolCallId: 'tool-call-approval-wire',
				},
				principal: {
					agentId: 'agent-approval-wire',
					frameworkIdentity: { agentId: 'agent-approval-wire', kind: 'openclaw' },
					profileAssignmentRevision: 'profile-assignment-approval-wire',
					toolPortalProfileId: 'profile-approval-wire',
				},
				requester: { authenticatedSubjectId: 'subject-approval-wire' },
			},
		} satisfies GatewayRuntimeApprovalChallengeIntent;
		const approvalAdmissionPrincipal = deriveGatewayControlStablePrincipal({
			principal: approvalIntent.trustedContext.principal,
		});
		const temporaryDirectoryPath = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-approval-control-wire-'),
		);
		const recordsTarget = {
			directoryPath: path.join(temporaryDirectoryPath, 'approval-records'),
			kind: 'controller-approval-records',
			zoneId: material.zoneId,
		} satisfies ControllerApprovalRecordsTarget;
		const approvalLedger = createControllerApprovalLedger({
			challengeTtlMs: 300_000,
			currentControllerEpoch: material.controllerEpoch,
			now: () => approvalNowMs,
			recordsTarget,
		});
		const callerContexts = createGatewayControlCallerContextRegistry({
			agentAuthorityKeys: material.agentAuthorityKeys,
			callerContextProofKey: material.callerContextProofKey,
		});
		const gatewayControlService = createGatewayControlService({
			identity: {
				bootId: material.bootId,
				controllerEpoch: material.controllerEpoch,
				generationId: material.generationId,
				peerId: material.peerId,
				processEpoch: material.processEpoch,
				zoneId: material.zoneId,
			},
			verifierPublicKeyPem: material.verifierPublicKeyPem,
		});
		const httpServer = createServer((request, response) => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === GATEWAY_CONTROL_READY_PATH) {
				gatewayControlService.handleReadyRequest(request, response);
				return;
			}
			response.statusCode = 404;
			response.end('not found\n');
		});
		httpServer.on('upgrade', (request, socket, head) => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === GATEWAY_CONTROL_SOCKET_PATH) {
				gatewayControlService.handleUpgrade(request, socket, head);
				return;
			}
			socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
			socket.destroy();
		});
		const sessionFenceRegistry = createControlSessionFenceRegistry();
		const dispatcher = createControlSessionDispatcher({ sessionFenceRegistry });
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				approvalLedger,
				callerContexts,
				gateway: {
					bootId: material.bootId,
					controllerEpoch: material.controllerEpoch,
					gatewayEpochId,
					gatewayVmId: 'gateway-vm-approval-wire',
					generationId: material.generationId,
					zoneId: material.zoneId,
				},
				session: {
					bootId: material.processEpoch,
					controllerEpoch: material.controllerEpoch,
					peerId: material.peerId,
					zoneId: material.zoneId,
				},
			}),
		);
		const port = await listen(httpServer);
		let client: Awaited<ReturnType<typeof connectGatewayControlSession>> | undefined;

		try {
			client = await connectGatewayControlSession({
				dispatcher,
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port }),
				material,
				resolveInboundStablePrincipal: ({ envelope, message }) =>
					resolveGatewayControlInboundStablePrincipal({
						callerContexts,
						envelope,
						message,
					}),
				sessionFenceRegistry,
			});
			type ApprovalCommand = Extract<
				GatewayControlRpcMessage,
				{
					readonly kind: 'command';
					readonly operation: 'tool_portal_admission_reserve' | 'tool_portal_dispatch_arm';
				}
			>;
			const emitApprovalCommand = async (options: {
				readonly message: ApprovalCommand;
				readonly messageId: string;
			}): Promise<Extract<GatewayControlRpcMessage, { readonly kind: 'command_result' }>> =>
				GatewayControlRpcCommandResultMessageSchema.parse(
					await withProtocolDeadline(
						gatewayControlService.emitApplicationMessage(
							{
								buildEnvelope: ({ acceptedSession, sequence }) => ({
									bootId: acceptedSession.bootId,
									connectionId: acceptedSession.connectionId,
									controllerEpoch: acceptedSession.controllerEpoch,
									createdAtMs: approvalNowMs,
									deliveryPolicy:
										gatewayControlDeliveryPolicyByOperation[options.message.operation],
									domain: 'gateway_control',
									expiresAtMs: approvalNowMs + 60_000,
									kind: 'command',
									messageId: options.messageId,
									operation: options.message.operation,
									peerId: acceptedSession.peerId,
									protocolVersion: CONTROL_PROTOCOL_VERSION,
									sequence,
									sessionId: acceptedSession.sessionId,
									zoneId: acceptedSession.zoneId,
								}),
								domainMessage: {
									kind: 'command',
									operation: options.message.operation,
								},
								payload: options.message,
							},
							{
								admissionPrincipal: approvalAdmissionPrincipal,
								commandResultTimeoutMs: 2_000,
							},
						),
						`approval control command ${options.message.operation}`,
					),
				);
			const reserveMessage = {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: approvalIntent },
			} satisfies ApprovalCommand;

			// Act
			const pendingResponse = await emitApprovalCommand({
				message: reserveMessage,
				messageId: '22222222-2222-4222-8222-222222222222',
			});
			if (pendingResponse.operation !== 'tool_portal_admission_reserve') {
				throw new Error('Expected an approval admission response over gateway control.');
			}
			const pendingAdmission = pendingResponse.payload.approvalAdmission;
			if (pendingAdmission?.kind !== 'approval-required') {
				throw new Error(
					`Expected a pending approval challenge over gateway control, received ${JSON.stringify(pendingResponse)}.`,
				);
			}
			const decision = await approvalLedger.decide({
				approvalId: pendingAdmission.challenge.approvalId,
				authorityContext: approvalAuthorityContext,
				decision: 'approve',
				operator: {
					approverId: 'operator-approval-wire',
					audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
					credentialId: 'credential-approval-wire',
					provenance: 'approval-access',
				},
			});
			const reservationResponse = await emitApprovalCommand({
				message: reserveMessage,
				messageId: '33333333-3333-4333-8333-333333333333',
			});
			if (reservationResponse.operation !== 'tool_portal_admission_reserve') {
				throw new Error('Expected an approval reservation response over gateway control.');
			}
			const reservationAdmission = reservationResponse.payload.approvalAdmission;
			if (
				reservationAdmission?.kind !== 'dispatch-reserved' ||
				reservationAdmission.reservation.backendKind === 'controller_execution'
			) {
				throw new Error('Expected an approved dispatch reservation over gateway control.');
			}
			const armMessage = {
				kind: 'command',
				operation: 'tool_portal_dispatch_arm',
				payload: { reservation: reservationAdmission.reservation },
			} satisfies ApprovalCommand;
			const armResponse = await emitApprovalCommand({
				message: armMessage,
				messageId: '44444444-4444-4444-8444-444444444444',
			});
			const replayResponse = await emitApprovalCommand({
				message: armMessage,
				messageId: '55555555-5555-4555-8555-555555555555',
			});

			// Assert
			expect(decision).toMatchObject({ decision: 'approve', kind: 'recorded' });
			expect(reservationAdmission.reservation).toMatchObject({
				authorityContext: approvalAuthorityContext,
				operationId: approvalIntent.operationId,
				stablePrincipal: approvalAdmissionPrincipal,
			});
			expect(armResponse).toMatchObject({
				kind: 'command_result',
				operation: 'tool_portal_dispatch_arm',
				payload: {
					approvalDispatch: {
						grant: {
							authorityContext: approvalAuthorityContext,
							operationId: approvalIntent.operationId,
							stablePrincipal: approvalAdmissionPrincipal,
						},
						kind: 'dispatch-armed',
					},
					responseToMessageId: '44444444-4444-4444-8444-444444444444',
					result: 'ok',
				},
			});
			expect(replayResponse).toMatchObject({
				kind: 'command_result',
				operation: 'tool_portal_dispatch_arm',
				payload: {
					approvalDispatch: {
						kind: 'ambiguous',
						operationId: approvalIntent.operationId,
						reason: 'dispatch-armed',
					},
					responseToMessageId: '55555555-5555-4555-8555-555555555555',
					result: 'ok',
				},
			});
		} finally {
			client?.close();
			await gatewayControlService.close();
			await closeHttpServer(httpServer);
			await rm(temporaryDirectoryPath, { force: true, recursive: true });
		}
	});

	it('dispatches heartbeat frames from the production gateway control publisher', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'epoch-publisher-heartbeat',
			zoneId: 'zone-publisher-heartbeat',
		});
		const gatewayControlService = createGatewayControlService({
			identity: {
				bootId: material.bootId,
				controllerEpoch: material.controllerEpoch,
				generationId: material.generationId,
				peerId: material.peerId,
				processEpoch: material.processEpoch,
				zoneId: material.zoneId,
			},
			verifierPublicKeyPem: material.verifierPublicKeyPem,
		});
		const httpServer = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === GATEWAY_CONTROL_READY_PATH) {
				gatewayControlService.handleReadyRequest(req, res);
				return;
			}
			res.statusCode = 404;
			res.end('not found\n');
		});
		httpServer.on('upgrade', (req, socket, head) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === GATEWAY_CONTROL_SOCKET_PATH) {
				gatewayControlService.handleUpgrade(req, socket, head);
				return;
			}
			socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
			socket.destroy();
		});
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		const sessionFenceRegistry = createControlSessionFenceRegistry();
		const dispatcher = createControlSessionDispatcher({ sessionFenceRegistry });
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry({
					agentAuthorityKeys: material.agentAuthorityKeys,
					callerContextProofKey: material.callerContextProofKey,
				}),
				gateway: {
					bootId: material.bootId,
					controllerEpoch: material.controllerEpoch,
					gatewayEpochId: `gateway-epoch:${material.generationId}`,
					gatewayVmId: 'gateway-vm-heartbeat-test',
					generationId: material.generationId,
					zoneId: material.zoneId,
				},
				recordHealthEvent: (event) => {
					recordedHealthEvents.push(event);
				},
				session: {
					bootId: material.bootId,
					controllerEpoch: material.controllerEpoch,
					peerId: material.peerId,
					zoneId: material.zoneId,
				},
			}),
		);
		const port = await listen(httpServer);
		const client = await connectGatewayControlSession({
			dispatcher,
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port }),
			material,
			sessionFenceRegistry,
		});

		try {
			await gatewayControlService.emitApplicationMessage({
				buildEnvelope: ({ acceptedSession, sequence }) => ({
					bootId: acceptedSession.bootId,
					connectionId: acceptedSession.connectionId,
					controllerEpoch: material.controllerEpoch,
					createdAtMs: 10_000,
					deliveryPolicy: gatewayControlDeliveryPolicyByKind.heartbeat,
					domain: 'gateway_control',
					kind: 'heartbeat',
					messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
					peerId: material.peerId,
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					sequence,
					sessionId: acceptedSession.sessionId,
					zoneId: material.zoneId,
				}),
				domainMessage: { kind: 'heartbeat' },
				payload: GatewayControlRpcMessageSchema.parse({
					kind: 'heartbeat',
					payload: { elapsedMs: 4, observedAtMs: 9_996 },
				}),
			});

			expect(recordedHealthEvents).toEqual([
				{
					domain: 'gateway_control',
					elapsedMs: 4,
					kind: 'gateway-control-session',
					observedAtMs: 9_996,
					operation: 'control-session-heartbeat',
					peerId: material.peerId,
					result: 'ok',
					zoneId: material.zoneId,
				},
			]);
		} finally {
			client.close();
			await gatewayControlService.close();
			await closeHttpServer(httpServer);
		}
	});

	it('preserves zone B safety and liveness under real two-zone control pressure', async () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator({
			maxNonSafetyMessages: 7,
		});
		const heldAuthority = deferredProtocolWork();
		const heldControlPings = [deferredProtocolWork(), deferredProtocolWork()] as const;
		const heldInboundHeartbeat = deferredProtocolWork();
		const heldRuntimeStatus = deferredProtocolWork();
		const inboundHeartbeatStarted = deferredProtocolWork();
		const runtimeStatusStarted = deferredProtocolWork();
		let inboundHeartbeatSequence: number | undefined;
		let runtimeStatusSequence: number | undefined;
		let authorityStarts = 0;
		let resolveAuthorityCapacity!: () => void;
		const authorityCapacity = new Promise<void>((resolve) => {
			resolveAuthorityCapacity = resolve;
		});
		let controlPingStarts = 0;
		const controlPingStarted = [deferredProtocolWork(), deferredProtocolWork()] as const;
		const materialA = createGatewayControlSessionMaterial({
			controllerEpoch: 'controller-pressure',
			zoneId: 'zone-a',
		});
		const materialB = createGatewayControlSessionMaterial({
			controllerEpoch: 'controller-pressure',
			zoneId: 'zone-b',
		});
		const responseFor = (options: {
			readonly envelope: ControlEnvelope;
			readonly operation: string;
		}): GatewayControlRpcMessage =>
			GatewayControlRpcMessageSchema.parse({
				kind: 'command_result',
				operation: options.operation,
				payload: {
					responseToMessageId: options.envelope.messageId,
					result: 'ok',
				},
			});
		const serviceA = createGatewayControlService({
			applicationMessageHandler: {
				handle: async ({ envelope, payload }) => {
					const message = GatewayControlRpcMessageSchema.parse(payload);
					if (message.kind === 'command' && message.operation === 'control_ping') {
						const controlPingIndex = controlPingStarts;
						controlPingStarts += 1;
						const started = controlPingStarted[controlPingIndex];
						const held = heldControlPings[controlPingIndex];
						if (started === undefined || held === undefined) {
							throw new Error('unexpected excess zone A control ping');
						}
						started.resolve();
						await held.promise;
						return responseFor({ envelope, operation: message.operation });
					}
					return undefined;
				},
				messageIdentity: ({ payload }) => {
					const message = GatewayControlRpcMessageSchema.parse(payload);
					return {
						kind: message.kind,
						...(message.operation === undefined ? {} : { operation: message.operation }),
					};
				},
			},
			identity: {
				bootId: materialA.bootId,
				controllerEpoch: materialA.controllerEpoch,
				generationId: materialA.generationId,
				peerId: materialA.peerId,
				processEpoch: materialA.processEpoch,
				zoneId: materialA.zoneId,
			},
			verifierPublicKeyPem: materialA.verifierPublicKeyPem,
		});
		const serviceB = createGatewayControlService({
			applicationMessageHandler: {
				handle: async ({ envelope, payload }) => {
					const message = GatewayControlRpcMessageSchema.parse(payload);
					return message.kind === 'command'
						? responseFor({ envelope, operation: message.operation })
						: undefined;
				},
				messageIdentity: ({ payload }) => {
					const message = GatewayControlRpcMessageSchema.parse(payload);
					return {
						kind: message.kind,
						...(message.operation === undefined ? {} : { operation: message.operation }),
					};
				},
			},
			identity: {
				bootId: materialB.bootId,
				controllerEpoch: materialB.controllerEpoch,
				generationId: materialB.generationId,
				peerId: materialB.peerId,
				processEpoch: materialB.processEpoch,
				zoneId: materialB.zoneId,
			},
			verifierPublicKeyPem: materialB.verifierPublicKeyPem,
		});
		const startServiceHost = async (
			service: typeof serviceA,
		): Promise<{ readonly httpServer: HttpServer; readonly port: number }> => {
			const httpServer = createServer((request, response) => {
				if (
					new URL(request.url ?? '/', 'http://127.0.0.1').pathname === GATEWAY_CONTROL_READY_PATH
				) {
					service.handleReadyRequest(request, response);
					return;
				}
				response.statusCode = 404;
				response.end('not found\n');
			});
			httpServer.on('upgrade', (request, socket, head) => {
				if (
					new URL(request.url ?? '/', 'http://127.0.0.1').pathname === GATEWAY_CONTROL_SOCKET_PATH
				) {
					service.handleUpgrade(request, socket, head);
					return;
				}
				socket.destroy();
			});
			return { httpServer, port: await listen(httpServer) };
		};
		const hostA = await startServiceHost(serviceA);
		const hostB = await startServiceHost(serviceB);
		const dispatcherA = {
			dispatch: async ({ envelope, payload }) => {
				const message = GatewayControlRpcMessageSchema.parse(payload);
				if (message.kind === 'heartbeat') {
					inboundHeartbeatSequence = envelope.sequence;
					inboundHeartbeatStarted.resolve();
					await heldInboundHeartbeat.promise;
					return undefined;
				}
				if (message.kind === 'event' && message.operation === 'runtime_status') {
					runtimeStatusSequence = envelope.sequence;
					runtimeStatusStarted.resolve();
					await heldRuntimeStatus.promise;
					return undefined;
				}
				if (message.kind === 'command' && message.operation === 'lease_get') {
					authorityStarts += 1;
					if (authorityStarts === 3) {
						resolveAuthorityCapacity();
					}
					await heldAuthority.promise;
					return GatewayControlRpcMessageSchema.parse({
						kind: 'command_result',
						operation: message.operation,
						payload: {
							error: { errorClass: 'test_complete', retryable: false },
							responseToMessageId: envelope.messageId,
							result: 'failed',
						},
					});
				}
				return undefined;
			},
			register: () => undefined,
			validate: () => undefined,
		} satisfies ControlSessionDispatcher;
		const dispatcherB = {
			dispatch: async () => undefined,
			register: () => undefined,
			validate: () => undefined,
		} satisfies ControlSessionDispatcher;
		const clientA = await connectGatewayControlSession({
			dispatcher: dispatcherA,
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: hostA.port }),
			material: materialA,
			processAdmissionCoordinator: coordinator,
			resolveInboundStablePrincipal: () => ({
				stablePrincipal: 'a'.repeat(64),
				status: 'accepted',
			}),
		});
		const clientB = await connectGatewayControlSession({
			dispatcher: dispatcherB,
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: hostB.port }),
			material: materialB,
			processAdmissionCoordinator: coordinator,
		});
		const leaseIntent = (index: number): Parameters<typeof serviceA.emitApplicationMessage>[0] => ({
			buildEnvelope: ({ acceptedSession, sequence }) => ({
				bootId: acceptedSession.bootId,
				connectionId: acceptedSession.connectionId,
				controllerEpoch: acceptedSession.controllerEpoch,
				createdAtMs: index + 1,
				deliveryPolicy: 'acked_idempotent' as const,
				domain: 'gateway_control' as const,
				kind: 'command' as const,
				messageId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
				operation: 'lease_get',
				peerId: acceptedSession.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				sequence,
				sessionId: acceptedSession.sessionId,
				zoneId: acceptedSession.zoneId,
			}),
			domainMessage: { kind: 'command' as const, operation: 'lease_get' },
			payload: GatewayControlRpcMessageSchema.parse({
				kind: 'command',
				operation: 'lease_get',
				payload: {
					callerContext: { callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
					leaseId: `lease-${String(index)}`,
				},
			}),
		});
		const authorityPromises = Array.from({ length: 3 }, (_, index) =>
			serviceA
				.emitApplicationMessage(leaseIntent(index), {
					admissionPrincipal: 'a'.repeat(64),
					commandResultTimeoutMs: 2_000,
				})
				.catch((error: unknown) => error),
		);
		const zoneAHeartbeat = serviceA
			.emitApplicationMessage({
				buildEnvelope: ({ acceptedSession, sequence }) => ({
					bootId: acceptedSession.bootId,
					connectionId: acceptedSession.connectionId,
					controllerEpoch: acceptedSession.controllerEpoch,
					createdAtMs: 10,
					deliveryPolicy: 'critical_idempotent',
					domain: 'gateway_control',
					kind: 'heartbeat',
					messageId: '11000000-0000-4000-8000-000000000001',
					peerId: acceptedSession.peerId,
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					sequence,
					sessionId: acceptedSession.sessionId,
					zoneId: acceptedSession.zoneId,
				}),
				domainMessage: { kind: 'heartbeat' },
				payload: GatewayControlRpcMessageSchema.parse({
					kind: 'heartbeat',
					payload: { observedAtMs: 10 },
				}),
			})
			.catch((error: unknown) => error);
		const zoneARuntimeStatus = serviceA
			.emitApplicationMessage({
				buildEnvelope: ({ acceptedSession, sequence }) => ({
					bootId: acceptedSession.bootId,
					connectionId: acceptedSession.connectionId,
					controllerEpoch: acceptedSession.controllerEpoch,
					createdAtMs: 11,
					deliveryPolicy: 'latest_wins',
					domain: 'gateway_control',
					kind: 'event',
					messageId: '11000000-0000-4000-8000-000000000002',
					operation: 'runtime_status',
					peerId: acceptedSession.peerId,
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					sequence,
					sessionId: acceptedSession.sessionId,
					zoneId: acceptedSession.zoneId,
				}),
				domainMessage: { kind: 'event', operation: 'runtime_status' },
				payload: GatewayControlRpcMessageSchema.parse({
					kind: 'event',
					operation: 'runtime_status',
					payload: {
						findings: [{ id: 'zone-a-pressure', ok: true }],
						observedAtMs: 11,
						statusKind: 'openclaw-runtime',
					},
				}),
			})
			.catch((error: unknown) => error);

		try {
			await withProtocolDeadline(authorityCapacity, 'zone A authority capacity');
			await withProtocolDeadline(inboundHeartbeatStarted.promise, 'zone A inbound heartbeat');
			await withProtocolDeadline(runtimeStatusStarted.promise, 'zone A runtime status');
			expect([inboundHeartbeatSequence, runtimeStatusSequence]).toEqual([4, 5]);
			const sessionA = clientA.getDiagnostics().lastHelloResponse;
			const initialDiagnosticsB = clientB.getDiagnostics();
			const sessionB = initialDiagnosticsB.lastHelloResponse;
			if (sessionA?.outcome !== 'accepted' || sessionB?.outcome !== 'accepted') {
				throw new Error('expected two accepted control sessions');
			}
			const initialSessionIdentityB = {
				attachmentGeneration: initialDiagnosticsB.attachmentGeneration,
				connectionId: sessionB.connectionId,
				helloCount: initialDiagnosticsB.helloCount,
				sessionId: sessionB.sessionId,
			};
			const pingEnvelope = (messageId: string): ControlEnvelope => ({
				bootId: materialA.processEpoch,
				connectionId: sessionA.connectionId,
				controllerEpoch: materialA.controllerEpoch,
				createdAtMs: 1,
				deliveryPolicy: 'acked_idempotent',
				domain: 'gateway_control',
				kind: 'command',
				messageId,
				operation: 'control_ping',
				peerId: materialA.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				sequence: 99,
				sessionId: sessionA.sessionId,
				zoneId: materialA.zoneId,
			});
			const startControlPing = (index: number): Promise<unknown> =>
				clientA
					.emitApplicationMessage(
						pingEnvelope(`20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`),
						{ kind: 'command', operation: 'control_ping' },
						{ kind: 'command', operation: 'control_ping', payload: {} },
						{ commandResultTimeoutMs: 2_000 },
					)
					.catch((error: unknown) => error);
			const firstControlPing = startControlPing(0);
			await withProtocolDeadline(controlPingStarted[0].promise, 'first zone A control ping');
			const secondControlPing = startControlPing(1);
			await withProtocolDeadline(controlPingStarted[1].promise, 'second zone A control ping');
			const controlPingPromises = [firstControlPing, secondControlPing];
			expect(coordinator.diagnostics()).toMatchObject({ nonSafetyMessages: 7 });

			const globalRefusal = GatewayControlRpcMessageSchema.parse(
				await withProtocolDeadline(
					serviceA.emitApplicationMessage(leaseIntent(3), {
						admissionPrincipal: 'a'.repeat(64),
						commandResultTimeoutMs: 2_000,
					}),
					'zone A shared-process global refusal',
				),
			);
			expect(globalRefusal).toMatchObject({
				kind: 'command_result',
				operation: 'lease_get',
				payload: {
					error: {
						errorClass: 'gateway_control_admission_refused',
						retryable: true,
					},
					responseToMessageId: '10000000-0000-4000-8000-000000000004',
					result: 'failed',
				},
			});
			expect(authorityStarts).toBe(3);

			heldControlPings[0].resolve();
			await withProtocolDeadline(
				controlPingPromises[0] ?? Promise.resolve(),
				'released zone A control ping',
			);
			expect(coordinator.diagnostics()).toMatchObject({ nonSafetyMessages: 6 });

			await withProtocolDeadline(
				serviceB.emitApplicationMessage({
					buildEnvelope: ({ acceptedSession, sequence }) => ({
						bootId: acceptedSession.bootId,
						connectionId: acceptedSession.connectionId,
						controllerEpoch: acceptedSession.controllerEpoch,
						createdAtMs: 1,
						deliveryPolicy: 'critical_idempotent',
						domain: 'gateway_control',
						kind: 'heartbeat',
						messageId: '30000000-0000-4000-8000-000000000001',
						peerId: acceptedSession.peerId,
						protocolVersion: CONTROL_PROTOCOL_VERSION,
						sequence,
						sessionId: acceptedSession.sessionId,
						zoneId: acceptedSession.zoneId,
					}),
					domainMessage: { kind: 'heartbeat' },
					payload: GatewayControlRpcMessageSchema.parse({
						kind: 'heartbeat',
						payload: { observedAtMs: 1 },
					}),
				}),
				'zone B liveness receipt',
			);
			await withProtocolDeadline(
				clientB.emitApplicationMessage(
					{
						bootId: materialB.processEpoch,
						connectionId: sessionB.connectionId,
						controllerEpoch: materialB.controllerEpoch,
						createdAtMs: 1,
						deliveryPolicy: 'critical_idempotent',
						domain: 'gateway_control',
						kind: 'command',
						messageId: '30000000-0000-4000-8000-000000000002',
						operation: 'recovery_command',
						peerId: materialB.peerId,
						protocolVersion: CONTROL_PROTOCOL_VERSION,
						sequence: 99,
						sessionId: sessionB.sessionId,
						zoneId: materialB.zoneId,
					},
					{ kind: 'command', operation: 'recovery_command' },
					{
						kind: 'command',
						operation: 'recovery_command',
						payload: { action: 'refresh_runtime_status' },
					},
					{ commandResultTimeoutMs: 2_000 },
				),
				'zone B safety result',
			);
			const diagnosticsBAfterPressure = clientB.getDiagnostics();
			expect(diagnosticsBAfterPressure).toMatchObject({ accepted: true, ready: true });
			expect({
				attachmentGeneration: diagnosticsBAfterPressure.attachmentGeneration,
				connectionId: diagnosticsBAfterPressure.lastHelloResponse?.connectionId,
				helloCount: diagnosticsBAfterPressure.helloCount,
				sessionId: diagnosticsBAfterPressure.lastHelloResponse?.sessionId,
			}).toEqual(initialSessionIdentityB);

			heldAuthority.resolve();
			heldInboundHeartbeat.resolve();
			heldRuntimeStatus.resolve();
			for (const heldControlPing of heldControlPings) {
				heldControlPing.resolve();
			}
			await withProtocolDeadline(
				Promise.allSettled([
					...authorityPromises,
					...controlPingPromises,
					zoneAHeartbeat,
					zoneARuntimeStatus,
				]),
				'zone A pressure settlement',
			);
		} finally {
			heldAuthority.resolve();
			heldInboundHeartbeat.resolve();
			heldRuntimeStatus.resolve();
			for (const heldControlPing of heldControlPings) {
				heldControlPing.resolve();
			}
			clientA.close();
			clientB.close();
			await serviceA.close();
			await serviceB.close();
			await closeHttpServer(hostA.httpServer);
			await closeHttpServer(hostB.httpServer);
		}
		expect(coordinator.diagnostics()).toEqual({
			activeSessions: 0,
			nonSafetyBytes: 0,
			nonSafetyMessages: 0,
		});
	});

	it('fences a disposable gateway attachment when a sequenced latest-wins frame is not receipted', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const messageObserved = waitForProtocolEvent<ControlEnvelope>((resolve) => {
			socketServer.on('connection', (socket) => {
				socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (hello: GatewayControlHello, acknowledge) => {
					acknowledge({
						attachmentGeneration: hello.attachmentGeneration,
						connectionId: '55555555-5555-4555-8555-555555555555',
						controllerEpoch: hello.controllerEpoch,
						outcome: 'accepted',
						sessionId: '33333333-3333-4333-8333-333333333333',
					});
				});
				socket.once(
					CONTROL_SESSION_EVENT_NAMES.message,
					(envelope: ControlEnvelope, _payload: unknown, _acknowledge) => {
						resolve(envelope);
					},
				);
			});
		});
		const firstAttachmentDisconnected = waitForProtocolEvent<void>((resolve) => {
			socketServer.on('connection', (socket) => {
				socket.once('disconnect', () => resolve());
			});
		});
		const port = await listen(httpServer);
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			commandAckTimeoutMs: 25,
			connectTimeoutMs: 100,
			endpoint: { host: '127.0.0.1', path: controlPath, port },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByKind: { heartbeat: 'latest_wins' },
			policyByOperation: {},
			refreshExtraHeaders: async () => ({}),
		});

		try {
			const hello = await client.ready;
			await client.emitApplicationMessage(
				{
					bootId: 'process-a',
					connectionId: hello.connectionId,
					controllerEpoch: 'controller-a',
					createdAtMs: 1,
					deliveryPolicy: 'latest_wins',
					domain: 'gateway_control',
					kind: 'heartbeat',
					messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
					peerId: 'gateway-zone-a',
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					sequence: 99,
					sessionId: hello.sessionId,
					zoneId: 'zone-a',
				},
				{ kind: 'heartbeat' },
				{ kind: 'heartbeat', payload: { observedAtMs: 1 } },
			);

			await expect(messageObserved).resolves.toMatchObject({
				messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				sequence: 1,
			});
			await firstAttachmentDisconnected;
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('fences a real Socket.IO hello with a foreign controller epoch before registration', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const foreignAttachmentDisconnected = waitForProtocolEvent<void>((resolve) => {
			socketServer.on('connection', (socket) => {
				socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (hello: GatewayControlHello, acknowledge) => {
					acknowledge({
						attachmentGeneration: hello.attachmentGeneration,
						connectionId: '55555555-5555-4555-8555-555555555555',
						controllerEpoch: 'controller-foreign',
						outcome: 'accepted',
						sessionId: '33333333-3333-4333-8333-333333333333',
					});
				});
				socket.once('disconnect', () => resolve());
			});
		});
		const port = await listen(httpServer);
		const registeredControllerEpochs: string[] = [];
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			connectTimeoutMs: 100,
			endpoint: { host: '127.0.0.1', path: controlPath, port },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			onHelloResponse: (response) => registeredControllerEpochs.push(response.controllerEpoch),
			policyByOperation: {},
			refreshExtraHeaders: async () => ({}),
		});

		try {
			await foreignAttachmentDisconnected;
			expect(registeredControllerEpochs).toEqual([]);
			expect(client.getDiagnostics()).toMatchObject({ accepted: false, ready: false });
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('fences a real Socket.IO frame without an acknowledgement callback before dispatch', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const attachmentDisconnected = waitForProtocolEvent<void>((resolve) => {
			socketServer.on('connection', (socket) => {
				socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (hello: GatewayControlHello, acknowledge) => {
					acknowledge({
						attachmentGeneration: hello.attachmentGeneration,
						connectionId: '55555555-5555-4555-8555-555555555555',
						controllerEpoch: hello.controllerEpoch,
						outcome: 'accepted',
						sessionId: '33333333-3333-4333-8333-333333333333',
					});
					setImmediate(() => {
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							{
								bootId: 'process-a',
								connectionId: '55555555-5555-4555-8555-555555555555',
								controllerEpoch: 'controller-a',
								createdAtMs: 1,
								deliveryPolicy: 'critical_idempotent',
								domain: 'gateway_control',
								kind: 'heartbeat',
								messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
								peerId: 'gateway-zone-a',
								protocolVersion: CONTROL_PROTOCOL_VERSION,
								sequence: 1,
								sessionId: '33333333-3333-4333-8333-333333333333',
								zoneId: 'zone-a',
							} satisfies ControlEnvelope,
							{ kind: 'heartbeat', payload: { observedAtMs: 1 } },
						);
					});
				});
				socket.once('disconnect', () => resolve());
			});
		});
		const port = await listen(httpServer);
		let dispatchCount = 0;
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			connectTimeoutMs: 100,
			dispatcher: {
				dispatch: async () => {
					dispatchCount += 1;
					return undefined;
				},
				register: () => undefined,
				validate: () => undefined,
			},
			endpoint: { host: '127.0.0.1', path: controlPath, port },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByKind: { heartbeat: 'critical_idempotent' },
			policyByOperation: {},
			refreshExtraHeaders: async () => ({}),
		});

		try {
			await attachmentDisconnected;
			expect(dispatchCount).toBe(0);
			expect(client.getDiagnostics()).toMatchObject({ accepted: false, ready: false });
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('treats Socket.IO message ack as receipt and waits for correlated command_result', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const commandResultMessage = buildLeaseCreateOkCommandResultMessage(validEnvelope.messageId);

		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: validEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: validEnvelope.sessionId,
				});
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: unknown, _payload: unknown, ack) => {
					ack({ received: true });
					setImmediate(() => {
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							commandResultEnvelopeFor(envelope as ControlEnvelope),
							commandResultMessage,
							() => undefined,
						);
					});
				},
			);
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 500,
			connectTimeoutMs: 500,
		});

		try {
			await client.ready;
			await expect(
				client.emitApplicationMessage(
					validEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-a' },
				),
			).resolves.toEqual(commandResultMessage);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('waits for semantic command_result beyond the transport ack timeout', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const commandResultMessage = buildLeaseCreateOkCommandResultMessage(validEnvelope.messageId);
		let releaseCommandResult: (() => void) | undefined;
		const commandResultRelease = new Promise<void>((resolve) => {
			releaseCommandResult = resolve;
		});
		let observeTransportReceipt: (() => void) | undefined;
		const transportReceiptObserved = new Promise<void>((resolve) => {
			observeTransportReceipt = resolve;
		});

		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: validEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: validEnvelope.sessionId,
				});
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: unknown, _payload: unknown, ack) => {
					ack({ received: true });
					observeTransportReceipt?.();
					void commandResultRelease.then(() => {
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							commandResultEnvelopeFor(envelope as ControlEnvelope),
							commandResultMessage,
							() => undefined,
						);
					});
				},
			);
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 50,
			connectTimeoutMs: 50,
		});

		try {
			await client.ready;
			let commandResolvedBeforeRelease = false;
			const commandResultPromise = client
				.emitApplicationMessage(
					validEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-a' },
					{ commandResultTimeoutMs: 500 },
				)
				.then((result) => {
					commandResolvedBeforeRelease = true;
					return result;
				});
			await transportReceiptObserved;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(commandResolvedBeforeRelease).toBe(false);
			if (releaseCommandResult === undefined) {
				throw new Error('Expected command result release hook to be registered.');
			}
			releaseCommandResult();
			await expect(commandResultPromise).resolves.toEqual(commandResultMessage);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('uses separate connect and command acknowledgement timeout budgets', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		let observedMessageCount = 0;
		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: validEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: validEnvelope.sessionId,
				});
			});
			socket.on(CONTROL_SESSION_EVENT_NAMES.message, () => {
				observedMessageCount += 1;
			});
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			commandAckTimeoutMs: 20,
			connectTimeoutMs: 500,
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
		});

		try {
			await expect(client.ready).resolves.toMatchObject({
				outcome: 'accepted',
			});
			await expect(
				client.emitApplicationMessage(
					validEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-a' },
				),
			).rejects.toThrow(/operation has timed out/u);
			expect(observedMessageCount).toBe(1);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('does not resolve pending commands from stale-session command_result frames', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const commandResultMessage = buildLeaseCreateOkCommandResultMessage(validEnvelope.messageId);

		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: validEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: validEnvelope.sessionId,
				});
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: unknown, _payload: unknown, ack) => {
					ack({ received: true });
					setImmediate(() => {
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							{
								...(envelope as ControlEnvelope),
								sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
							},
							commandResultMessage,
							() => undefined,
						);
					});
				},
			);
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 50,
			connectTimeoutMs: 50,
		});

		try {
			await client.ready;
			await expect(
				client.emitApplicationMessage(
					validEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-a' },
					{ commandResultTimeoutMs: 50 },
				),
			).rejects.toThrow(/control command result timed out/u);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('rejects oversized control payloads before they enter the Socket.IO control channel', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const observedMessages: unknown[] = [];
		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(CONTROL_SESSION_EVENT_NAMES.message, (envelope: unknown, payload: unknown, ack) => {
				observedMessages.push({ envelope, payload });
				ack({ received: true });
				setImmediate(() => {
					const controlEnvelope = envelope as ControlEnvelope;
					socket.emit(
						CONTROL_SESSION_EVENT_NAMES.message,
						commandResultEnvelopeFor(controlEnvelope),
						buildLeaseCreateOkCommandResultMessage(controlEnvelope.messageId),
						() => undefined,
					);
				});
			});
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
		});

		try {
			await client.ready;
			await expect(
				client.emitApplicationMessage(
					validEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ bulkLikeLogChunk: 'x'.repeat(CONTROL_QUEUE_LIMITS.maxHttpBufferBytes) },
				),
			).rejects.toThrow(/control message exceeds/u);
			expect(observedMessages).toEqual([]);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('rejects forbidden bulk envelopes before they enter the Socket.IO control channel', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const observedMessages: unknown[] = [];
		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(CONTROL_SESSION_EVENT_NAMES.message, (envelope: unknown, payload: unknown, ack) => {
				observedMessages.push({ envelope, payload });
				ack({ received: true });
				setImmediate(() => {
					const controlEnvelope = envelope as ControlEnvelope;
					socket.emit(
						CONTROL_SESSION_EVENT_NAMES.message,
						commandResultEnvelopeFor(controlEnvelope),
						buildLeaseCreateOkCommandResultMessage(controlEnvelope.messageId),
						() => undefined,
					);
				});
			});
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
		});

		try {
			await client.ready;
			await expect(
				client.emitApplicationMessage(
					{
						...validEnvelope,
						deliveryPolicy: 'forbidden_bulk',
						messageId: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
					},
					{ kind: 'command', operation: 'lease_create' },
					{ bulkLikeLogChunk: 'bulk must not cross control' },
				),
			).rejects.toThrow(/forbidden bulk message/u);
			expect(observedMessages).toEqual([]);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('fetches a gateway readiness credential, signs the upgrade headers, and connects through the plugin service', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'controller-epoch-a',
			zoneId: 'zone-a',
		});
		const service = createGatewayControlService({
			identity: {
				bootId: material.bootId,
				controllerEpoch: material.controllerEpoch,
				generationId: material.generationId,
				peerId: material.peerId,
				processEpoch: material.processEpoch,
				zoneId: material.zoneId,
			},
			verifierPublicKeyPem: material.verifierPublicKeyPem,
		});
		const httpServer = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://openclaw.local');
			if (url.pathname === GATEWAY_CONTROL_READY_PATH) {
				service.handleReadyRequest(req, res);
				return;
			}
			res.statusCode = 404;
			res.end('not found\n');
		});
		httpServer.on('upgrade', (req, socket, head) => {
			const url = new URL(req.url ?? '/', 'http://openclaw.local');
			if (url.pathname === GATEWAY_CONTROL_SOCKET_PATH) {
				service.handleUpgrade(req, socket, head);
				return;
			}
			socket.destroy();
		});
		const port = await listen(httpServer);

		const client = await connectGatewayControlSession({
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port }),
			material,
		});

		try {
			await expect(client.ready).resolves.toMatchObject({
				controllerEpoch: 'controller-epoch-a',
				outcome: 'accepted',
			});
		} finally {
			client.close();
			await service.close();
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
	});

	it('includes safe gateway readiness rejection details in startup errors', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'controller-epoch-a',
			zoneId: 'zone-a',
		});
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			return new Response('unauthorized: signature_mismatch\n', {
				status: 401,
				statusText: 'Unauthorized',
			});
		});

		await expect(
			fetchGatewayControlCredential({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
			}),
		).rejects.toThrow(
			'Gateway control readiness failed with HTTP 401 Unauthorized: unauthorized: signature_mismatch',
		);
	});

	it('dispatches peer-originated gateway control messages through the controller dispatcher', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const dispatcher = createControlSessionDispatcher();
		const dispatchedPayloads: unknown[] = [];
		const observedCommandResults: unknown[] = [];
		let resolveCommandResultObserved: (() => void) | undefined;
		const commandResultObserved = new Promise<void>((resolve) => {
			resolveCommandResultObserved = resolve;
		});
		const peerEnvelope = {
			...validEnvelope,
			deliveryPolicy: 'critical_idempotent',
			messageId: 'abababab-abab-4bab-8bab-abababababab',
			sequence: 1,
		} satisfies ControlEnvelope;
		const peerMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
				correlation: {
					traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				},
			},
		});
		let emitPeerMessage:
			| ((envelope: ControlEnvelope, payload: unknown) => Promise<unknown>)
			| undefined;

		dispatcher.register('gateway_control', {
			policyByOperation: gatewayControlDeliveryPolicyByOperation,
			messageIdentity: ({ payload }) => {
				const parsedMessage = GatewayControlRpcMessageSchema.parse(payload);
				return {
					kind: parsedMessage.kind,
					...(parsedMessage.operation === undefined ? {} : { operation: parsedMessage.operation }),
				};
			},
			handle: async ({ payload }) => {
				dispatchedPayloads.push(payload);
				return buildLeaseCreateOkCommandResultMessage(peerEnvelope.messageId);
			},
		});

		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: validEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: validEnvelope.sessionId,
				});
			});
			emitPeerMessage = async (envelope, payload) => {
				const receipt: unknown = await socket
					.timeout(500)
					.emitWithAck(CONTROL_SESSION_EVENT_NAMES.message, envelope, payload);
				return receipt;
			};
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: unknown, payload: unknown, acknowledge: (response: unknown) => void) => {
					const controlEnvelope = envelope as ControlEnvelope;
					if (controlEnvelope.kind === 'command_result') {
						observedCommandResults.push(payload);
						resolveCommandResultObserved?.();
					}
					acknowledge({ received: true });
				},
			);
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			dispatcher,
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: gatewayControlDeliveryPolicyByOperation,
			commandAckTimeoutMs: 500,
			connectTimeoutMs: 500,
		});

		try {
			await client.ready;
			if (emitPeerMessage === undefined) {
				throw new Error('peer socket was not connected');
			}
			await expect(emitPeerMessage(peerEnvelope, peerMessage)).resolves.toEqual({
				received: true,
			});
			await commandResultObserved;
			expect(observedCommandResults).toEqual([
				buildLeaseCreateOkCommandResultMessage(peerEnvelope.messageId),
			]);
			expect(dispatchedPayloads).toEqual([peerMessage]);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('drops delayed peer-originated responses after reconnect accepts a fresh session', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const dispatcher = createControlSessionDispatcher();
		const observedHelloPayloads: ControlHello[] = [];
		const observedCommandResults: unknown[] = [];
		const firstPeerEnvelope = {
			...validEnvelope,
			connectionId: '55555555-5555-4555-8555-555555555555',
			deliveryPolicy: 'critical_idempotent',
			messageId: 'abababab-abab-4bab-8bab-abababababab',
			sequence: 1,
			sessionId: '33333333-3333-4333-8333-333333333333',
		} satisfies ControlEnvelope;
		const secondPeerEnvelope = {
			...validEnvelope,
			commandId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
			connectionId: '66666666-5555-4555-8555-555555555555',
			deliveryPolicy: 'critical_idempotent',
			idempotencyKey: 'command-key-b',
			messageId: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
			sequence: 2,
			sessionId: '77777777-7777-4777-8777-777777777777',
		} satisfies ControlEnvelope;
		const peerMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		});
		let releaseFirstDispatch: (() => void) | undefined;
		const firstDispatchMayComplete = new Promise<void>((resolve) => {
			releaseFirstDispatch = resolve;
		});
		let currentServerSocket: SocketIoServerSocket | undefined;
		let clientSocket: ReturnType<typeof createSocketIoClient> | undefined;
		let resolveSecondHello: (() => void) | undefined;
		let resolveSecondCommandResult: (() => void) | undefined;
		const secondHelloObserved = waitForProtocolEvent<void>((resolve) => {
			resolveSecondHello = resolve;
		});
		const secondCommandResultObserved = waitForProtocolEvent<void>((resolve) => {
			resolveSecondCommandResult = resolve;
		});

		dispatcher.register('gateway_control', {
			policyByOperation: gatewayControlDeliveryPolicyByOperation,
			messageIdentity: ({ payload }) => {
				const parsedMessage = GatewayControlRpcMessageSchema.parse(payload);
				return {
					kind: parsedMessage.kind,
					...(parsedMessage.operation === undefined ? {} : { operation: parsedMessage.operation }),
				};
			},
			handle: async ({ envelope }) => {
				if (envelope.messageId === firstPeerEnvelope.messageId) {
					await firstDispatchMayComplete;
				}
				return buildLeaseCreateOkCommandResultMessage(envelope.messageId);
			},
		});

		socketServer.on('connection', (socket) => {
			currentServerSocket = socket;
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (payload: ControlHello, ack) => {
				observedHelloPayloads.push(payload);
				ack({
					connectionId:
						observedHelloPayloads.length === 1
							? firstPeerEnvelope.connectionId
							: secondPeerEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId:
						observedHelloPayloads.length === 1
							? firstPeerEnvelope.sessionId
							: secondPeerEnvelope.sessionId,
				});
				if (observedHelloPayloads.length === 2) {
					resolveSecondHello?.();
				}
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(_envelope: unknown, payload: unknown, acknowledge: (response: unknown) => void) => {
					observedCommandResults.push(payload);
					resolveSecondCommandResult?.();
					acknowledge({ received: true });
				},
			);
		});

		const emitPeerMessage = async (
			envelope: ControlEnvelope,
			payload: GatewayControlRpcMessage,
		): Promise<unknown> => {
			if (currentServerSocket === undefined) {
				throw new Error('peer socket was not connected');
			}
			const receiptPayload: unknown = await currentServerSocket
				.timeout(500)
				.emitWithAck(CONTROL_SESSION_EVENT_NAMES.message, envelope, payload);
			return receiptPayload;
		};

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			createSocket: (socketOptions) => {
				const socket = createSocketIoClient(
					`http://${socketOptions.endpoint.host}:${String(socketOptions.endpoint.port)}`,
					{
						addTrailingSlash: false,
						path: socketOptions.endpoint.path,
						reconnectionDelay: 10,
						reconnectionDelayMax: 10,
						timeout: socketOptions.timeoutMs,
						transports: ['websocket'],
					},
				);
				clientSocket = socket;
				return socket;
			},
			dispatcher,
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: gatewayControlDeliveryPolicyByOperation,
			commandAckTimeoutMs: 500,
			connectTimeoutMs: 500,
		});

		try {
			await client.ready;
			await expect(emitPeerMessage(firstPeerEnvelope, peerMessage)).resolves.toEqual({
				received: true,
			});
			clientSocket?.io.engine?.close();
			await expect(secondHelloObserved).resolves.toBeUndefined();
			await waitForClientAcceptedSession({
				client,
				sessionId: secondPeerEnvelope.sessionId,
				timeoutMs: 1_000,
			});

			releaseFirstDispatch?.();
			await waitForProtocolRetryInterval(75);
			expect(observedCommandResults).toEqual([]);

			await expect(emitPeerMessage(secondPeerEnvelope, peerMessage)).resolves.toEqual({
				received: true,
			});
			await secondCommandResultObserved;
			expect(observedCommandResults).toEqual([
				buildLeaseCreateOkCommandResultMessage(secondPeerEnvelope.messageId),
			]);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('rejects controller-side processing failures without labeling them as schema failures', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const peerEnvelope = {
			...validEnvelope,
			deliveryPolicy: 'critical_idempotent',
			messageId: 'abababab-abab-4bab-8bab-abababababab',
			sequence: 1,
		} satisfies ControlEnvelope;
		const peerMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		});
		let emitPeerMessage:
			| ((envelope: ControlEnvelope, payload: unknown) => Promise<unknown>)
			| undefined;

		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: validEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: validEnvelope.sessionId,
				});
			});
			emitPeerMessage = async (envelope, payload) => {
				const receiptPayload: unknown = await socket
					.timeout(500)
					.emitWithAck(CONTROL_SESSION_EVENT_NAMES.message, envelope, payload);
				return receiptPayload;
			};
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: gatewayControlDeliveryPolicyByOperation,
			commandAckTimeoutMs: 500,
			connectTimeoutMs: 500,
		});

		try {
			await client.ready;
			if (emitPeerMessage === undefined) {
				throw new Error('peer socket was not connected');
			}
			await expect(emitPeerMessage(peerEnvelope, peerMessage)).resolves.toEqual({
				errorClass: 'control_message_processing_failed',
				received: false,
				safeMessage: 'control message was rejected',
			});
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('returns a failed command_result when controller dispatch throws after accepting a peer command', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const dispatcher = createControlSessionDispatcher();
		const observedCommandResults: unknown[] = [];
		let resolveCommandResultObserved: (() => void) | undefined;
		const commandResultObserved = new Promise<void>((resolve) => {
			resolveCommandResultObserved = resolve;
		});
		const peerEnvelope = {
			...validEnvelope,
			deliveryPolicy: 'critical_idempotent',
			messageId: 'abababab-abab-4bab-8bab-abababababab',
			sequence: 1,
		} satisfies ControlEnvelope;
		const peerMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		});
		let emitPeerMessage:
			| ((envelope: ControlEnvelope, payload: unknown) => Promise<unknown>)
			| undefined;

		dispatcher.register('gateway_control', {
			policyByOperation: gatewayControlDeliveryPolicyByOperation,
			messageIdentity: ({ payload }) => {
				const parsedMessage = GatewayControlRpcMessageSchema.parse(payload);
				return {
					kind: parsedMessage.kind,
					...(parsedMessage.operation === undefined ? {} : { operation: parsedMessage.operation }),
				};
			},
			buildHandlerFailureResult: ({ envelope, payload }) => {
				const parsedMessage = GatewayControlRpcMessageSchema.parse(payload);
				return {
					kind: 'command_result',
					operation: parsedMessage.operation,
					payload: {
						error: {
							errorClass: 'test_handler_failed',
							retryable: true,
							safeMessage: 'test handler failed',
						},
						responseToMessageId: envelope.messageId,
						result: 'failed',
					},
				};
			},
			handle: async () => {
				throw new Error('boom after ack');
			},
		});

		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: validEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: validEnvelope.sessionId,
				});
			});
			emitPeerMessage = async (envelope, payload) => {
				const receiptPayload: unknown = await socket
					.timeout(500)
					.emitWithAck(CONTROL_SESSION_EVENT_NAMES.message, envelope, payload);
				return receiptPayload;
			};
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: unknown, payload: unknown, acknowledge: (response: unknown) => void) => {
					const controlEnvelope = envelope as ControlEnvelope;
					if (controlEnvelope.kind === 'command_result') {
						observedCommandResults.push(payload);
						resolveCommandResultObserved?.();
					}
					acknowledge({ received: true });
				},
			);
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			dispatcher,
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: gatewayControlDeliveryPolicyByOperation,
			commandAckTimeoutMs: 500,
			connectTimeoutMs: 500,
		});

		try {
			await client.ready;
			if (emitPeerMessage === undefined) {
				throw new Error('peer socket was not connected');
			}
			await expect(emitPeerMessage(peerEnvelope, peerMessage)).resolves.toEqual({
				received: true,
			});
			await commandResultObserved;
			expect(observedCommandResults).toEqual([
				{
					kind: 'command_result',
					operation: 'lease_create',
					payload: {
						error: {
							errorClass: 'test_handler_failed',
							retryable: true,
							safeMessage: 'test handler failed',
						},
						responseToMessageId: peerEnvelope.messageId,
						result: 'failed',
					},
				},
			]);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('closes instead of dispatching peer-originated critical messages after a sequence gap', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const dispatcher = createControlSessionDispatcher();
		const dispatchedPayloads: unknown[] = [];
		const peerEnvelope = {
			...validEnvelope,
			deliveryPolicy: 'critical_idempotent',
			messageId: 'abababab-abab-4bab-8bab-abababababab',
			sequence: 2,
		} satisfies ControlEnvelope;
		const peerMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		});
		let emitPeerMessage:
			| ((envelope: ControlEnvelope, payload: unknown) => Promise<unknown>)
			| undefined;

		dispatcher.register('gateway_control', {
			policyByOperation: gatewayControlDeliveryPolicyByOperation,
			messageIdentity: ({ payload }) => {
				const parsedMessage = GatewayControlRpcMessageSchema.parse(payload);
				return {
					kind: parsedMessage.kind,
					...(parsedMessage.operation === undefined ? {} : { operation: parsedMessage.operation }),
				};
			},
			handle: async ({ payload }) => {
				dispatchedPayloads.push(payload);
				return undefined;
			},
		});

		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: validEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: validEnvelope.sessionId,
				});
			});
			emitPeerMessage = async (envelope, payload) => {
				const receipt: unknown = await socket
					.timeout(100)
					.emitWithAck(CONTROL_SESSION_EVENT_NAMES.message, envelope, payload);
				return receipt;
			};
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			dispatcher,
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: gatewayControlDeliveryPolicyByOperation,
			commandAckTimeoutMs: 100,
			connectTimeoutMs: 100,
		});

		try {
			await client.ready;
			if (emitPeerMessage === undefined) {
				throw new Error('peer socket was not connected');
			}
			await expect(emitPeerMessage(peerEnvelope, peerMessage)).rejects.toThrow();
			expect(dispatchedPayloads).toEqual([]);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('refreshes the gateway readiness credential before reconnecting after plugin restart', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'controller-epoch-a',
			zoneId: 'zone-a',
		});
		const createService = (): ReturnType<typeof createGatewayControlService> =>
			createGatewayControlService({
				identity: {
					bootId: material.bootId,
					controllerEpoch: material.controllerEpoch,
					generationId: material.generationId,
					peerId: material.peerId,
					processEpoch: material.processEpoch,
					zoneId: material.zoneId,
				},
				verifierPublicKeyPem: material.verifierPublicKeyPem,
			});
		let service = createService();
		const httpServer = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://openclaw.local');
			if (url.pathname === GATEWAY_CONTROL_READY_PATH) {
				service.handleReadyRequest(req, res);
				return;
			}
			res.statusCode = 404;
			res.end('not found\n');
		});
		httpServer.on('upgrade', (req, socket, head) => {
			const url = new URL(req.url ?? '/', 'http://openclaw.local');
			if (url.pathname === GATEWAY_CONTROL_SOCKET_PATH) {
				service.handleUpgrade(req, socket, head);
				return;
			}
			socket.destroy();
		});
		const port = await listen(httpServer);

		const client = await connectGatewayControlSession({
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port }),
			material,
		});

		try {
			const firstAttachmentGeneration = client.getDiagnostics().attachmentGeneration;
			expect(firstAttachmentGeneration).toBeTypeOf('number');
			expect(client.getDiagnostics().helloCount).toBe(1);
			await service.close();
			service = createService();

			await waitForClientHelloCount({
				client,
				minimumHelloCount: 2,
				timeoutMs: 2_000,
			});
			expect(client.getDiagnostics()).toMatchObject({ accepted: true, ready: true });
			expect(client.getDiagnostics().attachmentGeneration).toBeGreaterThan(
				firstAttachmentGeneration ?? 0,
			);
			await expect(service.waitForAcceptedSession()).resolves.toMatchObject({
				attachmentGeneration: client.getDiagnostics().attachmentGeneration,
			});
		} finally {
			client.close();
			await service.close();
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
	});

	it('clears the real socket.io-client send buffer so stale application emits cannot flush', () => {
		const socket = createSocketIoClient('http://127.0.0.1:1', {
			autoConnect: false,
			path: controlPath,
			transports: ['websocket'],
		});
		try {
			socket.emit(CONTROL_SESSION_EVENT_NAMES.message, validEnvelope, { stale: true });
			expect(socket.sendBuffer).toHaveLength(1);

			clearControlSessionSendBuffer(socket);

			expect(socket.sendBuffer).toHaveLength(0);
		} finally {
			socket.close();
		}
	});

	it('computes bounded jittered delays for manual reconnect attempts', () => {
		expect(
			computeControlSessionManualReconnectDelayMs({
				attempt: 0,
				random: () => 0.5,
			}),
		).toBe(CONTROL_SESSION_TIMING_MS.manualReconnectInitialDelay);
		expect(
			computeControlSessionManualReconnectDelayMs({
				attempt: 1,
				random: () => 0.5,
			}),
		).toBe(CONTROL_SESSION_TIMING_MS.manualReconnectInitialDelay * 2);
		expect(
			computeControlSessionManualReconnectDelayMs({
				attempt: 99,
				random: () => 0.5,
			}),
		).toBe(CONTROL_SESSION_TIMING_MS.manualReconnectMaxDelay);
		expect(
			computeControlSessionManualReconnectDelayMs({
				attempt: 0,
				random: () => 0,
			}),
		).toBeLessThan(CONTROL_SESSION_TIMING_MS.manualReconnectInitialDelay);
		expect(
			computeControlSessionManualReconnectDelayMs({
				attempt: 0,
				random: () => 1,
			}),
		).toBeGreaterThan(CONTROL_SESSION_TIMING_MS.manualReconnectInitialDelay);
		expect(
			computeControlSessionManualReconnectDelayMs({
				attempt: 99,
				random: () => 1,
			}),
		).toBeLessThanOrEqual(CONTROL_SESSION_TIMING_MS.manualReconnectMaxDelay);
	});

	it('sends hello again before application messages after reconnect', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const observedHelloPayloads: ControlHello[] = [];
		const observedMessages: unknown[] = [];
		let clientSocket: ReturnType<typeof createSocketIoClient> | undefined;
		let resolveSecondHello: (() => void) | undefined;
		const secondHelloObserved = waitForProtocolEvent<void>((resolve) => {
			resolveSecondHello = resolve;
		});

		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (payload: ControlHello, ack) => {
				observedHelloPayloads.push(payload);
				ack({
					connectionId:
						observedHelloPayloads.length === 1
							? '55555555-5555-4555-8555-555555555555'
							: '66666666-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
				if (observedHelloPayloads.length === 2) {
					resolveSecondHello?.();
				}
			});
			socket.on(CONTROL_SESSION_EVENT_NAMES.message, (envelope: unknown, payload: unknown, ack) => {
				observedMessages.push({ envelope, payload });
				ack({ received: true });
				setImmediate(() => {
					const controlEnvelope = envelope as ControlEnvelope;
					socket.emit(
						CONTROL_SESSION_EVENT_NAMES.message,
						commandResultEnvelopeFor(controlEnvelope),
						buildLeaseCreateOkCommandResultMessage(controlEnvelope.messageId),
						() => undefined,
					);
				});
			});
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			createSocket: (socketOptions) => {
				const socket = createSocketIoClient(
					`http://${socketOptions.endpoint.host}:${String(socketOptions.endpoint.port)}`,
					{
						addTrailingSlash: false,
						path: socketOptions.endpoint.path,
						reconnectionDelay: 10,
						reconnectionDelayMax: 10,
						timeout: socketOptions.timeoutMs,
						transports: ['websocket'],
					},
				);
				clientSocket = socket;
				return socket;
			},
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 500,
			connectTimeoutMs: 500,
		});

		try {
			await client.ready;
			clientSocket?.io.engine?.close();
			await expect(secondHelloObserved).resolves.toBeUndefined();
			await expect(
				client.emitApplicationMessage(
					{
						...validEnvelope,
						connectionId: '66666666-5555-4555-8555-555555555555',
						messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
						sequence: 1,
					},
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-after-reconnect' },
				),
			).resolves.toEqual(
				buildLeaseCreateOkCommandResultMessage('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
			);

			expect(observedHelloPayloads).toHaveLength(2);
			expect(observedHelloPayloads[1]).toEqual({
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'worker_control',
				lastSeenControllerSequence: 0,
				lastSeenPeerSequence: 0,
				peerId: 'gateway-zone-a',
				previousSessionId: '33333333-3333-4333-8333-333333333333',
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			});
			expect(observedMessages).toHaveLength(1);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('marks the session stale when a reserved dispatcher response is not receipted', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const observedResponseEnvelopes: ControlEnvelope[] = [];
		let clientSocket: ReturnType<typeof createSocketIoClient> | undefined;
		let serverSocket: SocketIoServerSocket | undefined;
		let resolveFirstResponse: (() => void) | undefined;
		const firstResponseObserved = waitForProtocolEvent<void>((resolve) => {
			resolveFirstResponse = resolve;
		});

		socketServer.on('connection', (socket) => {
			serverSocket = socket;
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: validEnvelope.connectionId,
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: validEnvelope.sessionId,
				});
			});
			socket.on(CONTROL_SESSION_EVENT_NAMES.message, (envelope: ControlEnvelope, _payload) => {
				observedResponseEnvelopes.push(envelope);
				if (observedResponseEnvelopes.length === 1) {
					resolveFirstResponse?.();
				}
			});
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			createSocket: (socketOptions) => {
				const socket = createSocketIoClient(
					`http://${socketOptions.endpoint.host}:${String(socketOptions.endpoint.port)}`,
					{
						addTrailingSlash: false,
						path: socketOptions.endpoint.path,
						reconnectionDelay: 10,
						reconnectionDelayMax: 10,
						timeout: socketOptions.timeoutMs,
						transports: ['websocket'],
					},
				);
				clientSocket = socket;
				return socket;
			},
			dispatcher: {
				dispatch: async ({ envelope }) =>
					buildLeaseCreateOkCommandResultMessage(envelope.messageId),
				register: () => undefined,
				validate: () => undefined,
			},
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 50,
			connectTimeoutMs: 50,
		});

		try {
			await client.ready;
			expect(clientSocket?.connected).toBe(true);
			const firstCommandEnvelope = {
				...validEnvelope,
				messageId: 'aaaaaaaa-1111-4111-8111-111111111111',
				sequence: 1,
			} satisfies ControlEnvelope;
			await serverSocket?.timeout(1_000).emitWithAck(
				CONTROL_SESSION_EVENT_NAMES.message,
				firstCommandEnvelope,
				GatewayControlRpcMessageSchema.parse({
					kind: 'command',
					operation: 'lease_create',
					payload: {
						callerContext: {
							callerContextId: '44444444-4444-4444-8444-444444444444',
						},
					},
				}),
			);
			await firstResponseObserved;
			await waitForProtocolRetryInterval(75);

			await expect(
				client.emitApplicationMessage(
					{
						...validEnvelope,
						messageId: 'bbbbbbbb-2222-4222-8222-222222222222',
						sequence: 2,
					},
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-after-unreceipted-response' },
				),
			).rejects.toThrow(/control session is stale: sequence_gap/u);
			expect(observedResponseEnvelopes.map((envelope) => envelope.sequence)).toEqual([1]);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('resends hello and resumes application traffic when reconnect requires resync', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const observedHelloPayloads: ControlHello[] = [];
		let clientSocket: ReturnType<typeof createSocketIoClient> | undefined;
		let resolveSecondHello: (() => void) | undefined;
		const secondHelloObserved = waitForProtocolEvent<void>((resolve) => {
			resolveSecondHello = resolve;
		});

		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (payload: ControlHello, ack) => {
				observedHelloPayloads.push(payload);
				ack({
					connectionId:
						observedHelloPayloads.length === 1
							? '55555555-5555-4555-8555-555555555555'
							: '66666666-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: observedHelloPayloads.length === 2 ? 'resync_required' : 'accepted',
					sessionId:
						observedHelloPayloads.length === 1
							? '33333333-3333-4333-8333-333333333333'
							: '99999999-9999-4999-8999-999999999999',
				});
				if (observedHelloPayloads.length === 2) {
					resolveSecondHello?.();
				}
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: unknown, _payload: unknown, ack) => {
					ack({ received: true });
					setImmediate(() => {
						const controlEnvelope = envelope as ControlEnvelope;
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							commandResultEnvelopeFor(controlEnvelope),
							buildLeaseCreateOkCommandResultMessage(controlEnvelope.messageId),
							() => undefined,
						);
					});
				},
			);
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			createSocket: (socketOptions) => {
				const socket = createSocketIoClient(
					`http://${socketOptions.endpoint.host}:${String(socketOptions.endpoint.port)}`,
					{
						addTrailingSlash: false,
						path: socketOptions.endpoint.path,
						reconnectionDelay: 10,
						reconnectionDelayMax: 10,
						timeout: socketOptions.timeoutMs,
						transports: ['websocket'],
					},
				);
				clientSocket = socket;
				return socket;
			},
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 500,
			connectTimeoutMs: 500,
		});

		try {
			await client.ready;
			clientSocket?.io.engine?.close();
			await expect(secondHelloObserved).resolves.toBeUndefined();
			await waitForClientHelloCount({ client, minimumHelloCount: 3, timeoutMs: 1_000 });
			await expect(
				client.emitApplicationMessage(
					{
						...validEnvelope,
						connectionId: '66666666-5555-4555-8555-555555555555',
						messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
						sequence: 1,
						sessionId: '99999999-9999-4999-8999-999999999999',
					},
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-after-reconnect' },
				),
			).resolves.toEqual(
				buildLeaseCreateOkCommandResultMessage('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
			);
			expect(client.getDiagnostics().lastHelloResponse).toMatchObject({
				outcome: 'accepted',
			});
			expect(observedHelloPayloads).toHaveLength(3);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('continues reconnecting when one reconnect hello is not acknowledged', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const observedHelloPayloads: ControlHello[] = [];
		let clientSocket: ReturnType<typeof createSocketIoClient> | undefined;
		let resolveSecondHello: (() => void) | undefined;
		const secondHelloObserved = waitForProtocolEvent<void>((resolve) => {
			resolveSecondHello = resolve;
		});

		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (payload: ControlHello, ack) => {
				observedHelloPayloads.push(payload);
				if (observedHelloPayloads.length === 1) {
					ack({
						connectionId: '55555555-5555-4555-8555-555555555555',
						controllerEpoch: 'epoch-a',
						outcome: 'accepted',
						sessionId: '33333333-3333-4333-8333-333333333333',
					});
					return;
				}
				resolveSecondHello?.();
				if (observedHelloPayloads.length === 2) {
					return;
				}
				ack({
					connectionId: '66666666-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '99999999-9999-4999-8999-999999999999',
				});
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: unknown, _payload: unknown, ack) => {
					ack({ received: true });
					setImmediate(() => {
						const controlEnvelope = envelope as ControlEnvelope;
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							commandResultEnvelopeFor(controlEnvelope),
							buildLeaseCreateOkCommandResultMessage(controlEnvelope.messageId),
							() => undefined,
						);
					});
				},
			);
		});

		const port = await listen(httpServer);
		const client = createControlSessionClient({
			createSocket: (socketOptions) => {
				const socket = createSocketIoClient(
					`http://${socketOptions.endpoint.host}:${String(socketOptions.endpoint.port)}`,
					{
						addTrailingSlash: false,
						path: socketOptions.endpoint.path,
						reconnectionDelay: 10,
						reconnectionDelayMax: 10,
						timeout: socketOptions.timeoutMs,
						transports: ['websocket'],
					},
				);
				clientSocket = socket;
				return socket;
			},
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 50,
			connectTimeoutMs: 50,
		});

		try {
			await client.ready;
			clientSocket?.io.engine?.close();
			await expect(secondHelloObserved).resolves.toBeUndefined();
			expect(client.getDiagnostics()).toMatchObject({
				accepted: false,
				connected: true,
				ready: false,
			});
			await waitForClientHelloCount({ client, minimumHelloCount: 2, timeoutMs: 1_000 });
			await expect(
				client.emitApplicationMessage(
					{
						...validEnvelope,
						connectionId: '66666666-5555-4555-8555-555555555555',
						messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
						sequence: 1,
						sessionId: '99999999-9999-4999-8999-999999999999',
					},
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-after-timeout' },
				),
			).resolves.toEqual(
				buildLeaseCreateOkCommandResultMessage('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
			);
			expect(observedHelloPayloads).toHaveLength(3);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('does not buffer critical application messages while disconnected', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
		});
		const port = await listen(httpServer);
		let socketRef: ReturnType<typeof createSocketIoClient> | undefined;
		const client = createControlSessionClient({
			createSocket: (socketOptions) => {
				const socket = createSocketIoClient(
					`http://${socketOptions.endpoint.host}:${String(socketOptions.endpoint.port)}`,
					{
						addTrailingSlash: false,
						path: socketOptions.endpoint.path,
						timeout: socketOptions.timeoutMs,
						transports: ['websocket'],
					},
				);
				socketRef = socket;
				return socket;
			},
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 50,
			connectTimeoutMs: 50,
		});

		try {
			await client.ready;
			if (socketRef === undefined) {
				throw new Error('test socket was not created');
			}
			socketRef.disconnect();
			await expect(
				client.emitApplicationMessage(
					validEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-a' },
				),
			).rejects.toThrow(/control session is not connected/u);
			expect(socketRef.sendBuffer).toHaveLength(0);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('bounds pending critical messages and rejects overflow before the peer observes it', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const pendingCommandCompletions: Array<() => void> = [];
		let observedMessageCount = 0;
		let resolveAllPendingObserved: (() => void) | undefined;
		const allPendingObserved = new Promise<void>((resolve) => {
			resolveAllPendingObserved = resolve;
		});
		socketServer.on('connection', (socket) => {
			let peerSequence = 0;
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: unknown, _payload: unknown, ack) => {
					const controlEnvelope = envelope as ControlEnvelope;
					observedMessageCount += 1;
					pendingCommandCompletions.push(() => {
						ack({ received: true });
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							commandResultEnvelopeFor(controlEnvelope, ++peerSequence),
							buildLeaseCreateOkCommandResultMessage(controlEnvelope.messageId),
							() => undefined,
						);
					});
					if (observedMessageCount === CONTROL_QUEUE_LIMITS.queueMessageCap) {
						resolveAllPendingObserved?.();
					}
				},
			);
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 5_000,
			connectTimeoutMs: 5_000,
		});

		try {
			await client.ready;
			const pendingResults = Array.from(
				{ length: CONTROL_QUEUE_LIMITS.queueMessageCap },
				(_unused, commandIndex) =>
					client.emitApplicationMessage(
						{
							...validEnvelope,
							messageId: `20000000-0000-4000-8000-${String(commandIndex + 1).padStart(12, '0')}`,
							sequence: commandIndex + 1,
						},
						{ kind: 'command', operation: 'lease_create' },
						{ leaseId: 'lease-a' },
					),
			);
			const overflowEnvelope = {
				...validEnvelope,
				messageId: '20000000-0000-4000-8000-999999999999',
				sequence: CONTROL_QUEUE_LIMITS.queueMessageCap + 1,
			} satisfies ControlEnvelope;
			for (const pendingResult of pendingResults) {
				pendingResult.catch(() => undefined);
			}
			await expect(
				client.emitApplicationMessage(
					overflowEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-overflow' },
				),
			).rejects.toThrow(/control session pending queue overflow/u);
			await allPendingObserved;
			expect(observedMessageCount).toBe(CONTROL_QUEUE_LIMITS.queueMessageCap);

			for (const completeCommand of pendingCommandCompletions) {
				completeCommand();
			}
			await expect(Promise.allSettled(pendingResults)).resolves.toHaveLength(
				CONTROL_QUEUE_LIMITS.queueMessageCap,
			);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('marks the session unusable after pending critical message overflow', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const pendingCommandCompletions: Array<() => void> = [];
		const observedCloseReasons: unknown[] = [];
		let resolveCloseObserved: (() => void) | undefined;
		const closeObserved = new Promise<void>((resolve) => {
			resolveCloseObserved = resolve;
		});
		let observedMessageCount = 0;
		let resolveAllPendingObserved: (() => void) | undefined;
		const allPendingObserved = new Promise<void>((resolve) => {
			resolveAllPendingObserved = resolve;
		});
		socketServer.on('connection', (socket) => {
			let peerSequence = 0;
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(CONTROL_SESSION_EVENT_NAMES.close, (payload: unknown, ack) => {
				observedCloseReasons.push(payload);
				resolveCloseObserved?.();
				ack({ received: true });
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: unknown, _payload: unknown, ack) => {
					const controlEnvelope = envelope as ControlEnvelope;
					observedMessageCount += 1;
					pendingCommandCompletions.push(() => {
						ack({ received: true });
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							commandResultEnvelopeFor(controlEnvelope, ++peerSequence),
							buildLeaseCreateOkCommandResultMessage(controlEnvelope.messageId),
							() => undefined,
						);
					});
					if (observedMessageCount === CONTROL_QUEUE_LIMITS.queueMessageCap) {
						resolveAllPendingObserved?.();
					}
				},
			);
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 5_000,
			connectTimeoutMs: 5_000,
		});

		try {
			await client.ready;
			const pendingResults = Array.from(
				{ length: CONTROL_QUEUE_LIMITS.queueMessageCap },
				(_unused, commandIndex) =>
					client.emitApplicationMessage(
						{
							...validEnvelope,
							messageId: `30000000-0000-4000-8000-${String(commandIndex + 1).padStart(12, '0')}`,
							sequence: commandIndex + 1,
						},
						{ kind: 'command', operation: 'lease_create' },
						{ leaseId: 'lease-a' },
					),
			);
			const overflowEnvelope = {
				...validEnvelope,
				messageId: '30000000-0000-4000-8000-999999999999',
				sequence: CONTROL_QUEUE_LIMITS.queueMessageCap + 1,
			} satisfies ControlEnvelope;
			for (const pendingResult of pendingResults) {
				pendingResult.catch(() => undefined);
			}
			await expect(
				client.emitApplicationMessage(
					overflowEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-overflow' },
				),
			).rejects.toThrow(/control session pending queue overflow/u);
			await allPendingObserved;

			expect(observedMessageCount).toBe(CONTROL_QUEUE_LIMITS.queueMessageCap);
			await closeObserved;
			expect(observedCloseReasons).toEqual([
				{
					reason: 'queue_overflow',
					safeMessage: 'control session pending queue overflow',
					sessionId: validEnvelope.sessionId,
				},
			]);

			for (const completeCommand of pendingCommandCompletions) {
				completeCommand();
			}
			await expect(Promise.allSettled(pendingResults)).resolves.toHaveLength(
				CONTROL_QUEUE_LIMITS.queueMessageCap,
			);
			await expect(
				client.emitApplicationMessage(
					validEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-after-overflow' },
				),
			).rejects.toThrow(/control session is stale/u);
			expect(observedMessageCount).toBe(CONTROL_QUEUE_LIMITS.queueMessageCap);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('preserves the heartbeat priority lane when the normal critical lane is saturated', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const pendingCommandCompletions: Array<() => void> = [];
		let observedCommandCount = 0;
		let observedHeartbeatCount = 0;
		let resolveAllPendingObserved: (() => void) | undefined;
		const allPendingObserved = new Promise<void>((resolve) => {
			resolveAllPendingObserved = resolve;
		});
		socketServer.on('connection', (socket) => {
			let peerSequence = 0;
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: ControlEnvelope, _payload: unknown, ack) => {
					if (envelope.kind === 'heartbeat') {
						observedHeartbeatCount += 1;
						ack({ received: true });
						return;
					}
					observedCommandCount += 1;
					pendingCommandCompletions.push(() => {
						ack({ received: true });
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							{
								...commandResultEnvelopeFor(envelope, ++peerSequence),
								connectionId: '55555555-5555-4555-8555-555555555555',
							},
							buildLeaseCreateOkCommandResultMessage(envelope.messageId),
							() => undefined,
						);
					});
					if (observedCommandCount === CONTROL_QUEUE_LIMITS.queueMessageCap) {
						resolveAllPendingObserved?.();
					}
				},
			);
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByKind: {
				heartbeat: 'critical_idempotent',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 5_000,
			connectTimeoutMs: 5_000,
		});

		try {
			await client.ready;
			const pendingResults = Array.from(
				{ length: CONTROL_QUEUE_LIMITS.queueMessageCap },
				(_unused, commandIndex) =>
					client.emitApplicationMessage(
						{
							...validEnvelope,
							messageId: `00000000-0000-4000-8000-${String(commandIndex + 1).padStart(12, '0')}`,
							sequence: commandIndex + 1,
						},
						{ kind: 'command', operation: 'lease_create' },
						{ leaseId: 'lease-a' },
					),
			);
			const heartbeatAfterFloodEnvelope = {
				...heartbeatEnvelope,
				sequence: CONTROL_QUEUE_LIMITS.queueMessageCap + 1,
			} satisfies ControlEnvelope;
			for (const pendingResult of pendingResults) {
				pendingResult.catch(() => undefined);
			}
			await allPendingObserved;

			await expect(
				client.emitApplicationMessage(
					heartbeatAfterFloodEnvelope,
					{ kind: 'heartbeat' },
					{ observedAtMs: 1 },
				),
			).resolves.toEqual({ received: true });
			expect(observedHeartbeatCount).toBe(1);

			expect(observedCommandCount).toBe(CONTROL_QUEUE_LIMITS.queueMessageCap);

			for (const completeCommand of pendingCommandCompletions) {
				completeCommand();
			}
			await expect(Promise.allSettled(pendingResults)).resolves.toHaveLength(
				CONTROL_QUEUE_LIMITS.queueMessageCap,
			);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('preserves the operation_cancel priority lane when the normal critical lane is saturated', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const pendingCommandCompletions: Array<() => void> = [];
		let observedCommandCount = 0;
		let observedCancelCount = 0;
		let resolveAllPendingObserved: (() => void) | undefined;
		const allPendingObserved = new Promise<void>((resolve) => {
			resolveAllPendingObserved = resolve;
		});
		socketServer.on('connection', (socket) => {
			let peerSequence = 0;
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: ControlEnvelope, _payload: unknown, ack) => {
					if (envelope.operation === 'operation_cancel') {
						observedCancelCount += 1;
						ack({ received: true });
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							{
								...commandResultEnvelopeFor(envelope, ++peerSequence),
								connectionId: '55555555-5555-4555-8555-555555555555',
							},
							buildOperationCancelOkCommandResultMessage(envelope.messageId),
							() => undefined,
						);
						return;
					}
					observedCommandCount += 1;
					pendingCommandCompletions.push(() => {
						ack({ received: true });
						socket.emit(
							CONTROL_SESSION_EVENT_NAMES.message,
							commandResultEnvelopeFor(envelope, ++peerSequence),
							buildLeaseCreateOkCommandResultMessage(envelope.messageId),
							() => undefined,
						);
					});
					if (observedCommandCount === CONTROL_QUEUE_LIMITS.queueMessageCap) {
						resolveAllPendingObserved?.();
					}
				},
			);
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
				operation_cancel: 'acked_idempotent',
			},
			commandAckTimeoutMs: 5_000,
			connectTimeoutMs: 5_000,
		});

		try {
			await client.ready;
			const pendingResults = Array.from(
				{ length: CONTROL_QUEUE_LIMITS.queueMessageCap },
				(_unused, commandIndex) =>
					client.emitApplicationMessage(
						{
							...validEnvelope,
							messageId: `10000000-0000-4000-8000-${String(commandIndex + 1).padStart(12, '0')}`,
							sequence: commandIndex + 1,
						},
						{ kind: 'command', operation: 'lease_create' },
						{ leaseId: 'lease-a' },
					),
			);
			const cancelEnvelope = {
				...validEnvelope,
				commandId: '11111111-2222-4333-8444-555555555555',
				deliveryPolicy: 'acked_idempotent',
				idempotencyKey: 'cancel-command-key-a',
				messageId: '10000000-0000-4000-8000-999999999999',
				operation: 'operation_cancel',
				sequence: CONTROL_QUEUE_LIMITS.queueMessageCap + 1,
			} satisfies ControlEnvelope;
			for (const pendingResult of pendingResults) {
				pendingResult.catch(() => undefined);
			}
			await allPendingObserved;

			await expect(
				client.emitApplicationMessage(
					cancelEnvelope,
					{ kind: 'command', operation: 'operation_cancel' },
					{
						activeOperationId: 'lease-create-a',
						initiatedBy: 'controller',
						reason: 'operator_cancelled',
					},
				),
			).resolves.toMatchObject({
				operation: 'operation_cancel',
				payload: {
					result: 'ok',
				},
			});
			expect(observedCancelCount).toBe(1);

			expect(observedCommandCount).toBe(CONTROL_QUEUE_LIMITS.queueMessageCap);
			expect(pendingCommandCompletions).toHaveLength(CONTROL_QUEUE_LIMITS.queueMessageCap);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('reuses an unreceipted priority sequence instead of forcing a local gap', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		let observedHeartbeatCount = 0;
		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(_envelope: ControlEnvelope, _payload, ack) => {
					observedHeartbeatCount += 1;
					if (observedHeartbeatCount > 1) {
						ack({ received: true });
					}
				},
			);
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			commandAckTimeoutMs: 20,
			connectTimeoutMs: 500,
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByKind: {
				heartbeat: 'critical_idempotent',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
		});

		try {
			await client.ready;
			const firstHeartbeatEnvelope = {
				...heartbeatEnvelope,
				messageId: '10000000-0000-4000-8000-000000000001',
				sequence: 1,
			} satisfies ControlEnvelope;
			await expect(
				client.emitApplicationMessage(
					firstHeartbeatEnvelope,
					{ kind: 'heartbeat' },
					{ observedAtMs: 1 },
				),
			).rejects.toThrow(/operation has timed out/u);
			await expect(
				client.emitApplicationMessage(
					{
						...firstHeartbeatEnvelope,
						messageId: '10000000-0000-4000-8000-000000000002',
					},
					{ kind: 'heartbeat' },
					{ observedAtMs: 2 },
				),
			).resolves.toEqual({ received: true });
			expect(observedHeartbeatCount).toBe(2);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('does not count priority command result timeouts as transport acknowledgement failures', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		let observedCancelCount = 0;
		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: ControlEnvelope, _payload: unknown, ack) => {
					if (envelope.operation === 'operation_cancel') {
						observedCancelCount += 1;
						ack({ received: true });
					}
				},
			);
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			commandAckTimeoutMs: 500,
			connectTimeoutMs: 500,
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
				operation_cancel: 'acked_idempotent',
			},
		});

		try {
			await client.ready;
			await Array.from(
				{ length: CONTROL_SESSION_TIMING_MS.priorityAckFailureThreshold },
				(_unused, cancelIndex) => cancelIndex,
			).reduce<Promise<void>>(async (previousCancel, cancelIndex) => {
				await previousCancel;
				const cancelSequence = cancelIndex + 1;
				await expect(
					client.emitApplicationMessage(
						{
							...validEnvelope,
							commandId: `11111111-2222-4333-8444-${String(cancelSequence).padStart(12, '0')}`,
							deliveryPolicy: 'acked_idempotent',
							idempotencyKey: `cancel-command-key-${String(cancelSequence)}`,
							messageId: `10000000-0000-4000-8000-${String(cancelSequence).padStart(12, '0')}`,
							operation: 'operation_cancel',
							sequence: cancelSequence,
						},
						{ kind: 'command', operation: 'operation_cancel' },
						{
							activeOperationId: 'lease-create-a',
							initiatedBy: 'controller',
							reason: 'operator_cancelled',
						},
						{ commandResultTimeoutMs: 20 },
					),
				).rejects.toThrow(/control command result timed out/u);
				expect(client.getDiagnostics().ready).toBe(true);
			}, Promise.resolve());
			expect(observedCancelCount).toBe(CONTROL_SESSION_TIMING_MS.priorityAckFailureThreshold);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('resets consecutive priority acknowledgement failures after a fresh accepted hello', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const observedCloseReasons: unknown[] = [];
		const observedHelloPayloads: ControlHello[] = [];
		let clientSocket: ReturnType<typeof createSocketIoClient> | undefined;
		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (payload: ControlHello, ack) => {
				observedHelloPayloads.push(payload);
				ack({
					connectionId:
						observedHelloPayloads.length === 1
							? '55555555-5555-4555-8555-555555555555'
							: '66666666-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(CONTROL_SESSION_EVENT_NAMES.close, (payload: unknown, ack) => {
				observedCloseReasons.push(payload);
				ack({ received: true });
			});
			socket.on(CONTROL_SESSION_EVENT_NAMES.message, () => undefined);
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			createSocket: (socketOptions) => {
				const socket = createSocketIoClient(
					`http://${socketOptions.endpoint.host}:${String(socketOptions.endpoint.port)}`,
					{
						addTrailingSlash: false,
						path: socketOptions.endpoint.path,
						reconnectionDelay: 10,
						reconnectionDelayMax: 10,
						timeout: socketOptions.timeoutMs,
						transports: ['websocket'],
					},
				);
				clientSocket = socket;
				return socket;
			},
			commandAckTimeoutMs: 20,
			connectTimeoutMs: 500,
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByKind: {
				heartbeat: 'critical_idempotent',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
		});

		try {
			await client.ready;
			await Array.from(
				{ length: CONTROL_SESSION_TIMING_MS.priorityAckFailureThreshold - 1 },
				(_unused, heartbeatIndex) => heartbeatIndex,
			).reduce<Promise<void>>(async (previousHeartbeat, heartbeatIndex) => {
				await previousHeartbeat;
				const heartbeatSequence = heartbeatIndex + 1;
				await expect(
					client.emitApplicationMessage(
						{
							...heartbeatEnvelope,
							messageId: `10000000-0000-4000-8000-${String(heartbeatSequence).padStart(12, '0')}`,
							sequence: 1,
						},
						{ kind: 'heartbeat' },
						{ observedAtMs: heartbeatSequence },
					),
				).rejects.toThrow(/operation has timed out/u);
				expect(client.getDiagnostics().ready).toBe(true);
			}, Promise.resolve());

			clientSocket?.io.engine?.close();
			await waitForClientHelloCount({ client, minimumHelloCount: 2, timeoutMs: 1_000 });
			await expect(
				client.emitApplicationMessage(
					{
						...heartbeatEnvelope,
						connectionId: '66666666-5555-4555-8555-555555555555',
						messageId: '10000000-0000-4000-8000-999999999999',
						sequence: 1,
					},
					{ kind: 'heartbeat' },
					{ observedAtMs: 999 },
				),
			).rejects.toThrow(/operation has timed out/u);
			expect(client.getDiagnostics().ready).toBe(true);
			expect(observedCloseReasons).toEqual([]);
			expect(observedHelloPayloads).toHaveLength(2);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('marks the session stale after consecutive priority heartbeat acknowledgements fail', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const observedCloseReasons: unknown[] = [];
		let observedHeartbeatCount = 0;
		let resolveCloseObserved: (() => void) | undefined;
		const closeObserved = new Promise<void>((resolve) => {
			resolveCloseObserved = resolve;
		});
		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(CONTROL_SESSION_EVENT_NAMES.close, (payload: unknown, ack) => {
				observedCloseReasons.push(payload);
				resolveCloseObserved?.();
				ack({ received: true });
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: ControlEnvelope, _payload: unknown) => {
					if (envelope.kind === 'heartbeat') {
						observedHeartbeatCount += 1;
					}
				},
			);
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByKind: {
				heartbeat: 'critical_idempotent',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			commandAckTimeoutMs: 20,
			connectTimeoutMs: 20,
		});

		try {
			await client.ready;
			await Array.from(
				{ length: CONTROL_SESSION_TIMING_MS.priorityAckFailureThreshold },
				(_unused, heartbeatIndex) => heartbeatIndex,
			).reduce<Promise<void>>(async (previousHeartbeat, heartbeatIndex) => {
				await previousHeartbeat;
				const heartbeatSequence = heartbeatIndex + 1;
				await expect(
					client.emitApplicationMessage(
						{
							...heartbeatEnvelope,
							messageId: `10000000-0000-4000-8000-${String(heartbeatSequence).padStart(12, '0')}`,
							sequence: 1,
						},
						{ kind: 'heartbeat' },
						{ observedAtMs: heartbeatSequence },
					),
				).rejects.toThrow(/operation has timed out/u);
				if (heartbeatSequence < CONTROL_SESSION_TIMING_MS.priorityAckFailureThreshold) {
					expect(client.getDiagnostics().ready).toBe(true);
				}
			}, Promise.resolve());
			await closeObserved;
			expect(observedHeartbeatCount).toBe(CONTROL_SESSION_TIMING_MS.priorityAckFailureThreshold);
			expect(observedCloseReasons).toEqual([
				{
					reason: 'transport_error',
					safeMessage: `control session priority message failed ${String(CONTROL_SESSION_TIMING_MS.priorityAckFailureThreshold)} consecutive times`,
					sessionId: heartbeatEnvelope.sessionId,
				},
			]);
			await expect(
				client.emitApplicationMessage(
					validEnvelope,
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-after-heartbeat-timeout' },
				),
			).rejects.toThrow(/control session is stale/u);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('coalesces latest-wins flood traffic before it reaches Socket.IO', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		const observedLatestWinsEvents: unknown[] = [];
		let resolveHeartbeatObserved: (() => void) | undefined;
		const heartbeatObserved = new Promise<void>((resolve) => {
			resolveHeartbeatObserved = resolve;
		});
		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
			socket.on(
				CONTROL_SESSION_EVENT_NAMES.message,
				(envelope: ControlEnvelope, payload: unknown, ack) => {
					if (envelope.kind === 'event') {
						observedLatestWinsEvents.push(payload);
						return;
					}
					if (envelope.kind === 'heartbeat') {
						resolveHeartbeatObserved?.();
						ack({ received: true });
					}
				},
			);
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByKind: {
				heartbeat: 'critical_idempotent',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
				runtime_status: 'latest_wins',
			},
			commandAckTimeoutMs: 5_000,
			connectTimeoutMs: 5_000,
		});

		try {
			await client.ready;
			const floodCount = CONTROL_QUEUE_LIMITS.queueMessageCap * 2;
			await Promise.all(
				Array.from({ length: floodCount }, (_unused, snapshotIndex) =>
					client.emitApplicationMessage(
						{
							...latestWinsEventEnvelope,
							messageId: `10000000-0000-4000-8000-${String(snapshotIndex + 1).padStart(12, '0')}`,
							sequence: snapshotIndex + 1,
						},
						{ kind: 'event', operation: 'runtime_status' },
						{ snapshotIndex },
					),
				),
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const heartbeatAfterFloodEnvelope = {
				...heartbeatEnvelope,
				sequence: 1,
			} satisfies ControlEnvelope;
			await expect(
				client.emitApplicationMessage(
					heartbeatAfterFloodEnvelope,
					{ kind: 'heartbeat' },
					{ observedAtMs: 1 },
				),
			).resolves.toEqual({ received: true });
			await heartbeatObserved;

			expect(observedLatestWinsEvents).toEqual([{ snapshotIndex: floodCount - 1 }]);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});

	it('fails closed when envelope delivery policy contradicts the receiver-derived policy', async () => {
		const httpServer = createServer();
		const socketServer = new SocketIoServer(httpServer, {
			addTrailingSlash: false,
			path: controlPath,
			serveClient: false,
			transports: ['websocket'],
		});
		socketServer.on('connection', (socket) => {
			socket.on(CONTROL_SESSION_EVENT_NAMES.hello, (_payload: ControlHello, ack) => {
				ack({
					connectionId: '55555555-5555-4555-8555-555555555555',
					controllerEpoch: 'epoch-a',
					outcome: 'accepted',
					sessionId: '33333333-3333-4333-8333-333333333333',
				});
			});
		});
		const port = await listen(httpServer);
		const client = createControlSessionClient({
			endpoint: {
				host: '127.0.0.1',
				path: controlPath,
				port,
			},
			identity: {
				bootId: 'gateway-boot-a',
				controllerEpoch: 'epoch-a',
				domain: 'gateway_control',
				peerId: 'gateway-zone-a',
			},
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
		});

		try {
			await client.ready;
			await expect(
				client.emitApplicationMessage(
					{
						...validEnvelope,
						deliveryPolicy: 'latest_wins',
					},
					{ kind: 'command', operation: 'lease_create' },
					{ leaseId: 'lease-a' },
				),
			).rejects.toThrow(/delivery policy mismatch/u);
		} finally {
			client.close();
			await closeSocketIoServer(socketServer);
		}
	});
});

describe('control session dispatcher', () => {
	it('registers per-domain handlers and rejects unknown or mismatched messages before dispatch', async () => {
		const dispatcher = createControlSessionDispatcher();
		const handledPayloads: unknown[] = [];

		dispatcher.register('gateway_control', {
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			messageIdentity: () => ({ kind: 'command', operation: 'lease_create' }),
			handle: async ({ payload }) => {
				handledPayloads.push(payload);
				return { ok: true };
			},
		});

		await expect(
			dispatcher.dispatch({
				envelope: validEnvelope,
				payload: { leaseId: 'lease-a' },
			}),
		).resolves.toEqual({ ok: true });
		expect(handledPayloads).toEqual([{ leaseId: 'lease-a' }]);

		await expect(
			dispatcher.dispatch({
				envelope: {
					...validEnvelope,
					domain: 'worker_control',
				},
				payload: {},
			}),
		).rejects.toThrow(/no control session handler/u);

		await expect(
			dispatcher.dispatch({
				envelope: {
					...validEnvelope,
					deliveryPolicy: 'latest_wins',
				},
				payload: {},
			}),
		).rejects.toThrow(/delivery policy mismatch/u);
	});

	it('rejects stale session identity before dispatch can mutate state', async () => {
		const dispatcher = createControlSessionDispatcher({
			sessionFence: {
				bootId: validEnvelope.bootId,
				connectionId: validEnvelope.connectionId,
				controllerEpoch: validEnvelope.controllerEpoch,
				domain: validEnvelope.domain,
				peerId: validEnvelope.peerId,
				sessionId: validEnvelope.sessionId,
				zoneId: validEnvelope.zoneId,
			},
		});
		const handledPayloads: unknown[] = [];

		dispatcher.register('gateway_control', {
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			messageIdentity: () => ({ kind: 'command', operation: 'lease_create' }),
			handle: async ({ payload }) => {
				handledPayloads.push(payload);
				return { ok: true };
			},
		});

		await expect(
			dispatcher.dispatch({
				envelope: {
					...validEnvelope,
					controllerEpoch: 'stale-controller-epoch',
				},
				payload: { leaseId: 'lease-stale' },
			}),
		).rejects.toThrow(/control session envelope controllerEpoch mismatch/u);
		expect(handledPayloads).toEqual([]);
	});

	it('deduplicates retried command envelopes and returns the cached terminal result', async () => {
		const dispatcher = createControlSessionDispatcher();
		let sideEffectCount = 0;

		dispatcher.register('gateway_control', {
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			messageIdentity: () => ({ kind: 'command', operation: 'lease_create' }),
			handle: async () => {
				sideEffectCount += 1;
				return { ok: true, sideEffectCount };
			},
		});

		await expect(
			dispatcher.dispatch({
				envelope: validEnvelope,
				payload: { leaseId: 'lease-a' },
			}),
		).resolves.toEqual({ ok: true, sideEffectCount: 1 });
		await expect(
			dispatcher.dispatch({
				envelope: {
					...validEnvelope,
					messageId: '88888888-8888-4888-8888-888888888888',
					sequence: validEnvelope.sequence + 1,
				},
				payload: { leaseId: 'lease-a' },
			}),
		).resolves.toEqual({ ok: true, sideEffectCount: 1 });
		expect(sideEffectCount).toBe(1);
	});

	it('rejects out-of-window command replay before dispatch can mutate state again', async () => {
		vi.useFakeTimers({ now: 1_000 });
		try {
			const dispatcher = createControlSessionDispatcher();
			let sideEffectCount = 0;

			dispatcher.register('gateway_control', {
				policyByOperation: {
					lease_create: 'single_use_critical',
				},
				messageIdentity: () => ({ kind: 'command', operation: 'lease_create' }),
				handle: async () => {
					sideEffectCount += 1;
					return { ok: true, sideEffectCount };
				},
			});

			await expect(
				dispatcher.dispatch({
					envelope: validEnvelope,
					payload: { leaseId: 'lease-a' },
				}),
			).resolves.toEqual({ ok: true, sideEffectCount: 1 });

			vi.setSystemTime(1_000 + CONTROL_QUEUE_LIMITS.dedupeWindowTtlMs + 1);

			await expect(
				dispatcher.dispatch({
					envelope: {
						...validEnvelope,
						messageId: '99999999-9999-4999-8999-999999999999',
						sequence: validEnvelope.sequence + 1,
					},
					payload: { leaseId: 'lease-a' },
				}),
			).rejects.toThrow(/control session replay window expired/u);
			expect(sideEffectCount).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('accepts a recreated boot session and fences lingering old boot traffic', async () => {
		const fenceRegistry = createControlSessionFenceRegistry();
		const dispatcher = createControlSessionDispatcher({ sessionFenceRegistry: fenceRegistry });
		const handledBootIds: string[] = [];

		dispatcher.register('gateway_control', {
			policyByOperation: {
				lease_create: 'single_use_critical',
			},
			messageIdentity: () => ({ kind: 'command', operation: 'lease_create' }),
			handle: async ({ envelope }) => {
				handledBootIds.push(envelope.bootId);
				return { ok: true, bootId: envelope.bootId };
			},
		});

		fenceRegistry.acceptSession({
			bootId: 'old-boot',
			connectionId: validEnvelope.connectionId,
			controllerEpoch: 'old-epoch',
			domain: validEnvelope.domain,
			peerId: validEnvelope.peerId,
			sessionId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
			zoneId: validEnvelope.zoneId,
		});

		await expect(
			dispatcher.dispatch({
				envelope: {
					...validEnvelope,
					bootId: 'old-boot',
					controllerEpoch: 'old-epoch',
					sessionId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
				},
				payload: { leaseId: 'lease-old' },
			}),
		).resolves.toEqual({ ok: true, bootId: 'old-boot' });

		fenceRegistry.acceptSession({
			bootId: 'new-boot',
			connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			controllerEpoch: 'new-epoch',
			domain: validEnvelope.domain,
			peerId: validEnvelope.peerId,
			sessionId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
			zoneId: validEnvelope.zoneId,
		});

		await expect(
			dispatcher.dispatch({
				envelope: {
					...validEnvelope,
					bootId: 'new-boot',
					commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
					connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
					controllerEpoch: 'new-epoch',
					idempotencyKey: 'new-command-key',
					messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
					sequence: validEnvelope.sequence + 1,
					sessionId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
				},
				payload: { leaseId: 'lease-new' },
			}),
		).resolves.toEqual({ ok: true, bootId: 'new-boot' });

		await expect(
			dispatcher.dispatch({
				envelope: {
					...validEnvelope,
					bootId: 'old-boot',
					commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
					controllerEpoch: 'old-epoch',
					idempotencyKey: 'old-command-after-recreate',
					messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
					sequence: validEnvelope.sequence + 2,
					sessionId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
				},
				payload: { leaseId: 'lease-old-after-recreate' },
			}),
		).rejects.toThrow(/control session envelope bootId mismatch/u);
		expect(handledBootIds).toEqual(['old-boot', 'new-boot']);
	});
});
