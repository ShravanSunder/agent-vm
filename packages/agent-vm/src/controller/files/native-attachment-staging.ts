import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { ManagedVmFileTransferCapability } from '@agent-vm/managed-vm';
import { normalizeGogFileArgument } from '@agent-vm/oauth-broker-contracts';

import { relayOperationFile } from './operation-file-relay.js';
import type {
	OperationFileRetentionBudget,
	OperationFileRetentionOwner,
} from './operation-file-retention-budget.js';
import type { OperationFolderGuestAccess } from './operation-folder-guest-access.js';

export interface NativeAttachmentOwner {
	readonly agentId: string;
	readonly zoneId: string;
	readonly gatewayVmId: string;
	readonly stablePrincipal: string;
	readonly profileName: string;
	readonly sessionId: string;
}
export type NativeAttachmentStageResult =
	| {
			readonly kind: 'staged';
			readonly stagingId: string;
			readonly path: string;
			readonly byteLength: number;
			readonly sha256: string;
	  }
	| {
			readonly kind: 'failed';
			readonly reason: 'unavailable' | 'capacity' | 'transfer-failed' | 'cleanup-pending';
	  };

interface StagingRecord {
	readonly owner: NativeAttachmentOwner;
	readonly directory: string;
	readonly retention: OperationFileRetentionOwner;
	readonly remove: () => Promise<void>;
	settling: boolean;
	ready: boolean;
	cleanupEligible: boolean;
	gatewayContained: boolean;
}

interface NativeAttachmentStageRequest {
	readonly destinationRoot: string;
	readonly owner: NativeAttachmentOwner;
	readonly source: Pick<OperationFolderGuestAccess, 'read'>;
	readonly sourceRelativePath: string;
	readonly destination: Pick<
		OperationFolderGuestAccess,
		'createDirectory' | 'publish' | 'removeOwned'
	>;
	readonly destinationWriter: Pick<ManagedVmFileTransferCapability, 'writeFileStream'>;
	readonly sourceAuthorityIsCurrent: () => boolean;
	readonly destinationAuthorityIsCurrent: () => boolean;
	readonly signal: AbortSignal;
}

export interface NativeAttachmentStaging {
	stage(request: NativeAttachmentStageRequest): Promise<NativeAttachmentStageResult>;
	settle(request: {
		readonly owner: NativeAttachmentOwner;
		readonly stagingId: string;
		readonly outcome: 'sent' | 'failed' | 'unconfirmed' | 'sender-pending';
	}): Promise<{ readonly kind: 'cleaned' | 'retained' | 'unavailable' }>;
	releaseGatewayAfterContainment(gateway: {
		readonly zoneId: string;
		readonly gatewayVmId: string;
	}): Promise<void>;
	reapPendingCleanup(): Promise<void>;
}

function nativeAttachmentDestinationKey(
	owner: Pick<NativeAttachmentOwner, 'zoneId' | 'gatewayVmId'>,
): string {
	return JSON.stringify([owner.zoneId, owner.gatewayVmId]);
}

