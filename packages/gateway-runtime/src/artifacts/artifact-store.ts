import { createHash, randomUUID } from 'node:crypto';

import {
	PortalArtifactReadRequestSchema,
	PortalArtifactReadResultSchema,
	type ArtifactReference,
	type PortalArtifactReadRequest,
	type PortalArtifactReadResult,
} from '@agent-vm/agent-portal-sdk';

import {
	GatewayRuntimeArtifactAuthorizationSchema,
	GatewayRuntimeArtifactReadAuthorityDecisionSchema,
	GatewayRuntimeArtifactReadCallerSchema,
	type GatewayRuntimeArtifactAuthorization,
	type GatewayRuntimeArtifactReadAuthorityResolver,
	type GatewayRuntimeArtifactReadCaller,
} from './artifact-read-authority.js';

export {
	GatewayRuntimeArtifactAuthorizationSchema,
	GatewayRuntimeArtifactReadCallerSchema,
	createGatewayRuntimeArtifactReadAuthorityResolver,
	gatewayRuntimeArtifactStablePrincipalFromTrustedContext,
	type GatewayRuntimeArtifactAuthorization,
	type GatewayRuntimeArtifactCurrentAuthority,
	type GatewayRuntimeArtifactCurrentAuthorityDecision,
	type GatewayRuntimeArtifactReadAuthorityDecision,
	type GatewayRuntimeArtifactReadAuthorityResolver,
	type GatewayRuntimeArtifactReadCaller,
	type GatewayRuntimeArtifactMcpReadCaller,
	type GatewayRuntimeArtifactProtectedUdsReadCaller,
	type GatewayRuntimeArtifactStablePrincipal,
} from './artifact-read-authority.js';

export type GatewayRuntimeArtifactStoreErrorCode =
	| 'capacity'
	| 'cleanup-failed'
	| 'expired'
	| 'not-authorized'
	| 'not-found'
	| 'range'
	| 'retired'
	| 'write-cancelled'
	| 'write-failed';

export class GatewayRuntimeArtifactStoreError extends Error {
	readonly code: GatewayRuntimeArtifactStoreErrorCode;

	constructor(code: GatewayRuntimeArtifactStoreErrorCode, message: string) {
		super(message);
		this.name = 'GatewayRuntimeArtifactStoreError';
		this.code = code;
	}
}

export interface GatewayRuntimeArtifactStorageWriter {
	readonly commit: () => Promise<void>;
	readonly discard: () => Promise<void>;
	readonly write: (chunk: Uint8Array, signal?: AbortSignal) => Promise<void>;
}

export interface GatewayRuntimeArtifactStorageBackend {
	readonly createWriter: (artifactId: string) => Promise<GatewayRuntimeArtifactStorageWriter>;
	readonly readRange: (props: {
		readonly artifactId: string;
		readonly maxBytes: number;
		readonly offsetBytes: number;
	}) => Promise<Uint8Array>;
	readonly remove: (artifactId: string) => Promise<void>;
}

export interface GatewayRuntimeArtifactStoreLimits {
	readonly maximumArtifactBytes: number;
	readonly maximumArtifactCount: number;
	readonly maximumLifetimeMs: number;
	readonly maximumTotalBytes: number;
}

export interface GatewayRuntimeArtifactStoreCounters {
	readonly activeReservations: number;
	readonly artifactCount: number;
	readonly committedBytes: number;
	readonly orphanedArtifactCount: number;
	readonly orphanedBytes: number;
	readonly reservedBytes: number;
	readonly retired: boolean;
}

export interface GatewayRuntimeArtifactWriteHandle {
	readonly artifactId: string;
	readonly abort: () => Promise<void>;
	readonly commit: () => Promise<ArtifactReference>;
	readonly write: (chunk: Uint8Array, signal?: AbortSignal) => Promise<void>;
}

export interface GatewayRuntimeArtifactReader<
	TCaller extends GatewayRuntimeArtifactReadCaller = GatewayRuntimeArtifactReadCaller,
> {
	readonly read: (props: {
		readonly caller: TCaller;
		readonly request: PortalArtifactReadRequest;
	}) => Promise<PortalArtifactReadResult>;
}

