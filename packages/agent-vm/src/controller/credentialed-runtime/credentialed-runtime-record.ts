import type { ManagedVmExactProcessTerminationCapability } from '@agent-vm/managed-vm';
import { z } from 'zod';

import { terminateRecordedManagedVmProcess } from '../../shared/controller-managed-vm-termination.js';
import {
	createCrashDurableRecordStore,
	type CrashDurableRecordStore,
} from '../durable-state/crash-durable-record-store.js';

const processIdentitySchema = z
	.object({
		command: z.string().min(1),
		hostProcessId: z.number().int().positive(),
		processStartIdentity: z.string().min(1),
		vmId: z.string().min(1),
	})
	.strict();

const recordBaseShape = {
	agentId: z.string().min(1),
	controllerEpoch: z.string().min(1),
	gatewayEpoch: z.string().min(1),
	generation: z.number().int().nonnegative(),
	groupRevision: z.string().min(1),
	parentGatewayVmId: z.string().min(1),
	recordId: z.string().min(1),
	recordVersion: z.literal(1),
	runtimeEpoch: z.string().min(1),
	runtimeId: z.string().min(1),
	stablePrincipal: z.string().min(1),
	updatedAtMs: z.number().int().nonnegative(),
	zoneId: z.string().min(1),
} as const;

export const credentialedRuntimeRecordSchema = z.discriminatedUnion('kind', [
	z.object({ ...recordBaseShape, kind: z.literal('reserved') }).strict(),
	z.object({ ...recordBaseShape, kind: z.literal('creation-started') }).strict(),
	z
		.object({
			...recordBaseShape,
			kind: z.literal('vm-created'),
			vmId: z.string().min(1),
		})
		.strict(),
	z
		.object({
			...recordBaseShape,
			identity: processIdentitySchema,
			kind: z.literal('identity-published'),
			vmId: z.string().min(1),
		})
		.strict(),
	z
		.object({
			...recordBaseShape,
			activeOperationId: z.string().min(1),
			identity: processIdentitySchema,
			kind: z.literal('current-active'),
			startedAtMs: z.number().int().nonnegative(),
			vmId: z.string().min(1),
		})
		.strict(),
	z
		.object({
			...recordBaseShape,
			identity: processIdentitySchema,
			idleExpiresAtMs: z.number().int().nonnegative(),
			kind: z.literal('current-idle'),
			lastUsedAtMs: z.number().int().nonnegative(),
			vmId: z.string().min(1),
		})
		.strict(),
	z
		.object({
			...recordBaseShape,
			identity: processIdentitySchema.nullable(),
			kind: z.literal('retiring'),
			reason: z.string().min(1),
			vmId: z.string().min(1).nullable(),
		})
		.strict(),
	z
		.object({
			...recordBaseShape,
			containment: z.literal('proven'),
			identity: processIdentitySchema.nullable(),
			kind: z.literal('contained-terminal'),
			vmId: z.string().min(1).nullable(),
		})
		.strict(),
	z
		.object({
			...recordBaseShape,
			containment: z.literal('unproven'),
			identity: processIdentitySchema.nullable(),
			kind: z.literal('owner-unsafe'),
			reason: z.string().min(1),
			vmId: z.string().min(1).nullable(),
		})
		.strict(),
]);

export type CredentialedRuntimeRecord = z.infer<typeof credentialedRuntimeRecordSchema>;
export type CredentialedRuntimeProcessIdentity = z.infer<typeof processIdentitySchema>;
export type CredentialedRuntimeRecordStaticFields = Pick<
	CredentialedRuntimeRecord,
	| 'agentId'
	| 'controllerEpoch'
	| 'gatewayEpoch'
	| 'groupRevision'
	| 'parentGatewayVmId'
	| 'recordId'
	| 'recordVersion'
	| 'runtimeEpoch'
	| 'runtimeId'
	| 'stablePrincipal'
	| 'zoneId'
>;

export function createCredentialedRuntimeRecordStore(options: {
	readonly recordsDirectoryPath: string;
}): CrashDurableRecordStore<CredentialedRuntimeRecord> {
	return createCrashDurableRecordStore({
		recordSchema: credentialedRuntimeRecordSchema,
		recordsDirectoryPath: options.recordsDirectoryPath,
	});
}

export type CredentialedRuntimeRecordStore = CrashDurableRecordStore<CredentialedRuntimeRecord>;

export interface CredentialedRuntimeOwnerUnsafeIdentity {
	readonly agentId: string;
	readonly runtimeId: string;
	readonly zoneId: string;
}

export async function containCredentialedRuntimeRecords(options: {
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly now?: () => number;
	readonly recordsDirectoryPath: string;
}): Promise<readonly CredentialedRuntimeOwnerUnsafeIdentity[]> {
	const now = options.now ?? Date.now;
	const store = createCredentialedRuntimeRecordStore({
		recordsDirectoryPath: options.recordsDirectoryPath,
	});
	const ownerUnsafe: CredentialedRuntimeOwnerUnsafeIdentity[] = [];
	for (const record of await store.listRecords()) {
		if (
			record.kind === 'reserved' ||
			record.kind === 'creation-started' ||
			record.kind === 'contained-terminal'
		) {
			// oxlint-disable-next-line no-await-in-loop -- recovery preserves record ordering
			await store.mutateRecord(record.recordId, () => ({ nextRecord: null, result: undefined }));
			continue;
		}
		const identity = 'identity' in record ? record.identity : null;
		if (record.kind === 'owner-unsafe' || identity === null) {
			ownerUnsafe.push({
				agentId: record.agentId,
				runtimeId: record.runtimeId,
				zoneId: record.zoneId,
			});
			continue;
		}
		try {
			// oxlint-disable-next-line no-await-in-loop -- exact recovery is sequential
			await terminateRecordedManagedVmProcess({
				exactProcessTermination: options.exactProcessTermination,
				target: {
					hostPid: identity.hostProcessId,
					processIdentity: {
						command: identity.command,
						lstart: identity.processStartIdentity,
					},
					vmId: identity.vmId,
				},
			});
			// oxlint-disable-next-line no-await-in-loop -- recovery preserves record ordering
			await store.mutateRecord(record.recordId, () => ({ nextRecord: null, result: undefined }));
		} catch {
			ownerUnsafe.push({
				agentId: record.agentId,
				runtimeId: record.runtimeId,
				zoneId: record.zoneId,
			});
			// oxlint-disable-next-line no-await-in-loop -- durable fencing must precede later records
			await store.mutateRecord(record.recordId, () => ({
				nextRecord: {
					...record,
					containment: 'unproven' as const,
					generation: record.generation + 1,
					identity,
					kind: 'owner-unsafe' as const,
					reason: 'startup exact termination could not be proven',
					updatedAtMs: now(),
					vmId: 'vmId' in record ? record.vmId : null,
				},
				result: undefined,
			}));
		}
	}
	return ownerUnsafe;
}
