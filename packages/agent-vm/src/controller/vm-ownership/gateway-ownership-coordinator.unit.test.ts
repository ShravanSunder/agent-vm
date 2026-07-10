import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	CreatedManagedVmOwnershipReservation,
	CreateManagedVmOwnershipReservationOptions,
	ManagedVmDestroyReceiptV1,
	ManagedVmDestroyTargetV1,
	ManagedVmOwnershipReservationReferenceV1,
	ManagedVmOwnershipReservationV1,
} from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createGatewayOwnershipCoordinator } from './gateway-ownership-coordinator.js';
import { createVmOwnershipJournal } from './vm-ownership-journal.js';

const FIXED_NOW_MS = 1_783_680_000_000;
const CONTROLLER_EPOCH = 'controller-epoch-a';
const CONTROL_BOOT_ID = 'control-boot-a';
const CONTROL_GENERATION_ID = 'control-generation-a';
const ZONE_ID = 'sunfam';

const temporaryDirectories: string[] = [];

async function createTemporaryStateDirectory(): Promise<string> {
	const stateDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-ownership-coordinator-'));
	temporaryDirectories.push(stateDirectory);
	return stateDirectory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (temporaryDirectory) => {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}),
	);
});

function createFakeReservation(
	options: CreateManagedVmOwnershipReservationOptions,
): CreatedManagedVmOwnershipReservation {
	if (options.reservationRoot === undefined) {
		throw new Error('coordinator must provide the owned reservation root');
	}
	const reservationDirectory = path.join(options.reservationRoot, options.reservationId);
	// This filename deliberately mirrors the installed Gondolin contract.
	const reservationPath = path.join(reservationDirectory, 'reservation-v1.json');
	const ownerProcess = {
		command: 'agent-vm-coordinator-unit-test',
		pid: process.pid,
		startCookie: 'coordinator-unit-test-process',
	};
	const runner = {
		backend: options.runnerBackend ?? 'qemu',
		discoveryIdentity: `gondolin-exact-vm:${options.reservationId}`,
		executable: options.runnerExecutable ?? '',
	};
	const resources = {
		disposableStoragePaths: options.resources?.disposableStoragePaths ?? [],
		...(options.resources?.ingressEndpoint === undefined
			? {}
			: { ingressEndpoint: options.resources.ingressEndpoint }),
		ingressListener: options.resources?.ingressListener ?? false,
		ingressSockets: options.resources?.ingressSockets ?? false,
		...(options.resources?.qmpSocketPath === undefined
			? {}
			: { qmpSocketPath: options.resources.qmpSocketPath }),
		retainedStoragePaths: options.resources?.retainedStoragePaths ?? [],
		...(options.resources?.sessionIpcPath === undefined
			? {}
			: { sessionIpcPath: options.resources.sessionIpcPath }),
		...(options.resources?.sshEndpoint === undefined
			? {}
			: { sshEndpoint: options.resources.sshEndpoint }),
		sshListener: options.resources?.sshListener ?? false,
		sshSessions: options.resources?.sshSessions ?? false,
	} satisfies CreatedManagedVmOwnershipReservation['reservation']['resources'];
	const reservation = {
		contractVersion: 1,
		controllerEpoch: options.controllerEpoch,
		createdAt: new Date(FIXED_NOW_MS).toISOString(),
		discoveryKey: `discovery-${options.reservationId}`,
		ownerProcess,
		parentGateway: options.parentGateway,
		...(options.principal === undefined ? {} : { principal: options.principal }),
		reservationId: options.reservationId,
		resources,
		revision: 1,
		role: options.role,
		runner,
		sessionLabel: options.sessionLabel,
		state: 'reserved',
		vmId: options.vmId,
	} satisfies CreatedManagedVmOwnershipReservation['reservation'];
	const target = {
		contractVersion: 1,
		controllerEpoch: options.controllerEpoch,
		ownerProcess,
		parentGateway: options.parentGateway,
		...(options.principal === undefined ? {} : { principal: options.principal }),
		reservationId: options.reservationId,
		reservationPath,
		resources,
		role: options.role,
		runner,
		sessionLabel: options.sessionLabel,
		vmId: options.vmId,
	} satisfies ManagedVmDestroyTargetV1;
	return {
		reference: {
			expectedContractVersion: 1,
			expectedRevision: 1,
			reservationId: options.reservationId,
			reservationPath,
		},
		reservation,
		reservationDirectory,
		reservationPath,
		target,
	};
}

function createDestroyReceipt(
	target: ManagedVmDestroyTargetV1,
	complete: boolean,
): ManagedVmDestroyReceiptV1 {
	const resourceStatus = complete ? ('already-absent' as const) : ('incomplete' as const);
	const executableName = path.basename(target.runner.executable);
	return {
		complete,
		completedAt: new Date(FIXED_NOW_MS + 1).toISOString(),
		contractVersion: 1,
		controllerEpoch: target.controllerEpoch,
		parentGateway: target.parentGateway,
		requestedRunner: {
			backend: target.runner.backend,
			discoveryIdentity: target.runner.discoveryIdentity,
			executableName: /^[A-Za-z0-9._+-]{1,128}$/u.test(executableName) ? executableName : 'runner',
			...(target.runner.pid === undefined ? {} : { pid: target.runner.pid }),
			...(target.runner.startCookie ? { startCookie: target.runner.startCookie } : {}),
		},
		reservationId: target.reservationId,
		resources: {
			disposableStorage: { status: resourceStatus },
			exactRunner: { status: resourceStatus },
			ingressListener: { status: resourceStatus },
			ingressSockets: { status: resourceStatus },
			qmp: { status: resourceStatus },
			sessionIpc: { status: resourceStatus },
			sshListener: { status: resourceStatus },
			sshSessions: { status: resourceStatus },
		},
		role: target.role,
		vmId: target.vmId,
	};
}

