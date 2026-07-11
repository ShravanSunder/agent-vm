import path from 'node:path';

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

import { vmDestroyReceiptMatchesTarget } from '../../shared/vm-destruction-receipt.js';
import {
	createGatewayDestructionBudget,
	type GatewayDestructionBudget,
} from './gateway-destruction-budget.js';
export {
	GatewayOwnershipCoordinatorError,
	type GatewayOwnershipCoordinatorErrorCode,
} from './gateway-ownership-errors.js';
import {
	registerGatewayMembershipBarrier,
	type GatewayMembershipBarrier,
	type GatewaySealResult,
} from './gateway-membership-barrier.js';
import { GatewayOwnershipCoordinatorError } from './gateway-ownership-errors.js';
import { createGatewayOwnershipStartupReconciler } from './gateway-ownership-startup-reconciliation.js';
import {
	serializeVmOwnershipPrincipal,
	type GatewayEpochIdentity,
	type GatewayOwnershipReservationReference,
	type ToolVmOwnershipReservationReference,
	type VmOwnershipDeploymentIdentity,
	type VmOwnershipPrincipal,
} from './vm-ownership-contracts.js';
import { createVmOwnershipJournal } from './vm-ownership-journal.js';
import { createVmOwnershipReservationAuthority } from './vm-ownership-reservation-authority.js';
import { listManagedVmOwnershipReservationPaths as listManagedVmOwnershipReservationPathsDefault } from './vm-ownership-reservation-inventory.js';

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

