// Integration copy at 3031ad24, retargeted through tool-engine and its managed adapter.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GatewayRuntimeClient } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { gatewayRuntimeManagedToolPortalConfigSchema } from '@agent-vm/config-contracts';
import { createControllerApprovalLedger } from '@agent-vm/controller-test-support/approval/controller-approval-ledger.js';
import { createControlSessionDispatcher } from '@agent-vm/controller-test-support/control-session/control-session-dispatcher.js';
import { createGatewayControlCallerContextRegistry } from '@agent-vm/controller-test-support/control-session/gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	resolveGatewayControlInboundStablePrincipal,
} from '@agent-vm/controller-test-support/control-session/gateway-control-domain-handler.js';
import type { ControllerApprovalRecordsTarget } from '@agent-vm/controller-test-support/durable-state/controller-state-record-paths.js';
import {
	GatewayControlRpcCommandResultMessageSchema,
	GatewayRuntimeGatewayDispatchReservationSchema,
	deriveGatewayControlStablePrincipal,
} from '@agent-vm/gateway-control-contracts';
import {
	GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
	createGatewayRuntimeApprovalPort,
	createGatewayRuntimeManagedToolPortalComposition,
	createGatewayRuntimePaths,
	createGatewayRuntimePrivateUdsDispatcher,
	createManagedPluginAttachmentState,
	resolveGatewayRuntimeOperationGroup,
	startGatewayRuntimeUdsServer,
	type GatewayRuntimeApprovalControlCommandPort,
	type GatewayRuntimeApprovalControlCommandResponse,
} from '@agent-vm/gateway-runtime';
import { createManagedToolEngineAdapter } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-dispatch-adapter.js';
import {
	BASE_TIME_MS,
	acceptedSession,
	authorityContext,
	callToolPortal,
	createInboundEnvelope,
	createRecordingApprovedBackend,
	gateway,
	managedPluginAttachment,
	managedPrincipal,
	operatorIdentity,
	portalCallRequest,
	semanticSnapshot,
	singleResultItem,
	toolPortalConfig,
	trustedInvocationContext,
	unexpectedBackendPort,
	type ApprovalControlTraceEntry,
	type RecordedApprovedBackendInvocation,
} from '@agent-vm/gateway-runtime/managed-tool-engine/test-fixtures/managed-approval-dispatch-test-fixture.js';
import { describe, expect, it, vi } from 'vitest';

