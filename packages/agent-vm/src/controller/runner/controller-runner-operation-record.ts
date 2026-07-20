import {
	type GatewayStablePrincipalDigest,
	GatewayStablePrincipalDigestSchema,
} from '@agent-vm/agent-portal-sdk/contracts';
import { z } from 'zod/v4';

import { createCrashDurableRecordStore } from '../durable-state/crash-durable-record-store.js';

const ControllerRunnerAuthoritySchema = z
	.object({
		controllerEpoch: z.string().min(1),
		executionFingerprint: z.string().min(1),
		gatewayEpoch: z.string().min(1),
		operationId: z.string().min(1),
		parentGatewayVmId: z.string().min(1),
		runnerId: z.string().min(1),
		runtimeEpoch: z.string().min(1),
		stablePrincipal: GatewayStablePrincipalDigestSchema,
	})
	.strict();

const ControllerRunnerHostProcessIdentitySchema = z
	.object({
		command: z.string().min(1),
		hostProcessId: z.number().int().positive(),
		processStartIdentity: z.string().min(1),
		vmId: z.string().min(1),
	})
	.strict();

const ControllerRunnerRecordBaseSchema = ControllerRunnerAuthoritySchema.extend({
	generation: z.number().int().positive(),
	recordVersion: z.literal(1),
	updatedAt: z.string().datetime(),
});

const ControllerRunnerUnidentifiedRecordSchema = z.discriminatedUnion('kind', [
	ControllerRunnerRecordBaseSchema.extend({ kind: z.literal('reserved') }).strict(),
	ControllerRunnerRecordBaseSchema.extend({ kind: z.literal('creation-started') }).strict(),
	ControllerRunnerRecordBaseSchema.extend({
		kind: z.literal('vm-created'),
		vmId: z.string().min(1),
	}).strict(),
]);

const ControllerRunnerIdentifiedRecordSchema = z.discriminatedUnion('kind', [
	ControllerRunnerRecordBaseSchema.extend({
		identity: ControllerRunnerHostProcessIdentitySchema,
		kind: z.literal('identity-published'),
		vmId: z.string().min(1),
	}).strict(),
	ControllerRunnerRecordBaseSchema.extend({
		identity: ControllerRunnerHostProcessIdentitySchema,
		kind: z.literal('admission-validated'),
		vmId: z.string().min(1),
	}).strict(),
	ControllerRunnerRecordBaseSchema.extend({
		identity: ControllerRunnerHostProcessIdentitySchema,
		kind: z.literal('dispatch-armed'),
		vmId: z.string().min(1),
	}).strict(),
	ControllerRunnerRecordBaseSchema.extend({
		identity: ControllerRunnerHostProcessIdentitySchema,
		kind: z.literal('running'),
		vmId: z.string().min(1),
	}).strict(),
	ControllerRunnerRecordBaseSchema.extend({
		identity: ControllerRunnerHostProcessIdentitySchema,
		kind: z.literal('result-streaming'),
		vmId: z.string().min(1),
	}).strict(),
	ControllerRunnerRecordBaseSchema.extend({
		identity: ControllerRunnerHostProcessIdentitySchema,
		kind: z.literal('result-recorded'),
		vmId: z.string().min(1),
	}).strict(),
]);

const ControllerRunnerContainmentRecordSchema = z.discriminatedUnion('kind', [
	ControllerRunnerRecordBaseSchema.extend({
		identity: ControllerRunnerHostProcessIdentitySchema.nullable(),
		kind: z.literal('containment-started'),
		vmId: z.string().min(1).nullable(),
	}).strict(),
	ControllerRunnerRecordBaseSchema.extend({
		identity: ControllerRunnerHostProcessIdentitySchema.nullable(),
		kind: z.literal('gateway-retired'),
		vmId: z.string().min(1).nullable(),
	}).strict(),
]);

const ControllerRunnerContainedRecordSchema = ControllerRunnerRecordBaseSchema.extend({
	containment: z.literal('proven'),
	identity: ControllerRunnerHostProcessIdentitySchema.nullable(),
	kind: z.literal('contained-terminal'),
	vmId: z.string().min(1).nullable(),
}).strict();

