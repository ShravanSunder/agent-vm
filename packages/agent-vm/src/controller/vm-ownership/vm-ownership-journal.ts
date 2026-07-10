import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { ZodError } from 'zod';

import {
	gatewayIdentitiesEqual,
	gatewayMembershipRecordSchema,
	stablePrincipalKey,
	type ChildMembershipState,
	type GatewayMembershipRecord,
	type GatewayMembershipState,
	type ToolVmChildMembership,
} from './vm-ownership-contracts.js';

export type VmOwnershipJournalErrorCode =
	| 'membership-ambiguous'
	| 'membership-duplicate'
	| 'membership-malformed'
	| 'membership-missing'
	| 'membership-identity-mismatch'
	| 'membership-revision-conflict'
	| 'membership-revision-regressed'
	| 'membership-state-transition-refused'
	| 'ownership-path-symlink'
	| 'ownership-storage-unsafe';

export class VmOwnershipJournalError extends Error {
	public constructor(public readonly code: VmOwnershipJournalErrorCode) {
		super(`VM ownership journal refused operation: ${code}`);
		this.name = 'VmOwnershipJournalError';
	}
}

export interface VmOwnershipJournal {
	assertReservationPathOwned(reservationPath: string, reservationId: string): void;
	captureTimestampMs(): number;
	createGatewayMembership(record: GatewayMembershipRecord): Promise<GatewayMembershipRecord>;
	ensureStorage(): Promise<void>;
	inspectMembershipFile(gatewayEpochId: string): Promise<{
		readonly directoryMode: number;
		readonly fileMode: number;
	}>;
	loadAllGatewayMemberships(): Promise<readonly GatewayMembershipRecord[]>;
	loadGatewayMembership(gatewayEpochId: string): Promise<GatewayMembershipRecord>;
	membershipPathForTesting(gatewayEpochId: string): string;
	reservationPathFor(reservationId: string): string;
	replaceGatewayMembership(options: {
		readonly expectedRevision: number;
		readonly record: GatewayMembershipRecord;
	}): Promise<GatewayMembershipRecord>;
}

interface CreateVmOwnershipJournalOptions {
	readonly nowMs: () => number;
	readonly stateDirectory: string;
}

const stateDirectoryOperationQueues = new Map<string, Promise<void>>();

function modeBits(mode: number): number {
	return mode & 0o777;
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function inspectPathWithoutFollowingSymlinks(
	ownedPath: string,
): Promise<'directory' | 'missing' | 'regular-file'> {
	try {
		const stats = await lstat(ownedPath);
		if (stats.isSymbolicLink()) {
			throw new VmOwnershipJournalError('ownership-path-symlink');
		}
		if (stats.isDirectory()) {
			return 'directory';
		}
		if (stats.isFile()) {
			return 'regular-file';
		}
		throw new VmOwnershipJournalError('ownership-storage-unsafe');
	} catch (error) {
		if (isMissingFileError(error)) {
			return 'missing';
		}
		throw error;
	}
}

async function ensureOwnedDirectory(directoryPath: string): Promise<void> {
	const existingKind = await inspectPathWithoutFollowingSymlinks(directoryPath);
	if (existingKind === 'missing') {
		await mkdir(directoryPath, { mode: 0o700, recursive: true });
	}
	const createdKind = await inspectPathWithoutFollowingSymlinks(directoryPath);
	if (createdKind !== 'directory') {
		throw new VmOwnershipJournalError('ownership-storage-unsafe');
	}
	await chmod(directoryPath, 0o700);
}

function parseMembershipRecord(rawRecord: string): GatewayMembershipRecord {
	try {
		const parsedJson: unknown = JSON.parse(rawRecord);
		const record = gatewayMembershipRecordSchema.parse(parsedJson);
		assertMembershipSemantics(record);
		return record;
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof ZodError) {
			throw new VmOwnershipJournalError('membership-malformed');
		}
		throw error;
	}
}