export interface GatewayRuntimeArtifactStore extends GatewayRuntimeArtifactReader {
	readonly beginWrite: (props: {
		readonly authorization: GatewayRuntimeArtifactAuthorization;
		readonly lifetimeMs: number;
		readonly maximumBytes: number;
		readonly mediaType?: string;
	}) => Promise<GatewayRuntimeArtifactWriteHandle>;
	readonly inspectCounters: () => GatewayRuntimeArtifactStoreCounters;
	readonly retireEpoch: () => Promise<void>;
}

export interface CreateGatewayRuntimeArtifactStoreProps {
	readonly authorityResolver: GatewayRuntimeArtifactReadAuthorityResolver;
	readonly createArtifactId?: () => string;
	readonly epochId: string;
	readonly limits: GatewayRuntimeArtifactStoreLimits;
	readonly now?: () => number;
	readonly storageBackend: GatewayRuntimeArtifactStorageBackend;
}

interface CommittedArtifact {
	readonly authorization: GatewayRuntimeArtifactAuthorization;
	readonly epochId: string;
	readonly reference: ArtifactReference;
}

type WriteState = 'active' | 'aborted' | 'committed' | 'failed';

interface ActiveWriteReservation {
	abortForRetirement: () => Promise<void>;
	readonly artifactId: string;
	readonly maximumBytes: number;
}

interface ArtifactStateTransactionGate {
	readonly promise: Promise<void>;
	readonly release: () => void;
}

function createArtifactStateTransactionGate(): ArtifactStateTransactionGate {
	let release: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	if (release === undefined) {
		throw new Error('Artifact state transaction gate was not initialized.');
	}
	return { promise, release };
}

function constantStoreError(
	code: GatewayRuntimeArtifactStoreErrorCode,
	message: string,
): GatewayRuntimeArtifactStoreError {
	return new GatewayRuntimeArtifactStoreError(code, message);
}

function assertPositiveSafeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw constantStoreError('capacity', `${label} must be a positive safe integer.`);
	}
}

function validateLimits(limits: GatewayRuntimeArtifactStoreLimits): void {
	assertPositiveSafeInteger(limits.maximumArtifactBytes, 'Maximum artifact bytes');
	assertPositiveSafeInteger(limits.maximumArtifactCount, 'Maximum artifact count');
	assertPositiveSafeInteger(limits.maximumLifetimeMs, 'Maximum artifact lifetime');
	assertPositiveSafeInteger(limits.maximumTotalBytes, 'Maximum total artifact bytes');
}

function referencesMatch(left: ArtifactReference, right: ArtifactReference): boolean {
	return (
		left.byteLength === right.byteLength &&
		left.expiresAt === right.expiresAt &&
		left.fingerprint === right.fingerprint &&
		left.id === right.id &&
		left.mediaType === right.mediaType
	);
}

function createReference(props: {
	readonly artifactId: string;
	readonly byteLength: number;
	readonly expiresAt: string;
	readonly fingerprint: string;
	readonly mediaType?: string;
}): ArtifactReference {
	return {
		byteLength: props.byteLength,
		expiresAt: props.expiresAt,
		fingerprint: props.fingerprint,
		id: props.artifactId,
		...(props.mediaType === undefined ? {} : { mediaType: props.mediaType }),
	};
}

