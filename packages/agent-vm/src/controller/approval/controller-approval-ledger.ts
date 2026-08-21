import { randomUUID } from 'node:crypto';

import {
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	GatewayRuntimeApprovalAuthorityContextSchema,
	GatewayRuntimeApprovalChallengeIntentSchema,
	GatewayRuntimeApprovalChallengeSchema,
	GatewayRuntimeControllerExecutionDispatchReservationSchema,
	GatewayRuntimeApprovalDispatchGrantSchema,
	GatewayRuntimeApprovalDispatchReservationSchema,
	deriveGatewayRuntimeApprovalFingerprint,
	deriveGatewayRuntimeApprovalId,
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimeApprovalAdmissionResult,
	type GatewayRuntimeApprovalArmDispatchResult,
	type GatewayRuntimeApprovalAuthorityContext,
	type GatewayRuntimeApprovalChallenge,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeApprovalDispatchReservation,
} from '@agent-vm/gateway-control-contracts';
import { z } from 'zod/v4';

import type { ControllerApprovalRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import {
	createCrashDurableRecordStore,
	type CrashDurableRecordMutation,
	type CrashDurableRecordStore,
} from '../durable-state/crash-durable-record-store.js';

const ControllerApprovalOperatorIdentitySchema = z
	.object({
		approverId: z.string().min(1),
		audience: z.literal(GATEWAY_RUNTIME_APPROVAL_AUDIENCE),
		provenance: z.literal('managed-gateway'),
		stablePrincipal: z.string().regex(/^[a-f0-9]{64}$/u),
	})
	.strict();

const ControllerApprovalDecisionSchema = z
	.object({
		decidedAt: z.string().datetime(),
		decision: z.enum(['approve', 'deny']),
		operator: ControllerApprovalOperatorIdentitySchema,
	})
	.strict();

const ControllerApprovalApprovedDecisionSchema = ControllerApprovalDecisionSchema.extend({
	decision: z.literal('approve'),
}).strict();

const ControllerApprovalDeniedDecisionSchema = ControllerApprovalDecisionSchema.extend({
	decision: z.literal('deny'),
}).strict();

const ControllerApprovalRevocationSchema = z
	.object({
		operator: ControllerApprovalOperatorIdentitySchema,
		revokedAt: z.string().datetime(),
	})
	.strict();

const ControllerExecutionDispatchGrantSchema =
	GatewayRuntimeControllerExecutionDispatchReservationSchema.omit({
		reservationId: true,
	})
		.extend({ grantId: z.string().uuid() })
		.strict();

const ControllerApprovalDispatchGrantSchema = z.union([
	GatewayRuntimeApprovalDispatchGrantSchema,
	ControllerExecutionDispatchGrantSchema,
]);

type ControllerApprovalDispatchGrant = z.infer<typeof ControllerApprovalDispatchGrantSchema>;

export type ControllerApprovalArmDispatchResult =
	| Exclude<GatewayRuntimeApprovalArmDispatchResult, { readonly kind: 'dispatch-armed' }>
	| {
			readonly grant: ControllerApprovalDispatchGrant;
			readonly kind: 'dispatch-armed';
	  };

const ControllerApprovalRecordBaseSchema = z.object({
	authorityContext: GatewayRuntimeApprovalAuthorityContextSchema,
	challenge: GatewayRuntimeApprovalChallengeSchema,
	recordVersion: z.literal(1),
});

const ControllerApprovalRecordSchema = z.discriminatedUnion('kind', [
	ControllerApprovalRecordBaseSchema.extend({ kind: z.literal('pending') }).strict(),
	ControllerApprovalRecordBaseSchema.extend({
		decision: ControllerApprovalApprovedDecisionSchema,
		kind: z.literal('approved'),
	}).strict(),
	ControllerApprovalRecordBaseSchema.extend({
		decision: ControllerApprovalDeniedDecisionSchema,
		kind: z.literal('denied'),
	}).strict(),
	ControllerApprovalRecordBaseSchema.extend({
		kind: z.literal('revoked'),
		priorState: z.discriminatedUnion('kind', [
			z.object({ kind: z.literal('pending') }).strict(),
			z
				.object({
					decision: ControllerApprovalApprovedDecisionSchema,
					kind: z.literal('approved'),
				})
				.strict(),
		]),
		revocation: ControllerApprovalRevocationSchema,
	}).strict(),
	ControllerApprovalRecordBaseSchema.extend({
		consumedAt: z.string().datetime(),
		decision: ControllerApprovalApprovedDecisionSchema,
		kind: z.literal('consumed-not-dispatched'),
		reservation: GatewayRuntimeApprovalDispatchReservationSchema,
	}).strict(),
	ControllerApprovalRecordBaseSchema.extend({
		armedAt: z.string().datetime(),
		decision: ControllerApprovalApprovedDecisionSchema,
		grant: ControllerApprovalDispatchGrantSchema,
		kind: z.literal('dispatch-armed'),
		reservation: GatewayRuntimeApprovalDispatchReservationSchema,
	}).strict(),
]);

type ControllerApprovalRecord = z.infer<typeof ControllerApprovalRecordSchema>;
export type ControllerApprovalOperatorIdentity = z.infer<
	typeof ControllerApprovalOperatorIdentitySchema
>;

export type ControllerApprovalDecisionResult =
	| {
			readonly decision: 'approve';
			readonly kind: 'recorded';
			readonly view: Extract<ControllerApprovalOperatorView, { readonly kind: 'approved' }>;
	  }
	| {
			readonly decision: 'deny';
			readonly kind: 'recorded';
			readonly view: Extract<ControllerApprovalOperatorView, { readonly kind: 'denied' }>;
	  }
	| {
			readonly kind: 'rejected';
			readonly reason:
				| 'already-decided'
				| 'expired'
				| 'not-found'
				| 'principal-mismatch'
				| 'stale-authority';
	  };

export type ControllerApprovalRevocationResult =
	| {
			readonly kind: 'recorded';
			readonly view: Extract<ControllerApprovalOperatorView, { readonly kind: 'revoked' }>;
	  }
	| {
			readonly kind: 'rejected';
			readonly reason:
				| 'already-consumed'
				| 'already-revoked'
				| 'expired'
				| 'not-found'
				| 'stale-authority';
	  };

export type ControllerApprovalOperatorView =
	| {
			readonly challenge: GatewayRuntimeApprovalChallenge;
			readonly kind: 'pending';
	  }
	| {
			readonly challenge: GatewayRuntimeApprovalChallenge;
			readonly decision: z.infer<typeof ControllerApprovalApprovedDecisionSchema>;
			readonly kind: 'approved';
	  }
	| {
			readonly challenge: GatewayRuntimeApprovalChallenge;
			readonly decision: z.infer<typeof ControllerApprovalDeniedDecisionSchema>;
			readonly kind: 'denied';
	  }
	| {
			readonly challenge: GatewayRuntimeApprovalChallenge;
			readonly kind: 'revoked';
			readonly revocation: z.infer<typeof ControllerApprovalRevocationSchema>;
	  }
	| {
			readonly challenge: GatewayRuntimeApprovalChallenge;
			readonly consumedAt: string;
			readonly kind: 'consumed-not-dispatched';
	  }
	| {
			readonly armedAt: string;
			readonly challenge: GatewayRuntimeApprovalChallenge;
			readonly kind: 'dispatch-armed';
	  };

export interface ControllerApprovalLedger {
	readonly armDispatch: (props: {
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly reservation: GatewayRuntimeApprovalDispatchReservation;
	}) => Promise<ControllerApprovalArmDispatchResult>;
	readonly decide: (props: {
		readonly approvalId: string;
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly decision: 'approve' | 'deny';
		readonly operator: ControllerApprovalOperatorIdentity;
	}) => Promise<ControllerApprovalDecisionResult>;
	readonly list: () => Promise<readonly ControllerApprovalOperatorView[]>;
	readonly read: (approvalId: string) => Promise<ControllerApprovalOperatorView | null>;
	readonly requestApproval: (props: {
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly intent: GatewayRuntimeApprovalChallengeIntent;
	}) => Promise<GatewayRuntimeApprovalAdmissionResult>;
	readonly revoke: (props: {
		readonly approvalId: string;
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly operator: ControllerApprovalOperatorIdentity;
	}) => Promise<ControllerApprovalRevocationResult>;
}

interface CreateControllerApprovalLedgerProps {
	readonly challengeTtlMs: number;
	readonly currentControllerEpoch: string;
	readonly generateUuid?: () => string;
	readonly now?: () => number;
	readonly recordsTarget: ControllerApprovalRecordsTarget;
	readonly store?: CrashDurableRecordStore<ControllerApprovalRecord>;
}

function createZoneBoundApprovalRecordSchema(
	recordsTarget: ControllerApprovalRecordsTarget,
): z.ZodType<ControllerApprovalRecord> {
	return ControllerApprovalRecordSchema.superRefine((record, context) => {
		if (record.authorityContext.zoneId !== recordsTarget.zoneId) {
			context.addIssue({
				code: 'custom',
				message: `Approval record zone '${record.authorityContext.zoneId}' does not match target zone '${recordsTarget.zoneId}'.`,
				path: ['authorityContext', 'zoneId'],
			});
		}
	});
}

function createZoneBoundApprovalRecordStore(options: {
	readonly providedStore?: CrashDurableRecordStore<ControllerApprovalRecord>;
	readonly recordsTarget: ControllerApprovalRecordsTarget;
}): CrashDurableRecordStore<ControllerApprovalRecord> {
	const recordSchema = createZoneBoundApprovalRecordSchema(options.recordsTarget);
	const backingStore =
		options.providedStore ??
		createCrashDurableRecordStore({
			recordSchema,
			recordsDirectoryPath: options.recordsTarget.directoryPath,
		});

	function parseRecord(record: ControllerApprovalRecord): ControllerApprovalRecord {
		return recordSchema.parse(record);
	}

	return {
		loadRecord: async (recordId) => {
			const record = await backingStore.loadRecord(recordId);
			return record === null ? null : parseRecord(record);
		},
		listRecords: async () => (await backingStore.listRecords()).map(parseRecord),
		mutateRecord: async <TResult>(
			recordId: string,
			mutate: (
				currentRecord: ControllerApprovalRecord | null,
			) =>
				| CrashDurableRecordMutation<TResult, ControllerApprovalRecord>
				| Promise<CrashDurableRecordMutation<TResult, ControllerApprovalRecord>>,
		): Promise<TResult> =>
			await backingStore.mutateRecord(recordId, async (currentRecord) => {
				const mutation = await mutate(currentRecord === null ? null : parseRecord(currentRecord));
				return {
					nextRecord: mutation.nextRecord === null ? null : parseRecord(mutation.nextRecord),
					result: mutation.result,
				};
			}),
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('Approval fingerprint values must be finite.');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const fields = Object.entries(value)
			.filter(([, fieldValue]) => fieldValue !== undefined)
			.toSorted(([leftName], [rightName]) => leftName.localeCompare(rightName));
		return `{${fields
			.map(([fieldName, fieldValue]) => `${JSON.stringify(fieldName)}:${canonicalJson(fieldValue)}`)
			.join(',')}}`;
	}
	throw new TypeError('Approval fingerprint values must be JSON-compatible.');
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function isExpired(challenge: GatewayRuntimeApprovalChallenge, now: number): boolean {
	return Date.parse(challenge.expiresAt) <= now;
}

function assertNeverControllerApprovalRecord(record: never): never {
	throw new Error(`Unsupported controller approval record: ${String(record)}`);
}

function operatorView(record: ControllerApprovalRecord): ControllerApprovalOperatorView {
	switch (record.kind) {
		case 'pending':
			return { challenge: record.challenge, kind: record.kind };
		case 'approved':
			return { challenge: record.challenge, decision: record.decision, kind: record.kind };
		case 'denied':
			return { challenge: record.challenge, decision: record.decision, kind: record.kind };
		case 'revoked':
			return {
				challenge: record.challenge,
				kind: record.kind,
				revocation: record.revocation,
			};
		case 'consumed-not-dispatched':
			return {
				challenge: record.challenge,
				consumedAt: record.consumedAt,
				kind: record.kind,
			};
		case 'dispatch-armed':
			return { armedAt: record.armedAt, challenge: record.challenge, kind: record.kind };
		default:
			return assertNeverControllerApprovalRecord(record);
	}
}

function notDispatched(
	record: ControllerApprovalRecord,
	reason:
		| 'consumed-without-dispatch'
		| 'denied'
		| 'expired'
		| 'revoked'
		| 'stale-authority'
		| 'stale-fingerprint',
): Extract<GatewayRuntimeApprovalAdmissionResult, { readonly kind: 'not-dispatched' }> {
	return { kind: 'not-dispatched', operationId: record.challenge.intent.operationId, reason };
}

export function createControllerApprovalLedger(
	props: CreateControllerApprovalLedgerProps,
): ControllerApprovalLedger {
	if (!Number.isSafeInteger(props.challengeTtlMs) || props.challengeTtlMs <= 0) {
		throw new TypeError('Approval challenge TTL must be a positive safe integer.');
	}
	const currentControllerEpoch = z.string().min(1).parse(props.currentControllerEpoch);
	const now = props.now ?? Date.now;
	const generateUuid = props.generateUuid ?? randomUUID;
	const store = createZoneBoundApprovalRecordStore({
		recordsTarget: props.recordsTarget,
		...(props.store === undefined ? {} : { providedStore: props.store }),
	});

	function parseAuthorityContextForTarget(
		authorityContextInput: GatewayRuntimeApprovalAuthorityContext,
	): GatewayRuntimeApprovalAuthorityContext {
		const authorityContext =
			GatewayRuntimeApprovalAuthorityContextSchema.parse(authorityContextInput);
		if (authorityContext.zoneId !== props.recordsTarget.zoneId) {
			throw new Error(
				`Approval authority zone '${authorityContext.zoneId}' does not match target zone '${props.recordsTarget.zoneId}'.`,
			);
		}
		return authorityContext;
	}

	async function requestApproval(request: {
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly intent: GatewayRuntimeApprovalChallengeIntent;
	}): Promise<GatewayRuntimeApprovalAdmissionResult> {
		const authorityContext = parseAuthorityContextForTarget(request.authorityContext);
		const intent = GatewayRuntimeApprovalChallengeIntentSchema.parse(request.intent);
		if (authorityContext.controllerEpoch !== currentControllerEpoch) {
			return {
				kind: 'not-dispatched',
				operationId: intent.operationId,
				reason: 'stale-authority',
			};
		}
		const fingerprint = deriveGatewayRuntimeApprovalFingerprint({ authorityContext, intent });
		const approvalId = deriveGatewayRuntimeApprovalId(fingerprint);
		return await store.mutateRecord<GatewayRuntimeApprovalAdmissionResult>(
			approvalId,
			(currentRecord) => {
				const currentTime = now();
				if (currentRecord === null) {
					const challenge = GatewayRuntimeApprovalChallengeSchema.parse({
						approvalId,
						createdAt: new Date(currentTime).toISOString(),
						expiresAt: new Date(currentTime + props.challengeTtlMs).toISOString(),
						fingerprint,
						intent,
					});
					const record = ControllerApprovalRecordSchema.parse({
						authorityContext,
						challenge,
						kind: 'pending',
						recordVersion: 1,
					});
					return {
						nextRecord: record,
						result: { challenge, kind: 'approval-required' } as const,
					};
				}
				if (!sameCanonicalValue(currentRecord.authorityContext, authorityContext)) {
					return {
						nextRecord: currentRecord,
						result: notDispatched(currentRecord, 'stale-authority'),
					};
				}
				if (currentRecord.challenge.fingerprint !== fingerprint) {
					return {
						nextRecord: currentRecord,
						result: {
							kind: 'not-dispatched',
							operationId: intent.operationId,
							reason: 'stale-fingerprint',
						} as const,
					};
				}
				if (currentRecord.kind === 'dispatch-armed') {
					return {
						nextRecord: currentRecord,
						result: {
							kind: 'ambiguous',
							operationId: currentRecord.challenge.intent.operationId,
							reason: 'dispatch-armed',
						} as const,
					};
				}
				if (isExpired(currentRecord.challenge, currentTime)) {
					return {
						nextRecord: currentRecord,
						result: notDispatched(currentRecord, 'expired'),
					};
				}
				switch (currentRecord.kind) {
					case 'pending':
						return {
							nextRecord: currentRecord,
							result: { challenge: currentRecord.challenge, kind: 'approval-required' } as const,
						};
					case 'approved': {
						const consumedAt = new Date(currentTime).toISOString();
						const reservation = GatewayRuntimeApprovalDispatchReservationSchema.parse({
							approvalId,
							authorityContext,
							backendKind: intent.backendKind,
							...(intent.backendKind === 'controller_execution'
								? { bindingRevision: intent.semanticRevisions.bindingRevision }
								: {}),
							expiresAt: currentRecord.challenge.expiresAt,
							fingerprint,
							operationId: intent.operationId,
							reservationId: generateUuid(),
							stablePrincipal: deriveGatewayControlStablePrincipal({
								principal: intent.trustedContext.principal,
							}),
						});
						return {
							nextRecord: ControllerApprovalRecordSchema.parse({
								...currentRecord,
								consumedAt,
								kind: 'consumed-not-dispatched',
								reservation,
							}),
							result: { kind: 'dispatch-reserved', reservation } as const,
						};
					}
					case 'denied':
						return {
							nextRecord: currentRecord,
							result: notDispatched(currentRecord, 'denied'),
						};
					case 'revoked':
						return {
							nextRecord: currentRecord,
							result: notDispatched(currentRecord, 'revoked'),
						};
					case 'consumed-not-dispatched':
						return {
							nextRecord: currentRecord,
							result: notDispatched(currentRecord, 'consumed-without-dispatch'),
						};
					default:
						return assertNeverControllerApprovalRecord(currentRecord);
				}
			},
		);
	}

	async function armDispatch(request: {
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly reservation: GatewayRuntimeApprovalDispatchReservation;
	}): Promise<ControllerApprovalArmDispatchResult> {
		const authorityContext = parseAuthorityContextForTarget(request.authorityContext);
		const reservation = GatewayRuntimeApprovalDispatchReservationSchema.parse(request.reservation);
		if (authorityContext.controllerEpoch !== currentControllerEpoch) {
			return {
				kind: 'not-dispatched',
				operationId: reservation.operationId,
				reason: 'stale-authority',
			};
		}
		return await store.mutateRecord<ControllerApprovalArmDispatchResult>(
			reservation.approvalId,
			(currentRecord) => {
				if (currentRecord === null) {
					return {
						nextRecord: null,
						result: {
							kind: 'not-dispatched',
							operationId: reservation.operationId,
							reason: 'stale-fingerprint',
						} as const,
					};
				}
				if (!sameCanonicalValue(currentRecord.authorityContext, authorityContext)) {
					return {
						nextRecord: currentRecord,
						result: notDispatched(currentRecord, 'stale-authority'),
					};
				}
				if (currentRecord.kind === 'dispatch-armed') {
					if (!sameCanonicalValue(currentRecord.reservation, reservation)) {
						return {
							nextRecord: currentRecord,
							result: notDispatched(currentRecord, 'stale-fingerprint'),
						};
					}
					return {
						nextRecord: currentRecord,
						result: {
							kind: 'ambiguous',
							operationId: currentRecord.challenge.intent.operationId,
							reason: 'dispatch-armed',
						} as const,
					};
				}
				if (isExpired(currentRecord.challenge, now())) {
					return {
						nextRecord: currentRecord,
						result: notDispatched(currentRecord, 'expired'),
					};
				}
				if (
					currentRecord.kind !== 'consumed-not-dispatched' ||
					!sameCanonicalValue(currentRecord.reservation, reservation)
				) {
					return {
						nextRecord: currentRecord,
						result: notDispatched(currentRecord, 'stale-fingerprint'),
					};
				}
				const armedAt = new Date(now()).toISOString();
				const grant = ControllerApprovalDispatchGrantSchema.parse({
					approvalId: reservation.approvalId,
					authorityContext,
					backendKind: reservation.backendKind,
					...(reservation.backendKind === 'controller_execution'
						? { bindingRevision: reservation.bindingRevision }
						: {}),
					expiresAt: reservation.expiresAt,
					fingerprint: reservation.fingerprint,
					grantId: generateUuid(),
					operationId: reservation.operationId,
					stablePrincipal: reservation.stablePrincipal,
				});
				return {
					nextRecord: ControllerApprovalRecordSchema.parse({
						authorityContext: currentRecord.authorityContext,
						armedAt,
						challenge: currentRecord.challenge,
						decision: currentRecord.decision,
						grant,
						kind: 'dispatch-armed',
						recordVersion: currentRecord.recordVersion,
						reservation: currentRecord.reservation,
					}),
					result: { grant, kind: 'dispatch-armed' } as const,
				};
			},
		);
	}

	async function decide(request: {
		readonly approvalId: string;
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly decision: 'approve' | 'deny';
		readonly operator: ControllerApprovalOperatorIdentity;
	}): Promise<ControllerApprovalDecisionResult> {
		const authorityContext = parseAuthorityContextForTarget(request.authorityContext);
		const operator = ControllerApprovalOperatorIdentitySchema.parse(request.operator);
		if (authorityContext.controllerEpoch !== currentControllerEpoch) {
			return { kind: 'rejected', reason: 'stale-authority' };
		}
		return await store.mutateRecord<ControllerApprovalDecisionResult>(
			request.approvalId,
			(currentRecord) => {
				if (currentRecord === null) {
					return { nextRecord: null, result: { kind: 'rejected', reason: 'not-found' } as const };
				}
				if (!sameCanonicalValue(currentRecord.authorityContext, authorityContext)) {
					return {
						nextRecord: currentRecord,
						result: { kind: 'rejected', reason: 'stale-authority' } as const,
					};
				}
				if (isExpired(currentRecord.challenge, now())) {
					return {
						nextRecord: currentRecord,
						result: { kind: 'rejected', reason: 'expired' } as const,
					};
				}
				if (currentRecord.kind !== 'pending') {
					return {
						nextRecord: currentRecord,
						result: { kind: 'rejected', reason: 'already-decided' } as const,
					};
				}
				if (
					deriveGatewayControlStablePrincipal({
						principal: currentRecord.challenge.intent.trustedContext.principal,
					}) !== operator.stablePrincipal
				) {
					return {
						nextRecord: currentRecord,
						result: { kind: 'rejected', reason: 'principal-mismatch' } as const,
					};
				}
				const decidedAt = new Date(now()).toISOString();
				if (request.decision === 'approve') {
					const decision = ControllerApprovalApprovedDecisionSchema.parse({
						decidedAt,
						decision: request.decision,
						operator,
					});
					const nextRecord = ControllerApprovalRecordSchema.parse({
						...currentRecord,
						decision,
						kind: 'approved',
					});
					if (nextRecord.kind !== 'approved') {
						throw new Error('Recorded approval did not produce an approved record.');
					}
					return {
						nextRecord,
						result: {
							decision: request.decision,
							kind: 'recorded',
							view: {
								challenge: nextRecord.challenge,
								decision: nextRecord.decision,
								kind: nextRecord.kind,
							},
						} as const,
					};
				}
				const decision = ControllerApprovalDeniedDecisionSchema.parse({
					decidedAt,
					decision: request.decision,
					operator,
				});
				const nextRecord = ControllerApprovalRecordSchema.parse({
					...currentRecord,
					decision,
					kind: 'denied',
				});
				if (nextRecord.kind !== 'denied') {
					throw new Error('Recorded denial did not produce a denied record.');
				}
				return {
					nextRecord,
					result: {
						decision: request.decision,
						kind: 'recorded',
						view: {
							challenge: nextRecord.challenge,
							decision: nextRecord.decision,
							kind: nextRecord.kind,
						},
					} as const,
				};
			},
		);
	}

	async function revoke(request: {
		readonly approvalId: string;
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly operator: ControllerApprovalOperatorIdentity;
	}): Promise<ControllerApprovalRevocationResult> {
		const authorityContext = parseAuthorityContextForTarget(request.authorityContext);
		const operator = ControllerApprovalOperatorIdentitySchema.parse(request.operator);
		if (authorityContext.controllerEpoch !== currentControllerEpoch) {
			return { kind: 'rejected', reason: 'stale-authority' };
		}
		return await store.mutateRecord<ControllerApprovalRevocationResult>(
			request.approvalId,
			(currentRecord) => {
				if (currentRecord === null) {
					return { nextRecord: null, result: { kind: 'rejected', reason: 'not-found' } as const };
				}
				if (!sameCanonicalValue(currentRecord.authorityContext, authorityContext)) {
					return {
						nextRecord: currentRecord,
						result: { kind: 'rejected', reason: 'stale-authority' } as const,
					};
				}
				if (isExpired(currentRecord.challenge, now())) {
					return {
						nextRecord: currentRecord,
						result: { kind: 'rejected', reason: 'expired' } as const,
					};
				}
				if (currentRecord.kind === 'revoked') {
					return {
						nextRecord: currentRecord,
						result: { kind: 'rejected', reason: 'already-revoked' } as const,
					};
				}
				if (currentRecord.kind !== 'pending' && currentRecord.kind !== 'approved') {
					return {
						nextRecord: currentRecord,
						result: { kind: 'rejected', reason: 'already-consumed' } as const,
					};
				}
				const revocation = ControllerApprovalRevocationSchema.parse({
					operator,
					revokedAt: new Date(now()).toISOString(),
				});
				const priorState =
					currentRecord.kind === 'pending'
						? { kind: 'pending' as const }
						: { decision: currentRecord.decision, kind: 'approved' as const };
				const nextRecord = ControllerApprovalRecordSchema.parse({
					authorityContext: currentRecord.authorityContext,
					challenge: currentRecord.challenge,
					kind: 'revoked',
					priorState,
					recordVersion: currentRecord.recordVersion,
					revocation,
				});
				if (nextRecord.kind !== 'revoked') {
					throw new Error('Recorded revocation did not produce a revoked record.');
				}
				return {
					nextRecord,
					result: {
						kind: 'recorded',
						view: {
							challenge: nextRecord.challenge,
							kind: nextRecord.kind,
							revocation: nextRecord.revocation,
						},
					} as const,
				};
			},
		);
	}

	return {
		armDispatch,
		decide,
		list: async () => (await store.listRecords()).map(operatorView),
		read: async (approvalId) => {
			const record = await store.loadRecord(approvalId);
			return record === null ? null : operatorView(record);
		},
		requestApproval,
		revoke,
	};
}
