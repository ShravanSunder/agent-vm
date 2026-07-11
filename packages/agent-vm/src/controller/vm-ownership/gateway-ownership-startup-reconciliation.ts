import { isDeepStrictEqual } from 'node:util';

import type {
	ManagedVmDestroyTargetV1,
	ManagedVmOwnershipReservationV1,
} from '@agent-vm/gondolin-adapter';

import type { GatewayDestructionBudget } from './gateway-destruction-budget.js';
import { reconcilePersistedGatewayMembership } from './gateway-membership-reconciliation.js';
import { GatewayOwnershipCoordinatorError } from './gateway-ownership-errors.js';
import type {
	GatewayMembershipRecord,
	VmOwnershipDeploymentIdentity,
} from './vm-ownership-contracts.js';
import { createVmOwnershipJournal } from './vm-ownership-journal.js';
import type { VmOwnershipReservationAuthority } from './vm-ownership-reservation-authority.js';
import {
	reconcileUnreferencedVmOwnershipReservations,
	type UnreferencedVmOwnershipReservationReconciliationResult,
} from './vm-ownership-reservation-reconciliation.js';

export interface GatewayOwnershipStartupReconciler {
	reconcile(
		zoneIds: readonly string[],
		options?: { readonly standaloneZoneId?: string },
	): Promise<void>;
}

interface CreateGatewayOwnershipStartupReconcilerOptions {
	readonly assertCanonicalStateDirectory: (zoneId: string, stateDirectory: string) => string;
	readonly authority: VmOwnershipReservationAuthority;
	readonly deploymentIdentity: VmOwnershipDeploymentIdentity;
	readonly destructionBudget: GatewayDestructionBudget;
	readonly isZoneAlreadyCurrent: (zoneId: string) => boolean;
	readonly listReservationPaths: (reservationRoot: string) => Promise<readonly string[]>;
	readonly markZoneOwnerUnsafe: (zoneId: string) => void;
	readonly nowMs: () => number;
	readonly readReservation: (reservationPath: string) => Promise<ManagedVmOwnershipReservationV1>;
	readonly readTarget: (reservationPath: string) => Promise<ManagedVmDestroyTargetV1>;
	readonly standaloneReservationRoot?: string;
	readonly stateDirectoryForZone: (zoneId: string) => string;
}

function gatewayRecordKey(record: GatewayMembershipRecord): string {
	return `${record.gateway.gatewayEpochId}\0${record.gateway.gatewayVmId}`;
}

