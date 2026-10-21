import {
	assessAccessInput,
	jsonValueSchema,
	type PortalCallRequest,
} from '@agent-collaboration/tool-access/contracts';

import type {
	ApprovalReceipt,
	BackendKind,
	DispatchInvocation,
	OperationRecord,
	ToolBackend,
} from '#dispatch/dispatch-contracts';
import type {
	StandalonePortalCallItem,
	StandalonePortalInvocation,
	StandalonePortalPreparedBatch,
} from '#dispatch/standalone-portal-ports';
import { createStandaloneToolPortalCore } from '#dispatch/standalone-tool-portal-core';

export const fixtureRevision = { owner: 'fixture-host', revision: '1' };
const fixtureNow = Date.parse('2026-10-21T00:00:00.000Z');
const expiry = '2026-10-21T00:05:00.000Z';
export const fixtureChallenge = {
	challengeId: '1887db43-77bc-438b-9cc8-fad7e4a2606d',
	expiresAt: expiry,
};
export const fixtureSummary = {
	description: `${'🦁'.repeat(245)} search-suffix`,
	input: { optional: [], propertyCount: 0, required: [], type: 'object' },
	namespace: 'example',
	name: 'read',
	safety: {},
	toolRef: 'example:read',
};

export interface CoreFixtureOptions {
	readonly authenticatedRef: string;
	readonly approved?: boolean;
}

export function fixtureBackendItem(
	call: PortalCallRequest['calls'][number],
	operationId: string,
): StandalonePortalCallItem {
	const identity = { id: call.id, operationId, owningGeneration: 'backend-generation' };
	if (call.name === 'cancelled')
		return {
			...identity,
			status: 'error',
			error: { code: 'cancelled', message: 'Fixture cancellation proved termination.' },
			outcome: {
				kind: 'cancelled-proven',
				certainty: 'proven-terminated',
				retryClass: 'manual-only',
			},
		};
	if (call.name === 'uncertain')
		return {
			...identity,
			status: 'error',
			error: { code: 'execution_failed', message: 'Fixture transport lost.' },
			outcome: {
				kind: 'ambiguous',
				certainty: 'side-effects-and-termination-unknown',
				retryClass: 'forbidden',
			},
		};
	if (call.name === 'failed')
		return {
			...identity,
			status: 'error',
			error: { code: 'execution_failed', message: 'Fixture tool refused.' },
			outcome: {
				kind: 'completed',
				completion: 'failed',
				certainty: 'proven',
				retryClass: 'forbidden',
			},
			value: { refused: true },
		};
	return {
		...identity,
		status: 'ok',
		outcome: {
			kind: 'completed',
			completion: 'succeeded',
			certainty: 'proven',
			retryClass: 'forbidden',
		},
		value: { input: call.arguments, tool: call.name },
	};
}

