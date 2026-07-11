import { settleGatewayChildDestructionTasks } from './gateway-child-destruction.js';
import {
	createGatewayDestructionBudget,
	type GatewayDestructionBudget,
} from './gateway-destruction-budget.js';
import { GatewayOwnershipCoordinatorError } from './gateway-ownership-errors.js';
import type { GatewayMembershipRecord, ToolVmChildMembership } from './vm-ownership-contracts.js';
import type { VmOwnershipJournal } from './vm-ownership-journal.js';
import type { VmOwnershipReservationAuthority } from './vm-ownership-reservation-authority.js';

interface ReconcilePersistedGatewayMembershipOptions {
	readonly authority: VmOwnershipReservationAuthority;
	readonly destructionBudget?: GatewayDestructionBudget;
	readonly journal: VmOwnershipJournal;
	readonly loadedRecord: GatewayMembershipRecord;
	readonly nowMs: () => number;
}

function withoutChildDispositionReason(
	child: ToolVmChildMembership,
): Omit<ToolVmChildMembership, 'dispositionReason'> {
	const { dispositionReason: _dispositionReason, ...childWithoutDispositionReason } = child;
	return childWithoutDispositionReason;
}

async function replaceReconciledMembership(options: {
	readonly journal: VmOwnershipJournal;
	readonly nowMs: () => number;
	readonly record: GatewayMembershipRecord;
	readonly replacement: Omit<GatewayMembershipRecord, 'revision' | 'updatedAtMs'>;
}): Promise<GatewayMembershipRecord> {
	return await options.journal.replaceGatewayMembership({
		expectedRevision: options.record.revision,
		record: {
			...options.replacement,
			revision: options.record.revision + 1,
			updatedAtMs: options.nowMs(),
		},
	});
}

async function markReconciledMembershipOwnerUnsafe(options: {
	readonly childReservationId?: string;
	readonly journal: VmOwnershipJournal;
	readonly nowMs: () => number;
	readonly record: GatewayMembershipRecord;
}): Promise<GatewayMembershipRecord> {
	return await replaceReconciledMembership({
		journal: options.journal,
		nowMs: options.nowMs,
		record: options.record,
		replacement: {
			...options.record,
			children:
				options.childReservationId === undefined
					? options.record.children
					: options.record.children.map((child) =>
							child.reservationId === options.childReservationId
								? {
										...child,
										dispositionReason: 'exact-destroy-unavailable',
										state: 'owner-unsafe',
									}
								: child,
						),
			state: 'owner-unsafe',
		},
	});
}

