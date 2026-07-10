import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
	createManagedVmOwnershipReservation as createManagedVmOwnershipReservationDefault,
	destroyManagedVmExact as destroyManagedVmExactDefault,
	readManagedVmDestroyTarget as readManagedVmDestroyTargetDefault,
	readManagedVmOwnershipReservation as readManagedVmOwnershipReservationDefault,
	type CreatedManagedVmOwnershipReservation,
	type CreateManagedVmOwnershipReservationOptions,
	type ManagedVmDestroyReceiptV1,
	type ManagedVmDestroyTargetV1,
	type ManagedVmOwnershipReservationReferenceV1,
	type ManagedVmOwnershipReservationV1,
} from '@agent-vm/gondolin-adapter';

import {
	registerGatewayMembershipBarrier,
	type GatewayMembershipBarrier,
	type GatewaySealResult,
} from './gateway-membership-barrier.js';
import {
	type GatewayEpochIdentity,
	type GatewayOwnershipReservationReference,
	type ToolVmOwnershipReservationReference,
} from './vm-ownership-contracts.js';
import { createVmOwnershipJournal } from './vm-ownership-journal.js';

export type GatewayOwnershipCoordinatorErrorCode =
	| 'gateway-already-current'
	| 'gateway-identity-mismatch'
	| 'gateway-not-current'
	| 'owner-unsafe'
	| 'reservation-identity-mismatch'
	| 'state-directory-mismatch';

export class GatewayOwnershipCoordinatorError extends Error {
	public constructor(
		public readonly code: GatewayOwnershipCoordinatorErrorCode,
		options: { readonly cause?: unknown } = {},
	) {
		super(`Gateway ownership coordinator refused operation: ${code}`, options);
		this.name = 'GatewayOwnershipCoordinatorError';
	}
}

export interface GatewayOwnershipEpochHandle {
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly ownershipReservation: ManagedVmOwnershipReservationReferenceV1;
}

export interface ProvisionalToolVmOwnershipHandle {
	readonly ready: Promise<ManagedVmOwnershipReservationReferenceV1>;
	commitCurrent(): Promise<void>;
	destroyDetached(): Promise<ManagedVmDestroyReceiptV1>;
	destroyLive(
		closeLiveVm: () => Promise<ManagedVmDestroyReceiptV1>,
	): Promise<ManagedVmDestroyReceiptV1>;
}

export interface GatewayOwnershipCoordinator {
	beginGatewayEpoch(options: {
		readonly bootId: string;
		readonly generationId: string;
		readonly sessionLabel: string;
		readonly zoneId: string;
	}): Promise<GatewayOwnershipEpochHandle>;
	admitProvisionalToolVm(options: {
		readonly agentId: string;
		readonly expectedGateway: GatewayEpochIdentity;
		readonly sessionLabel: string;
	}): ProvisionalToolVmOwnershipHandle;
	destroyGatewayDetached(expectedGateway: GatewayEpochIdentity): Promise<ManagedVmDestroyReceiptV1>;
	recordGatewayDestroyReceipt(
		expectedGateway: GatewayEpochIdentity,
		receipt: ManagedVmDestroyReceiptV1,
	): Promise<void>;
	recordGatewayDestroyUnavailable(expectedGateway: GatewayEpochIdentity): Promise<void>;
	sealGatewayEpoch(expectedGateway: GatewayEpochIdentity): GatewaySealResult;
}

interface CreateGatewayOwnershipCoordinatorOptions {
	readonly controllerEpoch: string;
	readonly createId: () => string;
	readonly createManagedVmOwnershipReservation?: (
		options: CreateManagedVmOwnershipReservationOptions,
	) => Promise<CreatedManagedVmOwnershipReservation>;
	readonly destroyManagedVmExact?: (
		target: ManagedVmDestroyTargetV1,
	) => Promise<ManagedVmDestroyReceiptV1>;
	readonly nowMs: () => number;
	readonly readManagedVmDestroyTarget?: (
		reservationPath: string,
	) => Promise<ManagedVmDestroyTargetV1>;
	readonly readManagedVmOwnershipReservation?: (
		reservationPath: string,
	) => Promise<ManagedVmOwnershipReservationV1>;
	readonly stateDirectoryForZone: (zoneId: string) => string;
}