export function createStandaloneCoreFixture(identity?: {
	readonly owningGeneration: string;
	readonly operationIds: Readonly<Record<string, string>>;
}): {
	readonly core: ReturnType<typeof createStandaloneToolPortalCore<CoreFixtureOptions, undefined>>;
	readonly effects: DispatchInvocation[];
	readonly batches: string[][];
	readonly transitions: string[];
	readonly resolve: (options: CoreFixtureOptions) => Promise<StandalonePortalInvocation<undefined>>;
} {
	const effects: DispatchInvocation[] = [];
	const batches: string[][] = [];
	const transitions: string[] = [];
	async function resolve(
		options: CoreFixtureOptions,
	): Promise<StandalonePortalInvocation<undefined>> {
		if (options.authenticatedRef !== 'host-verified-agent')
			throw new Error('Unknown authenticated context.');
		return {
			authority: 'fixture-host',
			principal: 'agent-a',
			verifiedContextRef: options.authenticatedRef,
			owningGeneration: identity?.owningGeneration ?? 'host-generation',
			correlation: {},
			readOptions: undefined,
			operationId: (callId) => identity?.operationIds[callId] ?? `operation:${callId}`,
			accessForCall: async (call) =>
				assessAccessInput.parse({
					capability: { namespace: call.namespace, tool: call.name },
					surface: 'mcp',
					call: { arguments: call.arguments, digest: 'a'.repeat(64), account: null },
					facts: {
						workspace: { kind: 'not-configured' },
						assignment: {
							revision: fixtureRevision,
							profileRevision: fixtureRevision,
							profile: {
								profileId: 'reader',
								namespaces: {
									example: {
										backendKind: 'mcp_provider',
										tools: {
											allow: ['read', 'write', 'failed', 'uncertain', 'cancelled'],
											deny: [],
										},
										calls: {
											kind: 'selectors',
											withoutApproval: {
												allow: ['read', 'failed', 'uncertain', 'cancelled'],
												deny: [],
											},
											requiresApproval: { allow: ['write'], deny: [] },
										},
										operations: {},
									},
								},
							},
						},
						surface: { eligible: ['mcp'], snapshot: fixtureRevision },
						accounts: [],
						upstream: { status: 'available', credentialNeed: 'none', binding: fixtureRevision },
					},
				}),
			entries: [
				{
					namespaces: new Set(['example']),
					namespaceDiscovery: [{ namespace: 'example', summary: 'Example tools.' }],
					capabilityMetadata: () => ({ callDisposition: { kind: 'without-approval' } }),
					backend: {
						list: async (request) => ({
							ok: true,
							auditCorrelationId: 'audit-list',
							items: request.requests.map(({ id }) => ({
								id,
								status: 'ok',
								value: { namespaces: ['example'], nextCursor: '7', tools: [fixtureSummary] },
							})),
						}),
						search: async (request) => ({
							ok: true,
							items: request.requests.map(({ id, query }) => ({
								id,
								status: 'ok',
								value: {
									tools: fixtureSummary.description.includes(query ?? '') ? [fixtureSummary] : [],
								},
							})),
						}),
						describe: async (request) => ({
							ok: true,
							items: request.requests.map(({ id }) => ({
								id,
								status: 'ok',
								value: {
									tools: [
										{
											annotations: {},
											namespace: 'example',
											name: 'read',
											toolRef: 'example:read',
											related: [],
											description: fixtureSummary.description,
											typescriptHelper: 'export function read(): Promise<void>;',
										},
									],
								},
							})),
						}),
					},
				},
			],
			prepareBatch: async (plans): Promise<StandalonePortalPreparedBatch> => {
				batches.push(plans.filter((plan) => plan.requiresApproval).map((plan) => plan.operationId));
				const records = new Map<string, OperationRecord>();
				const items = new Map<string, StandalonePortalCallItem>();
				const receipts = new Map<string, ApprovalReceipt>();
				const backend: ToolBackend<BackendKind> = {
					backendKind: 'mcp_provider',
					list: async () => null,
					search: async () => null,
					describe: async () => null,
					invoke: async (invocation) => {
						effects.push(invocation);
						const plan = plans.find(
							(candidate) => candidate.operationId === invocation.operationKey.item,
						);
						if (plan === undefined) throw new Error('Unknown batch item.');
						const item = fixtureBackendItem(plan.call, plan.operationId);
						items.set(plan.operationId, item);
						if (item.outcome.certainty === 'proven-terminated')
							return { kind: 'failed', reason: 'fixture-proven-terminated' };
						return item.outcome.kind === 'ambiguous'
							? { kind: 'ambiguous', reason: 'fixture-stream-lost' }
							: { kind: 'completed', result: jsonValueSchema.parse(item) };
					},
				};
				return {
					backends: new Map([['mcp_provider', backend]]),
					operations: {
						lookup: async () => ({ kind: 'not-found' }),
						createOrRead: async ({ invocation, requiresApproval }) => {
							if (!requiresApproval) return { kind: 'untracked' };
							const record: OperationRecord = {
								version: 'tool-operation-v1',
								key: invocation.operationKey,
								intentDigest: invocation.intentDigest,
								revision: 'ready',
								createdAt: new Date(fixtureNow).toISOString(),
								updatedAt: new Date(fixtureNow).toISOString(),
								state: { kind: 'ready' },
							};
							records.set(invocation.operationKey.item, record);
							return { kind: 'created', record };
						},
						transition: async ({ invocation, expectedRevision, next }) => {
							const current = records.get(invocation.operationKey.item);
							if (current?.revision !== expectedRevision) return { kind: 'conflict' };
							const record = {
								...current,
								state: next,
								revision: `${expectedRevision}:${next.kind}`,
							};
							records.set(invocation.operationKey.item, record);
							transitions.push(next.kind);
							return { kind: 'found', record };
						},
					},
					approvals: {
						decision: async () => ({ kind: 'unavailable' }),
						challenge: async (invocation) => {
							if (!options.approved) return { kind: 'denied' };
							const receipt: ApprovalReceipt = {
								reference: `receipt:${invocation.operationKey.item}`,
								decision: 'approve',
								authoritativeRevision: fixtureRevision,
								operationKey: invocation.operationKey,
								intentDigest: invocation.intentDigest,
								backendKind: invocation.backendKind,
								bindingRevision: invocation.bindingRevision,
								admissionRevisions: invocation.admissionRevisions,
								verifiedContextRef: invocation.verifiedContextRef,
								expiresAt: expiry,
							};
							receipts.set(receipt.reference, receipt);
							return { kind: 'approved', receipt };
						},
						receipt: async ({ reference }) => {
							const receipt = receipts.get(reference);
							return receipt === undefined ? { kind: 'denied' } : { kind: 'approved', receipt };
						},
					},
					admissionItem: (operationId) => {
						const plan = plans.find((candidate) => candidate.operationId === operationId);
						return plan?.requiresApproval && !options.approved
							? {
									id: plan.call.id,
									operationId,
									owningGeneration: identity?.owningGeneration ?? 'host-generation',
									status: 'approval_required',
									approvalChallenge: fixtureChallenge,
									error: {
										code: 'approval_required',
										message: 'Capability execution requires operator approval.',
										safeDiagnostic: {
											code: 'approval_required',
											level: 'warn',
											safeMessage: 'Capability execution requires operator approval.',
										},
									},
									outcome: {
										kind: 'not-dispatched',
										certainty: 'proven',
										retryClass: 'safe-before-dispatch',
									},
								}
							: undefined;
					},
					backendItem: (operationId) => items.get(operationId),
					release: () => {},
				};
			},
		};
	}
	return {
		core: createStandaloneToolPortalCore({
			binding: { workspaceLayer: 'not-configured', config: fixtureRevision },
			now: () => fixtureNow,
			resolveInvocation: resolve,
		}),
		effects,
		batches,
		transitions,
		resolve,
	};
}
