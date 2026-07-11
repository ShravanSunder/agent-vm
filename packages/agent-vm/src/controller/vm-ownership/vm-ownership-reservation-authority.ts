import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type {
	ManagedVmDestroyReceiptV1,
	ManagedVmDestroyTargetV1,
	ManagedVmOwnershipReservationReferenceV1,
	ManagedVmOwnershipReservationV1,
} from '@agent-vm/gondolin-adapter';

import { vmDestroyReceiptMatchesTarget } from '../../shared/vm-destruction-receipt.js';
import type { GatewayDestructionBudget } from './gateway-destruction-budget.js';
import { GatewayOwnershipCoordinatorError } from './gateway-ownership-errors.js';
import type { VmOwnershipPrincipal } from './vm-ownership-contracts.js';

export interface MatchingVmOwnershipReservationOptions {
	readonly controllerEpoch: string;
	readonly parentGateway: ManagedVmOwnershipReservationV1['parentGateway'];
	readonly principal: VmOwnershipPrincipal;
	readonly reservationId: string;
	readonly reservationPath: string;
	readonly role: ManagedVmOwnershipReservationV1['role'];
	readonly sessionLabel: string;
	readonly vmId: string;
}

export interface VmOwnershipReservationAuthority {
	destroyManagedVmTarget(
		this: void,
		target: ManagedVmDestroyTargetV1,
	): Promise<ManagedVmDestroyReceiptV1>;
	destroyMatchingReservation(
		this: void,
		options: MatchingVmOwnershipReservationOptions,
	): Promise<{
		readonly receipt: ManagedVmDestroyReceiptV1;
		readonly reservationRevision: number;
	}>;
	managedReservationReference(
		this: void,
		options: {
			readonly reservationId: string;
			readonly stateDirectory: string;
		},
	): ManagedVmOwnershipReservationReferenceV1;
	readMatchingDestroyInputs(
		this: void,
		options: MatchingVmOwnershipReservationOptions,
	): Promise<{
		readonly reservation: ManagedVmOwnershipReservationV1;
		readonly target: ManagedVmDestroyTargetV1;
	}>;
	referencesEqual(
		this: void,
		left: ManagedVmOwnershipReservationReferenceV1,
		right: ManagedVmOwnershipReservationReferenceV1,
	): boolean;
	reservationPathFor(
		this: void,
		options: {
			readonly reservationId: string;
			readonly stateDirectory: string;
		},
	): string;
	reservationPathForRoot(this: void, reservationRoot: string, reservationId: string): string;
	reservationRootForStateDirectory(this: void, stateDirectory: string): string;
	targetMatchesReservation(
		this: void,
		options: {
			readonly reservation: ManagedVmOwnershipReservationV1;
			readonly reservationPath: string;
			readonly target: ManagedVmDestroyTargetV1;
		},
	): boolean;
}

interface CreateVmOwnershipReservationAuthorityOptions {
	readonly destroyManagedVmExact: (
		target: ManagedVmDestroyTargetV1,
	) => Promise<ManagedVmDestroyReceiptV1>;
	readonly destructionBudget: GatewayDestructionBudget;
	readonly readManagedVmDestroyTarget: (
		reservationPath: string,
	) => Promise<ManagedVmDestroyTargetV1>;
	readonly readManagedVmOwnershipReservation: (
		reservationPath: string,
	) => Promise<ManagedVmOwnershipReservationV1>;
}

function reservationMatchesReference(options: {
	readonly expected: MatchingVmOwnershipReservationOptions;
	readonly reservation: ManagedVmOwnershipReservationV1;
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
	return (
		options.reservation.contractVersion === 1 &&
		options.reservation.controllerEpoch === options.expected.controllerEpoch &&
		isDeepStrictEqual(options.reservation.parentGateway, options.expected.parentGateway) &&
		isDeepStrictEqual(parsedPrincipal, options.expected.principal) &&
		options.reservation.reservationId === options.expected.reservationId &&
		options.reservation.role === options.expected.role &&
		options.reservation.sessionLabel === options.expected.sessionLabel &&
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
		isDeepStrictEqual(target.parentGateway, reservation.parentGateway) &&
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

function reservationRootForStateDirectory(stateDirectory: string): string {
	return path.join(path.resolve(stateDirectory), 'vm-ownership', 'reservations');
}

function reservationPathForRoot(reservationRoot: string, reservationId: string): string {
	return path.join(path.resolve(reservationRoot), reservationId, 'reservation-v1.json');
}

function reservationPathFor(options: {
	readonly reservationId: string;
	readonly stateDirectory: string;
}): string {
	return reservationPathForRoot(
		reservationRootForStateDirectory(options.stateDirectory),
		options.reservationId,
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

function referencesEqual(
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

export function createVmOwnershipReservationAuthority(
	options: CreateVmOwnershipReservationAuthorityOptions,
): VmOwnershipReservationAuthority {
	const destroyManagedVmTarget = async (
		target: ManagedVmDestroyTargetV1,
	): Promise<ManagedVmDestroyReceiptV1> =>
		await options.destructionBudget.runTarget(
			`${target.role} VM '${target.vmId}'`,
			async () => await options.destroyManagedVmExact(target),
		);

	const readMatchingDestroyInputs = async (
		matchingOptions: MatchingVmOwnershipReservationOptions,
	): Promise<{
		readonly reservation: ManagedVmOwnershipReservationV1;
		readonly target: ManagedVmDestroyTargetV1;
	}> => {
		const [reservation, target] = await Promise.all([
			options.readManagedVmOwnershipReservation(matchingOptions.reservationPath),
			options.readManagedVmDestroyTarget(matchingOptions.reservationPath),
		]);
		if (
			!reservationMatchesReference({ expected: matchingOptions, reservation }) ||
			!targetMatchesReservation({
				reservation,
				reservationPath: matchingOptions.reservationPath,
				target,
			})
		) {
			throw new GatewayOwnershipCoordinatorError('reservation-identity-mismatch');
		}
		return { reservation, target };
	};

	return {
		destroyManagedVmTarget,
		async destroyMatchingReservation(matchingOptions): Promise<{
			readonly receipt: ManagedVmDestroyReceiptV1;
			readonly reservationRevision: number;
		}> {
			const { reservation, target } = await readMatchingDestroyInputs(matchingOptions);
			const receipt = await destroyManagedVmTarget(target);
			if (!vmDestroyReceiptMatchesTarget(receipt, target)) {
				throw new GatewayOwnershipCoordinatorError('owner-unsafe');
			}
			return { receipt, reservationRevision: reservation.revision };
		},
		managedReservationReference,
		readMatchingDestroyInputs,
		referencesEqual,
		reservationPathFor,
		reservationPathForRoot,
		reservationRootForStateDirectory,
		targetMatchesReservation,
	};
}
