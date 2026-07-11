import { isDeepStrictEqual } from 'node:util';

import type {
	ManagedVmDestroyTargetV1,
	ManagedVmOwnershipReservationV1,
} from '@agent-vm/gondolin-adapter';

import { vmDestroyReceiptMatchesTarget } from '../../shared/vm-destruction-receipt.js';
import { settleGatewayChildDestructionTasks } from './gateway-child-destruction.js';
import {
	createGatewayDestructionBudget,
	type GatewayDestructionBudget,
} from './gateway-destruction-budget.js';
import { GatewayOwnershipCoordinatorError } from './gateway-ownership-errors.js';
import {
	gatewayZonePrincipalSchema,
	stableAgentPrincipalSchema,
	type VmOwnershipDeploymentIdentity,
	workerTaskPrincipalSchema,
} from './vm-ownership-contracts.js';
import type { VmOwnershipReservationAuthority } from './vm-ownership-reservation-authority.js';

export interface UnreferencedVmOwnershipReservationReconciliationResult {
	readonly blockAllGatewayDestruction: boolean;
	readonly blockedGatewayKeys: ReadonlySet<string>;
	readonly errors: readonly unknown[];
}

interface ReconcileUnreferencedVmOwnershipReservationsOptions {
	readonly allowReservationsFromOtherZones?: boolean;
	readonly allowedRoles: ReadonlySet<ManagedVmOwnershipReservationV1['role']>;
	readonly authority: VmOwnershipReservationAuthority;
	readonly destructionBudget?: GatewayDestructionBudget;
	readonly deploymentIdentity: VmOwnershipDeploymentIdentity;
	readonly listReservationPaths: (reservationRoot: string) => Promise<readonly string[]>;
	readonly readReservation: (reservationPath: string) => Promise<ManagedVmOwnershipReservationV1>;
	readonly readTarget: (reservationPath: string) => Promise<ManagedVmDestroyTargetV1>;
	readonly referencedGatewayKeys?: ReadonlySet<string>;
	readonly referencedReservationPaths: ReadonlySet<string>;
	readonly reservationRoot: string;
	readonly zoneId?: string;
}

function reservationPrincipalMatchesScope(options: {
	readonly deploymentIdentity?: VmOwnershipDeploymentIdentity;
	readonly reservation: ManagedVmOwnershipReservationV1;
	readonly zoneId?: string;
}): boolean {
	if (typeof options.reservation.principal !== 'string') {
		return false;
	}
	let parsedPrincipal: unknown;
	try {
		parsedPrincipal = JSON.parse(options.reservation.principal);
	} catch {
		return false;
	}
	if (options.reservation.role === 'gateway') {
		const principal = gatewayZonePrincipalSchema.safeParse(parsedPrincipal);
		return (
			principal.success &&
			(options.deploymentIdentity === undefined ||
				isDeepStrictEqual(
					{
						configPath: principal.data.configPath,
						controllerPort: principal.data.controllerPort,
						projectNamespace: principal.data.projectNamespace,
					},
					options.deploymentIdentity,
				)) &&
			(options.zoneId === undefined || principal.data.zoneId === options.zoneId) &&
			options.reservation.parentGateway === null
		);
	}
	if (options.reservation.role === 'tool') {
		const principal = stableAgentPrincipalSchema.safeParse(parsedPrincipal);
		return (
			principal.success &&
			(options.deploymentIdentity === undefined ||
				isDeepStrictEqual(
					{
						configPath: principal.data.configPath,
						controllerPort: principal.data.controllerPort,
						projectNamespace: principal.data.projectNamespace,
					},
					options.deploymentIdentity,
				)) &&
			(options.zoneId === undefined || principal.data.zoneId === options.zoneId) &&
			options.reservation.parentGateway !== null
		);
	}
	const principal = workerTaskPrincipalSchema.safeParse(parsedPrincipal);
	return (
		principal.success &&
		(options.deploymentIdentity === undefined ||
			isDeepStrictEqual(
				{
					configPath: principal.data.configPath,
					controllerPort: principal.data.controllerPort,
					projectNamespace: principal.data.projectNamespace,
				},
				options.deploymentIdentity,
			)) &&
		(options.zoneId === undefined || principal.data.zoneId === options.zoneId) &&
		options.reservation.parentGateway === null
	);
}

function parentGatewayKey(parentGateway: ManagedVmOwnershipReservationV1['parentGateway']): string {
	return parentGateway === null ? 'none' : `${parentGateway.epoch}\0${parentGateway.vmId}`;
}

function gatewayReservationParentKey(
	reservation: ManagedVmOwnershipReservationV1,
): string | undefined {
	const gatewayVmPrefix = 'gateway-vm-';
	if (reservation.role !== 'gateway' || !reservation.vmId.startsWith(gatewayVmPrefix)) {
		return undefined;
	}
	const identityToken = reservation.vmId.slice(gatewayVmPrefix.length);
	if (identityToken.length === 0) {
		return undefined;
	}
	return `gateway-epoch-${identityToken}\0${reservation.vmId}`;
}

