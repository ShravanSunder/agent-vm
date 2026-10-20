// Integration copy at 3031ad24, retargeted through tool-engine and its managed adapter.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	PortalCallRequestSchema,
	PortalCallResultSchema,
	type PortalCallResult,
	type PortalDescribeResult,
	type PortalListResult,
	type PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import {
	GatewayRuntimeClient,
	type GatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeClientTrustedInvocationContext,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import type {
	GatewayRuntimeManagedToolPortalConfig,
	ToolPortalBackendKind,
} from '@agent-vm/config-contracts';
import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	createControllerApprovalLedger,
	type ControllerApprovalOperatorIdentity,
} from '@agent-vm/controller-test-support/approval/controller-approval-ledger.js';
import { createControlSessionDispatcher } from '@agent-vm/controller-test-support/control-session/control-session-dispatcher.js';
import {
	createGatewayControlCallerContextRegistry,
	type GatewayControlCallerContextSessionRef,
} from '@agent-vm/controller-test-support/control-session/gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	resolveGatewayControlInboundStablePrincipal,
} from '@agent-vm/controller-test-support/control-session/gateway-control-domain-handler.js';
import type { ControllerApprovalRecordsTarget } from '@agent-vm/controller-test-support/durable-state/controller-state-record-paths.js';
import type { GatewayEpochIdentity } from '@agent-vm/controller-test-support/vm-ownership/vm-ownership-contracts.js';
import {
	deriveGatewayControlStablePrincipal,
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	GatewayControlRpcCommandResultMessageSchema,
	gatewayControlDeliveryPolicyByOperation,
	type GatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import {
	createGatewayRuntimeApprovalPort,
	createGatewayRuntimePaths,
	createGatewayRuntimePrivateUdsDispatcher,
	createManagedPluginAttachmentState,
	resolveGatewayRuntimeOperationGroup,
	startGatewayRuntimeUdsServer,
	type GatewayRuntimeApprovalControlCommandPort,
	type GatewayRuntimeApprovalControlCommandResponse,
	type GatewayRuntimePortalProjectionOperations,
} from '@agent-vm/gateway-runtime';
import {
	createManagedToolEngineAdapter,
	type ManagedToolEngineAdapter,
} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-dispatch-adapter.js';
import {
	type ToolPortalBackendCallOptions,
	type ToolPortalBackendPort,
} from '@agent-vm/tool-portal';
import { describe, expect, it, vi } from 'vitest';

const BASE_TIME_MS = Date.parse('2026-07-13T17:00:00.000Z');

const acceptedSession = {
	bootId: 'framework-boot-a',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'controller-epoch-a',
	peerId: 'gateway-zone-a',
	sessionId: '22222222-2222-4222-8222-222222222222',
	zoneId: 'zone-a',
} satisfies GatewayControlCallerContextSessionRef;

const gateway = {
	bootId: acceptedSession.bootId,
	controllerEpoch: acceptedSession.controllerEpoch,
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'runtime-generation-a',
	zoneId: acceptedSession.zoneId,
} satisfies GatewayEpochIdentity;

const authorityContext = {
	controllerEpoch: gateway.controllerEpoch,
	frameworkEpoch: acceptedSession.bootId,
	gatewayEpoch: gateway.gatewayEpochId,
	runtimeEpoch: gateway.generationId,
	zoneId: gateway.zoneId,
} as const;

const semanticSnapshot = {
	activeRevision: 'semantic:12',
	agentProjections: {
		'agent-a': {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment:agent-a:7',
			toolPortalNamespaces: [{ namespace: 'github' }],
			toolPortalProfileId: 'code-builder',
		},
	},
	bindingRevision: 'binding:9',
	catalogRevision: 'catalog:12',
	desiredRevision: 'semantic:12',
	profilePolicyRevision: 'policy:7',
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	providerRevision: 'provider:5',
	schemaRevision: 'schema:1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		'code-builder': { github: ['protected_uds'] },
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

const toolPortalConfig = {
	agents: { 'agent-a': { profile: 'code-builder' } },
	mode: 'managed',
	profiles: {
		'code-builder': {
			namespaces: {
				github: {
					discovery: {},
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: [], deny: [] },
					},
					tools: { allow: ['create_issue'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies GatewayRuntimeManagedToolPortalConfig;

const managedPrincipal = {
	agentId: 'agent-a',
	frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
	profileAssignmentRevision: 'profile-assignment:agent-a:7',
	toolPortalProfileId: 'code-builder',
} as const;

const trustedInvocationContext = {
	correlation: {
		runId: 'approval-exactly-once-run',
		sessionId: 'approval-exactly-once-session',
		toolCallId: 'approval-exactly-once-tool-call',
	},
	principal: managedPrincipal,
	requester: { authenticatedSubjectId: 'hermes:agent-a' },
} satisfies GatewayRuntimeClientTrustedInvocationContext;

const managedPluginAttachment = {
	attachmentGeneration: 1,
	clientKind: 'hermes-managed-plugin',
	configuredAgentIds: [managedPrincipal.agentId],
	frameworkEpoch: authorityContext.frameworkEpoch,
	gatewayEpoch: authorityContext.gatewayEpoch,
	protocolVersion: 1,
	projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
	runtimeEpoch: authorityContext.runtimeEpoch,
	schemaVersion: 1,
} satisfies GatewayRuntimeAttachmentMetadata;

const operatorIdentity = {
	approverId: 'operator-a',
	audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	provenance: 'managed-gateway',
	stablePrincipal: deriveGatewayControlStablePrincipal({ principal: managedPrincipal }),
} satisfies ControllerApprovalOperatorIdentity;

const portalCallRequest = PortalCallRequestSchema.parse({
	calls: [
		{
			arguments: { issueTitle: 'Exactly once' },
			id: 'github-create-issue',
			name: 'create_issue',
			namespace: 'github',
		},
	],
	requestId: 'private-uds-approval-exactly-once',
});

interface ApprovalControlTraceEntry {
	readonly operation: 'tool_portal_admission_reserve' | 'tool_portal_dispatch_arm';
	readonly requestedPrincipal: string;
	readonly resolvedPrincipal: string;
	readonly resultKind: string;
}

interface RecordedMcpProviderInvocation {
	readonly options: ToolPortalBackendCallOptions<'mcp_provider'>;
	readonly request: typeof portalCallRequest;
}

async function callToolPortal(client: GatewayRuntimeClient): Promise<PortalCallResult> {
	return await client.portal.call(portalCallRequest, { trustedContext: trustedInvocationContext });
}

function createPrivateUdsPortalOperations(
	adapter: ManagedToolEngineAdapter,
): GatewayRuntimePortalProjectionOperations {
	return {
		call: async ({ publicRequest, trustedContext }) =>
			await adapter.call(publicRequest, { trustedContext, surfaceClass: 'protected_uds' }),
		describe: async () => {
			throw new Error('Discovery outside the approval proof');
		},
		list: async () => {
			throw new Error('Discovery outside the approval proof');
		},
		search: async () => {
			throw new Error('Discovery outside the approval proof');
		},
	};
}

function createInboundEnvelope(props: {
	readonly messageId: string;
	readonly operation: ApprovalControlTraceEntry['operation'];
	readonly sequence: number;
}): ControlEnvelope {
	return {
		bootId: acceptedSession.bootId,
		connectionId: acceptedSession.connectionId,
		controllerEpoch: acceptedSession.controllerEpoch,
		createdAtMs: BASE_TIME_MS + props.sequence,
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation[props.operation],
		domain: 'gateway_control',
		expiresAtMs: BASE_TIME_MS + 60_000,
		kind: 'command',
		messageId: props.messageId,
		operation: props.operation,
		peerId: acceptedSession.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: props.sequence,
		sessionId: acceptedSession.sessionId,
		zoneId: acceptedSession.zoneId,
	};
}

function unexpectedBackendPort<TBackendKind extends ToolPortalBackendKind>(
	backendKind: TBackendKind,
	label: string,
): ToolPortalBackendPort<TBackendKind> {
	const unexpected = (): never => {
		throw new Error(`${label} backend must not be invoked by the MCP provider proof.`);
	};
	return {
		backendKind,
		call: async (): Promise<PortalCallResult> => unexpected(),
		describe: async (): Promise<PortalDescribeResult> => unexpected(),
		list: async (): Promise<PortalListResult> => unexpected(),
		search: async (): Promise<PortalSearchResult> => unexpected(),
	};
}

function unexpectedMcpProviderRead(): never {
	throw new Error('MCP provider discovery was not expected in the approval call proof.');
}

function createRecordingMcpProviderBackend(
	invocations: RecordedMcpProviderInvocation[],
): ToolPortalBackendPort<'mcp_provider'> {
	return {
		backendKind: 'mcp_provider',
		call: async (request, options): Promise<PortalCallResult> => {
			const parsedRequest = PortalCallRequestSchema.parse(request);
			if (options.dispatchAuthority.kind !== 'approval-grant') {
				throw new Error('MCP provider dispatch requires a controller-issued approval grant.');
			}
			const grant = options.dispatchAuthority.grant;
			invocations.push({ options, request: parsedRequest });
			return PortalCallResultSchema.parse({
				items: parsedRequest.calls.map((call) => ({
					id: call.id,
					operationId: grant.operationId,
					outcome: {
						certainty: 'proven',
						completion: 'succeeded',
						kind: 'completed',
						retryClass: 'forbidden',
					},
					owningGeneration: semanticSnapshot.activeRevision,
					status: 'ok',
					value: { created: true },
				})),
				ok: true,
			});
		},
		describe: async (): Promise<PortalDescribeResult> => unexpectedMcpProviderRead(),
		list: async (): Promise<PortalListResult> => unexpectedMcpProviderRead(),
		search: async (): Promise<PortalSearchResult> => unexpectedMcpProviderRead(),
	};
}

function singleResultItem(result: PortalCallResult): PortalCallResult['items'][number] {
	const item = result.items[0];
	if (item === undefined || result.items.length !== 1) {
		throw new Error('Expected exactly one Tool Portal call result item.');
	}
	return item;
}

describe('managed private-UDS approval exactly-once dispatch', () => {
	it('dispatches one approved MCP-provider call across concurrent identical UDS successors and refuses replay', async () => {
		// Arrange
		const temporaryDirectoryPath = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-tool-portal-mcp-approval-'),
		);
		const udsTemporaryDirectoryPath = await mkdtemp('/tmp/agent-vm-approval-uds-');
		const recordsTarget = {
			directoryPath: path.join(temporaryDirectoryPath, 'approval-records'),
			kind: 'controller-approval-records',
			zoneId: gateway.zoneId,
		} satisfies ControllerApprovalRecordsTarget;
		const approvalLedger = createControllerApprovalLedger({
			challengeTtlMs: 300_000,
			currentControllerEpoch: gateway.controllerEpoch,
			now: () => BASE_TIME_MS,
			recordsTarget,
		});
		const callerContexts = createGatewayControlCallerContextRegistry({
			agentAuthorityKeys: {},
			callerContextProofKey: 'private-uds-approval-test-caller-context-proof-key',
		});
		const dispatcher = createControlSessionDispatcher({
			sessionFence: {
				bootId: acceptedSession.bootId,
				connectionId: acceptedSession.connectionId,
				controllerEpoch: acceptedSession.controllerEpoch,
				domain: 'gateway_control',
				peerId: acceptedSession.peerId,
				sessionId: acceptedSession.sessionId,
				zoneId: acceptedSession.zoneId,
			},
		});
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				approvalLedger,
				callerContexts,
				gateway,
				session: acceptedSession,
			}),
		);
		const controlTrace: ApprovalControlTraceEntry[] = [];
		let overlapSuccessors = false;
		let reserveArrivals = 0;
		let reserveCompletions = 0;
		const bothSuccessorsArrived = Promise.withResolvers<void>();
		const bothReservesFinished = Promise.withResolvers<void>();
		let nextSequence = 0;
		const controlCommandPort: GatewayRuntimeApprovalControlCommandPort = {
			sendCommand: async (request): Promise<GatewayRuntimeApprovalControlCommandResponse> => {
				if (overlapSuccessors && request.message.operation === 'tool_portal_admission_reserve') {
					reserveArrivals += 1;
					if (reserveArrivals === 2) bothSuccessorsArrived.resolve();
					await bothSuccessorsArrived.promise;
				}
				if (overlapSuccessors && request.message.operation === 'tool_portal_dispatch_arm')
					await bothReservesFinished.promise;
				nextSequence += 1;
				const messageId = `33333333-3333-4333-8333-${String(nextSequence).padStart(12, '0')}`;
				const envelope = createInboundEnvelope({
					messageId,
					operation: request.message.operation,
					sequence: nextSequence,
				});
				const principalResolution = resolveGatewayControlInboundStablePrincipal({
					callerContexts,
					envelope,
					message: request.message,
				});
				if (
					principalResolution.status !== 'accepted' ||
					principalResolution.stablePrincipal !== request.admissionPrincipal
				) {
					throw new Error(
						'Gateway approval command principal did not match production resolution.',
					);
				}
				const response = GatewayControlRpcCommandResultMessageSchema.parse(
					await dispatcher.dispatch({ envelope, payload: request.message }),
				);
				const resultKind =
					response.operation === 'tool_portal_admission_reserve'
						? (response.payload.approvalAdmission?.kind ?? response.payload.result)
						: (response.payload.approvalDispatch?.kind ?? response.payload.result);
				controlTrace.push({
					operation: request.message.operation,
					requestedPrincipal: request.admissionPrincipal,
					resolvedPrincipal: principalResolution.stablePrincipal,
					resultKind,
				});
				if (overlapSuccessors && request.message.operation === 'tool_portal_admission_reserve') {
					reserveCompletions += 1;
					if (reserveCompletions === 2) bothReservesFinished.resolve();
				}
				return { messageId, response };
			},
		};
		const approvalPort = createGatewayRuntimeApprovalPort({
			controlCommandPort,
			zoneId: acceptedSession.zoneId,
		});
		const backendInvocations: RecordedMcpProviderInvocation[] = [];
		const capabilityCore = createManagedToolEngineAdapter({
			authority: 'zone-a',
			configuration: {
				config: toolPortalConfig,
				revision: { owner: 'zone-a', revision: semanticSnapshot.profilePolicyRevision },
			},
			now: () => BASE_TIME_MS,
			approvalPort,
			backendPorts: {
				controllerExecution: unexpectedBackendPort(
					'controller_execution',
					'controller host action',
				),
				mcpProvider: createRecordingMcpProviderBackend(backendInvocations),
				toolVmRunner: unexpectedBackendPort('tool_vm_runner', 'Tool VM runner'),
			},
			semanticSnapshot,
		});
		const privateUdsDispatcher = createGatewayRuntimePrivateUdsDispatcher({
			approvalOperations: { decide: async () => ({ kind: 'rejected', reason: 'not-found' }) },
			artifactOperations: {
				read: async (): Promise<never> => {
					throw new Error('Artifact reads are outside the private-UDS approval proof.');
				},
			},
			portalOperations: createPrivateUdsPortalOperations(capabilityCore),
			sandboxDispatch: async (): Promise<never> => {
				throw new Error('Sandbox operations are outside the private-UDS approval proof.');
			},
		});
		const udsPaths = createGatewayRuntimePaths({
			runtimeRoot: udsTemporaryDirectoryPath,
		});
		const udsServer = await startGatewayRuntimeUdsServer({
			attachmentState: createManagedPluginAttachmentState({
				attachmentGeneration: managedPluginAttachment.attachmentGeneration,
				clientKind: managedPluginAttachment.clientKind,
				configuredAgentIds: managedPluginAttachment.configuredAgentIds,
				frameworkEpoch: managedPluginAttachment.frameworkEpoch,
				gatewayEpoch: managedPluginAttachment.gatewayEpoch,
				projectionCohortDigest: managedPluginAttachment.projectionCohortDigest,
				runtimeEpoch: managedPluginAttachment.runtimeEpoch,
				serverAuthority: { allowedOperationGroups: ['portal'], surface: 'managed-plugin' },
			}),
			dispatch: privateUdsDispatcher.dispatch,
			paths: udsPaths,
			resolveOperationGroup: resolveGatewayRuntimeOperationGroup,
		});
		const client = new GatewayRuntimeClient({
			attachment: managedPluginAttachment,
			socketPath: udsServer.readiness.socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});
		try {
			await client.connect();
			const initialResult = await callToolPortal(client);
			const initialItem = singleResultItem(initialResult);
			if (initialItem.status !== 'approval_required') {
				throw new Error('Initial private-UDS call did not return an approval challenge.');
			}
			const approvalId = initialItem.approvalChallenge.challengeId;
			const pendingView = await approvalLedger.read(approvalId);
			if (pendingView?.kind !== 'pending') {
				throw new Error('Controller ledger did not persist the private-UDS approval challenge.');
			}
			const decision = await approvalLedger.decide({
				approvalId,
				authorityContext,
				decision: 'approve',
				operator: operatorIdentity,
			});

			// Act
			overlapSuccessors = true;
			const successorResults = await Promise.all([callToolPortal(client), callToolPortal(client)]);
			overlapSuccessors = false;
			expect(reserveArrivals).toBe(2);
			expect(reserveCompletions).toBe(2);
			const successorItems = successorResults.map(singleResultItem);
			const successfulItems = successorItems.filter((item) => item.status === 'ok');
			const refusedItems = successorItems.filter((item) => item.status !== 'ok');
			const replayResult = await callToolPortal(client);
			const replayItem = singleResultItem(replayResult);

			// Assert
			expect(decision).toMatchObject({ decision: 'approve', kind: 'recorded' });
			expect(initialItem).toMatchObject({
				operationId: pendingView.challenge.intent.operationId,
				outcome: { kind: 'not-dispatched' },
				status: 'approval_required',
			});
			expect(successfulItems).toHaveLength(1);
			expect(refusedItems).toHaveLength(1);
			expect(refusedItems[0]).toMatchObject({ status: 'error' });
			expect(['not-dispatched', 'ambiguous']).toContain(refusedItems[0]?.outcome.kind);
			expect(replayItem).toMatchObject({
				operationId: initialItem.operationId,
				outcome: { kind: 'ambiguous', retryClass: 'forbidden' },
				status: 'error',
			});
			expect(backendInvocations).toHaveLength(1);
			const backendInvocation = backendInvocations[0];
			if (
				backendInvocation === undefined ||
				backendInvocation.options.dispatchAuthority.kind !== 'approval-grant'
			) {
				throw new Error('Exactly-once backend dispatch did not carry an approval grant.');
			}
			const expectedStablePrincipal = deriveGatewayControlStablePrincipal({
				principal: managedPrincipal,
			});
			expect(backendInvocation.request).toEqual({ calls: portalCallRequest.calls });
			expect(backendInvocation.options.dispatchAuthority.grant).toMatchObject({
				approvalId,
				authorityContext,
				backendKind: 'mcp_provider',
				operationId: initialItem.operationId,
				stablePrincipal: expectedStablePrincipal,
			});
			expect(successfulItems[0]?.operationId).toBe(initialItem.operationId);
			expect(refusedItems[0]?.operationId).toBe(initialItem.operationId);
			expect(
				controlTrace.filter(({ operation }) => operation === 'tool_portal_dispatch_arm'),
			).toHaveLength(1);
			expect(
				controlTrace.filter(({ operation }) => operation === 'tool_portal_admission_reserve'),
			).toHaveLength(4);
			expect(
				controlTrace.every(
					({ requestedPrincipal, resolvedPrincipal }) => requestedPrincipal === resolvedPrincipal,
				),
			).toBe(true);
			expect(new Set(controlTrace.map(({ requestedPrincipal }) => requestedPrincipal))).toEqual(
				new Set([expectedStablePrincipal]),
			);
			expect(controlTrace.map(({ resultKind }) => resultKind)).toEqual(
				expect.arrayContaining(['approval-required', 'dispatch-reserved', 'dispatch-armed']),
			);
			expect(await approvalLedger.read(approvalId)).toMatchObject({
				challenge: { intent: { operationId: initialItem.operationId } },
				kind: 'dispatch-armed',
			});
			expect(backendInvocations).toHaveLength(1);
			const reopenedLedger = createControllerApprovalLedger({
				challengeTtlMs: 300_000,
				currentControllerEpoch: gateway.controllerEpoch,
				now: () => BASE_TIME_MS,
				recordsTarget,
			});
			const reopenedAdapter = createManagedToolEngineAdapter({
				authority: 'zone-a',
				configuration: {
					config: toolPortalConfig,
					revision: { owner: 'zone-a', revision: semanticSnapshot.profilePolicyRevision },
				},
				semanticSnapshot,
				now: () => BASE_TIME_MS,
				approvalPort: {
					reserveDispatch: async ({ intent }) =>
						await reopenedLedger.requestApproval({ authorityContext, intent }),
					armDispatch: async ({ reservation }) =>
						await reopenedLedger.armDispatch({ authorityContext, reservation }),
				},
				backendPorts: {
					controllerExecution: unexpectedBackendPort('controller_execution', 'controller'),
					mcpProvider: createRecordingMcpProviderBackend(backendInvocations),
					toolVmRunner: unexpectedBackendPort('tool_vm_runner', 'runner'),
				},
			});
			expect(
				await reopenedAdapter.call(portalCallRequest, {
					trustedContext: trustedInvocationContext,
					surfaceClass: 'protected_uds',
				}),
			).toMatchObject({
				ok: false,
				items: [{ operationId: initialItem.operationId, outcome: { kind: 'ambiguous' } }],
			});
			expect(await reopenedLedger.read(approvalId)).toMatchObject({ kind: 'dispatch-armed' });
			expect(backendInvocations).toHaveLength(1);
		} finally {
			await client.disconnect();
			await udsServer.retire();
			await Promise.all([
				rm(temporaryDirectoryPath, { force: true, recursive: true }),
				rm(udsTemporaryDirectoryPath, { force: true, recursive: true }),
			]);
		}
	});
	it.each(['forged-reservation', 'receipt-reference-replay'] as const)(
		'refuses %s at the adapter/controller boundary',
		async (scenario) => {
			const directoryPath = await mkdtemp(
				path.join(os.tmpdir(), 'agent-vm-s2-forged-reservation-'),
			);
			const recordsTarget = {
				directoryPath,
				kind: 'controller-approval-records',
				zoneId: gateway.zoneId,
			} satisfies ControllerApprovalRecordsTarget;
			const ledger = createControllerApprovalLedger({
				challengeTtlMs: 300_000,
				currentControllerEpoch: gateway.controllerEpoch,
				now: () => BASE_TIME_MS,
				recordsTarget,
			});
			const effects: RecordedMcpProviderInvocation[] = [];
			const adapter = createManagedToolEngineAdapter({
				authority: 'zone-a',
				configuration: {
					config: toolPortalConfig,
					revision: { owner: 'zone-a', revision: semanticSnapshot.profilePolicyRevision },
				},
				semanticSnapshot,
				now: () => BASE_TIME_MS,
				approvalPort: {
					reserveDispatch: async ({ intent }) => {
						const result = await ledger.requestApproval({ authorityContext, intent });
						if (result.kind !== 'dispatch-reserved' || scenario !== 'forged-reservation')
							return result;
						return {
							...result,
							reservation: {
								...result.reservation,
								reservationId: '99999999-9999-4999-8999-999999999999',
							},
						};
					},
					armDispatch: async ({ reservation }) =>
						await ledger.armDispatch({ authorityContext, reservation }),
				},
				backendPorts: {
					controllerExecution: unexpectedBackendPort('controller_execution', 'controller'),
					mcpProvider: createRecordingMcpProviderBackend(effects),
					toolVmRunner: unexpectedBackendPort('tool_vm_runner', 'runner'),
				},
			});
			try {
				const pending = singleResultItem(
					await adapter.call(portalCallRequest, {
						trustedContext: trustedInvocationContext,
						surfaceClass: 'protected_uds',
					}),
				);
				if (pending.status !== 'approval_required') throw new Error('Expected real challenge');
				await ledger.decide({
					approvalId: pending.approvalChallenge.challengeId,
					authorityContext,
					decision: 'approve',
					operator: operatorIdentity,
				});
				if (scenario === 'forged-reservation') {
					expect(
						await adapter.call(portalCallRequest, {
							trustedContext: trustedInvocationContext,
							surfaceClass: 'protected_uds',
						}),
					).toMatchObject({ ok: false, items: [{ status: 'error' }] });
					expect(effects).toEqual([]);
					expect(await ledger.read(pending.approvalChallenge.challengeId)).not.toMatchObject({
						kind: 'dispatch-armed',
					});
				} else {
					const reference = adapter.register({
						context: { trustedContext: trustedInvocationContext, surfaceClass: 'protected_uds' },
						call:
							portalCallRequest.calls[0] ??
							(() => {
								throw new Error('Missing call');
							})(),
					});
					const backend = adapter.backends.get('mcp_provider');
					if (backend === undefined) throw new Error('Missing MCP backend');
					const observed: Parameters<typeof backend.invoke>[0][] = [];
					const originalInvoke = backend.invoke;
					vi.spyOn(backend, 'invoke').mockImplementation(async (invocation) => {
						observed.push(invocation);
						return await originalInvoke(invocation);
					});
					expect(await adapter.dispatcher.dispatch(adapter.request(reference))).toMatchObject({
						kind: 'completed',
					});
					const original = observed[0];
					if (original === undefined) throw new Error('Expected neutral invoke');
					expect(await backend.invoke(original)).toMatchObject({ kind: 'not-dispatched' });
					expect(effects).toHaveLength(1);
					adapter.release(reference);
				}
			} finally {
				await rm(directoryPath, { recursive: true, force: true });
			}
		},
	);
});