function parseMembershipValue(value: unknown): GatewayMembershipRecord {
	try {
		const record = gatewayMembershipRecordSchema.parse(value);
		assertMembershipSemantics(record);
		return record;
	} catch (error) {
		if (error instanceof ZodError) {
			throw new VmOwnershipJournalError('membership-malformed');
		}
		throw error;
	}
}

function assertMembershipSemantics(record: GatewayMembershipRecord): void {
	if (
		record.controllerEpoch !== record.gateway.controllerEpoch ||
		record.gatewayReservation.controllerEpoch !== record.gateway.controllerEpoch ||
		record.gatewayReservation.vmId !== record.gateway.gatewayVmId ||
		record.gatewayReservation.principal.zoneId !== record.gateway.zoneId
	) {
		throw new VmOwnershipJournalError('membership-identity-mismatch');
	}
	const reservationIds = new Set<string>([record.gatewayReservation.reservationId]);
	const reservationPaths = new Set<string>([record.gatewayReservation.reservationPath]);
	const vmIds = new Set<string>([record.gatewayReservation.vmId]);
	const activePrincipals = new Set<string>();
	for (const child of record.children) {
		if (
			child.controllerEpoch !== record.gateway.controllerEpoch ||
			child.parentGateway.gatewayEpochId !== record.gateway.gatewayEpochId ||
			child.parentGateway.gatewayVmId !== record.gateway.gatewayVmId ||
			child.principal.zoneId !== record.gateway.zoneId
		) {
			throw new VmOwnershipJournalError('membership-identity-mismatch');
		}
		if (child.observedReservationRevision < child.expectedRevision) {
			throw new VmOwnershipJournalError('membership-revision-regressed');
		}
		if (
			reservationIds.has(child.reservationId) ||
			reservationPaths.has(child.reservationPath) ||
			vmIds.has(child.vmId)
		) {
			throw new VmOwnershipJournalError('membership-ambiguous');
		}
		reservationIds.add(child.reservationId);
		reservationPaths.add(child.reservationPath);
		vmIds.add(child.vmId);
		if (child.state !== 'destroyed') {
			const principalKey = stablePrincipalKey(child.principal);
			if (activePrincipals.has(principalKey)) {
				throw new VmOwnershipJournalError('membership-ambiguous');
			}
			activePrincipals.add(principalKey);
		}
	}
	if (
		record.state === 'destroyed' &&
		record.children.some((child) => child.state !== 'destroyed')
	) {
		throw new VmOwnershipJournalError('membership-state-transition-refused');
	}
}

function gatewayReservationsEqual(
	left: GatewayMembershipRecord['gatewayReservation'],
	right: GatewayMembershipRecord['gatewayReservation'],
): boolean {
	return (
		left.controllerEpoch === right.controllerEpoch &&
		left.expectedRevision === right.expectedRevision &&
		left.parentGateway === null &&
		right.parentGateway === null &&
		left.principal.kind === right.principal.kind &&
		left.principal.zoneId === right.principal.zoneId &&
		left.reservationId === right.reservationId &&
		left.reservationPath === right.reservationPath &&
		left.role === right.role &&
		left.vmId === right.vmId
	);
}

function childIdentitiesEqual(left: ToolVmChildMembership, right: ToolVmChildMembership): boolean {
	return (
		left.controllerEpoch === right.controllerEpoch &&
		left.expectedRevision === right.expectedRevision &&
		left.parentGateway.gatewayEpochId === right.parentGateway.gatewayEpochId &&
		left.parentGateway.gatewayVmId === right.parentGateway.gatewayVmId &&
		left.principal.agentId === right.principal.agentId &&
		left.principal.kind === right.principal.kind &&
		left.principal.zoneId === right.principal.zoneId &&
		left.reservationId === right.reservationId &&
		left.reservationPath === right.reservationPath &&
		left.role === right.role &&
		left.vmId === right.vmId
	);
}

