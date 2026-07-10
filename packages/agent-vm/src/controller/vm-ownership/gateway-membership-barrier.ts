import {
	gatewayEpochIdentitySchema,
	gatewayIdentitiesEqual,
	gatewayMembershipRecordSchema,
	gatewayOwnershipReservationReferenceSchema,
	stablePrincipalKey,
	toolVmOwnershipReservationReferenceSchema,
	type GatewayEpochIdentity,
	type GatewayMembershipRecord,
	type GatewayOwnershipReservationReference,
	type OwnershipDispositionReason,
	type ToolVmChildMembership,
	type ToolVmOwnershipReservationReference,
} from './vm-ownership-contracts.js';
import type { VmOwnershipJournal } from './vm-ownership-journal.js';

export type GatewayMembershipErrorCode =
	| 'child-duplicate'
	| 'child-missing'
	| 'gateway-already-retired'
	| 'gateway-identity-mismatch'
	| 'gateway-not-admitting'
	| 'gateway-not-sealed'
	| 'gateway-reservation-mismatch'
	| 'principal-conflict'
	| 'reservation-revision-regressed'
	| 'wrong-parent';

export class GatewayMembershipError extends Error {
	public constructor(public readonly code: GatewayMembershipErrorCode) {
		super(`Gateway ownership membership refused operation: ${code}`);
		this.name = 'GatewayMembershipError';
	}
}

export type ChildDestroyDisposition =
	| {
			readonly complete: false;
			readonly observedReservationRevision: number;
			readonly reason: OwnershipDispositionReason;
	  }
	| {
			readonly complete: true;
			readonly observedReservationRevision: number;
	  };

export interface ProvisionalChildAdmission {
	readonly durable: Promise<void>;
	beginDestroying(): Promise<void>;
	commitCurrent(): Promise<void>;
	recordDestroyDisposition(disposition: ChildDestroyDisposition): Promise<void>;
}

export interface GatewaySealResult {
	readonly barrier: Promise<{
		readonly gatewayEpochId: string;
		readonly kind: 'children-destroyed';
	}>;
	readonly childReservationIds: readonly string[];
}

export interface GatewayMembershipBarrier {
	admitProvisionalChild(
		expectedGateway: GatewayEpochIdentity,
		reservation: ToolVmOwnershipReservationReference,
	): ProvisionalChildAdmission;
	beginGatewayDestroying(expectedGateway: GatewayEpochIdentity): Promise<GatewayMembershipRecord>;
	recordGatewayDestroyDisposition(
		expectedGateway: GatewayEpochIdentity,
		disposition: { readonly complete: boolean },
	): Promise<GatewayMembershipRecord>;
	sealGatewayEpoch(expectedGateway: GatewayEpochIdentity): GatewaySealResult;
	snapshot(): GatewayMembershipRecord;
}

interface RegisterGatewayMembershipBarrierOptions {
	readonly gateway: GatewayEpochIdentity;
	readonly gatewayReservation: GatewayOwnershipReservationReference;
	readonly journal: VmOwnershipJournal;
}

interface DeferredCompletion {
	readonly promise: Promise<void>;
	resolve(): void;
}

function createDeferredCompletion(): DeferredCompletion {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(): void {
			resolvePromise?.();
		},
	};
}

function assertGatewayReservationMatchesIdentity(options: {
	readonly gateway: GatewayEpochIdentity;
	readonly reservation: GatewayOwnershipReservationReference;
}): void {
	if (
		options.reservation.controllerEpoch !== options.gateway.controllerEpoch ||
		options.reservation.vmId !== options.gateway.gatewayVmId ||
		options.reservation.principal.zoneId !== options.gateway.zoneId
	) {
		throw new GatewayMembershipError('gateway-reservation-mismatch');
	}
}