const ControllerRunnerOwnerUnsafeRecordSchema = ControllerRunnerRecordBaseSchema.extend({
	containment: z.literal('unproven'),
	identity: ControllerRunnerHostProcessIdentitySchema.nullable(),
	kind: z.literal('owner-unsafe'),
	reason: z.string().min(1),
	vmId: z.string().min(1).nullable(),
}).strict();

const ControllerRunnerOperationRecordSchema = z.union([
	ControllerRunnerUnidentifiedRecordSchema,
	ControllerRunnerIdentifiedRecordSchema,
	ControllerRunnerContainmentRecordSchema,
	ControllerRunnerContainedRecordSchema,
	ControllerRunnerOwnerUnsafeRecordSchema,
]);

export type ControllerRunnerOperationAuthority = z.infer<typeof ControllerRunnerAuthoritySchema>;
export type ControllerRunnerHostProcessIdentity = z.infer<
	typeof ControllerRunnerHostProcessIdentitySchema
>;
export type ControllerRunnerOperationRecord = z.infer<typeof ControllerRunnerOperationRecordSchema>;
export type ControllerRunnerRecoverableRecord = Exclude<
	ControllerRunnerOperationRecord,
	{ readonly kind: 'contained-terminal' | 'owner-unsafe' }
>;

export type ControllerRunnerAllowedTransitionBySource = {
	readonly 'admission-validated': 'containment-started' | 'dispatch-armed';
	readonly 'containment-started': 'contained-terminal' | 'gateway-retired';
	readonly 'creation-started': 'vm-created';
	readonly 'dispatch-armed': 'containment-started' | 'running';
	readonly 'gateway-retired': 'contained-terminal';
	readonly 'identity-published': 'admission-validated' | 'containment-started';
	readonly reserved: 'creation-started';
	readonly 'result-recorded': 'containment-started';
	readonly 'result-streaming': 'containment-started' | 'result-recorded';
	readonly running: 'containment-started' | 'result-streaming';
	readonly 'vm-created': 'containment-started' | 'identity-published';
};

type ControllerRunnerTransitionSourceKind = keyof ControllerRunnerAllowedTransitionBySource;
type ControllerRunnerTransitionDestinationKind<
	TSourceKind extends ControllerRunnerTransitionSourceKind,
> = ControllerRunnerAllowedTransitionBySource[TSourceKind];
type ControllerRunnerContainmentStartSourceKind = {
	[TSourceKind in ControllerRunnerTransitionSourceKind]: 'containment-started' extends ControllerRunnerTransitionDestinationKind<TSourceKind>
		? TSourceKind
		: never;
}[ControllerRunnerTransitionSourceKind];
type ControllerRunnerRecordOfKind<TKind extends ControllerRunnerOperationRecord['kind']> =
	ControllerRunnerOperationRecord & { readonly kind: TKind };

export type ControllerRunnerContainmentResult =
	| { readonly kind: 'contained' }
	| { readonly kind: 'owner-unsafe'; readonly reason: string };

export interface CreateControllerRunnerOperationLedgerProps {
	readonly containPredecessor: (
		record: ControllerRunnerRecoverableRecord,
	) => Promise<ControllerRunnerContainmentResult>;
	readonly controllerEpoch: string;
	readonly recordsDirectoryPath: string;
	readonly runtime: {
		readonly clock: {
			readonly now: () => Date;
		};
	};
}

interface OperationIdProps {
	readonly operationId: string;
}

export interface ControllerRunnerRecoveryOperation {
	readonly operationId: string;
	readonly outcome: 'contained' | 'owner-unsafe';
}

export interface ControllerRunnerRecoveryResult {
	readonly adoptedRunnerCount: 0;
	readonly predecessorOperations: readonly ControllerRunnerRecoveryOperation[];
	readonly redispatchedOperationCount: 0;
}