/** Controller-owned metadata; the selected destination owns bytes until native send settles. */
export function createNativeAttachmentStaging(props: {
	readonly retentionBudget: OperationFileRetentionBudget;
}): NativeAttachmentStaging {
	const records = new Map<string, StagingRecord>();
	// Different agents share this destination VM. Reserve it synchronously through
	// write/publication/cleanup; SDK file admission alone is not a cross-call mutex.
	const activeDestinations = new Set<string>();
	const cleanupRecord = async (stagingId: string, record: StagingRecord): Promise<boolean> => {
		const key = nativeAttachmentDestinationKey(record.owner);
		if (!record.cleanupEligible || record.settling || activeDestinations.has(key)) return false;
		record.settling = true;
		activeDestinations.add(key);
		try {
			await record.remove();
			record.retention.releaseAfterCleanup(stagingId);
			records.delete(stagingId);
			return true;
		} catch {
			record.settling = false;
			return false;
		} finally {
			activeDestinations.delete(key);
		}
	};
	const stage: NativeAttachmentStaging['stage'] = async (request) => {
		const owner = structuredClone(request.owner);
		const relativePath = normalizeGogFileArgument(request.sourceRelativePath, 'file');
		if (
			relativePath === undefined ||
			!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(owner.profileName) ||
			!request.sourceAuthorityIsCurrent() ||
			!request.destinationAuthorityIsCurrent()
		)
			return { kind: 'failed', reason: 'unavailable' };
		if (
			[...records.values()].filter(
				(record) => record.owner.agentId === owner.agentId && record.owner.zoneId === owner.zoneId,
			).length >= 32
		)
			return { kind: 'failed', reason: 'capacity' };
		const stagingId = randomUUID();
		const directory = `portal-native-${owner.profileName}-${stagingId}`;
		const retention = props.retentionBudget.forOwner({
			agentId: owner.agentId,
			zoneId: owner.zoneId,
			ownerId: `native:${owner.gatewayVmId}:${owner.stablePrincipal}`,
		});
		if (!retention.reserve(stagingId, 16 * 1024 * 1024))
			return { kind: 'failed', reason: 'capacity' };
		let directoryCreated = false;
		const destination = request.destination;
		const destinationAuthorityIsCurrent = request.destinationAuthorityIsCurrent;
		const record: StagingRecord = {
			owner,
			directory,
			retention,
			ready: false,
			settling: false,
			cleanupEligible: false,
			gatewayContained: false,
			remove: async () => {
				if (!record.gatewayContained && !destinationAuthorityIsCurrent())
					throw new Error('Native staging target is no longer current.');
				await destination.removeOwned(directory);
			},
		};
		records.set(stagingId, record);
		const finalName = relativePath.split('/').at(-1);
		if (finalName === undefined) throw new Error('Validated file name is unavailable.');
		const result = await relayOperationFile({
			source: request.source,
			sourceRelativePath: relativePath,
			destination: {
				...request.destination,
				createDirectory: async (path) => {
					await request.destination.createDirectory(path);
					directoryCreated = true;
				},
			},
			destinationWriter: request.destinationWriter,
			destinationRoot: request.destinationRoot,
			destinationDirectory: directory,
			finalName,
			signal: request.signal,
			authorityIsCurrent: () =>
				records.get(stagingId) === record &&
				request.sourceAuthorityIsCurrent() &&
				request.destinationAuthorityIsCurrent(),
		});
		if (result.kind === 'failed') {
			record.cleanupEligible = true;
			try {
				if (directoryCreated) await record.remove();
				else if (result.reason !== 'destination-conflict')
					throw new Error('Staging creation was not acknowledged.');
				retention.releaseAfterCleanup(stagingId);
				records.delete(stagingId);
				return { kind: 'failed', reason: 'transfer-failed' };
			} catch {
				return { kind: 'failed', reason: 'cleanup-pending' };
			}
		}
		if (!retention.resize(stagingId, result.identity.byteLength)) {
			record.cleanupEligible = true;
			return { kind: 'failed', reason: 'cleanup-pending' };
		}
		record.ready = true;
		return { kind: 'staged', stagingId, path: result.path, ...result.identity };
	};
	return {
		stage: async (request) => {
			const key = nativeAttachmentDestinationKey(request.owner);
			if (activeDestinations.has(key)) return { kind: 'failed', reason: 'capacity' };
			activeDestinations.add(key);
			try {
				return await stage(request);
			} finally {
				activeDestinations.delete(key);
			}
		},
		settle: async (request) => {
			const record = records.get(request.stagingId);
			if (record === undefined || !record.ready || !isDeepStrictEqual(record.owner, request.owner))
				return { kind: 'unavailable' };
			if (request.outcome === 'sender-pending') return { kind: 'retained' };
			record.cleanupEligible = true;
			return { kind: (await cleanupRecord(request.stagingId, record)) ? 'cleaned' : 'retained' };
		},
		releaseGatewayAfterContainment: async (gateway) => {
			let pending = false;
			for (const [stagingId, record] of records) {
				if (
					record.owner.zoneId !== gateway.zoneId ||
					record.owner.gatewayVmId !== gateway.gatewayVmId
				)
					continue;
				record.gatewayContained = true;
				record.cleanupEligible = true;
				// oxlint-disable-next-line no-await-in-loop -- existing destination reservation serializes cleanup.
				if (!(await cleanupRecord(stagingId, record))) pending = true;
			}
			if (pending) throw new Error('Native attachment host cleanup remains pending.');
		},
		reapPendingCleanup: async () => {
			let pending = false;
			for (const [stagingId, record] of records) {
				if (!record.cleanupEligible) continue;
				// oxlint-disable-next-line no-await-in-loop -- preserve destination cleanup serialization.
				if (!(await cleanupRecord(stagingId, record))) pending = true;
			}
			if (pending) throw new Error('Native attachment cleanup remains pending.');
		},
	};
}