function assertExpectedGateway(
	registeredGateway: GatewayEpochIdentity,
	expectedGateway: GatewayEpochIdentity,
): void {
	const parsedExpectedGateway = gatewayEpochIdentitySchema.safeParse(expectedGateway);
	if (!parsedExpectedGateway.success) {
		throw new GatewayMembershipError('gateway-identity-mismatch');
	}
	if (!gatewayIdentitiesEqual(registeredGateway, parsedExpectedGateway.data)) {
		throw new GatewayMembershipError('gateway-identity-mismatch');
	}
}

function assertChildParentMatchesGateway(options: {
	readonly child: ToolVmOwnershipReservationReference;
	readonly gateway: GatewayEpochIdentity;
}): void {
	if (
		options.child.controllerEpoch !== options.gateway.controllerEpoch ||
		options.child.parentGateway.gatewayEpochId !== options.gateway.gatewayEpochId ||
		options.child.parentGateway.gatewayVmId !== options.gateway.gatewayVmId ||
		options.child.principal.zoneId !== options.gateway.zoneId
	) {
		throw new GatewayMembershipError('wrong-parent');
	}
}

function cloneRecord(record: GatewayMembershipRecord): GatewayMembershipRecord {
	return structuredClone(record);
}

function findChild(record: GatewayMembershipRecord, reservationId: string): ToolVmChildMembership {
	const child = record.children.find((candidate) => candidate.reservationId === reservationId);
	if (child === undefined) {
		throw new GatewayMembershipError('child-missing');
	}
	return child;
}

function replaceChild(options: {
	readonly child: ToolVmChildMembership;
	readonly record: GatewayMembershipRecord;
}): ToolVmChildMembership[] {
	return options.record.children.map((candidate) =>
		candidate.reservationId === options.child.reservationId ? options.child : candidate,
	);
}

function withoutDispositionReason(
	child: ToolVmChildMembership,
): Omit<ToolVmChildMembership, 'dispositionReason'> {
	return {
		controllerEpoch: child.controllerEpoch,
		expectedRevision: child.expectedRevision,
		observedReservationRevision: child.observedReservationRevision,
		parentGateway: child.parentGateway,
		principal: child.principal,
		reservationId: child.reservationId,
		reservationPath: child.reservationPath,
		role: child.role,
		state: child.state,
		vmId: child.vmId,
	};
}

class GatewayMembershipBarrierCore implements GatewayMembershipBarrier {
	readonly #childCompletions = new Map<string, DeferredCompletion>();
	readonly #journal: VmOwnershipJournal;
	#persistenceFailure: unknown;
	#record: GatewayMembershipRecord;
	#sealResult: GatewaySealResult | undefined;

	public constructor(options: {
		readonly journal: VmOwnershipJournal;
		readonly record: GatewayMembershipRecord;
	}) {
		this.#journal = options.journal;
		this.#record = cloneRecord(options.record);
	}

	public admitProvisionalChild(
		expectedGateway: GatewayEpochIdentity,
		untrustedReservation: ToolVmOwnershipReservationReference,
	): ProvisionalChildAdmission {
		this.#assertOperational();
		assertExpectedGateway(this.#record.gateway, expectedGateway);
		if (this.#record.state !== 'admitting') {
			throw new GatewayMembershipError('gateway-not-admitting');
		}
		const parsedReservation =
			toolVmOwnershipReservationReferenceSchema.safeParse(untrustedReservation);
		if (!parsedReservation.success) {
			throw new GatewayMembershipError('wrong-parent');
		}
		const reservation = parsedReservation.data;
		this.#journal.assertReservationPathOwned(
			reservation.reservationPath,
			reservation.reservationId,
		);
		assertChildParentMatchesGateway({ child: reservation, gateway: this.#record.gateway });
		if (
			this.#record.gatewayReservation.reservationId === reservation.reservationId ||
			this.#record.gatewayReservation.reservationPath === reservation.reservationPath ||
			this.#record.gatewayReservation.vmId === reservation.vmId ||
			this.#record.children.some(
				(child) =>
					child.reservationId === reservation.reservationId ||
					child.reservationPath === reservation.reservationPath ||
					child.vmId === reservation.vmId,
			)
		) {
			throw new GatewayMembershipError('child-duplicate');
		}
		const requestedPrincipalKey = stablePrincipalKey(reservation.principal);
		if (
			this.#record.children.some(
				(child) =>
					child.state !== 'destroyed' &&
					stablePrincipalKey(child.principal) === requestedPrincipalKey,
			)
		) {
			throw new GatewayMembershipError('principal-conflict');
		}

		const child = {
			...reservation,
			observedReservationRevision: reservation.expectedRevision,
			state: 'provisional',
		} satisfies ToolVmChildMembership;
		const completion = createDeferredCompletion();
		this.#childCompletions.set(reservation.reservationId, completion);
		const durable = this.#persistTransition({
			...this.#record,
			children: [...this.#record.children, child],
		});