interface CurrentGatewayOwnership {
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly gatewayReservation: CreatedManagedVmOwnershipReservation;
	readonly membershipBarrier: GatewayMembershipBarrier;
	readonly stateDirectory: string;
	ownerUnsafe: boolean;
}

function reservationRootForStateDirectory(stateDirectory: string): string {
	return path.join(path.resolve(stateDirectory), 'vm-ownership', 'reservations');
}

function reservationPathFor(options: {
	readonly reservationId: string;
	readonly stateDirectory: string;
}): string {
	return path.join(
		reservationRootForStateDirectory(options.stateDirectory),
		options.reservationId,
		'reservation-v1.json',
	);
}

function managedReservationReference(options: {
	readonly reservationId: string;
	readonly stateDirectory: string;
}): ManagedVmOwnershipReservationReferenceV1 {
	return {
		expectedContractVersion: 1,
		expectedRevision: 1,
		reservationId: options.reservationId,
		reservationPath: reservationPathFor(options),
	};
}

function managedReservationReferencesEqual(
	left: ManagedVmOwnershipReservationReferenceV1,
	right: ManagedVmOwnershipReservationReferenceV1,
): boolean {
	return (
		left.expectedContractVersion === right.expectedContractVersion &&
		left.expectedRevision === right.expectedRevision &&
		left.reservationId === right.reservationId &&
		left.reservationPath === right.reservationPath
	);
}

function gatewayIdentityMatches(
	currentGateway: GatewayEpochIdentity,
	expectedGateway: GatewayEpochIdentity,
): boolean {
	return (
		currentGateway.bootId === expectedGateway.bootId &&
		currentGateway.controllerEpoch === expectedGateway.controllerEpoch &&
		currentGateway.gatewayEpochId === expectedGateway.gatewayEpochId &&
		currentGateway.gatewayVmId === expectedGateway.gatewayVmId &&
		currentGateway.generationId === expectedGateway.generationId &&
		currentGateway.zoneId === expectedGateway.zoneId
	);
}

function createGatewayJournalReservationReference(options: {
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly reservation: CreatedManagedVmOwnershipReservation;
}): GatewayOwnershipReservationReference {
	return {
		controllerEpoch: options.gatewayIdentity.controllerEpoch,
		expectedRevision: options.reservation.reference.expectedRevision,
		parentGateway: null,
		principal: { kind: 'gateway-zone', zoneId: options.gatewayIdentity.zoneId },
		reservationId: options.reservation.reference.reservationId,
		reservationPath: options.reservation.reference.reservationPath,
		role: 'gateway',
		vmId: options.gatewayIdentity.gatewayVmId,
	};
}

function createToolJournalReservationReference(options: {
	readonly agentId: string;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly ownershipReservation: ManagedVmOwnershipReservationReferenceV1;
	readonly vmId: string;
}): ToolVmOwnershipReservationReference {
	return {
		controllerEpoch: options.gatewayIdentity.controllerEpoch,
		expectedRevision: options.ownershipReservation.expectedRevision,
		parentGateway: {
			gatewayEpochId: options.gatewayIdentity.gatewayEpochId,
			gatewayVmId: options.gatewayIdentity.gatewayVmId,
		},
		principal: {
			agentId: options.agentId,
			kind: 'stable-agent',
			zoneId: options.gatewayIdentity.zoneId,
		},
		reservationId: options.ownershipReservation.reservationId,
		reservationPath: options.ownershipReservation.reservationPath,
		role: 'tool',
		vmId: options.vmId,
	};
}

function parentGatewaysEqual(
	left: ManagedVmDestroyTargetV1['parentGateway'],
	right: ManagedVmDestroyTargetV1['parentGateway'],
): boolean {
	return isDeepStrictEqual(left, right);
}

function receiptExecutableName(executablePath: string): string {
	const executableName = path.basename(executablePath);
	return /^[A-Za-z0-9._+-]{1,128}$/u.test(executableName) ? executableName : 'runner';
}