type CreateReservationMock = Mock<
	(
		options: CreateManagedVmOwnershipReservationOptions,
	) => Promise<CreatedManagedVmOwnershipReservation>
>;
type DestroyExactMock = Mock<
	(target: ManagedVmDestroyTargetV1) => Promise<ManagedVmDestroyReceiptV1>
>;
type ReadDestroyTargetMock = Mock<(reservationPath: string) => Promise<ManagedVmDestroyTargetV1>>;
type ReadOwnershipReservationMock = Mock<
	(reservationPath: string) => Promise<ManagedVmOwnershipReservationV1>
>;

interface CoordinatorHarness {
	readonly coordinator: ReturnType<typeof createGatewayOwnershipCoordinator>;
	readonly createIdMock: Mock<() => string>;
	readonly createReservationMock: CreateReservationMock;
	readonly destroyExactMock: DestroyExactMock;
	readonly readDestroyTargetMock: ReadDestroyTargetMock;
	readonly readOwnershipReservationMock: ReadOwnershipReservationMock;
	readonly reservationByPath: Map<string, ManagedVmOwnershipReservationV1>;
	readonly targetByPath: Map<string, ManagedVmDestroyTargetV1>;
	persistCreatedReservation(
		created: CreatedManagedVmOwnershipReservation,
	): CreatedManagedVmOwnershipReservation;
	setDestroyComplete(complete: boolean): void;
	readonly stateDirectory: string;
	readonly stateDirectoryForZoneMock: Mock<(zoneId: string) => string>;
}

async function createCoordinatorHarness(
	options: { readonly destroyComplete?: boolean } = {},
): Promise<CoordinatorHarness> {
	const stateDirectory = await createTemporaryStateDirectory();
	let nextId = 1;
	let destroyComplete = options.destroyComplete ?? true;
	const reservationByPath = new Map<string, ManagedVmOwnershipReservationV1>();
	const targetByPath = new Map<string, ManagedVmDestroyTargetV1>();
	const stateDirectoryForZoneMock = vi.fn((_zoneId: string): string => stateDirectory);
	const persistCreatedReservation = (
		created: CreatedManagedVmOwnershipReservation,
	): CreatedManagedVmOwnershipReservation => {
		reservationByPath.set(created.reservationPath, structuredClone(created.reservation));
		targetByPath.set(created.reservationPath, structuredClone(created.target));
		return created;
	};
	const createIdMock = vi.fn(() => `ownership-id-${nextId++}`);
	const createReservationMock = vi.fn(
		async (
			reservationOptions: CreateManagedVmOwnershipReservationOptions,
		): Promise<CreatedManagedVmOwnershipReservation> =>
			persistCreatedReservation(createFakeReservation(reservationOptions)),
	);
	const destroyExactMock = vi.fn(
		async (target: ManagedVmDestroyTargetV1): Promise<ManagedVmDestroyReceiptV1> =>
			createDestroyReceipt(target, destroyComplete),
	);
	const readDestroyTargetMock = vi.fn(
		async (reservationPath: string): Promise<ManagedVmDestroyTargetV1> => {
			const target = targetByPath.get(reservationPath);
			if (target === undefined) {
				throw new Error(`missing fake destroy target: ${reservationPath}`);
			}
			return structuredClone(target);
		},
	);
	const readOwnershipReservationMock = vi.fn(
		async (reservationPath: string): Promise<ManagedVmOwnershipReservationV1> => {
			const reservation = reservationByPath.get(reservationPath);
			if (reservation === undefined) {
				throw new Error(`missing fake ownership reservation: ${reservationPath}`);
			}
			return structuredClone(reservation);
		},
	);
	return {
		coordinator: createGatewayOwnershipCoordinator({
			controllerEpoch: CONTROLLER_EPOCH,
			createId: createIdMock,
			createManagedVmOwnershipReservation: createReservationMock,
			destroyManagedVmExact: destroyExactMock,
			nowMs: () => FIXED_NOW_MS,
			readManagedVmDestroyTarget: readDestroyTargetMock,
			readManagedVmOwnershipReservation: readOwnershipReservationMock,
			stateDirectoryForZone: stateDirectoryForZoneMock,
		}),
		createIdMock,
		createReservationMock,
		destroyExactMock,
		persistCreatedReservation,
		readDestroyTargetMock,
		readOwnershipReservationMock,
		reservationByPath,
		setDestroyComplete(complete: boolean): void {
			destroyComplete = complete;
		},
		stateDirectory,
		stateDirectoryForZoneMock,
		targetByPath,
	};
}

interface DeferredPromise<TValue> {
	readonly promise: Promise<TValue>;
	resolve(value: TValue): void;
}

function createDeferredPromise<TValue>(): DeferredPromise<TValue> {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value: TValue): void {
			resolvePromise?.(value);
		},
	};
}

function reservationOptionsAt(
	createReservationMock: CreateReservationMock,
	callIndex: number,
): CreateManagedVmOwnershipReservationOptions {
	const reservationCall = createReservationMock.mock.calls[callIndex];
	if (reservationCall === undefined) {
		throw new Error(`missing ownership reservation call ${callIndex}`);
	}
	return reservationCall[0];
}