export type ControllerRunnerSuccessorAdmission =
	| { readonly kind: 'admitted' }
	| { readonly kind: 'rejected'; readonly reason: 'predecessor-owner-unsafe' };

export type ControllerRunnerReservationResult =
	| { readonly kind: 'reserved' }
	| { readonly kind: 'rejected'; readonly reason: 'duplicate-operation' };

export interface ControllerRunnerOperationLedger {
	readonly admitSuccessor: (props: {
		readonly parentGatewayVmId: string;
		readonly stablePrincipal: GatewayStablePrincipalDigest;
	}) => Promise<ControllerRunnerSuccessorAdmission>;
	readonly load: (operationId: string) => Promise<ControllerRunnerOperationRecord | null>;
	readonly publishIdentity: (
		props: OperationIdProps & { readonly identity: ControllerRunnerHostProcessIdentity },
	) => Promise<void>;
	readonly recordAdmissionValidated: (props: OperationIdProps) => Promise<void>;
	readonly recordContainmentStarted: (props: OperationIdProps) => Promise<void>;
	readonly recordContained: (props: OperationIdProps) => Promise<void>;
	readonly recordCreationStarted: (props: OperationIdProps) => Promise<void>;
	readonly recordDispatchArmed: (props: OperationIdProps) => Promise<void>;
	readonly recordGatewayRetired: (props: OperationIdProps) => Promise<void>;
	readonly recordResult: (props: OperationIdProps) => Promise<void>;
	readonly recordResultStreaming: (props: OperationIdProps) => Promise<void>;
	readonly recordRunning: (props: OperationIdProps) => Promise<void>;
	readonly recordVmCreated: (props: OperationIdProps & { readonly vmId: string }) => Promise<void>;
	readonly recover: () => Promise<ControllerRunnerRecoveryResult>;
	readonly reserve: (
		authority: ControllerRunnerOperationAuthority,
	) => Promise<ControllerRunnerReservationResult>;
}

function identityFromRecord(
	record: ControllerRunnerOperationRecord,
): ControllerRunnerHostProcessIdentity | null {
	return 'identity' in record ? record.identity : null;
}

function vmIdFromRecord(record: ControllerRunnerOperationRecord): string | null {
	if ('vmId' in record) return record.vmId;
	return null;
}

function isRecoverableRecord(
	record: ControllerRunnerOperationRecord,
): record is ControllerRunnerRecoverableRecord {
	return record.kind !== 'contained-terminal' && record.kind !== 'owner-unsafe';
}

function hasControllerRunnerRecordKind<TKind extends ControllerRunnerOperationRecord['kind']>(
	record: ControllerRunnerOperationRecord,
	kind: TKind,
): record is ControllerRunnerRecordOfKind<TKind> {
	return record.kind === kind;
}

function isControllerRunnerContainmentStartSourceKind(
	kind: ControllerRunnerOperationRecord['kind'],
): kind is ControllerRunnerContainmentStartSourceKind {
	switch (kind) {
		case 'admission-validated':
		case 'dispatch-armed':
		case 'identity-published':
		case 'result-recorded':
		case 'result-streaming':
		case 'running':
		case 'vm-created':
			return true;
		case 'contained-terminal':
		case 'containment-started':
		case 'creation-started':
		case 'gateway-retired':
		case 'owner-unsafe':
		case 'reserved':
			return false;
	}
	return false;
}