function destroyReceiptMatchesTarget(
	receipt: ManagedVmDestroyReceiptV1,
	target: ManagedVmDestroyTargetV1,
): boolean {
	const expectedRunner = {
		backend: target.runner.backend,
		discoveryIdentity: target.runner.discoveryIdentity,
		executableName: receiptExecutableName(target.runner.executable),
		...(target.runner.pid === undefined ? {} : { pid: target.runner.pid }),
		...(target.runner.startCookie === undefined ? {} : { startCookie: target.runner.startCookie }),
	};
	return (
		receipt.complete &&
		receipt.contractVersion === target.contractVersion &&
		receipt.controllerEpoch === target.controllerEpoch &&
		parentGatewaysEqual(receipt.parentGateway, target.parentGateway) &&
		receipt.reservationId === target.reservationId &&
		receipt.role === target.role &&
		receipt.vmId === target.vmId &&
		isDeepStrictEqual(receipt.requestedRunner, expectedRunner)
	);
}

function reservationMatchesReference(options: {
	readonly expected: {
		readonly controllerEpoch: string;
		readonly parentGateway: ManagedVmOwnershipReservationV1['parentGateway'];
		readonly reservationId: string;
		readonly role: ManagedVmOwnershipReservationV1['role'];
		readonly vmId: string;
	};
	readonly reservation: ManagedVmOwnershipReservationV1;
}): boolean {
	return (
		options.reservation.contractVersion === 1 &&
		options.reservation.controllerEpoch === options.expected.controllerEpoch &&
		parentGatewaysEqual(options.reservation.parentGateway, options.expected.parentGateway) &&
		options.reservation.reservationId === options.expected.reservationId &&
		options.reservation.role === options.expected.role &&
		options.reservation.vmId === options.expected.vmId
	);
}

function targetMatchesReservation(options: {
	readonly reservation: ManagedVmOwnershipReservationV1;
	readonly reservationPath: string;
	readonly target: ManagedVmDestroyTargetV1;
}): boolean {
	const { reservation, reservationPath, target } = options;
	return (
		target.contractVersion === reservation.contractVersion &&
		target.controllerEpoch === reservation.controllerEpoch &&
		parentGatewaysEqual(target.parentGateway, reservation.parentGateway) &&
		target.principal === reservation.principal &&
		target.reservationId === reservation.reservationId &&
		target.reservationPath === reservationPath &&
		target.role === reservation.role &&
		target.sessionLabel === reservation.sessionLabel &&
		target.vmId === reservation.vmId &&
		isDeepStrictEqual(target.ownerProcess, reservation.ownerProcess) &&
		isDeepStrictEqual(target.resources, reservation.resources) &&
		isDeepStrictEqual(target.runner, reservation.runner)
	);
}

function combinePrimaryAndCleanupErrors(options: {
	readonly cleanupErrors: readonly unknown[];
	readonly message: string;
	readonly primaryError: unknown;
}): unknown {
	if (options.cleanupErrors.length === 0) {
		return options.primaryError;
	}
	return new AggregateError([options.primaryError, ...options.cleanupErrors], options.message, {
		cause: options.primaryError,
	});
}