export interface PendingGatewayDetachedDestroyAttemptPort {
	attemptGatewayDetachedDestroy(
		expectedGateway: GatewayEpochIdentity,
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
	reconcileControllerStartup(
		zoneIds: readonly string[],
		options?: { readonly standaloneZoneId?: string },
	): Promise<void>;
	resolveGatewayEpoch(expected: {
		readonly bootId: string;
		readonly controllerEpoch: string;
		readonly zoneId: string;
	}): GatewayEpochIdentity;
	sealGatewayEpoch(expectedGateway: GatewayEpochIdentity): GatewaySealResult;
}

interface CreateGatewayOwnershipCoordinatorOptions {
	readonly controllerEpoch: string;
	readonly createId: () => string;
	readonly deploymentIdentity: VmOwnershipDeploymentIdentity;
	readonly createManagedVmOwnershipReservation?: (
		options: CreateManagedVmOwnershipReservationOptions,
	) => Promise<CreatedManagedVmOwnershipReservation>;
	readonly destroyManagedVmExact?: (
		target: ManagedVmDestroyTargetV1,
	) => Promise<ManagedVmDestroyReceiptV1>;
	readonly destructionBudget?: GatewayDestructionBudget;
	readonly listManagedVmOwnershipReservationPaths?: (
		reservationRoot: string,
	) => Promise<readonly string[]>;
	readonly nowMs: () => number;
	readonly readManagedVmDestroyTarget?: (
		reservationPath: string,
	) => Promise<ManagedVmDestroyTargetV1>;
	readonly readManagedVmOwnershipReservation?: (
		reservationPath: string,
	) => Promise<ManagedVmOwnershipReservationV1>;
	readonly standaloneReservationRoot?: string;
	readonly stateDirectoryForZone: (zoneId: string) => string;
}

interface CurrentGatewayOwnership {
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly gatewayReservation: CreatedManagedVmOwnershipReservation;
	readonly membershipBarrier: GatewayMembershipBarrier;
	readonly stateDirectory: string;
	ownerUnsafe: boolean;
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

function gatewayZonePrincipal(options: {
	readonly deploymentIdentity: VmOwnershipDeploymentIdentity;
	readonly zoneId: string;
}): Extract<VmOwnershipPrincipal, { readonly kind: 'gateway-zone' }> {
	return {
		...options.deploymentIdentity,
		kind: 'gateway-zone',
		zoneId: options.zoneId,
	};
}

function stableAgentPrincipal(options: {
	readonly agentId: string;
	readonly deploymentIdentity: VmOwnershipDeploymentIdentity;
	readonly zoneId: string;
}): Extract<VmOwnershipPrincipal, { readonly kind: 'stable-agent' }> {
	return {
		...options.deploymentIdentity,
		agentId: options.agentId,
		kind: 'stable-agent',
		zoneId: options.zoneId,
	};
}

function createGatewayJournalReservationReference(options: {
	readonly deploymentIdentity: VmOwnershipDeploymentIdentity;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly reservation: CreatedManagedVmOwnershipReservation;
}): GatewayOwnershipReservationReference {
	return {
		controllerEpoch: options.gatewayIdentity.controllerEpoch,
		expectedRevision: options.reservation.reference.expectedRevision,
		parentGateway: null,
		principal: gatewayZonePrincipal({
			deploymentIdentity: options.deploymentIdentity,
			zoneId: options.gatewayIdentity.zoneId,
		}),
		reservationId: options.reservation.reference.reservationId,
		reservationPath: options.reservation.reference.reservationPath,
		role: 'gateway',
		sessionLabel: options.reservation.reservation.sessionLabel,
		vmId: options.gatewayIdentity.gatewayVmId,
	};
}

function createToolJournalReservationReference(options: {
	readonly agentId: string;
	readonly deploymentIdentity: VmOwnershipDeploymentIdentity;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly ownershipReservation: ManagedVmOwnershipReservationReferenceV1;
	readonly sessionLabel: string;
	readonly vmId: string;
}): ToolVmOwnershipReservationReference {
	return {
		controllerEpoch: options.gatewayIdentity.controllerEpoch,
		expectedRevision: options.ownershipReservation.expectedRevision,
		parentGateway: {
			gatewayEpochId: options.gatewayIdentity.gatewayEpochId,
			gatewayVmId: options.gatewayIdentity.gatewayVmId,
		},
		principal: stableAgentPrincipal({
			agentId: options.agentId,
			deploymentIdentity: options.deploymentIdentity,
			zoneId: options.gatewayIdentity.zoneId,
		}),
		reservationId: options.ownershipReservation.reservationId,
		reservationPath: options.ownershipReservation.reservationPath,
		role: 'tool',
		sessionLabel: options.sessionLabel,
		vmId: options.vmId,
	};
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
): GatewayOwnershipCoordinator & PendingGatewayDetachedDestroyAttemptPort {
	const createManagedVmOwnershipReservation =
		coordinatorOptions.createManagedVmOwnershipReservation ??
		createManagedVmOwnershipReservationDefault;
	const destructionBudget =
		coordinatorOptions.destructionBudget ?? createGatewayDestructionBudget();
	const listManagedVmOwnershipReservationPaths =
		coordinatorOptions.listManagedVmOwnershipReservationPaths ??
		listManagedVmOwnershipReservationPathsDefault;
	const readManagedVmDestroyTarget =
		coordinatorOptions.readManagedVmDestroyTarget ?? readManagedVmDestroyTargetDefault;
	const readManagedVmOwnershipReservation =
		coordinatorOptions.readManagedVmOwnershipReservation ??
		readManagedVmOwnershipReservationDefault;
	const reservationAuthority = createVmOwnershipReservationAuthority({
		destroyManagedVmExact: coordinatorOptions.destroyManagedVmExact ?? destroyManagedVmExactDefault,
		destructionBudget,
		readManagedVmDestroyTarget,
		readManagedVmOwnershipReservation,
	});
	const {
		destroyManagedVmTarget,
		destroyMatchingReservation,
		managedReservationReference,
		readMatchingDestroyInputs,
		referencesEqual: managedReservationReferencesEqual,
		reservationPathFor,
		reservationRootForStateDirectory,
	} = reservationAuthority;
	const currentGatewayByZone = new Map<string, CurrentGatewayOwnership>();
	const gatewayBeginInFlightZones = new Set<string>();
	const ownerUnsafeZones = new Set<string>();
	let startupReconciliationInFlight = false;
	const startupReconciliationInFlightZones = new Set<string>();
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

	const requireMatchingGatewayForContainment = (
		expectedGateway: GatewayEpochIdentity,
	): CurrentGatewayOwnership => {
		const currentGateway = currentGatewayByZone.get(expectedGateway.zoneId);
		if (currentGateway === undefined) {
			throw new GatewayOwnershipCoordinatorError('gateway-not-current');
		}
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

	const startupReconciler = createGatewayOwnershipStartupReconciler({
		assertCanonicalStateDirectory,
		authority: reservationAuthority,
		deploymentIdentity: coordinatorOptions.deploymentIdentity,
		destructionBudget,
		isZoneAlreadyCurrent: (zoneId) =>
			currentGatewayByZone.has(zoneId) || gatewayBeginInFlightZones.has(zoneId),
		listReservationPaths: listManagedVmOwnershipReservationPaths,
		markZoneOwnerUnsafe: (zoneId) => ownerUnsafeZones.add(zoneId),
		nowMs: coordinatorOptions.nowMs,
		readReservation: readManagedVmOwnershipReservation,
		readTarget: readManagedVmDestroyTarget,
		...(coordinatorOptions.standaloneReservationRoot === undefined
			? {}
			: { standaloneReservationRoot: coordinatorOptions.standaloneReservationRoot }),
		stateDirectoryForZone: coordinatorOptions.stateDirectoryForZone,
	});
	const attemptGatewayDetachedDestroy = async (
		expectedGateway: GatewayEpochIdentity,
	): Promise<ManagedVmDestroyReceiptV1> => {
		const currentGateway = requireMatchingGatewayForContainment(expectedGateway);
		const destroyed = await destroyMatchingReservation({
			controllerEpoch: currentGateway.gatewayIdentity.controllerEpoch,
			parentGateway: null,
			principal: gatewayZonePrincipal({
				deploymentIdentity: coordinatorOptions.deploymentIdentity,
				zoneId: currentGateway.gatewayIdentity.zoneId,
			}),
			reservationId: currentGateway.gatewayReservation.reference.reservationId,
			reservationPath: currentGateway.gatewayReservation.reference.reservationPath,
			role: 'gateway',
			sessionLabel: currentGateway.gatewayReservation.reservation.sessionLabel,
			vmId: currentGateway.gatewayIdentity.gatewayVmId,
		});
		return destroyed.receipt;
	};

	return {
		attemptGatewayDetachedDestroy,
		async beginGatewayEpoch(beginOptions): Promise<GatewayOwnershipEpochHandle> {
			if (startupReconciliationInFlightZones.has(beginOptions.zoneId)) {
				throw new GatewayOwnershipCoordinatorError('startup-reconciliation-in-progress');
			}
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
			const gatewayPrincipal = gatewayZonePrincipal({
				deploymentIdentity: coordinatorOptions.deploymentIdentity,
				zoneId: beginOptions.zoneId,
			});
			const reservationId = `gateway-reservation-${identityToken}`;
			gatewayBeginInFlightZones.add(beginOptions.zoneId);
			try {
				let gatewayReservation: CreatedManagedVmOwnershipReservation;
				try {
					gatewayReservation = await createManagedVmOwnershipReservation({
						controllerEpoch: coordinatorOptions.controllerEpoch,
						parentGateway: null,
						principal: serializeVmOwnershipPrincipal(gatewayPrincipal),
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
							principal: gatewayPrincipal,
							reservationId,
							reservationPath: reservationPathFor({ reservationId, stateDirectory }),
							role: 'gateway',
							sessionLabel: beginOptions.sessionLabel,
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
						const receipt = await destroyManagedVmTarget(gatewayReservation.target);
						if (!vmDestroyReceiptMatchesTarget(receipt, gatewayReservation.target)) {
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
						principal: gatewayPrincipal,
						reservationId,
						reservationPath: expectedReference.reservationPath,
						role: 'gateway',
						sessionLabel: beginOptions.sessionLabel,
						vmId: gatewayIdentity.gatewayVmId,
					});
					if (persistedGateway.reservation.revision !== expectedReference.expectedRevision) {
						throw new GatewayOwnershipCoordinatorError('reservation-identity-mismatch');
					}
				} catch (primaryError) {
					const cleanupErrors: unknown[] = [];
					try {
						const receipt = await destroyManagedVmTarget(gatewayReservation.target);
						if (!vmDestroyReceiptMatchesTarget(receipt, gatewayReservation.target)) {
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
							deploymentIdentity: coordinatorOptions.deploymentIdentity,
							gatewayIdentity,
							reservation: gatewayReservation,
						}),
						journal,
					});
				} catch (primaryError) {
					const cleanupErrors: unknown[] = [];
					try {
						const receipt = await destroyManagedVmTarget(gatewayReservation.target);
						if (!vmDestroyReceiptMatchesTarget(receipt, gatewayReservation.target)) {
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
			const toolPrincipal = stableAgentPrincipal({
				agentId: admitOptions.agentId,
				deploymentIdentity: coordinatorOptions.deploymentIdentity,
				zoneId: currentGateway.gatewayIdentity.zoneId,
			});
			const ownershipReservation = managedReservationReference({
				reservationId,
				stateDirectory: currentGateway.stateDirectory,
			});
			const admission = currentGateway.membershipBarrier.admitProvisionalChild(
				currentGateway.gatewayIdentity,
				createToolJournalReservationReference({
					agentId: admitOptions.agentId,
					deploymentIdentity: coordinatorOptions.deploymentIdentity,
					gatewayIdentity: currentGateway.gatewayIdentity,
					ownershipReservation,
					sessionLabel: admitOptions.sessionLabel,
					vmId,
				}),
			);
			const createdReservation = createManagedVmOwnershipReservation({
				controllerEpoch: currentGateway.gatewayIdentity.controllerEpoch,
				parentGateway: {
					epoch: currentGateway.gatewayIdentity.gatewayEpochId,
					vmId: currentGateway.gatewayIdentity.gatewayVmId,
				},
				principal: serializeVmOwnershipPrincipal(toolPrincipal),
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
					principal: toolPrincipal,
					reservationId,
					reservationPath: ownershipReservation.reservationPath,
					role: 'tool',
					sessionLabel: admitOptions.sessionLabel,
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
							principal: toolPrincipal,
							reservationId,
							reservationPath: ownershipReservation.reservationPath,
							role: 'tool',
							sessionLabel: admitOptions.sessionLabel,
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
						const receipt = await destroyManagedVmTarget(creationResult.value.target);
						if (!vmDestroyReceiptMatchesTarget(receipt, creationResult.value.target)) {
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
						principal: toolPrincipal,
						reservationId,
						reservationPath: ownershipReservation.reservationPath,
						role: 'tool',
						sessionLabel: admitOptions.sessionLabel,
						vmId,
					});
					observedReservationRevision = destroyInputs.reservation.revision;
					const receipt =
						closeLiveVm === undefined
							? await destroyManagedVmTarget(destroyInputs.target)
							: await destructionBudget.runTarget(
									`tool VM '${destroyInputs.target.vmId}'`,
									closeLiveVm,
								);
					if (!vmDestroyReceiptMatchesTarget(receipt, destroyInputs.target)) {
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
				const receipt = await attemptGatewayDetachedDestroy(expectedGateway);
				await currentGateway.membershipBarrier.recordGatewayDestroyDisposition(expectedGateway, {
					complete: true,
				});
				currentGatewayByZone.delete(expectedGateway.zoneId);
				return receipt;
			} catch (primaryError) {
				const cleanupErrors: unknown[] = [];
				markCurrentGatewayOwnerUnsafe(currentGateway);
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
					principal: gatewayZonePrincipal({
						deploymentIdentity: coordinatorOptions.deploymentIdentity,
						zoneId: currentGateway.gatewayIdentity.zoneId,
					}),
					reservationId: currentGateway.gatewayReservation.reference.reservationId,
					reservationPath: currentGateway.gatewayReservation.reference.reservationPath,
					role: 'gateway',
					sessionLabel: currentGateway.gatewayReservation.reservation.sessionLabel,
					vmId: currentGateway.gatewayIdentity.gatewayVmId,
				});
				receiptMatches = vmDestroyReceiptMatchesTarget(receipt, target);
			} catch {
				receiptMatches = false;
			}
			if (!receiptMatches) {
				markCurrentGatewayOwnerUnsafe(currentGateway);
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
			markCurrentGatewayOwnerUnsafe(currentGateway);
			await currentGateway.membershipBarrier.beginGatewayDestroying(expectedGateway);
			await currentGateway.membershipBarrier.recordGatewayDestroyDisposition(expectedGateway, {
				complete: false,
			});
			throw new GatewayOwnershipCoordinatorError('owner-unsafe');
		},
		async reconcileControllerStartup(zoneIds, reconciliationOptions): Promise<void> {
			const requestedZoneIds = [...zoneIds];
			const uniqueZoneIds = new Set(requestedZoneIds);
			if (
				startupReconciliationInFlight ||
				uniqueZoneIds.size !== requestedZoneIds.length ||
				requestedZoneIds.some((zoneId) => startupReconciliationInFlightZones.has(zoneId))
			) {
				throw new GatewayOwnershipCoordinatorError('startup-reconciliation-in-progress');
			}
			startupReconciliationInFlight = true;
			for (const zoneId of requestedZoneIds) {
				startupReconciliationInFlightZones.add(zoneId);
			}
			try {
				await startupReconciler.reconcile(requestedZoneIds, reconciliationOptions);
			} finally {
				for (const zoneId of requestedZoneIds) {
					startupReconciliationInFlightZones.delete(zoneId);
				}
				startupReconciliationInFlight = false;
			}
		},
		resolveGatewayEpoch(expected): GatewayEpochIdentity {
			const currentGateway = requireCurrentGateway(expected.zoneId);
			const membershipState = currentGateway.membershipBarrier.snapshot().state;
			if (membershipState === 'owner-unsafe') {
				throw new GatewayOwnershipCoordinatorError('owner-unsafe');
			}
			if (membershipState !== 'admitting') {
				throw new GatewayOwnershipCoordinatorError('gateway-not-admitting');
			}
			if (
				currentGateway.gatewayIdentity.bootId !== expected.bootId ||
				currentGateway.gatewayIdentity.controllerEpoch !== expected.controllerEpoch
			) {
				throw new GatewayOwnershipCoordinatorError('gateway-identity-mismatch');
			}
			return structuredClone(currentGateway.gatewayIdentity);
		},
		sealGatewayEpoch(expectedGateway): GatewaySealResult {
			return requireExpectedGateway(expectedGateway).membershipBarrier.sealGatewayEpoch(
				expectedGateway,
			);
		},
	};
}