export function createGatewayOwnershipStartupReconciler(
	options: CreateGatewayOwnershipStartupReconcilerOptions,
): GatewayOwnershipStartupReconciler {
	const reconcileUnreferencedReservations = async (reconciliationOptions: {
		readonly allowReservationsFromOtherZones?: boolean;
		readonly allowedRoles: ReadonlySet<ManagedVmOwnershipReservationV1['role']>;
		readonly referencedGatewayKeys?: ReadonlySet<string>;
		readonly referencedReservationPaths: ReadonlySet<string>;
		readonly reservationRoot: string;
		readonly zoneId?: string;
	}): Promise<UnreferencedVmOwnershipReservationReconciliationResult> =>
		await reconcileUnreferencedVmOwnershipReservations({
			...reconciliationOptions,
			authority: options.authority,
			destructionBudget: options.destructionBudget,
			deploymentIdentity: options.deploymentIdentity,
			listReservationPaths: options.listReservationPaths,
			readReservation: options.readReservation,
			readTarget: options.readTarget,
		});

	return {
		async reconcile(zoneIds, reconciliationOptions): Promise<void> {
			const reconciliationErrors: unknown[] = [];
			for (const zoneId of zoneIds) {
				if (options.isZoneAlreadyCurrent(zoneId)) {
					reconciliationErrors.push(
						new GatewayOwnershipCoordinatorError('gateway-already-current'),
					);
					continue;
				}
				let journal: ReturnType<typeof createVmOwnershipJournal>;
				let membershipEvidenceUnsafe = false;
				let records: readonly GatewayMembershipRecord[] = [];
				let stateDirectory: string;
				try {
					stateDirectory = options.assertCanonicalStateDirectory(
						zoneId,
						options.stateDirectoryForZone(zoneId),
					);
					journal = createVmOwnershipJournal({ nowMs: options.nowMs, stateDirectory });
					// oxlint-disable-next-line no-await-in-loop -- each zone owns a separate journal and is reconciled to a terminal state before the next zone begins.
					records = await journal.loadAllGatewayMemberships();
				} catch (error) {
					options.markZoneOwnerUnsafe(zoneId);
					reconciliationErrors.push(error);
					membershipEvidenceUnsafe = true;
					try {
						stateDirectory = options.assertCanonicalStateDirectory(
							zoneId,
							options.stateDirectoryForZone(zoneId),
						);
						journal = createVmOwnershipJournal({ nowMs: options.nowMs, stateDirectory });
					} catch {
						continue;
					}
				}

				const referencedReservationPaths = new Set<string>();
				const referencedReservationIds = new Set<string>();
				for (const record of records) {
					for (const reference of [record.gatewayReservation, ...record.children]) {
						if (
							!isDeepStrictEqual(
								{
									configPath: reference.principal.configPath,
									controllerPort: reference.principal.controllerPort,
									projectNamespace: reference.principal.projectNamespace,
								},
								options.deploymentIdentity,
							) ||
							reference.principal.zoneId !== zoneId
						) {
							membershipEvidenceUnsafe = true;
							options.markZoneOwnerUnsafe(zoneId);
							reconciliationErrors.push(
								new GatewayOwnershipCoordinatorError('reservation-identity-mismatch'),
							);
						}
						if (
							referencedReservationPaths.has(reference.reservationPath) ||
							referencedReservationIds.has(reference.reservationId)
						) {
							membershipEvidenceUnsafe = true;
							options.markZoneOwnerUnsafe(zoneId);
							reconciliationErrors.push(new GatewayOwnershipCoordinatorError('owner-unsafe'));
						}
						referencedReservationPaths.add(reference.reservationPath);
						referencedReservationIds.add(reference.reservationId);
					}
				}
				if (membershipEvidenceUnsafe) {
					continue;
				}

				// oxlint-disable-next-line no-await-in-loop -- independent zones are reconciled serially so each zone's child-before-parent order stays inspectable.
				const inventoryResult = await reconcileUnreferencedReservations({
					allowedRoles: new Set(['gateway', 'tool']),
					referencedGatewayKeys: new Set(records.map(gatewayRecordKey)),
					referencedReservationPaths,
					reservationRoot: options.authority.reservationRootForStateDirectory(stateDirectory),
					zoneId,
				});
				if (inventoryResult.errors.length > 0) {
					options.markZoneOwnerUnsafe(zoneId);
					reconciliationErrors.push(...inventoryResult.errors);
				}
				if (inventoryResult.blockAllGatewayDestruction) {
					continue;
				}

				for (const loadedRecord of records) {
					if (loadedRecord.gateway.zoneId !== zoneId) {
						options.markZoneOwnerUnsafe(zoneId);
						reconciliationErrors.push(
							new GatewayOwnershipCoordinatorError('state-directory-mismatch'),
						);
						continue;
					}
					if (
						loadedRecord.state === 'destroyed' ||
						inventoryResult.blockedGatewayKeys.has(gatewayRecordKey(loadedRecord))
					) {
						continue;
					}
					try {
						// oxlint-disable-next-line no-await-in-loop -- each persisted tree is reconciled to a terminal revision before the next tree begins.
						await reconcilePersistedGatewayMembership({
							authority: options.authority,
							destructionBudget: options.destructionBudget,
							journal,
							loadedRecord,
							nowMs: options.nowMs,
						});
					} catch (error) {
						options.markZoneOwnerUnsafe(zoneId);
						reconciliationErrors.push(error);
					}
				}
			}

			if (options.standaloneReservationRoot !== undefined) {
				const standaloneInventoryResult = await reconcileUnreferencedReservations({
					allowReservationsFromOtherZones: reconciliationOptions?.standaloneZoneId !== undefined,
					allowedRoles: new Set(['standalone']),
					referencedReservationPaths: new Set(),
					reservationRoot: options.standaloneReservationRoot,
					...(reconciliationOptions?.standaloneZoneId === undefined
						? {}
						: { zoneId: reconciliationOptions.standaloneZoneId }),
				});
				reconciliationErrors.push(...standaloneInventoryResult.errors);
			}

			if (reconciliationErrors.length > 0) {
				throw new GatewayOwnershipCoordinatorError('owner-unsafe', {
					cause:
						reconciliationErrors.length === 1
							? reconciliationErrors[0]
							: new AggregateError(
									reconciliationErrors,
									`Controller startup ownership reconciliation failed for ${String(reconciliationErrors.length)} independent Gateway record or zone operation${reconciliationErrors.length === 1 ? '' : 's'}.`,
								),
				});
			}
		},
	};
}