const allowedGatewayStateTransitions = {
	admitting: new Set<GatewayMembershipState>(['admitting', 'sealed', 'owner-unsafe']),
	destroyed: new Set<GatewayMembershipState>(['destroyed']),
	destroying: new Set<GatewayMembershipState>(['destroying', 'destroyed', 'owner-unsafe']),
	'owner-unsafe': new Set<GatewayMembershipState>(['owner-unsafe', 'destroying']),
	sealed: new Set<GatewayMembershipState>(['sealed', 'destroying', 'owner-unsafe']),
} satisfies Readonly<Record<GatewayMembershipState, ReadonlySet<GatewayMembershipState>>>;

const allowedChildStateTransitions = {
	current: new Set<ChildMembershipState>(['current', 'destroying', 'destroyed', 'owner-unsafe']),
	destroyed: new Set<ChildMembershipState>(['destroyed']),
	destroying: new Set<ChildMembershipState>(['destroying', 'destroyed', 'owner-unsafe']),
	'owner-unsafe': new Set<ChildMembershipState>(['owner-unsafe', 'destroying', 'destroyed']),
	provisional: new Set<ChildMembershipState>([
		'provisional',
		'current',
		'destroying',
		'destroyed',
		'owner-unsafe',
	]),
} satisfies Readonly<Record<ChildMembershipState, ReadonlySet<ChildMembershipState>>>;

function assertReplacementPreservesAuthority(options: {
	readonly existing: GatewayMembershipRecord;
	readonly replacement: GatewayMembershipRecord;
}): void {
	if (
		options.existing.controllerEpoch !== options.replacement.controllerEpoch ||
		options.existing.createdAtMs !== options.replacement.createdAtMs ||
		!gatewayIdentitiesEqual(options.existing.gateway, options.replacement.gateway) ||
		!gatewayReservationsEqual(
			options.existing.gatewayReservation,
			options.replacement.gatewayReservation,
		)
	) {
		throw new VmOwnershipJournalError('membership-identity-mismatch');
	}
	if (!allowedGatewayStateTransitions[options.existing.state].has(options.replacement.state)) {
		throw new VmOwnershipJournalError('membership-state-transition-refused');
	}
	const appendedChildCount = options.replacement.children.length - options.existing.children.length;
	if (
		appendedChildCount < 0 ||
		appendedChildCount > 1 ||
		(appendedChildCount === 1 &&
			(options.existing.state !== 'admitting' || options.replacement.state !== 'admitting'))
	) {
		throw new VmOwnershipJournalError('membership-state-transition-refused');
	}
	const replacementChildren = new Map(
		options.replacement.children.map((child) => [child.reservationId, child]),
	);
	for (const existingChild of options.existing.children) {
		const replacementChild = replacementChildren.get(existingChild.reservationId);
		if (replacementChild === undefined || !childIdentitiesEqual(existingChild, replacementChild)) {
			throw new VmOwnershipJournalError('membership-identity-mismatch');
		}
		if (replacementChild.observedReservationRevision < existingChild.observedReservationRevision) {
			throw new VmOwnershipJournalError('membership-revision-regressed');
		}
		if (!allowedChildStateTransitions[existingChild.state].has(replacementChild.state)) {
			throw new VmOwnershipJournalError('membership-state-transition-refused');
		}
		if (
			existingChild.state === 'destroyed' &&
			(replacementChild.observedReservationRevision !== existingChild.observedReservationRevision ||
				replacementChild.dispositionReason !== existingChild.dispositionReason)
		) {
			throw new VmOwnershipJournalError('membership-state-transition-refused');
		}
	}
	if (appendedChildCount === 1) {
		const existingReservationIds = new Set(
			options.existing.children.map((child) => child.reservationId),
		);
		const appendedChild = options.replacement.children.find(
			(child) => !existingReservationIds.has(child.reservationId),
		);
		if (appendedChild?.state !== 'provisional') {
			throw new VmOwnershipJournalError('membership-state-transition-refused');
		}
	}
}

function assertGatewayEpochIdSafe(gatewayEpochId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(gatewayEpochId)) {
		throw new VmOwnershipJournalError('ownership-storage-unsafe');
	}
}