describe('managed private-UDS approval exactly-once dispatch', () => {
	it.each(['mcp_provider', 'tool_vm_runner'] as const)(
		'dispatches one approved %s call through production composition across concurrent UDS successors and refuses replay',
		async (backendKind) => {
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
			const backendInvocations: RecordedApprovedBackendInvocation[] = [];
			const selectedConfig = gatewayRuntimeManagedToolPortalConfigSchema.parse(toolPortalConfig);
			if (backendKind === 'tool_vm_runner') {
				const policy = selectedConfig.profiles['code-builder']?.namespaces.github;
				if (policy === undefined) throw new Error('Missing profile');
				policy.backend = {
					kind: 'tool_vm_runner',
					profile: 'sandbox_ssh',
					operations: {
						create_issue: {
							kind: 'command.fixed',
							description: 'Count controlled effect',
							executable: '/usr/bin/true',
							mandatoryArgvPrefix: [],
							workingDirectory: '.',
						},
					},
				};
			}
			const composition = await createGatewayRuntimeManagedToolPortalComposition({
				approvalPort,
				toolPortalConfig: selectedConfig,
				semanticSnapshot,
				artifactRuntime: {
					artifactsDirectoryPath: path.join(temporaryDirectoryPath, 'artifacts'),
					epochId: 'approval-epoch',
					now: () => BASE_TIME_MS,
					limits: {
						maximumArtifactBytes: 1024,
						maximumArtifactCount: 8,
						maximumLifetimeMs: 60000,
						maximumTotalBytes: 8192,
					},
				},
				authenticatedPrivateUdsOperationGroups:
					GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
				managedPluginAttachment: {
					clientKind: managedPluginAttachment.clientKind,
					configuredAgentIds: managedPluginAttachment.configuredAgentIds,
					gatewayEpoch: managedPluginAttachment.gatewayEpoch,
					projectionCohortDigest: managedPluginAttachment.projectionCohortDigest,
				},
				createPrivateUdsProjection: (props) => props,
				backendPortFactories: {
					controllerExecution: () =>
						unexpectedBackendPort('controller_execution', 'controller host action'),
					mcpProvider: () =>
						backendKind === 'mcp_provider'
							? createRecordingApprovedBackend('mcp_provider', backendInvocations)
							: unexpectedBackendPort('mcp_provider', 'unused provider'),
					toolVmRunner: () =>
						backendKind === 'tool_vm_runner'
							? createRecordingApprovedBackend('tool_vm_runner', backendInvocations)
							: unexpectedBackendPort('tool_vm_runner', 'unused runner'),
				},
			});

			const privateUdsDispatcher = createGatewayRuntimePrivateUdsDispatcher({
				approvalOperations: { decide: async () => ({ kind: 'rejected', reason: 'not-found' }) },
				artifactOperations: {
					read: async (): Promise<never> => {
						throw new Error('Artifact reads are outside the private-UDS approval proof.');
					},
				},
				portalOperations: composition.privateUdsProjection.portalOperations,
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
				const successorResults = await Promise.all([
					callToolPortal(client),
					callToolPortal(client),
				]);
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
					backendKind,
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
						config: selectedConfig,
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
						mcpProvider: createRecordingApprovedBackend('mcp_provider', backendInvocations),
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
				await composition.retireEpoch();
				await udsServer.retire();
				await Promise.all([
					rm(temporaryDirectoryPath, { force: true, recursive: true }),
					rm(udsTemporaryDirectoryPath, { force: true, recursive: true }),
				]);
			}
		},
	);
	it.each([
		'forged-reservation',
		'wrong-fingerprint',
		'wrong-approval-id',
		'receipt-reference-replay',
	] as const)('refuses %s at the adapter/controller boundary', async (scenario) => {
		const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-s2-forged-reservation-'));
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
		const effects: RecordedApprovedBackendInvocation[] = [];
		const controllerReservations: string[] = [];
		const offeredReservations: string[] = [];
		const armDispatch = vi.fn(
			async ({
				reservation,
			}: Pick<
				Parameters<ReturnType<typeof createControllerApprovalLedger>['armDispatch']>[0],
				'reservation'
			>) => await ledger.armDispatch({ authorityContext, reservation }),
		);
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
					if (result.kind !== 'dispatch-reserved' || scenario === 'receipt-reference-replay')
						return result;
					controllerReservations.push(result.reservation.reservationId);
					const reservation = GatewayRuntimeGatewayDispatchReservationSchema.parse({
						...result.reservation,
						...(scenario === 'forged-reservation'
							? { reservationId: '99999999-9999-4999-8999-999999999999' }
							: scenario === 'wrong-fingerprint'
								? { fingerprint: `sha256:${'f'.repeat(64)}` }
								: { approvalId: '99999999-9999-4999-8999-999999999999' }),
					});
					offeredReservations.push(reservation.reservationId);
					return {
						...result,
						reservation,
					};
				},
				armDispatch,
			},
			backendPorts: {
				controllerExecution: unexpectedBackendPort('controller_execution', 'controller'),
				mcpProvider: createRecordingApprovedBackend('mcp_provider', effects),
				toolVmRunner: unexpectedBackendPort('tool_vm_runner', 'runner'),
			},
		});
		const createOrRead = vi.spyOn(adapter.operations, 'createOrRead');
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
			if (scenario !== 'receipt-reference-replay') {
				expect(
					await adapter.call(portalCallRequest, {
						trustedContext: trustedInvocationContext,
						surfaceClass: 'protected_uds',
					}),
				).toMatchObject({ ok: false, items: [{ status: 'error' }] });
				if (scenario !== 'forged-reservation') {
					expect(controllerReservations).toHaveLength(1);
					expect(offeredReservations).toEqual(controllerReservations);
					expect(await createOrRead.mock.results[1]?.value).toEqual({ kind: 'denied' });
					expect(armDispatch).not.toHaveBeenCalled();
				}
				expect(effects).toEqual([]);
				expect(await ledger.read(pending.approvalChallenge.challengeId)).not.toMatchObject({
					kind: 'dispatch-armed',
				});
			} else {
				const reference = await adapter.register({
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
				const challenge = vi.spyOn(adapter.approvals, 'challenge');
				vi.spyOn(backend, 'invoke').mockImplementation(async (invocation) => {
					observed.push(invocation);
					return await originalInvoke(invocation);
				});
				expect(await adapter.dispatcher.dispatch(adapter.request(reference))).toMatchObject({
					kind: 'completed',
				});
				const original = observed[0];
				if (original === undefined) throw new Error('Expected neutral invoke');
				const issued = await challenge.mock.results[0]?.value;
				if (issued?.kind !== 'approved') throw new Error('Expected current approval receipt');
				expect(original.approvalReceiptRef).toBe(issued.receipt.reference);
				expect(original.verifiedContextRef).toBe(reference);
				expect(await backend.invoke(original)).toMatchObject({ kind: 'not-dispatched' });
				expect(effects).toHaveLength(1);
				adapter.release(reference);
			}
		} finally {
			await rm(directoryPath, { recursive: true, force: true });
		}
	});
});
