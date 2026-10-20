import { randomUUID } from 'node:crypto';

import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import {
	jsonValueSchema,
	revisionRef,
	type AssessAccessInput,
	type AccountFact,
} from '@agent-collaboration/tool-access/contracts';
import {
	canonicalDispatchJson,
	createCapabilityDispatcher,
	type ApprovalPort,
	type ApprovalReceipt,
	type BackendKind,
	type DispatchInvocation,
	type DispatchRequest,
	type OperationPort,
	type OperationRecord,
	type ResourceResult,
	type ToolBackend,
} from '@agent-collaboration/tool-engine/dispatch';
import {
	PortalCallResultSchema,
	type PortalCallRequest,
	type PortalCallResult,
} from '@agent-vm/agent-portal-sdk';
import {
	gatewayRuntimeManagedToolPortalConfigSchema,
	type GatewayRuntimeManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayRuntimeApprovalFingerprint,
	deriveGatewayRuntimeApprovalId,
	GatewayRuntimePortalSemanticSnapshotSchema,
	type GatewayRuntimeApprovalAdmissionResult,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeApprovalDispatchGrant,
	type GatewayRuntimeGatewayDispatchReservation,
	type GatewayRuntimePortalSemanticSnapshot,
	type GatewayRuntimeToolPortalDispatchAuthority,
} from '@agent-vm/gateway-control-contracts';
import type { GatewayRuntimeApprovalDecisionOperations } from '@agent-vm/gateway-runtime';
import { createManagedAccessRequest } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access-request.js';
import {
	createManagedEngineBackends,
	type ManagedBackendPorts,
} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-backend-projection.js';
import { createManagedPortalCallProjection } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-call-projection.js';
import { resolveManagedGoogleBinding } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-google-binding.js';
import {
	assertManagedNeutralBinding,
	resolveManagedEngineInvocation,
	type ManagedEngineInvocationContext,
} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-invocation-authority.js';
import {
	managedGoogleReadyPreflightSchema,
	type ManagedGoogleReadyPreflight,
} from '@agent-vm/oauth-broker-contracts';
import type { ToolPortalApprovalPort } from '@agent-vm/tool-portal';
import {
	deterministicOperationId,
	directDispatchFingerprint,
} from '@agent-vm/tool-portal/dispatch-authority';

interface ManagedDispatchEntry {
	readonly context: ManagedEngineInvocationContext;
	readonly call: PortalCallRequest['calls'][number];
	readonly accounts: readonly AccountFact[];
	readonly managedGoogle: ManagedGoogleReadyPreflight | null;
	admission: GatewayRuntimeApprovalAdmissionResult | null;
	reservation: GatewayRuntimeGatewayDispatchReservation | null;
	grant: GatewayRuntimeApprovalDispatchGrant | null;
	receipt: ApprovalReceipt | null;
	record: OperationRecord | null;
}

export interface ManagedToolEngineAdapter {
	readonly backends: ReadonlyMap<BackendKind, ToolBackend<BackendKind>>;
	readonly operations: OperationPort;
	readonly approvals: ApprovalPort;
	readonly assessAccess: ReturnType<typeof createAccessAssessor>;
	readonly dispatcher: ReturnType<typeof createCapabilityDispatcher>;
	readonly register: (props: {
		readonly context: ManagedEngineInvocationContext;
		readonly call: PortalCallRequest['calls'][number];
		readonly accounts?: readonly AccountFact[];
		readonly managedGoogle?: ManagedGoogleReadyPreflight;
	}) => string;
	readonly release: (reference: string) => void;
	readonly request: (reference: string) => DispatchRequest;
	readonly call: (
		request: PortalCallRequest,
		context: ManagedEngineInvocationContext,
	) => Promise<PortalCallResult>;
}
function assertNever(value: never): never {
	throw new Error(`Unknown managed dispatch variant: ${String(value)}`);
}