async function syncDirectory(directoryPath: string): Promise<void> {
	const directoryHandle = await open(directoryPath, 'r');
	try {
		await directoryHandle.sync();
	} finally {
		await directoryHandle.close();
	}
}

async function writeDurableRecord(options: {
	readonly content: string;
	readonly filePath: string;
	readonly membershipDirectory: string;
}): Promise<void> {
	const temporaryPath = path.join(
		options.membershipDirectory,
		`.membership-${process.pid}-${randomUUID()}.tmp`,
	);
	const temporaryHandle = await open(temporaryPath, 'wx', 0o600);
	let temporaryExists = true;
	try {
		await temporaryHandle.writeFile(options.content, { encoding: 'utf8' });
		await temporaryHandle.sync();
		await temporaryHandle.close();
		await rename(temporaryPath, options.filePath);
		temporaryExists = false;
		await chmod(options.filePath, 0o600);
		await syncDirectory(options.membershipDirectory);
	} catch (error) {
		await temporaryHandle.close().catch(() => undefined);
		if (temporaryExists) {
			await unlink(temporaryPath).catch(() => undefined);
		}
		throw error;
	}
}

interface OwnedVmIdentity {
	readonly reservationId: string;
	readonly reservationPath: string;
	readonly vmId: string;
}

function ownedVmIdentities(record: GatewayMembershipRecord): readonly OwnedVmIdentity[] {
	return [
		{
			reservationId: record.gatewayReservation.reservationId,
			reservationPath: record.gatewayReservation.reservationPath,
			vmId: record.gatewayReservation.vmId,
		},
		...record.children.map((child) => ({
			reservationId: child.reservationId,
			reservationPath: child.reservationPath,
			vmId: child.vmId,
		})),
	];
}

function recordsConflict(
	existing: GatewayMembershipRecord,
	candidate: GatewayMembershipRecord,
): boolean {
	if (
		existing.gateway.zoneId === candidate.gateway.zoneId &&
		existing.state !== 'destroyed' &&
		candidate.state !== 'destroyed'
	) {
		return true;
	}
	const existingIdentities = ownedVmIdentities(existing);
	return ownedVmIdentities(candidate).some((candidateIdentity) =>
		existingIdentities.some(
			(existingIdentity) =>
				existingIdentity.reservationId === candidateIdentity.reservationId ||
				existingIdentity.reservationPath === candidateIdentity.reservationPath ||
				existingIdentity.vmId === candidateIdentity.vmId,
		),
	);
}