function reservationReferenceFromOptions(
	options: CreateManagedVmOwnershipReservationOptions,
): ManagedVmOwnershipReservationReferenceV1 {
	if (options.reservationRoot === undefined) {
		throw new Error('ownership reservation root is required');
	}
	return {
		expectedContractVersion: 1,
		expectedRevision: 1,
		reservationId: options.reservationId,
		reservationPath: path.join(
			options.reservationRoot,
			options.reservationId,
			'reservation-v1.json',
		),
	};
}

function journalForHarness(
	harness: CoordinatorHarness,
): ReturnType<typeof createVmOwnershipJournal> {
	return createVmOwnershipJournal({
		nowMs: () => FIXED_NOW_MS,
		stateDirectory: harness.stateDirectory,
	});
}

function reservationAt(
	harness: CoordinatorHarness,
	reservationPath: string,
): ManagedVmOwnershipReservationV1 {
	const reservation = harness.reservationByPath.get(reservationPath);
	if (reservation === undefined) {
		throw new Error(`missing fake ownership reservation: ${reservationPath}`);
	}
	return reservation;
}

function targetAt(harness: CoordinatorHarness, reservationPath: string): ManagedVmDestroyTargetV1 {
	const target = harness.targetByPath.get(reservationPath);
	if (target === undefined) {
		throw new Error(`missing fake destroy target: ${reservationPath}`);
	}
	return target;
}

function wrongIdentityCompleteReceipt(target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 {
	return {
		...createDestroyReceipt(target, true),
		reservationId: `${target.reservationId}-wrong`,
	};
}

function errorTreeContainsCode(error: unknown, expectedCode: string): boolean {
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === expectedCode
	) {
		return true;
	}
	if (error instanceof AggregateError) {
		return error.errors.some((nestedError) => errorTreeContainsCode(nestedError, expectedCode));
	}
	return error instanceof Error && errorTreeContainsCode(error.cause, expectedCode);
}