/** Owns managed references, not permission or operation history. The controller keeps the ledger. */
export function createManagedToolEngineAdapter(props: {
	readonly authority: string;
	readonly configuration: {
		readonly config: GatewayRuntimeManagedToolPortalConfig;
		readonly revision: AssessAccessInput['facts']['assignment']['revision'];
	};
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly approvalPort: ToolPortalApprovalPort;
	readonly approvalDecisions?: GatewayRuntimeApprovalDecisionOperations;
	readonly backendPorts: ManagedBackendPorts;
	readonly now: () => number;
	readonly factsRejected?: (reason: string) => void;
}): ManagedToolEngineAdapter {
	const config = gatewayRuntimeManagedToolPortalConfigSchema.parse(props.configuration.config);
	const snapshot = GatewayRuntimePortalSemanticSnapshotSchema.parse(props.semanticSnapshot);
	const configurationRevision = revisionRef.parse(props.configuration.revision);
	// The workspace layer is a property of this host configuration, never of an incoming fact.
	const assessAccess = createAccessAssessor({
		workspaceLayer: 'not-configured',
		config: configurationRevision,
	});
	const entries = new Map<string, ManagedDispatchEntry>();
	function entry(reference: string): ManagedDispatchEntry {
		const selected = entries.get(reference);
		if (selected === undefined) throw new Error('Unknown managed context reference.');
		return selected;
	}
	function request(reference: string): DispatchRequest {
		const selected = entry(reference);
		return createManagedAccessRequest({
			authority: props.authority,
			config,
			snapshot,
			reference,
			context: selected.context,
			call: selected.call,
			accounts: selected.accounts,
		});
	}

	function validate(invocation: DispatchInvocation): {
		readonly selected: ManagedDispatchEntry;
		readonly current: DispatchRequest;
		readonly managed: ReturnType<typeof resolveManagedEngineInvocation>;
		readonly needsApproval: boolean;
	} {
		const selected = entry(invocation.verifiedContextRef);
		const current = request(invocation.verifiedContextRef);
		assertManagedNeutralBinding({ authority: props.authority, invocation, request: current });
		const policy =
			current.access.facts.assignment.profile.namespaces[invocation.capability.namespace];
		if (
			policy?.backendKind !== invocation.backendKind ||
			selected.call.namespace !== invocation.capability.namespace ||
			selected.call.name !== invocation.capability.tool ||
			canonicalDispatchJson(selected.call.arguments) !== canonicalDispatchJson(invocation.arguments)
		)
			throw new Error('Managed capability or intent changed.');
		const result = assessAccess(current.access);
		if (
			result.kind !== 'assessed' ||
			result.assessment.kind !== 'fixed' ||
			(result.assessment.state.kind !== 'usable' &&
				result.assessment.state.kind !== 'approval-each-call')
		)
			throw new Error('Managed final policy fence refused.');
		return {
			selected,
			current,
			managed: resolveManagedEngineInvocation({
				config,
				semanticSnapshot: snapshot,
				context: selected.context,
			}),
			needsApproval: result.assessment.state.kind === 'approval-each-call',
		};
	}
	function intent(invocation: DispatchInvocation): GatewayRuntimeApprovalChallengeIntent {
		const { selected, managed } = validate(invocation);
		const managedGoogle = resolveManagedGoogleBinding({
			config,
			profileId: managed.profileId,
			call: selected.call,
			preflight: selected.managedGoogle,
		});
		return {
			...(managedGoogle === undefined ? {} : { managedGoogle }),
			backendKind: invocation.backendKind,
			call: selected.call,
			operationId: deterministicOperationId({
				callId: selected.call.id,
				semanticRevision: snapshot.activeRevision,
				stablePrincipal: managed.stablePrincipal,
				surfaceClass: selected.context.surfaceClass,
			}),
			semanticRevisions: {
				activeRevision: snapshot.activeRevision,
				bindingRevision: snapshot.bindingRevision,
				catalogRevision: snapshot.catalogRevision,
				profilePolicyRevision: snapshot.profilePolicyRevision,
				providerRevision: snapshot.providerRevision,
				schemaRevision: snapshot.schemaRevision,
			},
			surfaceClass: selected.context.surfaceClass,
			trustedContext: selected.context.trustedContext,
		};
	}
	function record(
		invocation: DispatchInvocation,
		state: OperationRecord['state'],
		revision: string,
	): OperationRecord {
		const timestamp = new Date(props.now()).toISOString();
		return {
			version: 'tool-operation-v1',
			key: invocation.operationKey,
			intentDigest: invocation.intentDigest,
			createdAt: timestamp,
			updatedAt: timestamp,
			revision,
			state,
		};
	}
	const operations: OperationPort = {
		lookup: async () => ({ kind: 'unsupported-version' }),
		createOrRead: async ({ invocation, requiresApproval }) => {
			const { selected, managed, needsApproval } = validate(invocation);
			if (requiresApproval !== needsApproval) return { kind: 'denied' };
			if (!needsApproval) return { kind: 'untracked' };
			const admission = await props.approvalPort.reserveDispatch({ intent: intent(invocation) });
			selected.admission = admission;
			if (admission.kind === 'not-dispatched') return { kind: 'denied' };
			if (admission.kind === 'ambiguous') {
				const held = record(
					invocation,
					{ kind: 'ambiguous', reason: 'managed-dispatch-held' },
					'held',
				);
				selected.record = held;
				return { kind: 'existing', record: held };
			}
			if (admission.kind === 'dispatch-reserved') {
				const expected = intent(invocation);
				const reservation = admission.reservation;
				const fingerprint = deriveGatewayRuntimeApprovalFingerprint({
					authorityContext: reservation.authorityContext,
					intent: expected,
				});
				if (
					reservation.operationId !== expected.operationId ||
					reservation.backendKind !== expected.backendKind ||
					reservation.stablePrincipal !== managed.stablePrincipal ||
					reservation.fingerprint !== fingerprint ||
					reservation.approvalId !== deriveGatewayRuntimeApprovalId(fingerprint)
				)
					return { kind: 'denied' };
				selected.reservation = reservation;
				selected.receipt = {
					reference: randomUUID(),
					decision: 'approve',
					authoritativeRevision: { owner: props.authority, revision: reservation.fingerprint },
					operationKey: invocation.operationKey,
					intentDigest: invocation.intentDigest,
					backendKind: invocation.backendKind,
					bindingRevision: invocation.bindingRevision,
					admissionRevisions: invocation.admissionRevisions,
					verifiedContextRef: invocation.verifiedContextRef,
					expiresAt: reservation.expiresAt,
				};
			}
			const pending = record(
				invocation,
				{
					kind: 'pending',
					reference:
						admission.kind === 'approval-required'
							? admission.challenge.approvalId
							: admission.reservation.reservationId,
				},
				admission.kind === 'approval-required'
					? admission.challenge.approvalId
					: admission.reservation.reservationId,
			);
			selected.record = pending;
			return { kind: 'created', record: pending };
		},
		transition: async ({ invocation, expectedRevision, next }) => {
			const { selected } = validate(invocation);
			if (
				selected.record?.revision !== expectedRevision ||
				selected.receipt === null ||
				invocation.approvalReceiptRef !== selected.receipt.reference
			)
				return { kind: 'denied' };
			if (next.kind === 'armed' && selected.reservation === null) return { kind: 'denied' };
			if (
				next.kind === 'armed' &&
				selected.reservation !== null &&
				selected.reservation.backendKind !== 'controller_execution'
			) {
				const armed = await props.approvalPort.armDispatch({ reservation: selected.reservation });
				if (armed.kind !== 'dispatch-armed') return { kind: 'denied' };
				const { reservation } = selected;
				if (
					armed.grant.approvalId !== reservation.approvalId ||
					armed.grant.operationId !== reservation.operationId ||
					armed.grant.fingerprint !== reservation.fingerprint ||
					armed.grant.stablePrincipal !== reservation.stablePrincipal ||
					armed.grant.backendKind !== reservation.backendKind ||
					armed.grant.expiresAt !== reservation.expiresAt ||
					JSON.stringify(armed.grant.authorityContext) !==
						JSON.stringify(reservation.authorityContext)
				)
					return { kind: 'denied' };
				selected.grant = armed.grant;
			}
			selected.record = {
				...selected.record,
				state: next,
				revision: `${expectedRevision}:${next.kind}`,
			};
			return { kind: 'found', record: selected.record };
		},
	};
	const approvals: ApprovalPort = {
		decision: async ({ approvalId, decision, authenticatedApproverContextRef }) => {
			if (props.approvalDecisions === undefined) return { kind: 'unavailable' };
			try {
				const selected = entry(authenticatedApproverContextRef);
				resolveManagedEngineInvocation({
					config,
					semanticSnapshot: snapshot,
					context: selected.context,
				});
				const result = await props.approvalDecisions.decide({
					publicRequest: { challengeId: approvalId, decision },
					trustedContext: selected.context.trustedContext,
				});
				if (result.kind === 'rejected')
					return { kind: result.reason === 'expired' ? 'expired' : 'denied' };
				if (result.state === 'denied') return { kind: 'denied' };
				// Decision recording does not reserve or arm. A subsequent resource call obtains its receipt.
				return { kind: 'recorded', approvalId, decision };
			} catch {
				return { kind: 'denied' };
			}
		},
		challenge: async (invocation) => {
			const { selected } = validate(invocation);
			if (selected.admission?.kind === 'approval-required')
				return {
					kind: 'pending',
					challenge: {
						authority: props.authority,
						approvalId: selected.admission.challenge.approvalId,
						operationKey: invocation.operationKey,
						intentDigest: invocation.intentDigest,
						callerDisplay: invocation.operationKey.principal,
						targetDisplay: `${invocation.capability.namespace}/${invocation.capability.tool}`,
						revisions: invocation.admissionRevisions,
						expiresAt: selected.admission.challenge.expiresAt,
						permittedDecisions: ['approve', 'deny'],
					},
				};
			return selected.receipt === null
				? { kind: 'unavailable' }
				: { kind: 'approved', receipt: selected.receipt };
		},
		receipt: async ({ invocation, reference }) => {
			const { selected } = validate(invocation);
			return selected.receipt?.reference === reference
				? { kind: 'approved', receipt: selected.receipt }
				: { kind: 'denied' };
		},
	};

	async function invoke(invocation: DispatchInvocation): Promise<ResourceResult> {
		let dispatchAttempted = false;
		try {
			const { selected, managed, needsApproval } = validate(invocation);
			const expected = intent(invocation);
			let authority: GatewayRuntimeToolPortalDispatchAuthority;
			if (needsApproval) {
				if (
					selected.receipt === null ||
					selected.receipt.reference !== invocation.approvalReceiptRef ||
					Date.parse(selected.receipt.expiresAt) <= props.now()
				)
					return { kind: 'not-dispatched', reason: 'managed-receipt-required' };
				if (selected.reservation?.backendKind === 'controller_execution') {
					const reservation = selected.reservation;
					selected.reservation = null;
					authority = {
						kind: 'controller-approval-reservation',
						backendKind: 'controller_execution',
						reservation,
					};
				} else if (selected.grant !== null) {
					const grant = selected.grant;
					selected.grant = null;
					switch (grant.backendKind) {
						case 'controller_execution':
							authority = { kind: 'approval-grant', backendKind: 'controller_execution', grant };
							break;
						case 'mcp_provider':
							authority = { kind: 'approval-grant', backendKind: 'mcp_provider', grant };
							break;
						case 'tool_vm_runner':
							authority = { kind: 'approval-grant', backendKind: 'tool_vm_runner', grant };
							break;
						default:
							return assertNever(grant);
					}
				} else return { kind: 'not-dispatched', reason: 'managed-arm-required' };
			} else {
				const managedGoogle = resolveManagedGoogleBinding({
					config,
					profileId: managed.profileId,
					call: selected.call,
					preflight: selected.managedGoogle,
				});
				const fingerprint = directDispatchFingerprint({
					...(managedGoogle === undefined ? {} : { managedGoogle }),
					backendKind: invocation.backendKind,
					call: selected.call,
					principal: selected.context.trustedContext.principal,
					semanticSnapshot: snapshot,
					surfaceClass: selected.context.surfaceClass,
				});
				switch (invocation.backendKind) {
					case 'controller_execution':
						authority = {
							kind: 'without-approval',
							backendKind: 'controller_execution',
							bindingRevision: snapshot.bindingRevision,
							fingerprint,
							operationId: expected.operationId,
						};
						break;
					case 'mcp_provider':
						authority = {
							kind: 'without-approval',
							backendKind: 'mcp_provider',
							fingerprint,
							operationId: expected.operationId,
						};
						break;
					case 'tool_vm_runner':
						authority = {
							kind: 'without-approval',
							backendKind: 'tool_vm_runner',
							fingerprint,
							operationId: expected.operationId,
						};
						break;
					default:
						return assertNever(invocation.backendKind);
				}
			}
			const callRequest = { calls: [selected.call] };
			let response: PortalCallResult;
			dispatchAttempted = true;
			switch (authority.backendKind) {
				case 'controller_execution':
					response = await props.backendPorts.controllerExecution.call(callRequest, {
						...managed.options,
						dispatchAuthority: authority,
					});
					break;
				case 'mcp_provider':
					response = await props.backendPorts.mcpProvider.call(callRequest, {
						...managed.options,
						dispatchAuthority: authority,
					});
					break;
				case 'tool_vm_runner':
					response = await props.backendPorts.toolVmRunner.call(callRequest, {
						...managed.options,
						dispatchAuthority: authority,
					});
					break;
				default:
					return assertNever(authority);
			}
			const parsed = PortalCallResultSchema.parse(response);
			if (
				parsed.items.length !== 1 ||
				parsed.items[0]?.id !== selected.call.id ||
				parsed.items[0].operationId !== expected.operationId
			)
				return { kind: 'ambiguous', reason: 'managed-result-mismatch' };
			const item = parsed.items[0];
			if (item.outcome.kind === 'ambiguous')
				return { kind: 'ambiguous', reason: 'managed-backend-ambiguous' };
			if (item.outcome.kind === 'not-dispatched')
				return { kind: 'not-dispatched', reason: 'managed-backend-refused' };
			if (item.outcome.kind !== 'completed')
				return { kind: 'failed', reason: 'managed-backend-terminated' };
			return { kind: 'completed', result: jsonValueSchema.parse(item) };
		} catch {
			return dispatchAttempted
				? { kind: 'ambiguous', reason: 'managed-dispatch-unconfirmed' }
				: { kind: 'not-dispatched', reason: 'managed-authority-refused' };
		}
	}
	const backends = createManagedEngineBackends({
		config,
		snapshot,
		request,
		invoke,
		backendPorts: props.backendPorts,
		context: (reference) => entry(reference).context,
	});

	const dispatcher = createCapabilityDispatcher({
		assessAccess,
		operations,
		approvals,
		backends,
		now: props.now,
		...(props.factsRejected === undefined ? {} : { factsRejected: props.factsRejected }),
	});
	const register: ManagedToolEngineAdapter['register'] = ({
		context,
		call,
		accounts,
		managedGoogle,
	}) => {
		const reference = randomUUID();
		entries.set(reference, {
			context,
			call,
			accounts: accounts ?? [],
			managedGoogle:
				managedGoogle === undefined ? null : managedGoogleReadyPreflightSchema.parse(managedGoogle),
			admission: null,
			reservation: null,
			grant: null,
			receipt: null,
			record: null,
		});
		return reference;
	};
	return {
		backends,
		operations,
		approvals,
		assessAccess,
		dispatcher,
		register,
		request,
		release: (reference) => {
			entries.delete(reference);
		},
		call: createManagedPortalCallProjection({
			request,
			register,
			release: (reference) => {
				entries.delete(reference);
			},
			dispatcher,
			snapshot,
			admission: (reference) => entry(reference).admission,
		}),
	};
}