export async function reconcileUnreferencedVmOwnershipReservations(
	options: ReconcileUnreferencedVmOwnershipReservationsOptions,
): Promise<UnreferencedVmOwnershipReservationReconciliationResult> {
	const errors: unknown[] = [];
	const blockedGatewayKeys = new Set<string>();
	let blockAllGatewayDestruction = false;
	let unreferencedReservationPaths: readonly string[];
	try {
		const inventoriedPaths = await options.listReservationPaths(options.reservationRoot);
		if (new Set(inventoriedPaths).size !== inventoriedPaths.length) {
			throw new GatewayOwnershipCoordinatorError('owner-unsafe');
		}
		unreferencedReservationPaths = inventoriedPaths.filter(
			(reservationPath) => !options.referencedReservationPaths.has(reservationPath),
		);
	} catch (error) {
		return {
			blockAllGatewayDestruction: true,
			blockedGatewayKeys,
			errors: [error],
		};
	}

	const validatedReservations: {
		readonly reservation: ManagedVmOwnershipReservationV1;
		readonly target: ManagedVmDestroyTargetV1;
	}[] = [];
	for (const reservationPath of unreferencedReservationPaths) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- each orphan is independently authenticated before any destructive action.
			const reservation = await options.readReservation(reservationPath);
			if (
				!options.allowedRoles.has(reservation.role) ||
				reservationPath !==
					options.authority.reservationPathForRoot(
						options.reservationRoot,
						reservation.reservationId,
					) ||
				!reservationPrincipalMatchesScope({
					deploymentIdentity: options.deploymentIdentity,
					reservation,
				})
			) {
				throw new GatewayOwnershipCoordinatorError('reservation-identity-mismatch');
			}
			if (
				options.zoneId !== undefined &&
				!reservationPrincipalMatchesScope({
					deploymentIdentity: options.deploymentIdentity,
					reservation,
					zoneId: options.zoneId,
				})
			) {
				if (options.allowReservationsFromOtherZones === true) {
					continue;
				}
				throw new GatewayOwnershipCoordinatorError('reservation-identity-mismatch');
			}
			// oxlint-disable-next-line no-await-in-loop -- the target must be reread from the same authoritative reservation path.
			const target = await options.readTarget(reservationPath);
			if (!options.authority.targetMatchesReservation({ reservation, reservationPath, target })) {
				throw new GatewayOwnershipCoordinatorError('reservation-identity-mismatch');
			}
			validatedReservations.push({ reservation, target });
		} catch (error) {
			blockAllGatewayDestruction = true;
			errors.push(error);
		}
	}

	const childReservations = validatedReservations.filter(
		(entry) => entry.reservation.role !== 'gateway',
	);
	const gatewayReservations = validatedReservations.filter(
		(candidate) => candidate.reservation.role === 'gateway',
	);
	if (blockAllGatewayDestruction) {
		return { blockAllGatewayDestruction, blockedGatewayKeys, errors };
	}
	const gatewayDestructionBudget = options.destructionBudget ?? createGatewayDestructionBudget();
	const childGroups = new Map<string, typeof childReservations>();
	const childGatewayKeysByVmId = new Map<string, Set<string>>();
	const standaloneChildren: typeof childReservations = [];
	for (const entry of childReservations) {
		if (entry.reservation.parentGateway === null) {
			standaloneChildren.push(entry);
			continue;
		}
		const key = parentGatewayKey(entry.reservation.parentGateway);
		const group = childGroups.get(key) ?? [];
		group.push(entry);
		childGroups.set(key, group);
		const parentVmId = entry.reservation.parentGateway.vmId;
		const gatewayKeys = childGatewayKeysByVmId.get(parentVmId) ?? new Set<string>();
		gatewayKeys.add(key);
		childGatewayKeysByVmId.set(parentVmId, gatewayKeys);
	}
	const gatewayReservationsByParentKey = new Map<string, (typeof gatewayReservations)[number]>();
	for (const gatewayEntry of gatewayReservations) {
		const gatewayKey = gatewayReservationParentKey(gatewayEntry.reservation);
		if (gatewayKey === undefined) {
			continue;
		}
		if (gatewayReservationsByParentKey.has(gatewayKey)) {
			return {
				blockAllGatewayDestruction: true,
				blockedGatewayKeys,
				errors: [...errors, new GatewayOwnershipCoordinatorError('owner-unsafe')],
			};
		}
		gatewayReservationsByParentKey.set(gatewayKey, gatewayEntry);
	}
	const ambiguousParentVmIds = new Set<string>();
	for (const [gatewayVmId, gatewayKeys] of childGatewayKeysByVmId) {
		if (gatewayKeys.size <= 1) {
			continue;
		}
		ambiguousParentVmIds.add(gatewayVmId);
		for (const gatewayKey of gatewayKeys) {
			blockedGatewayKeys.add(gatewayKey);
		}
		errors.push(new GatewayOwnershipCoordinatorError('owner-unsafe'));
	}

	const standaloneResults = await settleGatewayChildDestructionTasks(
		standaloneChildren.map((entry) => async () => {
			const receipt = await options.authority.destroyManagedVmTarget(entry.target);
			if (!vmDestroyReceiptMatchesTarget(receipt, entry.target)) {
				throw new GatewayOwnershipCoordinatorError('owner-unsafe');
			}
		}),
	);
	for (const result of standaloneResults) {
		if (result.status === 'rejected') {
			errors.push(result.reason);
		}
	}

	const processedGatewayReservationIds = new Set<string>();
	for (const [gatewayKey, childGroup] of childGroups) {
		const parentGatewayVmId = childGroup[0]?.reservation.parentGateway?.vmId;
		const parentIsAmbiguous =
			parentGatewayVmId !== undefined && ambiguousParentVmIds.has(parentGatewayVmId);
		const gatewayEntry =
			parentGatewayVmId !== undefined && !parentIsAmbiguous
				? gatewayReservationsByParentKey.get(gatewayKey)
				: undefined;
		const referencedParentExists =
			!parentIsAmbiguous && options.referencedGatewayKeys?.has(gatewayKey) === true;
		if (gatewayEntry !== undefined) {
			processedGatewayReservationIds.add(gatewayEntry.reservation.reservationId);
		} else if (parentGatewayVmId !== undefined) {
			const unmatchedGatewayEntry = gatewayReservations.find(
				(entry) => entry.reservation.vmId === parentGatewayVmId,
			);
			if (unmatchedGatewayEntry !== undefined) {
				processedGatewayReservationIds.add(unmatchedGatewayEntry.reservation.reservationId);
			}
		}
		const destructionAttempt = gatewayDestructionBudget.createSubtreeAttempt();
		try {
			// oxlint-disable-next-line no-await-in-loop -- each orphan Gateway subtree gets one frozen aggregate attempt before the next independent subtree.
			await destructionAttempt.runSubtree(async (signal) => {
				const childResults = await settleGatewayChildDestructionTasks(
					childGroup.map((entry) => async () => {
						const receipt = await options.authority.destroyManagedVmTarget(entry.target);
						if (!vmDestroyReceiptMatchesTarget(receipt, entry.target)) {
							throw new GatewayOwnershipCoordinatorError('owner-unsafe');
						}
					}),
					{ signal },
				);
				destructionAttempt.throwIfExpired('orphan Gateway child destruction');
				const childErrors: unknown[] = [];
				for (const childResult of childResults) {
					if (childResult.status === 'rejected') {
						childErrors.push(childResult.reason as unknown);
					}
				}
				if (childErrors.length > 0) {
					throw new AggregateError(
						childErrors,
						`Orphan child destruction failed for Gateway '${gatewayKey}'.`,
					);
				}
				if (gatewayEntry === undefined && !referencedParentExists) {
					blockedGatewayKeys.add(gatewayKey);
					errors.push(new GatewayOwnershipCoordinatorError('owner-unsafe'));
					return;
				}
				if (gatewayEntry === undefined) {
					return;
				}
				destructionAttempt.throwIfExpired('before orphan Gateway exact destroy');
				const gatewayReceipt = await options.authority.destroyManagedVmTarget(gatewayEntry.target);
				if (!vmDestroyReceiptMatchesTarget(gatewayReceipt, gatewayEntry.target)) {
					throw new GatewayOwnershipCoordinatorError('owner-unsafe');
				}
			});
		} catch (error) {
			blockedGatewayKeys.add(gatewayKey);
			errors.push(error);
		}
	}

	if (!blockAllGatewayDestruction) {
		for (const entry of gatewayReservations) {
			if (processedGatewayReservationIds.has(entry.reservation.reservationId)) {
				continue;
			}
			const destructionAttempt = gatewayDestructionBudget.createSubtreeAttempt();
			try {
				// oxlint-disable-next-line no-await-in-loop -- an orphan Gateway without inventoried children still owns one bounded subtree attempt.
				await destructionAttempt.runSubtree(async () => {
					destructionAttempt.throwIfExpired('before childless orphan Gateway exact destroy');
					const receipt = await options.authority.destroyManagedVmTarget(entry.target);
					if (!vmDestroyReceiptMatchesTarget(receipt, entry.target)) {
						throw new GatewayOwnershipCoordinatorError('owner-unsafe');
					}
				});
			} catch (error) {
				errors.push(error);
			}
		}
	}

	return { blockAllGatewayDestruction, blockedGatewayKeys, errors };
}
