import path from 'node:path';

import {
	createManagedVmOwnershipReservation as createManagedVmOwnershipReservationDefault,
	destroyManagedVmExact as destroyManagedVmExactDefault,
	readManagedVmDestroyTarget as readManagedVmDestroyTargetDefault,
	type CreateManagedVmOwnershipReservationOptions,
	type ManagedVmDestroyReceiptV1,
	type ManagedVmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';

import { assertVmDestroyReceiptMatchesTarget } from '../../shared/vm-destruction-receipt.js';
import {
	createGatewayDestructionBudget,
	type GatewayDestructionBudget,
	type GatewaySubtreeDestructionAttempt,
} from './gateway-destruction-budget.js';
import type {
	GatewayOwnershipCoordinator,
	GatewayOwnershipEpochHandle,
	PendingGatewayDetachedDestroyAttemptPort,
} from './gateway-ownership-coordinator.js';
import { GatewayOwnershipCoordinatorError } from './gateway-ownership-errors.js';
import {
	serializeVmOwnershipPrincipal,
	type GatewayEpochIdentity,
	type VmOwnershipPrincipal,
} from './vm-ownership-contracts.js';

export interface VmCreationOwnership {
	readonly gatewayIdentity?: GatewayEpochIdentity;
	readonly ownershipReservation: ManagedVmOwnershipReservationReferenceV1;
	readonly containPendingCreate?: <TCreatedVm>(options: {
		readonly closeLateCreatedVm: (createdVm: TCreatedVm) => Promise<ManagedVmDestroyReceiptV1>;
		readonly pendingCreate: Promise<TCreatedVm>;
	}) => Promise<ManagedVmDestroyReceiptV1>;
	destroyDetached(): Promise<ManagedVmDestroyReceiptV1>;
	destroyLive(
		closeLiveVm: () => Promise<ManagedVmDestroyReceiptV1>,
	): Promise<ManagedVmDestroyReceiptV1>;
}

interface CreateGatewayVmCreationOwnershipOptions {
	readonly bootId: string;
	readonly destructionBudget?: GatewayDestructionBudget;
	readonly destroyGatewayOwnedLeases: (
		gatewayIdentity: GatewayEpochIdentity,
		signal: AbortSignal,
	) => Promise<void>;
	readonly generationId: string;
	readonly ownershipCoordinator: GatewayOwnershipCoordinator &
		PendingGatewayDetachedDestroyAttemptPort;
	readonly sessionLabel: string;
	readonly zoneId: string;
}

async function destroyGatewayChildren(options: {
	readonly destructionAttempt: GatewaySubtreeDestructionAttempt;
	readonly destroyGatewayOwnedLeases: (
		gatewayIdentity: GatewayEpochIdentity,
		signal: AbortSignal,
	) => Promise<void>;
	readonly gatewayOwnership: GatewayOwnershipEpochHandle;
	readonly ownershipCoordinator: GatewayOwnershipCoordinator;
}): Promise<void> {
	const sealed = options.ownershipCoordinator.sealGatewayEpoch(
		options.gatewayOwnership.gatewayIdentity,
	);
	await options.destroyGatewayOwnedLeases(
		options.gatewayOwnership.gatewayIdentity,
		options.destructionAttempt.signal,
	);
	options.destructionAttempt.throwIfExpired('before Gateway child membership barrier');
	await sealed.barrier;
	options.destructionAttempt.throwIfExpired('before Gateway VM destruction');
}

async function recordGatewaySubtreeDestroyUnavailable(options: {
	readonly gatewayOwnership: GatewayOwnershipEpochHandle;
	readonly ownershipCoordinator: GatewayOwnershipCoordinator;
	readonly primaryError: unknown;
}): Promise<never> {
	let ownerUnsafeError: unknown;
	try {
		await options.ownershipCoordinator.recordGatewayDestroyUnavailable(
			options.gatewayOwnership.gatewayIdentity,
		);
	} catch (error) {
		ownerUnsafeError = new GatewayOwnershipCoordinatorError('owner-unsafe', { cause: error });
	}
	ownerUnsafeError ??= new GatewayOwnershipCoordinatorError('owner-unsafe');
	throw new AggregateError(
		[options.primaryError, ownerUnsafeError],
		`Gateway VM '${options.gatewayOwnership.gatewayIdentity.gatewayVmId}' subtree destruction was not proven complete.`,
		{ cause: options.primaryError },
	);
}

export async function createGatewayVmCreationOwnership(
	options: CreateGatewayVmCreationOwnershipOptions,
): Promise<VmCreationOwnership> {
	const gatewayOwnership = await options.ownershipCoordinator.beginGatewayEpoch({
		bootId: options.bootId,
		generationId: options.generationId,
		sessionLabel: options.sessionLabel,
		zoneId: options.zoneId,
	});
	const destructionBudget = options.destructionBudget ?? createGatewayDestructionBudget();
	let pendingCreateContainment: Promise<ManagedVmDestroyReceiptV1> | undefined;
	return {
		gatewayIdentity: structuredClone(gatewayOwnership.gatewayIdentity),
		ownershipReservation: gatewayOwnership.ownershipReservation,
		containPendingCreate<TCreatedVm>(containmentOptions: {
			readonly closeLateCreatedVm: (createdVm: TCreatedVm) => Promise<ManagedVmDestroyReceiptV1>;
			readonly pendingCreate: Promise<TCreatedVm>;
		}): Promise<ManagedVmDestroyReceiptV1> {
			if (pendingCreateContainment !== undefined) {
				return pendingCreateContainment;
			}
			const destructionAttempt = destructionBudget.createSubtreeAttempt();
			const sealed = options.ownershipCoordinator.sealGatewayEpoch(
				gatewayOwnership.gatewayIdentity,
			);
			let releaseLateSettlementCleanup: (() => void) | undefined;
			const lateSettlementCleanupReady = new Promise<void>((resolve) => {
				releaseLateSettlementCleanup = resolve;
			});
			const releaseLateCleanup = (): void => {
				releaseLateSettlementCleanup?.();
				releaseLateSettlementCleanup = undefined;
			};
			const lateSettlementCleanup = containmentOptions.pendingCreate
				.then(
					(createdVm) => ({ createdVm, kind: 'fulfilled' as const }),
					(error: unknown) => ({ error, kind: 'rejected' as const }),
				)
				.then(async (createSettlement): Promise<ManagedVmDestroyReceiptV1> => {
					await lateSettlementCleanupReady;
					if (createSettlement.kind === 'fulfilled') {
						return await destructionAttempt.runTarget(
							`late gateway VM '${gatewayOwnership.gatewayIdentity.gatewayVmId}'`,
							async () => await containmentOptions.closeLateCreatedVm(createSettlement.createdVm),
						);
					}
					try {
						return await destructionAttempt.runTarget(
							`rejected gateway VM '${gatewayOwnership.gatewayIdentity.gatewayVmId}'`,
							async () =>
								await options.ownershipCoordinator.attemptGatewayDetachedDestroy(
									gatewayOwnership.gatewayIdentity,
								),
						);
					} catch (cleanupError) {
						const aggregateError = new AggregateError(
							[createSettlement.error, cleanupError],
							`Pending Gateway VM creation rejected and final detached cleanup was not proven for zone '${gatewayOwnership.gatewayIdentity.zoneId}'.`,
						);
						aggregateError.cause = createSettlement.error;
						throw aggregateError;
					}
				});
			void lateSettlementCleanup.catch(() => undefined);
			const containmentOperation = destructionAttempt.runSubtree(async () => {
				try {
					await options.destroyGatewayOwnedLeases(
						gatewayOwnership.gatewayIdentity,
						destructionAttempt.signal,
					);
					await sealed.barrier;
					await destructionAttempt
						.runTarget(
							`pending gateway VM '${gatewayOwnership.gatewayIdentity.gatewayVmId}'`,
							async () =>
								await options.ownershipCoordinator.attemptGatewayDetachedDestroy(
									gatewayOwnership.gatewayIdentity,
								),
						)
						.catch(() => undefined);
				} finally {
					releaseLateCleanup();
				}
				const finalReceipt = await lateSettlementCleanup;
				await options.ownershipCoordinator.recordGatewayDestroyReceipt(
					gatewayOwnership.gatewayIdentity,
					finalReceipt,
				);
				return finalReceipt;
			});
			pendingCreateContainment = containmentOperation.catch(async (primaryError) => {
				releaseLateCleanup();
				try {
					await options.ownershipCoordinator.recordGatewayDestroyUnavailable(
						gatewayOwnership.gatewayIdentity,
					);
				} catch (dispositionError) {
					const aggregateError = new AggregateError(
						[primaryError, dispositionError],
						`Pending Gateway VM containment is owner-unsafe for zone '${gatewayOwnership.gatewayIdentity.zoneId}'.`,
					);
					aggregateError.cause = primaryError;
					throw aggregateError;
				}
				throw primaryError;
			});
			return pendingCreateContainment;
		},
		async destroyDetached(): Promise<ManagedVmDestroyReceiptV1> {
			const destructionAttempt = destructionBudget.createSubtreeAttempt();
			try {
				return await destructionAttempt.runSubtree(async () => {
					await destroyGatewayChildren({
						destructionAttempt,
						destroyGatewayOwnedLeases: options.destroyGatewayOwnedLeases,
						gatewayOwnership,
						ownershipCoordinator: options.ownershipCoordinator,
					});
					return await options.ownershipCoordinator.destroyGatewayDetached(
						gatewayOwnership.gatewayIdentity,
					);
				});
			} catch (primaryError) {
				if (
					primaryError instanceof GatewayOwnershipCoordinatorError &&
					primaryError.code === 'owner-unsafe'
				) {
					throw primaryError;
				}
				return await recordGatewaySubtreeDestroyUnavailable({
					gatewayOwnership,
					ownershipCoordinator: options.ownershipCoordinator,
					primaryError,
				});
			}
		},
		async destroyLive(closeLiveVm): Promise<ManagedVmDestroyReceiptV1> {
			const destructionAttempt = destructionBudget.createSubtreeAttempt();
			let gatewayPhysicalDestroyComplete = false;
			try {
				return await destructionAttempt.runSubtree(async () => {
					await destroyGatewayChildren({
						destructionAttempt,
						destroyGatewayOwnedLeases: options.destroyGatewayOwnedLeases,
						gatewayOwnership,
						ownershipCoordinator: options.ownershipCoordinator,
					});
					const receipt = await destructionAttempt.runTarget(
						`gateway VM '${gatewayOwnership.gatewayIdentity.gatewayVmId}'`,
						closeLiveVm,
					);
					gatewayPhysicalDestroyComplete = receipt.complete;
					await options.ownershipCoordinator.recordGatewayDestroyReceipt(
						gatewayOwnership.gatewayIdentity,
						receipt,
					);
					return receipt;
				});
			} catch (primaryError) {
				if (gatewayPhysicalDestroyComplete) {
					throw primaryError;
				}
				return await recordGatewaySubtreeDestroyUnavailable({
					gatewayOwnership,
					ownershipCoordinator: options.ownershipCoordinator,
					primaryError,
				});
			}
		},
	};
}

interface CreateStandaloneVmCreationOwnershipOptions {
	readonly controllerEpoch: string;
	readonly createId: () => string;
	readonly principal: Extract<VmOwnershipPrincipal, { readonly kind: 'worker-task' }>;
	readonly reservationRoot: string;
	readonly sessionLabel: string;
	readonly createManagedVmOwnershipReservation?: (
		options: CreateManagedVmOwnershipReservationOptions,
	) => ReturnType<typeof createManagedVmOwnershipReservationDefault>;
	readonly destroyManagedVmExact?: typeof destroyManagedVmExactDefault;
	readonly readManagedVmDestroyTarget?: typeof readManagedVmDestroyTargetDefault;
}

export async function createStandaloneVmCreationOwnership(
	options: CreateStandaloneVmCreationOwnershipOptions,
): Promise<VmCreationOwnership> {
	const createManagedVmOwnershipReservation =
		options.createManagedVmOwnershipReservation ?? createManagedVmOwnershipReservationDefault;
	const destroyManagedVmExact = options.destroyManagedVmExact ?? destroyManagedVmExactDefault;
	const readManagedVmDestroyTarget =
		options.readManagedVmDestroyTarget ?? readManagedVmDestroyTargetDefault;
	const identityToken = options.createId();
	const createdReservation = await createManagedVmOwnershipReservation({
		controllerEpoch: options.controllerEpoch,
		parentGateway: null,
		principal: serializeVmOwnershipPrincipal(options.principal),
		reservationId: `standalone-reservation-${identityToken}`,
		reservationRoot: path.resolve(options.reservationRoot),
		role: 'standalone',
		sessionLabel: options.sessionLabel,
		vmId: `standalone-vm-${identityToken}`,
	});
	const destroyDetached = async (): Promise<ManagedVmDestroyReceiptV1> => {
		const target = await readManagedVmDestroyTarget(createdReservation.reference.reservationPath);
		const receipt = await destroyManagedVmExact(target);
		assertVmDestroyReceiptMatchesTarget(receipt, target, 'Standalone VM detached cleanup');
		return receipt;
	};
	return {
		ownershipReservation: createdReservation.reference,
		destroyDetached,
		async destroyLive(closeLiveVm): Promise<ManagedVmDestroyReceiptV1> {
			const target = await readManagedVmDestroyTarget(createdReservation.reference.reservationPath);
			const receipt = await closeLiveVm();
			assertVmDestroyReceiptMatchesTarget(receipt, target, 'Standalone VM live cleanup');
			return receipt;
		},
	};
}