export function createVmOwnershipJournal(
	options: CreateVmOwnershipJournalOptions,
): VmOwnershipJournal {
	if (!path.isAbsolute(options.stateDirectory)) {
		throw new VmOwnershipJournalError('ownership-storage-unsafe');
	}
	const stateDirectory = path.resolve(options.stateDirectory);
	const ownershipDirectory = path.join(stateDirectory, 'vm-ownership');
	const membershipDirectory = path.join(ownershipDirectory, 'gateway-membership');
	const reservationDirectory = path.join(ownershipDirectory, 'reservations');

	const membershipPath = (gatewayEpochId: string): string => {
		assertGatewayEpochIdSafe(gatewayEpochId);
		return path.join(membershipDirectory, `${gatewayEpochId}.json`);
	};

	const ensureStorage = async (): Promise<void> => {
		await ensureOwnedDirectory(stateDirectory);
		await ensureOwnedDirectory(ownershipDirectory);
		await ensureOwnedDirectory(membershipDirectory);
		await ensureOwnedDirectory(reservationDirectory);
	};

	const reservationPathFor = (reservationId: string): string => {
		assertGatewayEpochIdSafe(reservationId);
		return path.join(reservationDirectory, reservationId, 'reservation-v1.json');
	};

	const assertReservationPathOwned = (reservationPath: string, reservationId: string): void => {
		assertGatewayEpochIdSafe(reservationId);
		if (!path.isAbsolute(reservationPath)) {
			throw new VmOwnershipJournalError('ownership-storage-unsafe');
		}
		const relativePath = path.relative(reservationDirectory, reservationPath);
		const relativeSegments = relativePath.split(path.sep);
		if (
			relativePath.startsWith('..') ||
			path.isAbsolute(relativePath) ||
			relativeSegments.length !== 2 ||
			!relativeSegments[0] ||
			!relativeSegments[1] ||
			path.basename(reservationPath) !== 'reservation-v1.json'
		) {
			throw new VmOwnershipJournalError('ownership-storage-unsafe');
		}
		assertGatewayEpochIdSafe(relativeSegments[0]);
		if (reservationPath !== reservationPathFor(reservationId)) {
			throw new VmOwnershipJournalError('membership-identity-mismatch');
		}
	};

	const assertMembershipReservationPathsOwned = (record: GatewayMembershipRecord): void => {
		assertReservationPathOwned(
			record.gatewayReservation.reservationPath,
			record.gatewayReservation.reservationId,
		);
		for (const child of record.children) {
			assertReservationPathOwned(child.reservationPath, child.reservationId);
		}
	};

	const loadMembershipWithoutQueue = async (
		gatewayEpochId: string,
	): Promise<GatewayMembershipRecord> => {
		await ensureStorage();
		const filePath = membershipPath(gatewayEpochId);
		const fileKind = await inspectPathWithoutFollowingSymlinks(filePath);
		if (fileKind === 'missing') {
			throw new VmOwnershipJournalError('membership-missing');
		}
		if (fileKind !== 'regular-file') {
			throw new VmOwnershipJournalError('ownership-storage-unsafe');
		}
		const parsedRecord = parseMembershipRecord(await readFile(filePath, 'utf8'));
		assertMembershipReservationPathsOwned(parsedRecord);
		if (parsedRecord.gateway.gatewayEpochId !== gatewayEpochId) {
			throw new VmOwnershipJournalError('membership-ambiguous');
		}
		return parsedRecord;
	};

	const loadAllWithoutQueue = async (): Promise<readonly GatewayMembershipRecord[]> => {
		await ensureStorage();
		const entries = (await readdir(membershipDirectory)).filter((entry) => entry.endsWith('.json'));
		const records: GatewayMembershipRecord[] = [];
		for (const entry of entries.toSorted()) {
			const gatewayEpochId = entry.slice(0, -'.json'.length);
			// oxlint-disable-next-line no-await-in-loop -- every durable record is validated independently.
			records.push(await loadMembershipWithoutQueue(gatewayEpochId));
		}
		for (const [recordIndex, record] of records.entries()) {
			for (const candidate of records.slice(recordIndex + 1)) {
				if (recordsConflict(record, candidate)) {
					throw new VmOwnershipJournalError('membership-ambiguous');
				}
			}
		}
		return records;
	};

	const runSerialized = async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
		const priorOperation = stateDirectoryOperationQueues.get(stateDirectory) ?? Promise.resolve();
		let releaseOperation: (() => void) | undefined;
		const currentOperation = new Promise<void>((resolve) => {
			releaseOperation = resolve;
		});
		stateDirectoryOperationQueues.set(stateDirectory, currentOperation);
		await priorOperation.catch(() => undefined);
		try {
			return await operation();
		} finally {
			releaseOperation?.();
			if (stateDirectoryOperationQueues.get(stateDirectory) === currentOperation) {
				stateDirectoryOperationQueues.delete(stateDirectory);
			}
		}
	};

	return {
		assertReservationPathOwned,
		captureTimestampMs(): number {
			return options.nowMs();
		},
		async createGatewayMembership(record): Promise<GatewayMembershipRecord> {
			return await runSerialized(async () => {
				const parsedRecord = parseMembershipValue(record);
				assertMembershipReservationPathsOwned(parsedRecord);
				if (parsedRecord.revision !== 1) {
					throw new VmOwnershipJournalError('membership-revision-regressed');
				}
				if (parsedRecord.state !== 'admitting' || parsedRecord.children.length !== 0) {
					throw new VmOwnershipJournalError('membership-state-transition-refused');
				}
				await ensureStorage();
				const filePath = membershipPath(parsedRecord.gateway.gatewayEpochId);
				const existingKind = await inspectPathWithoutFollowingSymlinks(filePath);
				if (existingKind !== 'missing') {
					throw new VmOwnershipJournalError(
						existingKind === 'regular-file' ? 'membership-duplicate' : 'ownership-storage-unsafe',
					);
				}
				const existingRecords = await loadAllWithoutQueue();
				if (
					existingRecords.some((existingRecord) => recordsConflict(existingRecord, parsedRecord))
				) {
					throw new VmOwnershipJournalError('membership-ambiguous');
				}
				await writeDurableRecord({
					content: `${JSON.stringify(parsedRecord, null, 2)}\n`,
					filePath,
					membershipDirectory,
				});
				return parsedRecord;
			});
		},
		ensureStorage,
		async inspectMembershipFile(gatewayEpochId) {
			await ensureStorage();
			const directoryStats = await lstat(membershipDirectory);
			const fileStats = await lstat(membershipPath(gatewayEpochId));
			if (directoryStats.isSymbolicLink() || fileStats.isSymbolicLink()) {
				throw new VmOwnershipJournalError('ownership-path-symlink');
			}
			return {
				directoryMode: modeBits(directoryStats.mode),
				fileMode: modeBits(fileStats.mode),
			};
		},
		async loadAllGatewayMemberships(): Promise<readonly GatewayMembershipRecord[]> {
			return await runSerialized(loadAllWithoutQueue);
		},
		async loadGatewayMembership(gatewayEpochId): Promise<GatewayMembershipRecord> {
			return await runSerialized(async () => {
				const records = await loadAllWithoutQueue();
				const record = records.find(
					(candidate) => candidate.gateway.gatewayEpochId === gatewayEpochId,
				);
				if (record === undefined) {
					throw new VmOwnershipJournalError('membership-missing');
				}
				return record;
			});
		},
		membershipPathForTesting: membershipPath,
		reservationPathFor,
		async replaceGatewayMembership(replaceOptions): Promise<GatewayMembershipRecord> {
			return await runSerialized(async () => {
				const parsedRecord = parseMembershipValue(replaceOptions.record);
				assertMembershipReservationPathsOwned(parsedRecord);
				const existingRecord = await loadMembershipWithoutQueue(
					parsedRecord.gateway.gatewayEpochId,
				);
				if (existingRecord.revision !== replaceOptions.expectedRevision) {
					throw new VmOwnershipJournalError('membership-revision-conflict');
				}
				if (parsedRecord.revision <= existingRecord.revision) {
					throw new VmOwnershipJournalError('membership-revision-regressed');
				}
				if (parsedRecord.revision !== existingRecord.revision + 1) {
					throw new VmOwnershipJournalError('membership-revision-conflict');
				}
				assertReplacementPreservesAuthority({
					existing: existingRecord,
					replacement: parsedRecord,
				});
				const siblingRecords = (await loadAllWithoutQueue()).filter(
					(record) => record.gateway.gatewayEpochId !== parsedRecord.gateway.gatewayEpochId,
				);
				if (siblingRecords.some((siblingRecord) => recordsConflict(siblingRecord, parsedRecord))) {
					throw new VmOwnershipJournalError('membership-ambiguous');
				}
				const filePath = membershipPath(parsedRecord.gateway.gatewayEpochId);
				const existingKind = await inspectPathWithoutFollowingSymlinks(filePath);
				if (existingKind !== 'regular-file') {
					throw new VmOwnershipJournalError(
						existingKind === 'missing' ? 'membership-missing' : 'ownership-storage-unsafe',
					);
				}
				await writeDurableRecord({
					content: `${JSON.stringify(parsedRecord, null, 2)}\n`,
					filePath,
					membershipDirectory,
				});
				return parsedRecord;
			});
		},
	};
}

export type { GatewayMembershipRecord } from './vm-ownership-contracts.js';
