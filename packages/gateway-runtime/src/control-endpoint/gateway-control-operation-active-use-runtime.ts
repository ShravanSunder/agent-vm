import { createHash } from 'node:crypto';

import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import {
	deriveGatewayControlStablePrincipal,
	type GatewayControlLeaseRejectionReason,
	type GatewayControlLeaseUseSnapshot,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import { z } from 'zod';

import type {
	GatewayRuntimeToolVmRunnerBoundSandbox,
	GatewayRuntimeToolVmRunnerRejectedSandboxBinding,
} from '../backends/tool-vm-runner-backend-port.js';
import {
	createGatewayRuntimeSandboxOperationAuthority,
	type GatewayRuntimeSandboxOperationAuthority,
	type GatewayRuntimeSandboxOperationContext,
} from '../sandbox/sandbox-operation-authority.js';
import type { GatewayRuntimeSandboxProcessRegistry } from '../sandbox/sandbox-process-registry.js';
import type {
	StrictToolVmSshClient,
	StrictToolVmSshProcessChannelClient,
	StrictToolVmSshTransportFailureSubscription,
} from '../sandbox/strict-tool-vm-ssh-client.js';
import type {
	GatewayControlCallerContextRegistrationClient,
	GatewayControlRegisteredCallerContext,
} from './gateway-control-caller-context-registration-client.js';
import type {
	GatewayRuntimeControlCommand,
	GatewayRuntimeControlCommandClient,
	GatewayRuntimeControlCommandResponse,
} from './gateway-control-command-client.js';
import type {
	GatewayControlAcceptedSession,
	GatewayControlService,
} from './gateway-control-endpoint-contracts.js';
import type {
	GatewayControlPublishedBindingGeneration,
	GatewayControlPublishedBindingRuntime,
	GatewayControlPublishedBindingState,
} from './gateway-control-published-binding-runtime.js';
import {
	createGatewayControlReplacementSessionUseEndRuntime,
	type GatewayControlOperationActiveUseReleaseReason,
} from './gateway-control-replacement-session-use-end-runtime.js';

const UuidSchema = z.string().uuid();
export type { GatewayControlOperationActiveUseReleaseReason } from './gateway-control-replacement-session-use-end-runtime.js';

export interface GatewayControlOperationActiveUseScheduler {
	readonly schedule: (
		callback: () => void,
		delayMilliseconds: number,
	) => { readonly cancel: () => void };
}

export interface GatewayControlOperationActiveUseProcessRegistryFactoryRequest {
	readonly operationAuthority: GatewayRuntimeSandboxOperationAuthority;
	readonly operationContext: GatewayRuntimeSandboxOperationContext;
	readonly strictSshClient: StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
}

export interface GatewayControlOperationActiveUseAcquisition extends GatewayRuntimeToolVmRunnerBoundSandbox {
	readonly endActiveUse: (reason: GatewayControlOperationActiveUseReleaseReason) => Promise<void>;
	readonly retireGroup: (reason: GatewayControlOperationActiveUseReleaseReason) => Promise<void>;
}

export type GatewayControlOperationActiveUseAcquisitionResult =
	| GatewayControlOperationActiveUseAcquisition
	| GatewayRuntimeToolVmRunnerRejectedSandboxBinding;

export interface GatewayControlOperationActiveUseAcquisitionPort {
	readonly acquire: (request: {
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}) => Promise<GatewayControlOperationActiveUseAcquisitionResult>;
}

export interface CreateGatewayControlOperationActiveUseRuntimeProps {
	readonly callerContextRegistrationClient: Pick<
		GatewayControlCallerContextRegistrationClient,
		'close' | 'register'
	>;
	readonly commandTtlMs?: number;
	readonly controlCommandClient: GatewayRuntimeControlCommandClient;
	readonly controlService: Pick<
		GatewayControlService,
		'getCurrentAcceptedSession' | 'observeSessionState'
	>;
	readonly createProcessRegistry: (
		request: GatewayControlOperationActiveUseProcessRegistryFactoryRequest,
	) => GatewayRuntimeSandboxProcessRegistry;
	readonly createCommandId: () => string;
	readonly createUseId: () => string;
	readonly now?: () => number;
	readonly publishedBindingRuntime: Pick<
		GatewayControlPublishedBindingRuntime,
		'lookupReadyConnection'
	>;
	readonly scheduler: GatewayControlOperationActiveUseScheduler;
}

export interface GatewayControlOperationActiveUseRuntime {
	readonly acquisitionPort: GatewayControlOperationActiveUseAcquisitionPort;
	readonly retire: () => Promise<void>;
}

interface OperationGroupState {
	activeUseEndPromise: Promise<void> | undefined;
	readonly acceptedSession: GatewayControlAcceptedSession;
	readonly callerContext: GatewayControlRegisteredCallerContext;
	heartbeatHandle: { readonly cancel: () => void } | undefined;
	heartbeatSequence: number;
	groupRetirementPromise: Promise<void> | undefined;
	readonly leaseUse: GatewayControlLeaseUseSnapshot;
	readonly operationAuthority: GatewayRuntimeSandboxOperationAuthority;
	readonly operationContext: GatewayRuntimeSandboxOperationContext;
	readonly processRegistry: GatewayRuntimeSandboxProcessRegistry;
	readonly strictSshClient: StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
	transportFailureSubscription: StrictToolVmSshTransportFailureSubscription | undefined;
}

function requirePositiveSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer.`);
	}
	return value;
}

function correlationForControl(
	trustedContext: GatewayRuntimeTrustedInvocationContext,
): { readonly runId?: string; readonly toolCallId?: string } | undefined {
	const correlation = trustedContext.correlation;
	if (correlation?.runId === undefined && correlation?.toolCallId === undefined) return undefined;
	return {
		...(correlation.runId === undefined ? {} : { runId: correlation.runId }),
		...(correlation.toolCallId === undefined ? {} : { toolCallId: correlation.toolCallId }),
	};
}

function environmentGeneration(props: {
	readonly gatewayEpoch: string;
	readonly generation: GatewayControlPublishedBindingGeneration;
	readonly useId: string;
}): string {
	const digest = createHash('sha256')
		.update(
			JSON.stringify([
				props.gatewayEpoch,
				props.generation.leafGeneration,
				props.generation.sshBindingId,
				props.useId,
			]),
			'utf8',
		)
		.digest('hex');
	return `tool-vm-environment:${digest}`;
}

const unavailableBinding = (
	trustedContext: GatewayRuntimeTrustedInvocationContext,
): GatewayRuntimeToolVmRunnerRejectedSandboxBinding => ({
	kind: 'not-bound',
	owningGeneration: trustedContext.principal.profileAssignmentRevision,
	reason: 'unavailable',
});

function activeUseMatches(options: {
	readonly expectedLeaseId: string;
	readonly expectedState: 'active' | 'ended';
	readonly expectedUseId: string;
	readonly leaseUse: GatewayControlLeaseUseSnapshot;
}): boolean {
	return (
		options.leaseUse.leaseId === options.expectedLeaseId &&
		options.leaseUse.useId === options.expectedUseId &&
		options.leaseUse.state === options.expectedState
	);
}

function rejectedLeaseUseRequiresBindingRecovery(
	reason: GatewayControlLeaseRejectionReason,
): boolean {
	switch (reason) {
		case 'lease_absent':
		case 'lease_authority_absent':
		case 'lease_force_released':
		case 'lease_generation_stale':
		case 'lease_reacquire_required':
		case 'lease_releasing':
		case 'lease_retired':
			return true;
		case 'caller_context_absent':
		case 'caller_context_session_mismatch':
		case 'caller_context_stale':
		case 'lease_use_tombstoned':
		case 'ownership_denied':
		case 'runtime_not_ready':
			return false;
	}
	const exhaustiveReason: never = reason;
	return exhaustiveReason;
}

function rejectedLeaseUseProvesTerminalAbsence(
	reason: GatewayControlLeaseRejectionReason,
): boolean {
	switch (reason) {
		case 'lease_absent':
		case 'lease_authority_absent':
		case 'lease_force_released':
		case 'lease_retired':
		case 'lease_use_tombstoned':
			return true;
		case 'caller_context_absent':
		case 'caller_context_session_mismatch':
		case 'caller_context_stale':
		case 'lease_generation_stale':
		case 'lease_reacquire_required':
		case 'lease_releasing':
		case 'ownership_denied':
		case 'runtime_not_ready':
			return false;
	}
	const exhaustiveReason: never = reason;
	return exhaustiveReason;
}

function bindingGenerationsMatch(
	left: GatewayControlPublishedBindingGeneration,
	right: GatewayControlPublishedBindingGeneration,
): boolean {
	return (
		left.agentId === right.agentId &&
		left.leafGeneration === right.leafGeneration &&
		left.leaseId === right.leaseId &&
		left.profileAssignmentRevision === right.profileAssignmentRevision &&
		left.sshBindingId === right.sshBindingId &&
		left.stablePrincipal === right.stablePrincipal &&
		left.zoneId === right.zoneId
	);
}

export function createGatewayControlOperationActiveUseRuntime(
	props: CreateGatewayControlOperationActiveUseRuntimeProps,
): GatewayControlOperationActiveUseRuntime {
	const commandTtlMs = requirePositiveSafeInteger(
		props.commandTtlMs ?? 15_000,
		'Gateway control command TTL',
	);
	const now = props.now ?? Date.now;
	const operationGroups = new Set<OperationGroupState>();
	const pendingBindingRequestsByPrincipal = new Map<
		GatewayStablePrincipalDigest,
		{
			readonly acceptedSession: GatewayControlAcceptedSession;
			readonly promise: Promise<void>;
		}
	>();
	let closed = false;
	let retirementPromise: Promise<void> | undefined;

	function currentSession(expected: GatewayControlAcceptedSession): boolean {
		return !closed && props.controlService.getCurrentAcceptedSession() === expected;
	}

	async function sendAuthorityCommand(options: {
		readonly admissionPrincipal: GatewayStablePrincipalDigest;
		readonly idempotencyKey: string;
		readonly message: GatewayRuntimeControlCommand;
	}): Promise<GatewayRuntimeControlCommandResponse> {
		const observedAtMs = requirePositiveSafeInteger(now(), 'Gateway control command clock');
		return await props.controlCommandClient.sendCommand({
			admissionPrincipal: options.admissionPrincipal,
			commandId: UuidSchema.parse(props.createCommandId()),
			expiresAtMs: requirePositiveSafeInteger(
				observedAtMs + commandTtlMs,
				'Gateway control command expiry',
			),
			idempotencyKey: options.idempotencyKey,
			message: options.message,
		});
	}

	async function recoverBinding(
		trustedContext: GatewayRuntimeTrustedInvocationContext,
		stablePrincipal: GatewayStablePrincipalDigest,
		initialState: GatewayControlPublishedBindingState,
	): Promise<void> {
		const acceptedSession = props.controlService.getCurrentAcceptedSession();
		if (closed || acceptedSession === undefined) return;
		const existingRequest = pendingBindingRequestsByPrincipal.get(stablePrincipal);
		if (existingRequest?.acceptedSession === acceptedSession) {
			return await existingRequest.promise;
		}
		const requestPromise = (async (): Promise<void> => {
			const callerContext = await props.callerContextRegistrationClient.register({
				purpose: 'tool_vm_lease',
				trustedContext,
			});
			if (
				callerContext.admissionPrincipal !== stablePrincipal ||
				!currentSession(acceptedSession)
			) {
				throw new Error('Tool VM binding request caller authority is stale or mismatched.');
			}
			const correlation = correlationForControl(trustedContext);
			if (initialState.kind === 'degraded') {
				const reacquireResponse = await sendAuthorityCommand({
					admissionPrincipal: callerContext.admissionPrincipal,
					idempotencyKey: `lease-reacquire:${acceptedSession.sessionId}:${initialState.generation.leaseId}`,
					message: {
						kind: 'command',
						operation: 'lease_reacquire',
						payload: {
							callerContext: { callerContextId: callerContext.callerContextId },
							...(correlation === undefined ? {} : { correlation }),
							oldLeaseId: initialState.generation.leaseId,
							staleEvidence: {
								kind: 'tool-vm-ssh',
								observedAtMs: requirePositiveSafeInteger(now(), 'Tool VM stale evidence clock'),
								operation: 'command',
							},
						},
					},
				});
				if (
					!currentSession(acceptedSession) ||
					reacquireResponse.acceptedSession !== acceptedSession ||
					reacquireResponse.response.operation !== 'lease_reacquire' ||
					reacquireResponse.response.payload.result !== 'ok' ||
					reacquireResponse.response.payload.lease.leaseId === initialState.generation.leaseId
				) {
					throw new Error('Controller returned a mismatched Tool VM lease reacquire result.');
				}
			}
			const response = await sendAuthorityCommand({
				admissionPrincipal: callerContext.admissionPrincipal,
				idempotencyKey: `tool-vm-binding-request:${acceptedSession.sessionId}:${stablePrincipal}`,
				message: {
					kind: 'command',
					operation: 'tool_vm_binding_request',
					payload: {
						callerContext: { callerContextId: callerContext.callerContextId },
						...(correlation === undefined ? {} : { correlation }),
					},
				},
			});
			if (
				!currentSession(acceptedSession) ||
				response.acceptedSession !== acceptedSession ||
				response.response.operation !== 'tool_vm_binding_request'
			) {
				throw new Error('Tool VM binding request crossed its accepted control session.');
			}
			const payload = response.response.payload;
			if (
				payload.result !== 'ok' ||
				payload.bindingRequest.status !== 'publication_pending' ||
				payload.bindingRequest.agentId !== trustedContext.principal.agentId ||
				payload.bindingRequest.stablePrincipal !== stablePrincipal
			) {
				throw new Error('Controller returned a mismatched Tool VM binding request result.');
			}
		})();
		pendingBindingRequestsByPrincipal.set(stablePrincipal, {
			acceptedSession,
			promise: requestPromise,
		});
		try {
			await requestPromise;
		} finally {
			if (pendingBindingRequestsByPrincipal.get(stablePrincipal)?.promise === requestPromise) {
				pendingBindingRequestsByPrincipal.delete(stablePrincipal);
			}
		}
	}

	async function bestEffortEndUse(options: {
		readonly acceptedSession: GatewayControlAcceptedSession;
		readonly callerContext: GatewayControlRegisteredCallerContext;
		readonly leaseId: string;
		reason: GatewayControlOperationActiveUseReleaseReason;
		readonly useId: string;
	}): Promise<boolean> {
		if (props.controlService.getCurrentAcceptedSession() !== options.acceptedSession) return false;
		try {
			const response = await sendAuthorityCommand({
				admissionPrincipal: options.callerContext.admissionPrincipal,
				idempotencyKey: `lease-use-end:${options.leaseId}:${options.useId}`,
				message: {
					kind: 'command',
					operation: 'lease_use_end',
					payload: {
						callerContext: { callerContextId: options.callerContext.callerContextId },
						leaseId: options.leaseId,
						reason: options.reason,
						useId: options.useId,
					},
				},
			});
			if (
				response.acceptedSession !== options.acceptedSession ||
				response.response.operation !== 'lease_use_end'
			) {
				return false;
			}
			if (response.response.payload.result === 'rejected') {
				return rejectedLeaseUseProvesTerminalAbsence(
					response.response.payload.leaseRejectionReason,
				);
			}
			if (
				response.response.payload.result !== 'ok' ||
				!activeUseMatches({
					expectedLeaseId: options.leaseId,
					expectedState: 'ended',
					expectedUseId: options.useId,
					leaseUse: response.response.payload.leaseUse,
				})
			) {
				return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	const replacementSessionUseEndRuntime = createGatewayControlReplacementSessionUseEndRuntime({
		callerContextRegistrationClient: props.callerContextRegistrationClient,
		controlService: props.controlService,
		endUse: bestEffortEndUse,
	});

	function endActiveUse(
		state: OperationGroupState,
		reason: GatewayControlOperationActiveUseReleaseReason,
	): Promise<void> {
		if (state.activeUseEndPromise !== undefined) return state.activeUseEndPromise;
		state.heartbeatHandle?.cancel();
		state.heartbeatHandle = undefined;
		state.activeUseEndPromise = (async (): Promise<void> => {
			const ended = await bestEffortEndUse({
				acceptedSession: state.acceptedSession,
				callerContext: state.callerContext,
				leaseId: state.operationContext.leaseId,
				reason,
				useId: state.leaseUse.useId,
			});
			if (!ended) {
				replacementSessionUseEndRuntime.queue({
					leaseId: state.operationContext.leaseId,
					reason,
					stablePrincipal: state.operationContext.stablePrincipal,
					useId: state.leaseUse.useId,
				});
			}
		})();
		return state.activeUseEndPromise;
	}

	function retireGroup(
		state: OperationGroupState,
		reason: GatewayControlOperationActiveUseReleaseReason,
	): Promise<void> {
		if (state.groupRetirementPromise !== undefined) return state.groupRetirementPromise;
		state.operationAuthority.beginReplacement({
			replacementLeafGeneration: `${state.operationContext.leafGeneration}:retired`,
		});
		state.transportFailureSubscription?.unsubscribe();
		state.transportFailureSubscription = undefined;
		state.groupRetirementPromise = (async (): Promise<void> => {
			try {
				await Promise.all([endActiveUse(state, reason), state.processRegistry.retire()]);
			} finally {
				operationGroups.delete(state);
			}
		})();
		return state.groupRetirementPromise;
	}

	function scheduleHeartbeat(state: OperationGroupState, delayMilliseconds: number): void {
		if (
			closed ||
			state.activeUseEndPromise !== undefined ||
			state.groupRetirementPromise !== undefined ||
			!currentSession(state.acceptedSession)
		)
			return;
		state.heartbeatHandle = props.scheduler.schedule(() => {
			void (async (): Promise<void> => {
				try {
					if (
						!currentSession(state.acceptedSession) ||
						state.activeUseEndPromise !== undefined ||
						state.groupRetirementPromise !== undefined
					) {
						await retireGroup(state, 'failed');
						return;
					}
					state.heartbeatSequence += 1;
					const response = await sendAuthorityCommand({
						admissionPrincipal: state.callerContext.admissionPrincipal,
						idempotencyKey: `lease-use-heartbeat:${state.operationContext.leaseId}:${state.leaseUse.useId}:${String(state.heartbeatSequence)}`,
						message: {
							kind: 'command',
							operation: 'lease_use_heartbeat',
							payload: {
								callerContext: {
									callerContextId: state.callerContext.callerContextId,
								},
								leaseId: state.operationContext.leaseId,
								observedAtMs: requirePositiveSafeInteger(
									now(),
									'Tool VM active-use heartbeat clock',
								),
								useId: state.leaseUse.useId,
							},
						},
					});
					if (
						!currentSession(state.acceptedSession) ||
						response.acceptedSession !== state.acceptedSession ||
						response.response.operation !== 'lease_use_heartbeat' ||
						response.response.payload.result !== 'ok' ||
						!activeUseMatches({
							expectedLeaseId: state.operationContext.leaseId,
							expectedState: 'active',
							expectedUseId: state.leaseUse.useId,
							leaseUse: response.response.payload.leaseUse,
						})
					) {
						throw new Error('Tool VM active-use heartbeat authority is stale.');
					}
					const nextDelay = requirePositiveSafeInteger(
						response.response.payload.leaseUse.heartbeatAfterMs ?? 0,
						'Tool VM active-use heartbeat delay',
					);
					scheduleHeartbeat(state, nextDelay);
				} catch {
					await retireGroup(state, 'failed');
				}
			})();
		}, delayMilliseconds);
	}

	async function acquireWithControllerAuthorityRecovery(
		request: {
			readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
		},
		controllerAuthorityRecoveryAttempted: boolean,
	): Promise<GatewayControlOperationActiveUseAcquisitionResult> {
		if (closed) return unavailableBinding(request.trustedContext);
		const stablePrincipal = deriveGatewayControlStablePrincipal({
			principal: request.trustedContext.principal,
		});
		if (
			!(await replacementSessionUseEndRuntime.settle({
				stablePrincipal,
				trustedContext: request.trustedContext,
			}))
		) {
			return unavailableBinding(request.trustedContext);
		}
		let readyBinding = props.publishedBindingRuntime.lookupReadyConnection(request);
		if (readyBinding.kind !== 'ready') {
			try {
				await recoverBinding(request.trustedContext, stablePrincipal, readyBinding.state);
			} catch {
				return unavailableBinding(request.trustedContext);
			}
			readyBinding = props.publishedBindingRuntime.lookupReadyConnection(request);
			if (readyBinding.kind !== 'ready') {
				return unavailableBinding(request.trustedContext);
			}
		}
		const acceptedSession = props.controlService.getCurrentAcceptedSession();
		if (
			acceptedSession === undefined ||
			readyBinding.generation.stablePrincipal !== stablePrincipal ||
			readyBinding.generation.agentId !== request.trustedContext.principal.agentId ||
			readyBinding.generation.profileAssignmentRevision !==
				request.trustedContext.principal.profileAssignmentRevision ||
			readyBinding.generation.zoneId !== acceptedSession.zoneId
		) {
			return unavailableBinding(request.trustedContext);
		}

		let callerContext: GatewayControlRegisteredCallerContext | undefined;
		let useId: string | undefined;
		try {
			callerContext = await props.callerContextRegistrationClient.register({
				purpose: 'tool_vm_lease',
				trustedContext: request.trustedContext,
			});
			if (
				callerContext.admissionPrincipal !== stablePrincipal ||
				!currentSession(acceptedSession)
			) {
				throw new Error('Tool VM active-use caller authority is stale or mismatched.');
			}
			useId = UuidSchema.parse(props.createUseId());
			const correlation = correlationForControl(request.trustedContext);
			const startResponse = await sendAuthorityCommand({
				admissionPrincipal: callerContext.admissionPrincipal,
				idempotencyKey: `lease-use-start:${readyBinding.generation.leaseId}:${useId}`,
				message: {
					kind: 'command',
					operation: 'lease_use_start',
					payload: {
						callerContext: { callerContextId: callerContext.callerContextId },
						...(correlation === undefined ? {} : { correlation }),
						leaseId: readyBinding.generation.leaseId,
						useId,
					},
				},
			});
			if (
				!controllerAuthorityRecoveryAttempted &&
				currentSession(acceptedSession) &&
				startResponse.acceptedSession === acceptedSession &&
				startResponse.response.operation === 'lease_use_start' &&
				startResponse.response.payload.result === 'rejected' &&
				rejectedLeaseUseRequiresBindingRecovery(startResponse.response.payload.leaseRejectionReason)
			) {
				useId = undefined;
				await recoverBinding(request.trustedContext, stablePrincipal, {
					kind: 'unbound',
					stablePrincipal,
				});
				return await acquireWithControllerAuthorityRecovery(request, true);
			}
			if (
				!currentSession(acceptedSession) ||
				startResponse.acceptedSession !== acceptedSession ||
				startResponse.response.operation !== 'lease_use_start' ||
				startResponse.response.payload.result !== 'ok' ||
				!activeUseMatches({
					expectedLeaseId: readyBinding.generation.leaseId,
					expectedState: 'active',
					expectedUseId: useId,
					leaseUse: startResponse.response.payload.leaseUse,
				})
			) {
				throw new Error('Controller returned a mismatched Tool VM active-use start.');
			}
			const currentReadyBinding = props.publishedBindingRuntime.lookupReadyConnection(request);
			if (
				currentReadyBinding.kind !== 'ready' ||
				currentReadyBinding.connection !== readyBinding.connection ||
				!bindingGenerationsMatch(currentReadyBinding.generation, readyBinding.generation)
			) {
				throw new Error('Published Tool VM binding changed during active-use start.');
			}
			const operationContext = {
				activeUseId: useId,
				environmentGeneration: environmentGeneration({
					gatewayEpoch: acceptedSession.gatewayEpoch,
					generation: readyBinding.generation,
					useId,
				}),
				gatewayEpoch: acceptedSession.gatewayEpoch,
				leafGeneration: readyBinding.generation.leafGeneration,
				leaseId: readyBinding.generation.leaseId,
				sshBindingId: readyBinding.generation.sshBindingId,
				stablePrincipal,
			} satisfies GatewayRuntimeSandboxOperationContext;
			const operationAuthority = createGatewayRuntimeSandboxOperationAuthority(operationContext);
			const processRegistry = props.createProcessRegistry({
				operationAuthority,
				operationContext,
				strictSshClient: readyBinding.connection,
			});
			const state: OperationGroupState = {
				activeUseEndPromise: undefined,
				acceptedSession,
				callerContext,
				groupRetirementPromise: undefined,
				heartbeatHandle: undefined,
				heartbeatSequence: 0,
				leaseUse: startResponse.response.payload.leaseUse,
				operationAuthority,
				operationContext,
				processRegistry,
				strictSshClient: readyBinding.connection,
				transportFailureSubscription: undefined,
			};
			operationGroups.add(state);
			state.transportFailureSubscription = readyBinding.connection.observeTransportFailure(() => {
				void retireGroup(state, 'failed');
			});
			scheduleHeartbeat(
				state,
				requirePositiveSafeInteger(
					state.leaseUse.heartbeatAfterMs ?? 0,
					'Tool VM active-use heartbeat delay',
				),
			);
			return {
				endActiveUse: async (reason) => await endActiveUse(state, reason),
				environmentGeneration: operationContext.environmentGeneration,
				kind: 'bound',
				operationAuthority,
				operationContext,
				processRegistry,
				retireGroup: async (reason) => await retireGroup(state, reason),
				strictSshClient: readyBinding.connection,
			};
		} catch {
			if (callerContext !== undefined && useId !== undefined && currentSession(acceptedSession)) {
				await bestEffortEndUse({
					acceptedSession,
					callerContext,
					leaseId: readyBinding.generation.leaseId,
					reason: 'failed',
					useId,
				});
			}
			return unavailableBinding(request.trustedContext);
		}
	}

	const sessionObservation = props.controlService.observeSessionState(
		(session) => {
			for (const state of operationGroups) {
				if (session === state.acceptedSession) continue;
				void retireGroup(state, 'failed');
			}
		},
		() => undefined,
	);

	function retire(): Promise<void> {
		if (retirementPromise !== undefined) return retirementPromise;
		closed = true;
		sessionObservation.unsubscribe();
		pendingBindingRequestsByPrincipal.clear();
		replacementSessionUseEndRuntime.close();
		retirementPromise = (async (): Promise<void> => {
			await Promise.all(
				[...operationGroups].map(async (state) => await retireGroup(state, 'cancelled')),
			);
			await props.callerContextRegistrationClient.close();
		})();
		return retirementPromise;
	}

	return {
		acquisitionPort: {
			acquire: async (request) => await acquireWithControllerAuthorityRecovery(request, false),
		},
		retire,
	};
}