		return {
			beginDestroying: async (): Promise<void> => {
				await durable;
				const currentChild = findChild(this.#record, reservation.reservationId);
				if (currentChild.state === 'destroyed') {
					return;
				}
				await this.#persistTransition({
					...this.#record,
					children: replaceChild({
						child: { ...currentChild, state: 'destroying' },
						record: this.#record,
					}),
				});
			},
			commitCurrent: async (): Promise<void> => {
				await durable;
				this.#assertOperational();
				if (this.#record.state !== 'admitting') {
					throw new GatewayMembershipError('gateway-not-admitting');
				}
				const currentChild = findChild(this.#record, reservation.reservationId);
				if (currentChild.state !== 'provisional') {
					throw new GatewayMembershipError('child-duplicate');
				}
				await this.#persistTransition({
					...this.#record,
					children: replaceChild({
						child: { ...currentChild, state: 'current' },
						record: this.#record,
					}),
				});
			},
			durable,
			recordDestroyDisposition: async (disposition): Promise<void> => {
				await durable;
				const currentChild = findChild(this.#record, reservation.reservationId);
				if (currentChild.state === 'destroyed') {
					return;
				}
				if (disposition.observedReservationRevision < currentChild.observedReservationRevision) {
					throw new GatewayMembershipError('reservation-revision-regressed');
				}
				const updatedChild = {
					...withoutDispositionReason(currentChild),
					...(disposition.complete ? {} : { dispositionReason: disposition.reason }),
					observedReservationRevision: disposition.observedReservationRevision,
					state: disposition.complete ? 'destroyed' : 'owner-unsafe',
				} satisfies ToolVmChildMembership;
				const nextRecord = {
					...this.#record,
					children: replaceChild({ child: updatedChild, record: this.#record }),
					...(disposition.complete ? {} : { state: 'owner-unsafe' as const }),
				};
				await this.#persistTransition(nextRecord);
				if (disposition.complete) {
					completion.resolve();
				}
			},
		};
	}

	public async beginGatewayDestroying(
		expectedGateway: GatewayEpochIdentity,
	): Promise<GatewayMembershipRecord> {
		this.#assertOperational();
		assertExpectedGateway(this.#record.gateway, expectedGateway);
		if (this.#record.state !== 'sealed' && this.#record.state !== 'owner-unsafe') {
			throw new GatewayMembershipError('gateway-not-sealed');
		}
		if (this.#record.children.some((child) => child.state !== 'destroyed')) {
			throw new GatewayMembershipError('gateway-not-sealed');
		}
		await this.#persistTransition({ ...this.#record, state: 'destroying' });
		return this.snapshot();
	}

	public async recordGatewayDestroyDisposition(
		expectedGateway: GatewayEpochIdentity,
		disposition: { readonly complete: boolean },
	): Promise<GatewayMembershipRecord> {
		this.#assertOperational();
		assertExpectedGateway(this.#record.gateway, expectedGateway);
		if (this.#record.state !== 'destroying') {
			throw new GatewayMembershipError('gateway-not-sealed');
		}
		await this.#persistTransition({
			...this.#record,
			state: disposition.complete ? 'destroyed' : 'owner-unsafe',
		});
		return this.snapshot();
	}

	public sealGatewayEpoch(expectedGateway: GatewayEpochIdentity): GatewaySealResult {
		this.#assertOperational();
		assertExpectedGateway(this.#record.gateway, expectedGateway);
		if (this.#sealResult !== undefined) {
			return this.#sealResult;
		}
		if (this.#record.state !== 'admitting' && this.#record.state !== 'owner-unsafe') {
			throw new GatewayMembershipError(
				this.#record.state === 'destroyed' ? 'gateway-already-retired' : 'gateway-not-admitting',
			);
		}

		const childReservationIds = this.#record.children
			.filter((child) => child.state !== 'destroyed')
			.map((child) => child.reservationId);
		const sealDurable =
			this.#record.state === 'admitting'
				? this.#persistTransition({ ...this.#record, state: 'sealed' })
				: Promise.resolve();
		const childDispositionPromises = childReservationIds.map((reservationId) => {
			const completion = this.#childCompletions.get(reservationId);
			if (completion === undefined) {
				return Promise.reject(new GatewayMembershipError('child-missing'));
			}
			return completion.promise;
		});
		const barrier = Promise.all([sealDurable, ...childDispositionPromises]).then(() => ({
			gatewayEpochId: this.#record.gateway.gatewayEpochId,
			kind: 'children-destroyed' as const,
		}));
		this.#sealResult = { barrier, childReservationIds };
		return this.#sealResult;
	}

	public snapshot(): GatewayMembershipRecord {
		return cloneRecord(this.#record);
	}

	#assertOperational(): void {
		if (this.#persistenceFailure !== undefined) {
			throw new GatewayMembershipError('gateway-already-retired');
		}
	}

	#persistTransition(
		transitionedRecord: Omit<GatewayMembershipRecord, 'revision' | 'updatedAtMs'>,
	): Promise<void> {
		this.#assertOperational();
		const previousRevision = this.#record.revision;
		const nextRecord = gatewayMembershipRecordSchema.parse({
			...transitionedRecord,
			revision: previousRevision + 1,
			updatedAtMs: this.#journal.captureTimestampMs(),
		});
		this.#record = nextRecord;
		return this.#journal
			.replaceGatewayMembership({
				expectedRevision: previousRevision,
				record: nextRecord,
			})
			.then(() => undefined)
			.catch((error: unknown) => {
				this.#persistenceFailure = error;
				throw error;
			});
	}
}