function isMissingPathError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function createGatewayOwnershipCoordinator(
	coordinatorOptions: CreateGatewayOwnershipCoordinatorOptions,
): GatewayOwnershipCoordinator {
	const createManagedVmOwnershipReservation =
		coordinatorOptions.createManagedVmOwnershipReservation ??
		createManagedVmOwnershipReservationDefault;
	const destroyManagedVmExact =
		coordinatorOptions.destroyManagedVmExact ?? destroyManagedVmExactDefault;
	const readManagedVmDestroyTarget =
		coordinatorOptions.readManagedVmDestroyTarget ?? readManagedVmDestroyTargetDefault;
	const readManagedVmOwnershipReservation =
		coordinatorOptions.readManagedVmOwnershipReservation ??
		readManagedVmOwnershipReservationDefault;
	const currentGatewayByZone = new Map<string, CurrentGatewayOwnership>();
	const gatewayBeginInFlightZones = new Set<string>();
	const ownerUnsafeZones = new Set<string>();
	const stateDirectoryByZone = new Map<string, string>();

	const requireCurrentGateway = (zoneId: string): CurrentGatewayOwnership => {
		if (ownerUnsafeZones.has(zoneId)) {
			throw new GatewayOwnershipCoordinatorError('owner-unsafe');
		}
		const currentGateway = currentGatewayByZone.get(zoneId);
		if (currentGateway === undefined) {
			throw new GatewayOwnershipCoordinatorError('gateway-not-current');
		}
		if (currentGateway.ownerUnsafe) {
			throw new GatewayOwnershipCoordinatorError('owner-unsafe');
		}
		return currentGateway;
	};

	const requireExpectedGateway = (
		expectedGateway: GatewayEpochIdentity,
	): CurrentGatewayOwnership => {
		const currentGateway = requireCurrentGateway(expectedGateway.zoneId);
		if (!gatewayIdentityMatches(currentGateway.gatewayIdentity, expectedGateway)) {
			throw new GatewayOwnershipCoordinatorError('gateway-identity-mismatch');
		}
		return currentGateway;
	};

	const assertCanonicalStateDirectory = (zoneId: string, stateDirectory: string): string => {
		const canonicalStateDirectory = path.resolve(stateDirectory);
		const existingStateDirectory = stateDirectoryByZone.get(zoneId);
		if (
			existingStateDirectory !== undefined &&
			existingStateDirectory !== canonicalStateDirectory
		) {
			throw new GatewayOwnershipCoordinatorError('state-directory-mismatch');
		}
		stateDirectoryByZone.set(zoneId, canonicalStateDirectory);
		return canonicalStateDirectory;
	};

	const markCurrentGatewayOwnerUnsafe = (currentGateway: CurrentGatewayOwnership): void => {
		currentGateway.ownerUnsafe = true;
		ownerUnsafeZones.add(currentGateway.gatewayIdentity.zoneId);
	};

	const readMatchingDestroyInputs = async (options: {
		readonly controllerEpoch: string;
		readonly parentGateway: ManagedVmOwnershipReservationV1['parentGateway'];
		readonly reservationId: string;
		readonly reservationPath: string;
		readonly role: ManagedVmOwnershipReservationV1['role'];
		readonly vmId: string;
	}): Promise<{
		readonly reservation: ManagedVmOwnershipReservationV1;
		readonly target: ManagedVmDestroyTargetV1;
	}> => {
		const [reservation, target] = await Promise.all([
			readManagedVmOwnershipReservation(options.reservationPath),
			readManagedVmDestroyTarget(options.reservationPath),
		]);
		if (
			!reservationMatchesReference({ expected: options, reservation }) ||
			!targetMatchesReservation({
				reservation,
				reservationPath: options.reservationPath,
				target,
			})
		) {
			throw new GatewayOwnershipCoordinatorError('reservation-identity-mismatch');
		}
		return { reservation, target };
	};

	const destroyMatchingReservation = async (options: {
		readonly controllerEpoch: string;
		readonly parentGateway: ManagedVmOwnershipReservationV1['parentGateway'];
		readonly reservationId: string;
		readonly reservationPath: string;
		readonly role: ManagedVmOwnershipReservationV1['role'];
		readonly vmId: string;
	}): Promise<{
		readonly receipt: ManagedVmDestroyReceiptV1;
		readonly reservationRevision: number;
	}> => {
		const { reservation, target } = await readMatchingDestroyInputs(options);
		const receipt = await destroyManagedVmExact(target);
		if (!destroyReceiptMatchesTarget(receipt, target)) {
			throw new GatewayOwnershipCoordinatorError('owner-unsafe');
		}
		return { receipt, reservationRevision: reservation.revision };
	};

	return {
		async beginGatewayEpoch(beginOptions): Promise<GatewayOwnershipEpochHandle> {
			const existingGateway = currentGatewayByZone.get(beginOptions.zoneId);
			if (existingGateway?.membershipBarrier.snapshot().state === 'owner-unsafe') {
				throw new GatewayOwnershipCoordinatorError('owner-unsafe');
			}
			if (existingGateway !== undefined || gatewayBeginInFlightZones.has(beginOptions.zoneId)) {
				throw new GatewayOwnershipCoordinatorError('gateway-already-current');
			}
			if (ownerUnsafeZones.has(beginOptions.zoneId)) {
				throw new GatewayOwnershipCoordinatorError('owner-unsafe');
			}
			const stateDirectory = assertCanonicalStateDirectory(
				beginOptions.zoneId,
				coordinatorOptions.stateDirectoryForZone(beginOptions.zoneId),
			);
			const identityToken = coordinatorOptions.createId();
			const gatewayIdentity = {
				bootId: beginOptions.bootId,
				controllerEpoch: coordinatorOptions.controllerEpoch,
				gatewayEpochId: `gateway-epoch-${identityToken}`,
				gatewayVmId: `gateway-vm-${identityToken}`,
				generationId: beginOptions.generationId,
				zoneId: beginOptions.zoneId,
			} satisfies GatewayEpochIdentity;
			const reservationId = `gateway-reservation-${identityToken}`;
			gatewayBeginInFlightZones.add(beginOptions.zoneId);
			try {
				let gatewayReservation: CreatedManagedVmOwnershipReservation;
				try {
					gatewayReservation = await createManagedVmOwnershipReservation({
						controllerEpoch: coordinatorOptions.controllerEpoch,
						parentGateway: null,
						principal: JSON.stringify({
							kind: 'gateway-zone',
							zoneId: beginOptions.zoneId,
						}),
						reservationId,
						reservationRoot: reservationRootForStateDirectory(stateDirectory),
						role: 'gateway',
						sessionLabel: beginOptions.sessionLabel,
						vmId: gatewayIdentity.gatewayVmId,
					});
				} catch (primaryError) {
					const cleanupErrors: unknown[] = [];
					try {
						await destroyMatchingReservation({
							controllerEpoch: coordinatorOptions.controllerEpoch,
							parentGateway: null,
							reservationId,
							reservationPath: reservationPathFor({ reservationId, stateDirectory }),
							role: 'gateway',
							vmId: gatewayIdentity.gatewayVmId,
						});
					} catch (cleanupError) {
						if (!isMissingPathError(cleanupError)) {
							cleanupErrors.push(cleanupError);
							ownerUnsafeZones.add(beginOptions.zoneId);
						}
					}
					throw combinePrimaryAndCleanupErrors({
						cleanupErrors,
						message: 'Gateway reservation creation and cleanup both failed',
						primaryError,
					});
				}
				const expectedReference = managedReservationReference({ reservationId, stateDirectory });
				if (!managedReservationReferencesEqual(gatewayReservation.reference, expectedReference)) {
					try {
						const receipt = await destroyManagedVmExact(gatewayReservation.target);
						if (!destroyReceiptMatchesTarget(receipt, gatewayReservation.target)) {
							throw new GatewayOwnershipCoordinatorError('owner-unsafe');
						}
					} catch (cleanupError) {
						ownerUnsafeZones.add(beginOptions.zoneId);
						throw new GatewayOwnershipCoordinatorError('owner-unsafe', {
							cause: cleanupError,
						});
					}
					ownerUnsafeZones.add(beginOptions.zoneId);
					throw new GatewayOwnershipCoordinatorError('reservation-identity-mismatch');
				}
				try {
					const persistedGateway = await readMatchingDestroyInputs({
						controllerEpoch: gatewayIdentity.controllerEpoch,
						parentGateway: null,
						reservationId,
						reservationPath: expectedReference.reservationPath,
						role: 'gateway',
						vmId: gatewayIdentity.gatewayVmId,
					});
					if (persistedGateway.reservation.revision !== expectedReference.expectedRevision) {
						throw new GatewayOwnershipCoordinatorError('reservation-identity-mismatch');
					}
				} catch (primaryError) {
					const cleanupErrors: unknown[] = [];
					try {
						const receipt = await destroyManagedVmExact(gatewayReservation.target);
						if (!destroyReceiptMatchesTarget(receipt, gatewayReservation.target)) {
							throw new GatewayOwnershipCoordinatorError('owner-unsafe');
						}
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
					ownerUnsafeZones.add(beginOptions.zoneId);
					throw combinePrimaryAndCleanupErrors({
						cleanupErrors,
						message: 'Persisted Gateway ownership validation and cleanup both failed',
						primaryError,
					});
				}
				const journal = createVmOwnershipJournal({
					nowMs: coordinatorOptions.nowMs,
					stateDirectory,
				});
				let membershipBarrier: GatewayMembershipBarrier;
				try {
					membershipBarrier = await registerGatewayMembershipBarrier({
						gateway: gatewayIdentity,
						gatewayReservation: createGatewayJournalReservationReference({
							gatewayIdentity,
							reservation: gatewayReservation,
						}),
						journal,
					});
				} catch (primaryError) {
					const cleanupErrors: unknown[] = [];
					try {
						const receipt = await destroyManagedVmExact(gatewayReservation.target);
						if (!destroyReceiptMatchesTarget(receipt, gatewayReservation.target)) {
							throw new GatewayOwnershipCoordinatorError('owner-unsafe');
						}
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
					ownerUnsafeZones.add(beginOptions.zoneId);
					throw combinePrimaryAndCleanupErrors({
						cleanupErrors,
						message: 'Gateway membership registration and cleanup both failed',
						primaryError,
					});
				}
				currentGatewayByZone.set(beginOptions.zoneId, {
					gatewayIdentity,
					gatewayReservation,
					membershipBarrier,
					ownerUnsafe: false,
					stateDirectory,
				});
				return {
					gatewayIdentity,
					ownershipReservation: gatewayReservation.reference,
				};
			} finally {
				gatewayBeginInFlightZones.delete(beginOptions.zoneId);
			}
		},
		admitProvisionalToolVm(admitOptions): ProvisionalToolVmOwnershipHandle {
			const currentGateway = requireExpectedGateway(admitOptions.expectedGateway);
			const identityToken = coordinatorOptions.createId();
			const reservationId = `tool-reservation-${identityToken}`;
			const vmId = `tool-vm-${identityToken}`;
			const ownershipReservation = managedReservationReference({
				reservationId,
				stateDirectory: currentGateway.stateDirectory,
			});
			const admission = currentGateway.membershipBarrier.admitProvisionalChild(
				currentGateway.gatewayIdentity,
				createToolJournalReservationReference({
					agentId: admitOptions.agentId,
					gatewayIdentity: currentGateway.gatewayIdentity,
					ownershipReservation,
					vmId,
				}),
			);
			const createdReservation = createManagedVmOwnershipReservation({
				controllerEpoch: currentGateway.gatewayIdentity.controllerEpoch,
				parentGateway: {
					epoch: currentGateway.gatewayIdentity.gatewayEpochId,
					vmId: currentGateway.gatewayIdentity.gatewayVmId,
				},
				principal: JSON.stringify({
					agentId: admitOptions.agentId,
					kind: 'stable-agent',
					zoneId: currentGateway.gatewayIdentity.zoneId,
				}),
				reservationId,
				reservationRoot: reservationRootForStateDirectory(currentGateway.stateDirectory),
				role: 'tool',
				sessionLabel: admitOptions.sessionLabel,
				vmId,
			});
			const destroyExpectedReservation = async (): Promise<number> => {
				const destroyed = await destroyMatchingReservation({
					controllerEpoch: currentGateway.gatewayIdentity.controllerEpoch,
					parentGateway: {
						epoch: currentGateway.gatewayIdentity.gatewayEpochId,
						vmId: currentGateway.gatewayIdentity.gatewayVmId,
					},
					reservationId,
					reservationPath: ownershipReservation.reservationPath,
					role: 'tool',
					vmId,
				});
				return destroyed.reservationRevision;
			};
			let preReadyCleanupPending = false;
			const ready = (async (): Promise<ManagedVmOwnershipReservationReferenceV1> => {
				const [admissionResult, creationResult] = await Promise.allSettled([
					admission.durable,
					createdReservation,
				]);
				const referenceMatches =
					creationResult.status === 'fulfilled' &&
					managedReservationReferencesEqual(creationResult.value.reference, ownershipReservation);
				let persistedValidationError: unknown;
				if (admissionResult.status === 'fulfilled' && referenceMatches) {
					try {
						const persistedTool = await readMatchingDestroyInputs({
							controllerEpoch: currentGateway.gatewayIdentity.controllerEpoch,
							parentGateway: {
								epoch: currentGateway.gatewayIdentity.gatewayEpochId,
								vmId: currentGateway.gatewayIdentity.gatewayVmId,
							},
							reservationId,
							reservationPath: ownershipReservation.reservationPath,
							role: 'tool',
							vmId,
						});
						if (persistedTool.reservation.revision !== ownershipReservation.expectedRevision) {
							throw new GatewayOwnershipCoordinatorError('reservation-identity-mismatch');
						}
						return ownershipReservation;
					} catch (error) {
						persistedValidationError = error;
					}
				}

				const primaryErrors: unknown[] = [];
				if (admissionResult.status === 'rejected') {
					primaryErrors.push(admissionResult.reason);
				}
				if (creationResult.status === 'rejected') {
					primaryErrors.push(creationResult.reason);
				} else if (!referenceMatches) {
					primaryErrors.push(new GatewayOwnershipCoordinatorError('reservation-identity-mismatch'));
				}
				if (persistedValidationError !== undefined) {
					primaryErrors.push(persistedValidationError);
				}
				const primaryError =
					primaryErrors.length === 1
						? primaryErrors[0]
						: new AggregateError(primaryErrors, 'Tool reservation admission failed');
				const cleanupErrors: unknown[] = [];
				let cleanupComplete = false;
				let observedReservationRevision = ownershipReservation.expectedRevision;
				try {
					if (creationResult.status === 'fulfilled' && !referenceMatches) {
						const receipt = await destroyManagedVmExact(creationResult.value.target);
						if (!destroyReceiptMatchesTarget(receipt, creationResult.value.target)) {
							throw new GatewayOwnershipCoordinatorError('owner-unsafe');
						}
						observedReservationRevision = creationResult.value.reservation.revision;
						// A receipt for the untrusted returned target does not prove the deterministic
						// expected reservation was absent or destroyed. Keep membership owner-unsafe.
						cleanupComplete = false;
					} else {
						observedReservationRevision = await destroyExpectedReservation();
						cleanupComplete = true;
					}
				} catch (cleanupError) {
					if (creationResult.status === 'rejected' && isMissingPathError(cleanupError)) {
						cleanupComplete = true;
					} else {
						cleanupErrors.push(cleanupError);
					}
				}

				try {
					await admission.recordDestroyDisposition(
						cleanupComplete
							? { complete: true, observedReservationRevision }
							: {
									complete: false,
									observedReservationRevision,
									reason: 'exact-destroy-unavailable',
								},
					);
				} catch (dispositionError) {
					cleanupErrors.push(dispositionError);
					markCurrentGatewayOwnerUnsafe(currentGateway);
				}
				if (!cleanupComplete) {
					preReadyCleanupPending = true;
					throw new GatewayOwnershipCoordinatorError('owner-unsafe', {
						cause: combinePrimaryAndCleanupErrors({
							cleanupErrors,
							message: 'Tool reservation failure could not be contained',
							primaryError,
						}),
					});
				}
				throw combinePrimaryAndCleanupErrors({
					cleanupErrors,
					message: 'Tool reservation failed after cleanup',
					primaryError,
				});
			})();
			const destroyOwnedToolVm = async (
				closeLiveVm?: () => Promise<ManagedVmDestroyReceiptV1>,
			): Promise<ManagedVmDestroyReceiptV1> => {
				let readinessFailed = false;
				try {
					await ready;
				} catch (readyError) {
					readinessFailed = true;
					if (!preReadyCleanupPending || closeLiveVm !== undefined) {
						throw readyError;
					}
				}
				let observedReservationRevision = ownershipReservation.expectedRevision;
				try {
					await admission.beginDestroying();
					const destroyInputs = await readMatchingDestroyInputs({
						controllerEpoch: currentGateway.gatewayIdentity.controllerEpoch,
						parentGateway: {
							epoch: currentGateway.gatewayIdentity.gatewayEpochId,
							vmId: currentGateway.gatewayIdentity.gatewayVmId,
						},
						reservationId,
						reservationPath: ownershipReservation.reservationPath,
						role: 'tool',
						vmId,
					});
					observedReservationRevision = destroyInputs.reservation.revision;
					const receipt =
						closeLiveVm === undefined
							? await destroyManagedVmExact(destroyInputs.target)
							: await closeLiveVm();
					if (!destroyReceiptMatchesTarget(receipt, destroyInputs.target)) {
						throw new GatewayOwnershipCoordinatorError('owner-unsafe');
					}
					await admission.recordDestroyDisposition({
						complete: true,
						observedReservationRevision,
					});
					preReadyCleanupPending = false;
					return receipt;
				} catch (primaryError) {
					const cleanupErrors: unknown[] = [];
					try {
						const reservation = await readManagedVmOwnershipReservation(
							ownershipReservation.reservationPath,
						);
						observedReservationRevision = reservation.revision;
					} catch {
						// The expected revision is the only safe lower bound when reread is unavailable.
					}
					try {
						await admission.recordDestroyDisposition({
							complete: false,
							observedReservationRevision,
							reason:
								primaryError instanceof GatewayOwnershipCoordinatorError &&
								primaryError.code === 'reservation-identity-mismatch'
									? 'ownership-link-mismatch'
									: 'exact-destroy-incomplete',
						});
					} catch (dispositionError) {
						cleanupErrors.push(dispositionError);
						markCurrentGatewayOwnerUnsafe(currentGateway);
					}
					throw new GatewayOwnershipCoordinatorError('owner-unsafe', {
						cause: combinePrimaryAndCleanupErrors({
							cleanupErrors,
							message: readinessFailed
								? 'Pre-ready Tool VM cleanup could not be proven'
								: 'Exact Tool VM destroy could not be proven',
							primaryError,
						}),
					});
				}
			};
			return {
				async commitCurrent(): Promise<void> {
					await ready;
					await admission.commitCurrent();
				},
				async destroyDetached(): Promise<ManagedVmDestroyReceiptV1> {
					return await destroyOwnedToolVm();
				},
				async destroyLive(closeLiveVm): Promise<ManagedVmDestroyReceiptV1> {
					return await destroyOwnedToolVm(closeLiveVm);
				},
				ready,
			};
		},
		async destroyGatewayDetached(expectedGateway): Promise<ManagedVmDestroyReceiptV1> {
			const currentGateway = requireExpectedGateway(expectedGateway);
			const sealed = currentGateway.membershipBarrier.sealGatewayEpoch(expectedGateway);
			await sealed.barrier;
			await currentGateway.membershipBarrier.beginGatewayDestroying(expectedGateway);
			try {
				const destroyed = await destroyMatchingReservation({
					controllerEpoch: currentGateway.gatewayIdentity.controllerEpoch,
					parentGateway: null,
					reservationId: currentGateway.gatewayReservation.reference.reservationId,
					reservationPath: currentGateway.gatewayReservation.reference.reservationPath,
					role: 'gateway',
					vmId: currentGateway.gatewayIdentity.gatewayVmId,
				});
				await currentGateway.membershipBarrier.recordGatewayDestroyDisposition(expectedGateway, {
					complete: true,
				});
				currentGatewayByZone.delete(expectedGateway.zoneId);
				return destroyed.receipt;
			} catch (primaryError) {
				const cleanupErrors: unknown[] = [];
				try {
					await currentGateway.membershipBarrier.recordGatewayDestroyDisposition(expectedGateway, {
						complete: false,
					});
				} catch (dispositionError) {
					cleanupErrors.push(dispositionError);
					markCurrentGatewayOwnerUnsafe(currentGateway);
				}
				throw new GatewayOwnershipCoordinatorError('owner-unsafe', {
					cause: combinePrimaryAndCleanupErrors({
						cleanupErrors,
						message: 'Detached Gateway VM destroy could not be proven',
						primaryError,
					}),
				});
			}
		},
		async recordGatewayDestroyReceipt(expectedGateway, receipt): Promise<void> {
			const currentGateway = requireExpectedGateway(expectedGateway);
			await currentGateway.membershipBarrier.beginGatewayDestroying(expectedGateway);
			let receiptMatches = false;
			try {
				const { target } = await readMatchingDestroyInputs({
					controllerEpoch: currentGateway.gatewayIdentity.controllerEpoch,
					parentGateway: null,
					reservationId: currentGateway.gatewayReservation.reference.reservationId,
					reservationPath: currentGateway.gatewayReservation.reference.reservationPath,
					role: 'gateway',
					vmId: currentGateway.gatewayIdentity.gatewayVmId,
				});
				receiptMatches = destroyReceiptMatchesTarget(receipt, target);
			} catch {
				receiptMatches = false;
			}
			await currentGateway.membershipBarrier.recordGatewayDestroyDisposition(expectedGateway, {
				complete: receiptMatches,
			});
			if (!receiptMatches) {
				throw new GatewayOwnershipCoordinatorError('owner-unsafe');
			}
			currentGatewayByZone.delete(expectedGateway.zoneId);
		},
		async recordGatewayDestroyUnavailable(expectedGateway): Promise<void> {
			const currentGateway = requireExpectedGateway(expectedGateway);
			await currentGateway.membershipBarrier.beginGatewayDestroying(expectedGateway);
			await currentGateway.membershipBarrier.recordGatewayDestroyDisposition(expectedGateway, {
				complete: false,
			});
			throw new GatewayOwnershipCoordinatorError('owner-unsafe');
		},
		sealGatewayEpoch(expectedGateway): GatewaySealResult {
			return requireExpectedGateway(expectedGateway).membershipBarrier.sealGatewayEpoch(
				expectedGateway,
			);
		},
	};
}