export async function reconcilePersistedGatewayMembership(
	options: ReconcilePersistedGatewayMembershipOptions,
): Promise<GatewayMembershipRecord> {
	let record = options.loadedRecord;
	const destructionAttempt = (
		options.destructionBudget ?? createGatewayDestructionBudget()
	).createSubtreeAttempt();
	try {
		return await destructionAttempt.runSubtree(async (signal) => {
			const pendingChildren = record.children.filter((child) => child.state !== 'destroyed');
			const destroyedChildren = new Map<
				string,
				Awaited<ReturnType<VmOwnershipReservationAuthority['destroyMatchingReservation']>>
			>();
			const childResults = await settleGatewayChildDestructionTasks(
				pendingChildren.map((child) => async () => {
					const destroyedChild = await options.authority.destroyMatchingReservation({
						controllerEpoch: record.gateway.controllerEpoch,
						parentGateway: {
							epoch: record.gateway.gatewayEpochId,
							vmId: record.gateway.gatewayVmId,
						},
						principal: child.principal,
						reservationId: child.reservationId,
						reservationPath: child.reservationPath,
						role: 'tool',
						sessionLabel: child.sessionLabel,
						vmId: child.vmId,
					});
					destroyedChildren.set(child.reservationId, destroyedChild);
				}),
				{ signal },
			);
			destructionAttempt.throwIfExpired('persisted Gateway child destruction');

			const childDestroyErrors: unknown[] = [];
			for (const [childIndex, child] of pendingChildren.entries()) {
				destructionAttempt.throwIfExpired(
					`before persisting child '${child.reservationId}' destruction`,
				);
				const result = childResults[childIndex];
				if (result?.status === 'fulfilled') {
					const destroyedChild = destroyedChildren.get(child.reservationId);
					if (destroyedChild === undefined) {
						throw new GatewayOwnershipCoordinatorError('owner-unsafe');
					}
					// oxlint-disable-next-line no-await-in-loop -- successful child receipts advance one authoritative journal revision at a time after parallel destruction settles.
					record = await replaceReconciledMembership({
						journal: options.journal,
						nowMs: options.nowMs,
						record,
						replacement: {
							...record,
							children: record.children.map((candidate) =>
								candidate.reservationId === child.reservationId
									? {
											...withoutChildDispositionReason(candidate),
											observedReservationRevision: destroyedChild.reservationRevision,
											state: 'destroyed',
										}
									: candidate,
							),
						},
					});
					continue;
				}
				const childDestroyError: unknown =
					result?.reason ?? new Error('child destruction result missing');
				try {
					// oxlint-disable-next-line no-await-in-loop -- owner-unsafe evidence is serialized through journal revisions.
					record = await markReconciledMembershipOwnerUnsafe({
						childReservationId: child.reservationId,
						journal: options.journal,
						nowMs: options.nowMs,
						record,
					});
				} catch (persistenceError) {
					childDestroyErrors.push(
						new AggregateError(
							[childDestroyError, persistenceError],
							'Destroy failure and owner-unsafe membership persistence both failed',
							{ cause: childDestroyError },
						),
					);
					continue;
				}
				childDestroyErrors.push(childDestroyError);
			}
			if (childDestroyErrors.length > 0) {
				throw new AggregateError(
					childDestroyErrors,
					`Exact destruction failed for ${String(childDestroyErrors.length)} child VM${childDestroyErrors.length === 1 ? '' : 's'} owned by Gateway '${record.gateway.gatewayVmId}'.`,
				);
			}
			destructionAttempt.throwIfExpired('before persisted Gateway destruction');
			if (record.state === 'admitting') {
				record = await replaceReconciledMembership({
					journal: options.journal,
					nowMs: options.nowMs,
					record,
					replacement: { ...record, state: 'sealed' },
				});
			}
			if (record.state === 'sealed' || record.state === 'owner-unsafe') {
				record = await replaceReconciledMembership({
					journal: options.journal,
					nowMs: options.nowMs,
					record,
					replacement: { ...record, state: 'destroying' },
				});
			}
			if (record.state !== 'destroying') {
				throw new GatewayOwnershipCoordinatorError('owner-unsafe');
			}
			destructionAttempt.throwIfExpired('before persisted Gateway exact destroy');
			try {
				await options.authority.destroyMatchingReservation({
					controllerEpoch: record.gateway.controllerEpoch,
					parentGateway: null,
					principal: record.gatewayReservation.principal,
					reservationId: record.gatewayReservation.reservationId,
					reservationPath: record.gatewayReservation.reservationPath,
					role: 'gateway',
					sessionLabel: record.gatewayReservation.sessionLabel,
					vmId: record.gatewayReservation.vmId,
				});
			} catch (gatewayDestroyError) {
				try {
					record = await markReconciledMembershipOwnerUnsafe({
						journal: options.journal,
						nowMs: options.nowMs,
						record,
					});
				} catch (persistenceError) {
					const aggregateError = new AggregateError(
						[gatewayDestroyError, persistenceError],
						'Gateway destroy failure and owner-unsafe persistence both failed',
					);
					aggregateError.cause = gatewayDestroyError;
					throw aggregateError;
				}
				throw gatewayDestroyError;
			}
			return await replaceReconciledMembership({
				journal: options.journal,
				nowMs: options.nowMs,
				record,
				replacement: { ...record, state: 'destroyed' },
			});
		});
	} catch (error) {
		if (record.state !== 'destroyed' && record.state !== 'owner-unsafe') {
			try {
				record = await markReconciledMembershipOwnerUnsafe({
					journal: options.journal,
					nowMs: options.nowMs,
					record,
				});
			} catch (persistenceError) {
				const aggregateError = new AggregateError(
					[error, persistenceError],
					'Gateway subtree reconciliation and owner-unsafe persistence both failed',
				);
				aggregateError.cause = error;
				throw aggregateError;
			}
		}
		throw error;
	}
}