async function promiseSettled(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.finally(() => {
		settled = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	return settled;
}

async function beginGateway(
	harness: CoordinatorHarness,
	options: {
		readonly bootId?: string;
		readonly generationId?: string;
		readonly sessionLabel?: string;
		readonly zoneId?: string;
	} = {},
): ReturnType<CoordinatorHarness['coordinator']['beginGatewayEpoch']> {
	return await harness.coordinator.beginGatewayEpoch({
		bootId: options.bootId ?? CONTROL_BOOT_ID,
		generationId: options.generationId ?? CONTROL_GENERATION_ID,
		sessionLabel: options.sessionLabel ?? 'sunfam-gateway',
		zoneId: options.zoneId ?? ZONE_ID,
	});
}

describe('GatewayOwnershipCoordinator', () => {
	it('durably registers matching Gateway ownership before begin resolves', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();

		// Act
		const gateway = await beginGateway(harness, {
			bootId: 'control-boot-supplied',
			generationId: 'control-generation-supplied',
		});
		const createOptions = reservationOptionsAt(harness.createReservationMock, 0);
		const journal = createVmOwnershipJournal({
			nowMs: () => FIXED_NOW_MS,
			stateDirectory: harness.stateDirectory,
		});
		const durableMembership = await journal.loadGatewayMembership(
			gateway.gatewayIdentity.gatewayEpochId,
		);

		// Assert
		expect(harness.createReservationMock).toHaveBeenCalledTimes(1);
		expect(harness.stateDirectoryForZoneMock).toHaveBeenCalledWith(ZONE_ID);
		expect(gateway.gatewayIdentity).toMatchObject({
			bootId: 'control-boot-supplied',
			controllerEpoch: CONTROLLER_EPOCH,
			generationId: 'control-generation-supplied',
			zoneId: ZONE_ID,
		});
		expect(createOptions).toMatchObject({
			controllerEpoch: CONTROLLER_EPOCH,
			parentGateway: null,
			principal: JSON.stringify({ kind: 'gateway-zone', zoneId: ZONE_ID }),
			role: 'gateway',
			sessionLabel: 'sunfam-gateway',
			vmId: gateway.gatewayIdentity.gatewayVmId,
		});
		expect(gateway.ownershipReservation).toEqual({
			expectedContractVersion: 1,
			expectedRevision: 1,
			reservationId: createOptions.reservationId,
			reservationPath: path.join(
				createOptions.reservationRoot ?? '',
				createOptions.reservationId,
				'reservation-v1.json',
			),
		});
		expect(createOptions.reservationRoot).toBe(
			path.join(harness.stateDirectory, 'vm-ownership', 'reservations'),
		);
		expect(durableMembership).toMatchObject({
			controllerEpoch: CONTROLLER_EPOCH,
			gateway: gateway.gatewayIdentity,
			gatewayReservation: {
				controllerEpoch: CONTROLLER_EPOCH,
				parentGateway: null,
				principal: { kind: 'gateway-zone', zoneId: ZONE_ID },
				reservationId: gateway.ownershipReservation.reservationId,
				reservationPath: gateway.ownershipReservation.reservationPath,
				role: 'gateway',
				vmId: gateway.gatewayIdentity.gatewayVmId,
			},
			state: 'admitting',
		});
		expect('membershipBarrier' in gateway).toBe(false);
	});

	it('rejects Gateway begin when persisted reservation and destroy target identities diverge', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		let reservationPath = '';
		harness.createReservationMock.mockImplementationOnce(async (reservationOptions) => {
			const created = harness.persistCreatedReservation(createFakeReservation(reservationOptions));
			reservationPath = created.reservationPath;
			harness.targetByPath.set(created.reservationPath, {
				...created.target,
				sessionLabel: `${created.target.sessionLabel}-mismatch`,
			});
			return created;
		});

		// Act / Assert
		await expect(beginGateway(harness)).rejects.toSatisfy((error: unknown) =>
			errorTreeContainsCode(error, 'reservation-identity-mismatch'),
		);
		expect(harness.readOwnershipReservationMock).toHaveBeenCalledWith(reservationPath);
		expect(harness.readDestroyTargetMock).toHaveBeenCalledWith(reservationPath);
	});

	it('fences the zone when mismatched Gateway reference cleanup throws', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const cleanupError = new Error('exact Gateway cleanup crashed');
		let mismatchedTarget: ManagedVmDestroyTargetV1 | undefined;
		harness.createReservationMock.mockImplementationOnce(async (reservationOptions) => {
			const created = harness.persistCreatedReservation(createFakeReservation(reservationOptions));
			mismatchedTarget = created.target;
			return {
				...created,
				reference: {
					...created.reference,
					reservationId: `${created.reference.reservationId}-mismatch`,
				},
			};
		});
		harness.destroyExactMock.mockRejectedValueOnce(cleanupError);

		// Act / Assert
		await expect(beginGateway(harness)).rejects.toBeDefined();
		expect(harness.destroyExactMock).toHaveBeenCalledWith(mismatchedTarget);
		await expect(
			beginGateway(harness, { sessionLabel: 'sunfam-gateway-after-cleanup-throw' }),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
	});

	it('fences the zone when returned Gateway reference mismatches despite a complete returned-target cleanup', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		let expectedReference: ManagedVmOwnershipReservationReferenceV1 | undefined;
		let returnedTarget: ManagedVmDestroyTargetV1 | undefined;
		harness.createReservationMock.mockImplementationOnce(async (reservationOptions) => {
			const created = harness.persistCreatedReservation(createFakeReservation(reservationOptions));
			expectedReference = reservationReferenceFromOptions(reservationOptions);
			returnedTarget = created.target;
			return {
				...created,
				reference: {
					...created.reference,
					reservationId: `${created.reference.reservationId}-mismatch`,
				},
			};
		});

		// Act / Assert
		await expect(beginGateway(harness)).rejects.toSatisfy((error: unknown) =>
			errorTreeContainsCode(error, 'reservation-identity-mismatch'),
		);
		expect(harness.destroyExactMock).toHaveBeenCalledWith(returnedTarget);
		if (expectedReference === undefined) {
			throw new Error('Gateway create did not expose its deterministic expected reference');
		}
		expect(harness.reservationByPath.has(expectedReference.reservationPath)).toBe(true);
		await expect(
			beginGateway(harness, { sessionLabel: 'sunfam-gateway-unreconciled-successor' }),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
	});

	it('durably admits a Tool reservation parented to the current Gateway', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);

		// Act
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'main',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-main-tool',
		});
		expect('ownershipReservation' in tool).toBe(false);
		const ownershipReservation = await tool.ready;
		const createOptions = reservationOptionsAt(harness.createReservationMock, 1);
		const journal = createVmOwnershipJournal({
			nowMs: () => FIXED_NOW_MS,
			stateDirectory: harness.stateDirectory,
		});
		const durableMembership = await journal.loadGatewayMembership(
			gateway.gatewayIdentity.gatewayEpochId,
		);

		// Assert
		expect('admission' in tool).toBe(false);
		expect(createOptions).toMatchObject({
			controllerEpoch: CONTROLLER_EPOCH,
			parentGateway: {
				epoch: gateway.gatewayIdentity.gatewayEpochId,
				vmId: gateway.gatewayIdentity.gatewayVmId,
			},
			principal: JSON.stringify({ agentId: 'main', kind: 'stable-agent', zoneId: ZONE_ID }),
			role: 'tool',
			sessionLabel: 'sunfam-main-tool',
		});
		expect(ownershipReservation).toEqual(reservationReferenceFromOptions(createOptions));
		expect(durableMembership.children).toEqual([
			expect.objectContaining({
				controllerEpoch: CONTROLLER_EPOCH,
				parentGateway: {
					gatewayEpochId: gateway.gatewayIdentity.gatewayEpochId,
					gatewayVmId: gateway.gatewayIdentity.gatewayVmId,
				},
				principal: { agentId: 'main', kind: 'stable-agent', zoneId: ZONE_ID },
				reservationId: ownershipReservation.reservationId,
				reservationPath: ownershipReservation.reservationPath,
				role: 'tool',
				state: 'provisional',
			}),
		]);
		await tool.commitCurrent();
		await expect(
			journal.loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [expect.objectContaining({ state: 'current' })],
		});
	});

	it('rejects Tool readiness when persisted reservation and destroy target identities diverge', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		let reservationPath = '';
		harness.createReservationMock.mockImplementationOnce(async (reservationOptions) => {
			const created = harness.persistCreatedReservation(createFakeReservation(reservationOptions));
			reservationPath = created.reservationPath;
			harness.targetByPath.set(created.reservationPath, {
				...created.target,
				runner: {
					...created.target.runner,
					discoveryIdentity: `${created.target.runner.discoveryIdentity}:mismatch`,
				},
			});
			return created;
		});

		// Act
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'persisted-mismatch',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-persisted-mismatch-tool',
		});

		// Assert
		expect('ownershipReservation' in tool).toBe(false);
		await expect(tool.ready).rejects.toSatisfy((error: unknown) =>
			errorTreeContainsCode(error, 'reservation-identity-mismatch'),
		);
		expect(harness.readOwnershipReservationMock).toHaveBeenCalledWith(reservationPath);
		expect(harness.readDestroyTargetMock).toHaveBeenCalledWith(reservationPath);
	});

	it('keeps the expected Tool child owner-unsafe when only a mismatched returned target was destroyed', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		let returnedTarget: ManagedVmDestroyTargetV1 | undefined;
		harness.createReservationMock.mockImplementationOnce(async (reservationOptions) => {
			const created = harness.persistCreatedReservation(createFakeReservation(reservationOptions));
			returnedTarget = created.target;
			return {
				...created,
				reference: {
					...created.reference,
					reservationId: `${created.reference.reservationId}-mismatch`,
				},
			};
		});
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'mismatched-returned-target',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-mismatched-returned-target-tool',
		});
		expect('ownershipReservation' in tool).toBe(false);
		const expectedReference = reservationReferenceFromOptions(
			reservationOptionsAt(harness.createReservationMock, 1),
		);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);

		// Act / Assert
		await expect(tool.ready).rejects.toSatisfy(
			(error: unknown) =>
				errorTreeContainsCode(error, 'reservation-identity-mismatch') &&
				errorTreeContainsCode(error, 'owner-unsafe'),
		);
		expect(harness.destroyExactMock).toHaveBeenCalledWith(returnedTarget);
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [
				expect.objectContaining({
					reservationId: expectedReference.reservationId,
					state: 'owner-unsafe',
				}),
			],
		});
		expect(await promiseSettled(sealed.barrier)).toBe(false);
	});

	it('seals synchronously and waits for every pre-seal provisional child', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'main',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-main-tool',
		});
		await tool.ready;

		// Act
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);

		// Assert
		expect(() =>
			harness.coordinator.admitProvisionalToolVm({
				agentId: 'late',
				expectedGateway: gateway.gatewayIdentity,
				sessionLabel: 'sunfam-late-tool',
			}),
		).toThrow();
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({ state: 'sealed' });
		expect(await promiseSettled(sealed.barrier)).toBe(false);
		await expect(tool.destroyDetached()).resolves.toMatchObject({ complete: true });
		await expect(sealed.barrier).resolves.toEqual({
			gatewayEpochId: gateway.gatewayIdentity.gatewayEpochId,
			kind: 'children-destroyed',
		});
	});

	it('registers an in-flight reservation before seal and keeps incomplete late cleanup in the barrier', async () => {
		// Arrange
		const harness = await createCoordinatorHarness({ destroyComplete: false });
		const gateway = await beginGateway(harness);
		const deferredReservation = createDeferredPromise<CreatedManagedVmOwnershipReservation>();
		let deferredReservationOptions: CreateManagedVmOwnershipReservationOptions | undefined;
		harness.createReservationMock.mockImplementationOnce(
			(reservationOptions: CreateManagedVmOwnershipReservationOptions) => {
				deferredReservationOptions = reservationOptions;
				return deferredReservation.promise;
			},
		);

		// Act
		const lateTool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'late',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-late-tool',
		});
		expect('ownershipReservation' in lateTool).toBe(false);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);

		// Assert
		expect(sealed.childReservationIds).toHaveLength(1);
		expect(await promiseSettled(sealed.barrier)).toBe(false);
		if (deferredReservationOptions === undefined) {
			throw new Error('Tool reservation creation did not start synchronously');
		}
		deferredReservation.resolve(
			harness.persistCreatedReservation(createFakeReservation(deferredReservationOptions)),
		);
		const ownershipReservation = await lateTool.ready;
		await expect(lateTool.destroyDetached()).rejects.toMatchObject({ code: 'owner-unsafe' });
		expect(harness.destroyExactMock).toHaveBeenCalledTimes(1);
		expect(harness.destroyExactMock.mock.calls[0]?.[0]).toMatchObject({
			controllerEpoch: CONTROLLER_EPOCH,
			parentGateway: {
				epoch: gateway.gatewayIdentity.gatewayEpochId,
				vmId: gateway.gatewayIdentity.gatewayVmId,
			},
			role: 'tool',
		});
		const lateMembership = await journalForHarness(harness).loadGatewayMembership(
			gateway.gatewayIdentity.gatewayEpochId,
		);
		expect(lateMembership.children).toEqual([
			expect.objectContaining({
				reservationId: ownershipReservation.reservationId,
				state: 'owner-unsafe',
			}),
		]);
		expect(await promiseSettled(sealed.barrier)).toBe(false);
		harness.setDestroyComplete(true);
		await expect(lateTool.destroyDetached()).resolves.toMatchObject({ complete: true });
		await expect(sealed.barrier).resolves.toMatchObject({ kind: 'children-destroyed' });
	});

	it('exact-destroys a persisted Tool reservation when create rejects and preserves the original error', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const createError = new Error('reservation fsync failed after persistence');
		harness.createReservationMock.mockImplementationOnce(async (reservationOptions) => {
			harness.persistCreatedReservation(createFakeReservation(reservationOptions));
			throw createError;
		});

		// Act
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'create-failure',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-create-failure-tool',
		});
		expect('ownershipReservation' in tool).toBe(false);
		const ownershipReservation = reservationReferenceFromOptions(
			reservationOptionsAt(harness.createReservationMock, 1),
		);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);

		// Assert
		await expect(tool.ready).rejects.toBe(createError);
		const membershipAfterCleanup = await journalForHarness(harness).loadGatewayMembership(
			gateway.gatewayIdentity.gatewayEpochId,
		);
		expect(harness.readDestroyTargetMock).toHaveBeenCalledWith(
			ownershipReservation.reservationPath,
		);
		expect(harness.destroyExactMock).toHaveBeenCalledWith(
			targetAt(harness, ownershipReservation.reservationPath),
		);
		expect(await promiseSettled(sealed.barrier)).toBe(true);
		await expect(sealed.barrier).resolves.toMatchObject({ kind: 'children-destroyed' });
		expect(membershipAfterCleanup).toMatchObject({
			children: [
				expect.objectContaining({
					reservationId: ownershipReservation.reservationId,
					state: 'destroyed',
				}),
			],
		});
	});

	it('retries detached cleanup after Tool readiness rejects with incomplete cleanup', async () => {
		// Arrange
		const harness = await createCoordinatorHarness({ destroyComplete: false });
		const gateway = await beginGateway(harness);
		const createError = new Error('reservation persistence failed after writing the record');
		harness.createReservationMock.mockImplementationOnce(async (reservationOptions) => {
			harness.persistCreatedReservation(createFakeReservation(reservationOptions));
			throw createError;
		});
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'retry-pre-ready-cleanup',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-retry-pre-ready-cleanup-tool',
		});
		expect('ownershipReservation' in tool).toBe(false);
		const reservationReference = reservationReferenceFromOptions(
			reservationOptionsAt(harness.createReservationMock, 1),
		);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);
		await expect(tool.ready).rejects.toSatisfy((error: unknown) =>
			errorTreeContainsCode(error, 'owner-unsafe'),
		);
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [
				expect.objectContaining({
					reservationId: reservationReference.reservationId,
					state: 'owner-unsafe',
				}),
			],
		});
		expect(await promiseSettled(sealed.barrier)).toBe(false);
		harness.setDestroyComplete(true);

		// Act
		await expect(tool.destroyDetached()).resolves.toMatchObject({ complete: true });

		// Assert
		expect(harness.destroyExactMock).toHaveBeenCalledTimes(2);
		await expect(sealed.barrier).resolves.toMatchObject({ kind: 'children-destroyed' });
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [
				expect.objectContaining({
					reservationId: reservationReference.reservationId,
					state: 'destroyed',
				}),
			],
		});
	});

	it('exact-destroys after durable admission failure and keeps the Gateway owner-unsafe', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const journal = journalForHarness(harness);
		await unlink(journal.membershipPathForTesting(gateway.gatewayIdentity.gatewayEpochId));

		// Act
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'durable-failure',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-durable-failure-tool',
		});
		expect('ownershipReservation' in tool).toBe(false);
		const ownershipReservation = reservationReferenceFromOptions(
			reservationOptionsAt(harness.createReservationMock, 1),
		);

		// Assert
		await expect(tool.ready).rejects.toBeDefined();
		expect(harness.destroyExactMock).toHaveBeenCalledWith(
			targetAt(harness, ownershipReservation.reservationPath),
		);
		expect(() =>
			harness.coordinator.admitProvisionalToolVm({
				agentId: 'must-not-admit',
				expectedGateway: gateway.gatewayIdentity,
				sessionLabel: 'sunfam-must-not-admit-tool',
			}),
		).toThrowError(expect.objectContaining({ code: 'owner-unsafe' }));
		await expect(
			beginGateway(harness, { sessionLabel: 'sunfam-false-successor' }),
		).rejects.toBeDefined();
	});

	it('re-reads the latest Tool reservation revision and destroy target after VM creation extends it', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'latest-target',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-latest-target-tool',
		});
		const ownershipReservation = await tool.ready;
		const initialReservation = reservationAt(harness, ownershipReservation.reservationPath);
		const initialTarget = targetAt(harness, ownershipReservation.reservationPath);
		const latestReservation = {
			...initialReservation,
			revision: 2,
			runner: {
				...initialReservation.runner,
				discoveryIdentity: `${initialReservation.runner.discoveryIdentity}:latest`,
				pid: 43_210,
				startCookie: 'latest-runner-cookie',
			},
			state: 'running',
		} satisfies ManagedVmOwnershipReservationV1;
		const latestTarget = {
			...initialTarget,
			runner: latestReservation.runner,
		} satisfies ManagedVmDestroyTargetV1;
		harness.reservationByPath.set(ownershipReservation.reservationPath, latestReservation);
		harness.targetByPath.set(ownershipReservation.reservationPath, latestTarget);
		harness.destroyExactMock.mockImplementation(async (target) =>
			createDestroyReceipt(
				target,
				target.runner.discoveryIdentity === latestTarget.runner.discoveryIdentity,
			),
		);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);

		// Act
		await expect(tool.destroyDetached()).resolves.toMatchObject({ complete: true });

		// Assert
		expect(harness.readOwnershipReservationMock).toHaveBeenCalledWith(
			ownershipReservation.reservationPath,
		);
		expect(harness.readDestroyTargetMock).toHaveBeenCalledWith(
			ownershipReservation.reservationPath,
		);
		expect(harness.destroyExactMock).toHaveBeenCalledWith(latestTarget);
		await expect(sealed.barrier).resolves.toMatchObject({ kind: 'children-destroyed' });
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [
				expect.objectContaining({
					observedReservationRevision: 2,
					state: 'destroyed',
				}),
			],
		});
	});

	it('live-closes exactly once against the latest authoritative Tool target and resolves the seal barrier', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'live-latest-target',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-live-latest-target-tool',
		});
		const ownershipReservation = await tool.ready;
		const initialReservation = reservationAt(harness, ownershipReservation.reservationPath);
		const initialTarget = targetAt(harness, ownershipReservation.reservationPath);
		const latestReservation = {
			...initialReservation,
			revision: 2,
			runner: {
				...initialReservation.runner,
				discoveryIdentity: `${initialReservation.runner.discoveryIdentity}:live-latest`,
				pid: 54_321,
				startCookie: 'live-latest-runner-cookie',
			},
			state: 'running',
		} satisfies ManagedVmOwnershipReservationV1;
		const latestTarget = {
			...initialTarget,
			runner: latestReservation.runner,
		} satisfies ManagedVmDestroyTargetV1;
		harness.reservationByPath.set(ownershipReservation.reservationPath, latestReservation);
		harness.targetByPath.set(ownershipReservation.reservationPath, latestTarget);
		const closeLiveVm = vi.fn(
			async (): Promise<ManagedVmDestroyReceiptV1> => createDestroyReceipt(latestTarget, true),
		);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);

		// Act
		await expect(tool.destroyLive(closeLiveVm)).resolves.toEqual(
			createDestroyReceipt(latestTarget, true),
		);

		// Assert
		expect(closeLiveVm).toHaveBeenCalledTimes(1);
		expect(harness.readOwnershipReservationMock).toHaveBeenCalledWith(
			ownershipReservation.reservationPath,
		);
		expect(harness.readDestroyTargetMock).toHaveBeenCalledWith(
			ownershipReservation.reservationPath,
		);
		expect(harness.destroyExactMock).not.toHaveBeenCalled();
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [expect.objectContaining({ observedReservationRevision: 2, state: 'destroyed' })],
		});
		await expect(sealed.barrier).resolves.toMatchObject({ kind: 'children-destroyed' });
	});

	it.each([
		{
			createInvalidReceipt: (target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 =>
				wrongIdentityCompleteReceipt(target),
			name: 'wrong-identity',
		},
		{
			createInvalidReceipt: (target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 =>
				createDestroyReceipt(target, false),
			name: 'incomplete',
		},
	] as const)(
		'keeps a $name live-close receipt owner-unsafe until a later matching live retry',
		async ({ createInvalidReceipt }) => {
			// Arrange
			const harness = await createCoordinatorHarness();
			const gateway = await beginGateway(harness);
			const tool = harness.coordinator.admitProvisionalToolVm({
				agentId: 'live-receipt-retry',
				expectedGateway: gateway.gatewayIdentity,
				sessionLabel: 'sunfam-live-receipt-retry-tool',
			});
			const ownershipReservation = await tool.ready;
			const target = targetAt(harness, ownershipReservation.reservationPath);
			const closeLiveVm = vi
				.fn<() => Promise<ManagedVmDestroyReceiptV1>>()
				.mockResolvedValueOnce(createInvalidReceipt(target))
				.mockResolvedValueOnce(createDestroyReceipt(target, true));
			const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);

			// Act / Assert
			await expect(tool.destroyLive(closeLiveVm)).rejects.toMatchObject({ code: 'owner-unsafe' });
			await expect(
				journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
			).resolves.toMatchObject({
				children: [expect.objectContaining({ state: 'owner-unsafe' })],
			});
			expect(await promiseSettled(sealed.barrier)).toBe(false);
			await expect(tool.destroyLive(closeLiveVm)).resolves.toEqual(
				createDestroyReceipt(target, true),
			);
			expect(closeLiveVm).toHaveBeenCalledTimes(2);
			await expect(
				journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
			).resolves.toMatchObject({
				children: [expect.objectContaining({ state: 'destroyed' })],
			});
			await expect(sealed.barrier).resolves.toMatchObject({ kind: 'children-destroyed' });
		},
	);

	it('refuses live-close through rejected readiness while detached retry remains available', async () => {
		// Arrange
		const harness = await createCoordinatorHarness({ destroyComplete: false });
		const gateway = await beginGateway(harness);
		const createError = new Error('pre-ready persistence failed after writing the reservation');
		harness.createReservationMock.mockImplementationOnce(async (reservationOptions) => {
			harness.persistCreatedReservation(createFakeReservation(reservationOptions));
			throw createError;
		});
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'pre-ready-live-close',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-pre-ready-live-close-tool',
		});
		const readyError = await tool.ready.catch((error: unknown) => error);
		const closeLiveVm = vi.fn(async (): Promise<ManagedVmDestroyReceiptV1> => {
			throw new Error('live close must not run before readiness');
		});

		// Act / Assert
		await expect(tool.destroyLive(closeLiveVm)).rejects.toBe(readyError);
		expect(closeLiveVm).not.toHaveBeenCalled();
		harness.setDestroyComplete(true);
		await expect(tool.destroyDetached()).resolves.toMatchObject({ complete: true });
	});

	it('rejects a wrong-identity complete Tool receipt until a matching retry completes', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'receipt-identity',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-receipt-identity-tool',
		});
		await tool.ready;
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);
		harness.destroyExactMock.mockImplementationOnce(async (target) =>
			wrongIdentityCompleteReceipt(target),
		);

		// Act / Assert
		await expect(tool.destroyDetached()).rejects.toMatchObject({ code: 'owner-unsafe' });
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [expect.objectContaining({ state: 'owner-unsafe' })],
		});
		expect(await promiseSettled(sealed.barrier)).toBe(false);
		await expect(tool.destroyDetached()).resolves.toMatchObject({ complete: true });
		await expect(sealed.barrier).resolves.toMatchObject({ kind: 'children-destroyed' });
	});

	it('detached-destroys an empty sealed Gateway from its authoritative path and permits a successor', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);
		await sealed.barrier;
		const gatewayTarget = targetAt(harness, gateway.ownershipReservation.reservationPath);

		// Act
		await expect(
			harness.coordinator.destroyGatewayDetached(gateway.gatewayIdentity),
		).resolves.toEqual(createDestroyReceipt(gatewayTarget, true));

		// Assert
		expect(harness.readOwnershipReservationMock).toHaveBeenCalledWith(
			gateway.ownershipReservation.reservationPath,
		);
		expect(harness.readDestroyTargetMock).toHaveBeenCalledWith(
			gateway.ownershipReservation.reservationPath,
		);
		expect(harness.destroyExactMock).toHaveBeenCalledWith(gatewayTarget);
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({ state: 'destroyed' });
		const successor = await beginGateway(harness, {
			bootId: 'control-boot-successor',
			generationId: 'control-generation-successor',
			sessionLabel: 'sunfam-detached-successor',
		});
		expect(successor.gatewayIdentity).toMatchObject({
			bootId: 'control-boot-successor',
			controllerEpoch: CONTROLLER_EPOCH,
			generationId: 'control-generation-successor',
		});
	});

	it.each([
		{
			createInvalidReceipt: (target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 =>
				createDestroyReceipt(target, false),
			name: 'incomplete',
		},
		{
			createInvalidReceipt: (target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 =>
				wrongIdentityCompleteReceipt(target),
			name: 'wrong-identity',
		},
	] as const)(
		'keeps an empty Gateway owner-unsafe after a $name detached destroy receipt',
		async ({ createInvalidReceipt }) => {
			// Arrange
			const harness = await createCoordinatorHarness();
			const gateway = await beginGateway(harness);
			const gatewayTarget = targetAt(harness, gateway.ownershipReservation.reservationPath);
			harness.destroyExactMock.mockResolvedValueOnce(createInvalidReceipt(gatewayTarget));

			// Act / Assert
			await expect(
				harness.coordinator.destroyGatewayDetached(gateway.gatewayIdentity),
			).rejects.toMatchObject({ code: 'owner-unsafe' });
			expect(harness.destroyExactMock).toHaveBeenCalledWith(gatewayTarget);
			await expect(
				journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
			).resolves.toMatchObject({ state: 'owner-unsafe' });
			await expect(
				beginGateway(harness, { sessionLabel: 'sunfam-invalid-detached-successor' }),
			).rejects.toMatchObject({ code: 'owner-unsafe' });
		},
	);

	it('permits a successor only after a matching exact Gateway destroy receipt', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);
		await sealed.barrier;
		const gatewayTarget = targetAt(harness, gateway.ownershipReservation.reservationPath);

		// Act / Assert
		expect('recordGatewayDestroyDisposition' in harness.coordinator).toBe(false);
		await expect(
			harness.coordinator.recordGatewayDestroyUnavailable(gateway.gatewayIdentity),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
		await expect(
			beginGateway(harness, { sessionLabel: 'sunfam-gateway-before-exact-proof' }),
		).rejects.toBeDefined();
		await expect(
			harness.coordinator.recordGatewayDestroyReceipt(
				gateway.gatewayIdentity,
				wrongIdentityCompleteReceipt(gatewayTarget),
			),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
		await expect(
			beginGateway(harness, { sessionLabel: 'sunfam-gateway-after-wrong-proof' }),
		).rejects.toBeDefined();
		await expect(
			harness.coordinator.recordGatewayDestroyReceipt(
				gateway.gatewayIdentity,
				createDestroyReceipt(gatewayTarget, true),
			),
		).resolves.toBeUndefined();
		const successor = await beginGateway(harness, {
			sessionLabel: 'sunfam-gateway-successor',
		});
		expect(successor.gatewayIdentity.gatewayEpochId).not.toBe(
			gateway.gatewayIdentity.gatewayEpochId,
		);
	});

	it('rejects Tool admission for a stale expected Gateway without creating a reservation', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const staleGateway = {
			...gateway.gatewayIdentity,
			generationId: `${gateway.gatewayIdentity.generationId}-stale`,
		};

		// Act / Assert
		expect(() =>
			harness.coordinator.admitProvisionalToolVm({
				agentId: 'main',
				expectedGateway: staleGateway,
				sessionLabel: 'stale-gateway-tool',
			}),
		).toThrowError(expect.objectContaining({ code: 'gateway-identity-mismatch' }));
		expect(harness.createReservationMock).toHaveBeenCalledTimes(1);
	});

	it('admits exactly one in-flight Gateway begin for a zone', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const deferredReservation = createDeferredPromise<CreatedManagedVmOwnershipReservation>();
		let deferredReservationOptions: CreateManagedVmOwnershipReservationOptions | undefined;
		harness.createReservationMock.mockImplementationOnce((reservationOptions) => {
			deferredReservationOptions = reservationOptions;
			return deferredReservation.promise;
		});

		// Act
		const firstBegin = beginGateway(harness, { sessionLabel: 'sunfam-gateway-first' });
		const secondBegin = beginGateway(harness, { sessionLabel: 'sunfam-gateway-second' });

		// Assert
		await expect(secondBegin).rejects.toMatchObject({ code: 'gateway-already-current' });
		expect(harness.createReservationMock).toHaveBeenCalledTimes(1);
		if (deferredReservationOptions === undefined) {
			throw new Error('Gateway reservation creation did not start');
		}
		deferredReservation.resolve(
			harness.persistCreatedReservation(createFakeReservation(deferredReservationOptions)),
		);
		await expect(firstBegin).resolves.toMatchObject({
			gatewayIdentity: expect.objectContaining({ zoneId: ZONE_ID }),
		});
	});
});