export async function registerGatewayMembershipBarrier(
	options: RegisterGatewayMembershipBarrierOptions,
): Promise<GatewayMembershipBarrier> {
	const parsedGateway = gatewayEpochIdentitySchema.safeParse(options.gateway);
	const parsedGatewayReservation = gatewayOwnershipReservationReferenceSchema.safeParse(
		options.gatewayReservation,
	);
	if (!parsedGateway.success || !parsedGatewayReservation.success) {
		throw new GatewayMembershipError('gateway-reservation-mismatch');
	}
	const gateway = parsedGateway.data;
	const gatewayReservation = parsedGatewayReservation.data;
	options.journal.assertReservationPathOwned(
		gatewayReservation.reservationPath,
		gatewayReservation.reservationId,
	);
	assertGatewayReservationMatchesIdentity({ gateway, reservation: gatewayReservation });
	const timestampMs = options.journal.captureTimestampMs();
	const record = gatewayMembershipRecordSchema.parse({
		children: [],
		controllerEpoch: gateway.controllerEpoch,
		createdAtMs: timestampMs,
		gateway,
		gatewayReservation,
		revision: 1,
		schemaVersion: 1,
		state: 'admitting',
		updatedAtMs: timestampMs,
	});
	await options.journal.createGatewayMembership(record);
	return new GatewayMembershipBarrierCore({ journal: options.journal, record });
}

export type {
	GatewayEpochIdentity,
	GatewayOwnershipReservationReference,
	ToolVmOwnershipReservationReference,
} from './vm-ownership-contracts.js';