export function createGatewayRuntimeArtifactStore(
	props: CreateGatewayRuntimeArtifactStoreProps,
): GatewayRuntimeArtifactStore {
	if (typeof props.authorityResolver?.authorize !== 'function') {
		throw constantStoreError(
			'not-authorized',
			'Gateway runtime artifact read authority resolver is required.',
		);
	}
	if (props.epochId.length === 0) {
		throw constantStoreError('write-failed', 'Gateway runtime artifact epoch is required.');
	}
	validateLimits(props.limits);
	const createArtifactId = props.createArtifactId ?? randomUUID;
	const epochArtifactIdPrefix = createHash('sha256')
		.update(props.epochId, 'utf8')
		.digest('hex')
		.slice(0, 16);
	const now = props.now ?? Date.now;
	const activeReservations = new Set<ActiveWriteReservation>();
	const committedArtifacts = new Map<string, CommittedArtifact>();
	let committedBytes = 0;
	let orphanedArtifactCount = 0;
	let orphanedBytes = 0;
	let reservedBytes = 0;
	let retired = false;
	let retirementPromise: Promise<void> | null = null;
	let artifactStateTransaction = Promise.resolve();

	async function runArtifactStateTransaction<TResult>(
		operation: () => Promise<TResult>,
	): Promise<TResult> {
		const precedingTransaction = artifactStateTransaction;
		const nextTransaction = createArtifactStateTransactionGate();
		artifactStateTransaction = nextTransaction.promise;
		await precedingTransaction;
		try {
			return await operation();
		} finally {
			nextTransaction.release();
		}
	}

	function assertActiveStore(): void {
		if (retired) {
			throw constantStoreError('retired', 'Gateway runtime artifact epoch is retired.');
		}
	}

	function releaseReservation(reservation: ActiveWriteReservation): void {
		if (!activeReservations.delete(reservation)) return;
		reservedBytes -= reservation.maximumBytes;
	}

	async function cleanupWriter(cleanupProps: {
		readonly reservation: ActiveWriteReservation;
		readonly writer: GatewayRuntimeArtifactStorageWriter;
		readonly writtenBytes: number;
	}): Promise<void> {
		try {
			await cleanupProps.writer.discard();
			releaseReservation(cleanupProps.reservation);
		} catch {
			releaseReservation(cleanupProps.reservation);
			orphanedArtifactCount += 1;
			orphanedBytes += cleanupProps.writtenBytes;
			throw constantStoreError('cleanup-failed', 'Gateway runtime artifact cleanup failed.');
		}
	}

	async function removeCommittedArtifact(artifact: CommittedArtifact): Promise<boolean> {
		if (!committedArtifacts.has(artifact.reference.id)) return true;
		try {
			await props.storageBackend.remove(artifact.reference.id);
			committedArtifacts.delete(artifact.reference.id);
			committedBytes -= artifact.reference.byteLength;
			return true;
		} catch {
			committedArtifacts.delete(artifact.reference.id);
			committedBytes -= artifact.reference.byteLength;
			orphanedArtifactCount += 1;
			orphanedBytes += artifact.reference.byteLength;
			return false;
		}
	}

	async function reclaimExpiredArtifacts(): Promise<void> {
		const expiredArtifacts = Array.from(committedArtifacts.values()).filter(
			(artifact) => Date.parse(artifact.reference.expiresAt) <= now(),
		);
		const cleanupResults = await Promise.all(expiredArtifacts.map(removeCommittedArtifact));
		if (cleanupResults.some((cleanupSucceeded) => !cleanupSucceeded)) {
			throw constantStoreError('cleanup-failed', 'Gateway runtime artifact cleanup failed.');
		}
	}

	async function beginWrite(
		writeProps: Parameters<GatewayRuntimeArtifactStore['beginWrite']>[0],
	): Promise<GatewayRuntimeArtifactWriteHandle> {
		return await runArtifactStateTransaction(async () => {
			assertActiveStore();
			assertPositiveSafeInteger(writeProps.maximumBytes, 'Artifact reservation bytes');
			assertPositiveSafeInteger(writeProps.lifetimeMs, 'Artifact lifetime');
			await reclaimExpiredArtifacts();
			if (
				writeProps.maximumBytes > props.limits.maximumArtifactBytes ||
				writeProps.lifetimeMs > props.limits.maximumLifetimeMs ||
				committedArtifacts.size + activeReservations.size + orphanedArtifactCount >=
					props.limits.maximumArtifactCount ||
				committedBytes + orphanedBytes + reservedBytes + writeProps.maximumBytes >
					props.limits.maximumTotalBytes
			) {
				throw constantStoreError('capacity', 'Gateway runtime artifact capacity is exhausted.');
			}
			const parsedAuthorization = GatewayRuntimeArtifactAuthorizationSchema.parse(
				writeProps.authorization,
			);
			const artifactIdCandidate = createArtifactId();
			const artifactId = `${epochArtifactIdPrefix}-${artifactIdCandidate}`;
			if (
				artifactIdCandidate.length === 0 ||
				committedArtifacts.has(artifactId) ||
				[...activeReservations].some((reservation) => reservation.artifactId === artifactId)
			) {
				throw constantStoreError(
					'write-failed',
					'Gateway runtime artifact ID is invalid or reused.',
				);
			}
			const reservation: ActiveWriteReservation = {
				abortForRetirement: async () => undefined,
				artifactId,
				maximumBytes: writeProps.maximumBytes,
			};
			activeReservations.add(reservation);
			reservedBytes += writeProps.maximumBytes;
			let writer: GatewayRuntimeArtifactStorageWriter;
			try {
				writer = await props.storageBackend.createWriter(artifactId);
			} catch {
				releaseReservation(reservation);
				throw constantStoreError(
					'write-failed',
					'Gateway runtime artifact writer creation failed.',
				);
			}
			const hash = createHash('sha256');
			let state: WriteState = 'active';
			let writtenBytes = 0;

			function assertActiveWrite(): void {
				if (state !== 'active') {
					throw constantStoreError('write-failed', 'Gateway runtime artifact write is terminal.');
				}
			}

			async function abortWithCode(
				code: 'capacity' | 'write-cancelled' | 'write-failed',
				message: string,
				possiblyPersistedBytes: number = writtenBytes,
			): Promise<never> {
				state = 'failed';
				await cleanupWriter({ reservation, writer, writtenBytes: possiblyPersistedBytes });
				throw constantStoreError(code, message);
			}

			async function abort(): Promise<void> {
				await runArtifactStateTransaction(async () => {
					assertActiveWrite();
					state = 'aborted';
					await cleanupWriter({ reservation, writer, writtenBytes });
				});
			}

			async function write(chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
				await runArtifactStateTransaction(async () => {
					assertActiveWrite();
					if (signal?.aborted === true) {
						await abortWithCode('write-cancelled', 'Gateway runtime artifact write was cancelled.');
					}
					if (
						!Number.isSafeInteger(chunk.byteLength) ||
						writtenBytes + chunk.byteLength > writeProps.maximumBytes
					) {
						await abortWithCode('capacity', 'Gateway runtime artifact exceeded its reservation.');
					}
					try {
						await writer.write(chunk, signal);
					} catch {
						await abortWithCode(
							'write-failed',
							'Gateway runtime artifact write failed.',
							writtenBytes + chunk.byteLength,
						);
					}
					hash.update(chunk);
					writtenBytes += chunk.byteLength;
				});
			}

			async function commit(): Promise<ArtifactReference> {
				return await runArtifactStateTransaction(async () => {
					assertActiveWrite();
					try {
						await writer.commit();
					} catch {
						await abortWithCode('write-failed', 'Gateway runtime artifact commit failed.');
					}
					state = 'committed';
					releaseReservation(reservation);
					const reference = createReference({
						artifactId,
						byteLength: writtenBytes,
						expiresAt: new Date(now() + writeProps.lifetimeMs).toISOString(),
						fingerprint: `sha256:${hash.digest('hex')}`,
						...(writeProps.mediaType === undefined ? {} : { mediaType: writeProps.mediaType }),
					});
					committedArtifacts.set(artifactId, {
						authorization: parsedAuthorization,
						epochId: props.epochId,
						reference,
					});
					committedBytes += writtenBytes;
					return reference;
				});
			}

			reservation.abortForRetirement = async (): Promise<void> => {
				if (state !== 'active') return;
				state = 'aborted';
				await cleanupWriter({ reservation, writer, writtenBytes });
			};
			return { abort, artifactId, commit, write };
		});
	}

	async function read(
		readProps: Parameters<GatewayRuntimeArtifactStore['read']>[0],
	): Promise<PortalArtifactReadResult> {
		return await runArtifactStateTransaction(async () => {
			assertActiveStore();
			let request: PortalArtifactReadRequest;
			try {
				request = PortalArtifactReadRequestSchema.parse(readProps.request);
			} catch {
				throw constantStoreError(
					'not-authorized',
					'Gateway runtime artifact read is not authorized.',
				);
			}
			const artifact = committedArtifacts.get(request.reference.id);
			if (artifact === undefined) {
				throw constantStoreError(
					'not-authorized',
					'Gateway runtime artifact read is not authorized.',
				);
			}
			let caller: GatewayRuntimeArtifactReadCaller;
			try {
				caller = GatewayRuntimeArtifactReadCallerSchema.parse(readProps.caller);
			} catch {
				throw constantStoreError(
					'not-authorized',
					'Gateway runtime artifact read is not authorized.',
				);
			}
			let authorized = false;
			try {
				authorized =
					GatewayRuntimeArtifactReadAuthorityDecisionSchema.parse(
						props.authorityResolver.authorize({
							caller,
							storedAuthorization: artifact.authorization,
						}),
					).kind === 'authorized';
			} catch {
				authorized = false;
			}
			if (
				artifact.epochId !== props.epochId ||
				!authorized ||
				!referencesMatch(artifact.reference, request.reference)
			) {
				throw constantStoreError(
					'not-authorized',
					'Gateway runtime artifact read is not authorized.',
				);
			}
			if (Date.parse(artifact.reference.expiresAt) <= now()) {
				await removeCommittedArtifact(artifact);
				throw constantStoreError('expired', 'Gateway runtime artifact expired.');
			}
			const rangeEnd = request.offsetBytes + request.maxBytes;
			if (!Number.isSafeInteger(rangeEnd) || request.offsetBytes > artifact.reference.byteLength) {
				throw constantStoreError('range', 'Gateway runtime artifact range is invalid.');
			}
			let bytes: Uint8Array;
			try {
				bytes = await props.storageBackend.readRange({
					artifactId: artifact.reference.id,
					maxBytes: request.maxBytes,
					offsetBytes: request.offsetBytes,
				});
			} catch {
				throw constantStoreError('not-found', 'Gateway runtime artifact bytes were not found.');
			}
			if (bytes.byteLength > request.maxBytes) {
				throw constantStoreError(
					'range',
					'Gateway runtime artifact backend exceeded the read range.',
				);
			}
			return PortalArtifactReadResultSchema.parse({
				contentBase64: Buffer.from(bytes).toString('base64'),
				...(artifact.reference.mediaType === undefined
					? {}
					: { mediaType: artifact.reference.mediaType }),
				offsetBytes: request.offsetBytes,
				reference: artifact.reference,
				truncated: request.offsetBytes + bytes.byteLength < artifact.reference.byteLength,
			});
		});
	}

	function retireEpoch(): Promise<void> {
		if (retirementPromise !== null) return retirementPromise;
		retired = true;
		retirementPromise = runArtifactStateTransaction(async () => {
			const reservationCleanupResults = await Promise.all(
				Array.from(activeReservations).map(async (reservation) => {
					try {
						await reservation.abortForRetirement();
						return null;
					} catch (error) {
						return error instanceof GatewayRuntimeArtifactStoreError ? error : null;
					}
				}),
			);
			const artifactCleanupResults = await Promise.all(
				Array.from(committedArtifacts.values()).map(removeCommittedArtifact),
			);
			const cleanupErrors = reservationCleanupResults.filter(
				(error): error is GatewayRuntimeArtifactStoreError => error !== null,
			);
			if (artifactCleanupResults.some((cleanupSucceeded) => !cleanupSucceeded)) {
				cleanupErrors.push(
					constantStoreError('cleanup-failed', 'Gateway runtime artifact retirement failed.'),
				);
			}
			if (cleanupErrors.length > 0) throw cleanupErrors[0];
		});
		return retirementPromise;
	}

	function inspectCounters(): GatewayRuntimeArtifactStoreCounters {
		return {
			activeReservations: activeReservations.size,
			artifactCount: committedArtifacts.size,
			committedBytes,
			orphanedArtifactCount,
			orphanedBytes,
			reservedBytes,
			retired,
		};
	}

	return { beginWrite, inspectCounters, read, retireEpoch };
}