export function createControllerRunnerOperationLedger(
	props: CreateControllerRunnerOperationLedgerProps,
): ControllerRunnerOperationLedger {
	const now = props.runtime.clock.now;
	const recordStore = createCrashDurableRecordStore({
		recordSchema: ControllerRunnerOperationRecordSchema,
		recordsDirectoryPath: props.recordsDirectoryPath,
	});

	const transition = async <
		TSourceKind extends ControllerRunnerTransitionSourceKind,
		TDestinationKind extends ControllerRunnerTransitionDestinationKind<TSourceKind>,
	>(
		operationId: string,
		expectedKind: TSourceKind,
		destinationKind: TDestinationKind,
		createNext: (
			current: ControllerRunnerRecordOfKind<TSourceKind>,
		) => ControllerRunnerRecordOfKind<TDestinationKind>,
	): Promise<void> => {
		await recordStore.mutateRecord(operationId, (current) => {
			if (current === null || !hasControllerRunnerRecordKind(current, expectedKind)) {
				throw new Error(
					`Controller runner operation '${operationId}' expected '${expectedKind}' before transition.`,
				);
			}
			const nextRecord = createNext(current);
			if (nextRecord.kind !== destinationKind) {
				throw new Error(
					`Controller runner operation '${operationId}' produced '${nextRecord.kind}' instead of '${destinationKind}'.`,
				);
			}
			return { nextRecord, result: undefined };
		});
	};

	async function recover(): Promise<ControllerRunnerRecoveryResult> {
		const records = await recordStore.listRecords();
		const predecessorRecords = records.filter(
			(record) => record.controllerEpoch !== props.controllerEpoch,
		);
		const predecessorOperations: ControllerRunnerRecoveryOperation[] = [];
		for (const predecessorRecord of predecessorRecords) {
			if (!isRecoverableRecord(predecessorRecord)) {
				predecessorOperations.push({
					operationId: predecessorRecord.operationId,
					outcome: predecessorRecord.kind === 'contained-terminal' ? 'contained' : 'owner-unsafe',
				});
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- Each operation requires positive containment evidence before its durable fence is advanced.
			const containment = await props.containPredecessor(predecessorRecord);
			// oxlint-disable-next-line no-await-in-loop -- Preserve deterministic, generation-fenced durable recovery writes.
			const outcome = await recordStore.mutateRecord(
				predecessorRecord.operationId,
				(
					current,
				): {
					nextRecord: ControllerRunnerOperationRecord;
					result: ControllerRunnerRecoveryOperation['outcome'];
				} => {
					if (
						current === null ||
						current.controllerEpoch !== predecessorRecord.controllerEpoch ||
						current.generation !== predecessorRecord.generation ||
						!isRecoverableRecord(current)
					) {
						throw new Error(
							`Controller runner recovery fence changed for '${predecessorRecord.operationId}'.`,
						);
					}
					const sharedTerminalFields = {
						...current,
						generation: current.generation + 1,
						identity: identityFromRecord(current),
						updatedAt: now().toISOString(),
						vmId: vmIdFromRecord(current),
					};
					return containment.kind === 'contained'
						? {
								nextRecord: {
									...sharedTerminalFields,
									containment: 'proven',
									kind: 'contained-terminal',
								},
								result: 'contained',
							}
						: {
								nextRecord: {
									...sharedTerminalFields,
									containment: 'unproven',
									kind: 'owner-unsafe',
									reason: containment.reason,
								},
								result: 'owner-unsafe',
							};
				},
			);
			predecessorOperations.push({
				operationId: predecessorRecord.operationId,
				outcome,
			});
		}
		return { adoptedRunnerCount: 0, predecessorOperations, redispatchedOperationCount: 0 };
	}

	return {
		admitSuccessor: async ({ parentGatewayVmId, stablePrincipal }) => {
			const records = await recordStore.listRecords();
			return records.some(
				(record) =>
					record.parentGatewayVmId === parentGatewayVmId &&
					record.stablePrincipal === stablePrincipal &&
					record.kind === 'owner-unsafe',
			)
				? { kind: 'rejected', reason: 'predecessor-owner-unsafe' }
				: { kind: 'admitted' };
		},
		load: async (operationId) => await recordStore.loadRecord(operationId),
		publishIdentity: async ({ identity, operationId }) => {
			await transition(operationId, 'vm-created', 'identity-published', (current) => ({
				...current,
				generation: current.generation + 1,
				identity,
				kind: 'identity-published',
				updatedAt: now().toISOString(),
				vmId: identity.vmId,
			}));
		},
		recordAdmissionValidated: async ({ operationId }) => {
			await transition(operationId, 'identity-published', 'admission-validated', (current) => ({
				...current,
				generation: current.generation + 1,
				kind: 'admission-validated',
				updatedAt: now().toISOString(),
			}));
		},
		recordContainmentStarted: async ({ operationId }) => {
			await recordStore.mutateRecord(operationId, (current) => {
				if (current === null || !isControllerRunnerContainmentStartSourceKind(current.kind)) {
					throw new Error(
						`Controller runner operation '${operationId}' is not available for containment.`,
					);
				}
				return {
					nextRecord: {
						...current,
						generation: current.generation + 1,
						identity: identityFromRecord(current),
						kind: 'containment-started',
						updatedAt: now().toISOString(),
						vmId: vmIdFromRecord(current),
					},
					result: undefined,
				};
			});
		},
		recordContained: async ({ operationId }) => {
			await recordStore.mutateRecord(operationId, (current) => {
				if (
					current === null ||
					(current.kind !== 'containment-started' && current.kind !== 'gateway-retired')
				) {
					throw new Error(
						`Controller runner operation '${operationId}' must be contained before terminal completion.`,
					);
				}
				return {
					nextRecord: {
						...current,
						containment: 'proven',
						generation: current.generation + 1,
						kind: 'contained-terminal',
						updatedAt: now().toISOString(),
					},
					result: undefined,
				};
			});
		},
		recordCreationStarted: async ({ operationId }) => {
			await transition(operationId, 'reserved', 'creation-started', (current) => ({
				...current,
				generation: current.generation + 1,
				kind: 'creation-started',
				updatedAt: now().toISOString(),
			}));
		},
		recordDispatchArmed: async ({ operationId }) => {
			await transition(operationId, 'admission-validated', 'dispatch-armed', (current) => ({
				...current,
				generation: current.generation + 1,
				kind: 'dispatch-armed',
				updatedAt: now().toISOString(),
			}));
		},
		recordGatewayRetired: async ({ operationId }) => {
			await transition(operationId, 'containment-started', 'gateway-retired', (current) => ({
				...current,
				generation: current.generation + 1,
				kind: 'gateway-retired',
				updatedAt: now().toISOString(),
			}));
		},
		recordResult: async ({ operationId }) => {
			await transition(operationId, 'result-streaming', 'result-recorded', (current) => ({
				...current,
				generation: current.generation + 1,
				kind: 'result-recorded',
				updatedAt: now().toISOString(),
			}));
		},
		recordResultStreaming: async ({ operationId }) => {
			await transition(operationId, 'running', 'result-streaming', (current) => ({
				...current,
				generation: current.generation + 1,
				kind: 'result-streaming',
				updatedAt: now().toISOString(),
			}));
		},
		recordRunning: async ({ operationId }) => {
			await transition(operationId, 'dispatch-armed', 'running', (current) => ({
				...current,
				generation: current.generation + 1,
				kind: 'running',
				updatedAt: now().toISOString(),
			}));
		},
		recordVmCreated: async ({ operationId, vmId }) => {
			await transition(operationId, 'creation-started', 'vm-created', (current) => ({
				...current,
				generation: current.generation + 1,
				kind: 'vm-created',
				updatedAt: now().toISOString(),
				vmId,
			}));
		},
		recover,
		reserve: async (authority) => {
			if (authority.controllerEpoch !== props.controllerEpoch) {
				throw new Error('Controller runner reservation epoch does not match ledger owner.');
			}
			return await recordStore.mutateRecord<ControllerRunnerReservationResult>(
				authority.operationId,
				(
					current,
				): {
					nextRecord: ControllerRunnerOperationRecord;
					result: ControllerRunnerReservationResult;
				} => {
					if (current !== null) {
						return {
							nextRecord: current,
							result: { kind: 'rejected', reason: 'duplicate-operation' },
						};
					}
					return {
						nextRecord: {
							...authority,
							generation: 1,
							kind: 'reserved',
							recordVersion: 1,
							updatedAt: now().toISOString(),
						},
						result: { kind: 'reserved' },
					};
				},
			);
		},
	};
}
