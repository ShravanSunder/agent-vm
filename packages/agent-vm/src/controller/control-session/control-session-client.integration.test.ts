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
	createGatewayRuntimeReadinessSnapshot,
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
import { Server as SocketIoServer } from 'socket.io';
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
	computeControlSessionManualReconnectDelayMs,
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
	readonly client: ControlSessionClient<unknown>;
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

describe('retained Gateway control-session transport', () => {
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
					frameworkIdentity: { kind: 'hermes', profileName: 'agent-approval-wire' },
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
					provenance: 'managed-gateway',
					stablePrincipal: approvalAdmissionPrincipal,
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
		const heldRuntimeReadiness = deferredProtocolWork();
		const inboundHeartbeatStarted = deferredProtocolWork();
		const runtimeReadinessStarted = deferredProtocolWork();
		let inboundHeartbeatSequence: number | undefined;
		let runtimeReadinessSequence: number | undefined;
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
				if (message.kind === 'event' && message.operation === 'gateway_runtime_readiness') {
					runtimeReadinessSequence = envelope.sequence;
					runtimeReadinessStarted.resolve();
					await heldRuntimeReadiness.promise;
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
		const zoneARuntimeReadiness = serviceA
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
					operation: 'gateway_runtime_readiness',
					peerId: acceptedSession.peerId,
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					sequence,
					sessionId: acceptedSession.sessionId,
					zoneId: acceptedSession.zoneId,
				}),
				domainMessage: { kind: 'event', operation: 'gateway_runtime_readiness' },
				payload: GatewayControlRpcMessageSchema.parse({
					kind: 'event',
					operation: 'gateway_runtime_readiness',
					payload: createGatewayRuntimeReadinessSnapshot({
						controlEndpoint: {
							identity: {
								bootId: materialA.processEpoch,
								controllerEpoch: materialA.controllerEpoch,
								generationId: materialA.generationId,
								peerId: materialA.peerId,
								processEpoch: materialA.processEpoch,
								zoneId: materialA.zoneId,
							},
							listener: {
								host: '127.0.0.1',
								port: 18_790,
								readyPath: '/__agent-vm/ready',
								socketPath: '/__agent-vm/gateway-control',
							},
						},
						kind: 'tool-portal-role-readiness',
						providerRevision: 'provider-revision-a',
						requiredBackends: {
							readyBackendKinds: [],
							revision: 'binding-revision-a',
							status: 'ready',
						},
						semanticRevision: 'semantic-revision-a',
						serviceIdentity: {
							processEpoch: materialA.processEpoch,
							role: 'tool-portal',
							serviceId: 'tool-portal-zone-a',
						},
						snapshotVersion: 1,
						uds: {
							attachment: {
								expected: {
									attachmentGeneration: 1,
									clientKind: 'hermes-managed-plugin',
									configuredAgentIds: ['main'],
									frameworkEpoch: materialA.generationId,
									gatewayEpoch: materialA.generationId,
									protocolVersion: 1,
									projectionCohortDigest: `projection-cohort:${'a'.repeat(64)}`,
									runtimeEpoch: materialA.processEpoch,
									schemaVersion: 1,
								},
								observationSequence: 1,
								snapshotVersion: 1,
								status: 'awaiting-attachment',
							},
							publication: {
								identity: 'managed-plugin-private-uds',
								protocolVersion: 1,
								schemaVersion: 1,
								socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
								status: 'published',
							},
						},
					}),
				}),
			})
			.catch((error: unknown) => error);

		try {
			await withProtocolDeadline(authorityCapacity, 'zone A authority capacity');
			await withProtocolDeadline(inboundHeartbeatStarted.promise, 'zone A inbound heartbeat');
			await withProtocolDeadline(runtimeReadinessStarted.promise, 'zone A runtime readiness');
			expect([inboundHeartbeatSequence, runtimeReadinessSequence]).toEqual([4, 5]);
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
						payload: { action: 'restart_control_service' },
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
			heldRuntimeReadiness.resolve();
			for (const heldControlPing of heldControlPings) {
				heldControlPing.resolve();
			}
			await withProtocolDeadline(
				Promise.allSettled([
					...authorityPromises,
					...controlPingPromises,
					zoneAHeartbeat,
					zoneARuntimeReadiness,
				]),
				'zone A pressure settlement',
			);
		} finally {
			heldAuthority.resolve();
			heldInboundHeartbeat.resolve();
			heldRuntimeReadiness.resolve();
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
			const url = new URL(req.url ?? '/', 'http://hermes.local');
			if (url.pathname === GATEWAY_CONTROL_READY_PATH) {
				service.handleReadyRequest(req, res);
				return;
			}
			res.statusCode = 404;
			res.end('not found\n');
		});
		httpServer.on('upgrade', (req, socket, head) => {
			const url = new URL(req.url ?? '/', 'http://hermes.local');
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
			const url = new URL(req.url ?? '/', 'http://hermes.local');
			if (url.pathname === GATEWAY_CONTROL_READY_PATH) {
				service.handleReadyRequest(req, res);
				return;
			}
			res.statusCode = 404;
			res.end('not found\n');
		});
		httpServer.on('upgrade', (req, socket, head) => {
			const url = new URL(req.url ?? '/', 'http://hermes.local');
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

	it('registers the Gateway domain handler and rejects mismatched delivery policy', async () => {
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
