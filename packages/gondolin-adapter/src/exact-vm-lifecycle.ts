import {
	GONDOLIN_EXACT_VM_LIFECYCLE_CONTRACT_VERSION,
	createVmOwnershipReservation,
	destroyVmExact,
	readVmDestroyTarget,
	readVmOwnershipReservation,
	type CreateVmOwnershipReservationOptions as GondolinCreateVmOwnershipReservationOptions,
	type CreatedVmOwnershipReservation as GondolinCreatedVmOwnershipReservation,
	type DestroyVmExactOptions as GondolinDestroyVmExactOptions,
	type VmDestroyReceiptV1 as GondolinVmDestroyReceiptV1,
	type VmDestroyTargetV1 as GondolinVmDestroyTargetV1,
	type VmOwnershipReservationReferenceV1 as GondolinVmOwnershipReservationReferenceV1,
	type VmOwnershipReservationV1 as GondolinVmOwnershipReservationV1,
} from '@earendil-works/gondolin';

export const MANAGED_VM_EXACT_LIFECYCLE_CONTRACT_VERSION = 1 as const;

export type CreateVmOwnershipReservationOptions = GondolinCreateVmOwnershipReservationOptions;
export type CreatedVmOwnershipReservation = GondolinCreatedVmOwnershipReservation;
export type DestroyVmExactOptions = GondolinDestroyVmExactOptions;
export type VmDestroyReceiptV1 = GondolinVmDestroyReceiptV1;
export type VmDestroyTargetV1 = GondolinVmDestroyTargetV1;
export type VmOwnershipReservationReferenceV1 = GondolinVmOwnershipReservationReferenceV1;
export type VmOwnershipReservationV1 = GondolinVmOwnershipReservationV1;

export type CreateManagedVmOwnershipReservationOptions = CreateVmOwnershipReservationOptions;
export type CreatedManagedVmOwnershipReservation = CreatedVmOwnershipReservation;
export type DestroyManagedVmExactOptions = DestroyVmExactOptions;
export type ManagedVmDestroyReceiptV1 = VmDestroyReceiptV1;
export type ManagedVmDestroyTargetV1 = VmDestroyTargetV1;
export type ManagedVmOwnershipReservationReferenceV1 = VmOwnershipReservationReferenceV1;
export type ManagedVmOwnershipReservationV1 = VmOwnershipReservationV1;

export function assertManagedVmExactLifecycleContractVersion(
	contractVersion: unknown,
): asserts contractVersion is typeof MANAGED_VM_EXACT_LIFECYCLE_CONTRACT_VERSION {
	if (contractVersion !== MANAGED_VM_EXACT_LIFECYCLE_CONTRACT_VERSION) {
		throw new Error(
			`unsupported Gondolin exact VM lifecycle contract version: ${String(contractVersion)}`,
		);
	}
}

assertManagedVmExactLifecycleContractVersion(GONDOLIN_EXACT_VM_LIFECYCLE_CONTRACT_VERSION);

export async function createManagedVmOwnershipReservation(
	options: CreateManagedVmOwnershipReservationOptions,
): Promise<CreatedManagedVmOwnershipReservation> {
	return await createVmOwnershipReservation(options);
}

export async function readManagedVmDestroyTarget(
	reservationPath: string,
): Promise<ManagedVmDestroyTargetV1> {
	return await readVmDestroyTarget(reservationPath);
}

export async function readManagedVmOwnershipReservation(
	reservationPath: string,
): Promise<ManagedVmOwnershipReservationV1> {
	return await readVmOwnershipReservation(reservationPath);
}

export async function destroyManagedVmExact(
	target: ManagedVmDestroyTargetV1,
	options?: DestroyManagedVmExactOptions,
): Promise<ManagedVmDestroyReceiptV1> {
	return await destroyVmExact(target, options);
}
