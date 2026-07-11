import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
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

import {
	GatewayDestructionTimeoutError,
	type GatewayDestructionBudget,
} from './gateway-destruction-budget.js';
import { createGatewayOwnershipCoordinator } from './gateway-ownership-coordinator.js';
import type {
	GatewayEpochIdentity,
	GatewayMembershipRecord,
	VmOwnershipDeploymentIdentity,
	VmOwnershipPrincipal,
} from './vm-ownership-contracts.js';
import { createVmOwnershipJournal } from './vm-ownership-journal.js';

const FIXED_NOW_MS = 1_783_680_000_000;
const CONTROLLER_EPOCH = 'controller-epoch-a';
const CONTROL_BOOT_ID = 'control-boot-a';
const CONTROL_GENERATION_ID = 'control-generation-a';
const ZONE_ID = 'sunfam';
const TEST_DEPLOYMENT_IDENTITY = {
	configPath: '/deployments/sunfam/config/system.jsonc',
	controllerPort: 18_800,
	projectNamespace: 'sunfam-test-deployment',
} satisfies VmOwnershipDeploymentIdentity;

function gatewayTestPrincipal(
	zoneId = ZONE_ID,
): GatewayMembershipRecord['gatewayReservation']['principal'] {
	return { ...TEST_DEPLOYMENT_IDENTITY, kind: 'gateway-zone', zoneId };
}

function stableAgentTestPrincipal(
	agentId: string,
	zoneId = ZONE_ID,
): GatewayMembershipRecord['children'][number]['principal'] {
	return { ...TEST_DEPLOYMENT_IDENTITY, agentId, kind: 'stable-agent', zoneId };
}

function workerTaskTestPrincipal(
	taskId: string,
	zoneId = ZONE_ID,
): Extract<VmOwnershipPrincipal, { readonly kind: 'worker-task' }> {
	return { ...TEST_DEPLOYMENT_IDENTITY, kind: 'worker-task', taskId, zoneId };
}

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
type ListOwnershipReservationPathsMock = Mock<
	(reservationRoot: string) => Promise<readonly string[]>
>;

interface CoordinatorHarness {
	readonly coordinator: ReturnType<typeof createGatewayOwnershipCoordinator>;
	readonly createIdMock: Mock<() => string>;
	readonly createReservationMock: CreateReservationMock;
	readonly destroyExactMock: DestroyExactMock;
	readonly listOwnershipReservationPathsMock: ListOwnershipReservationPathsMock;
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
	options: {
		readonly destroyComplete?: boolean;
		readonly destructionBudget?: GatewayDestructionBudget;
	} = {},
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
	const listOwnershipReservationPathsMock = vi.fn(async (): Promise<readonly string[]> => []);
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
			deploymentIdentity: TEST_DEPLOYMENT_IDENTITY,
			createManagedVmOwnershipReservation: createReservationMock,
			destroyManagedVmExact: destroyExactMock,
			...(options.destructionBudget === undefined
				? {}
				: { destructionBudget: options.destructionBudget }),
			listManagedVmOwnershipReservationPaths: listOwnershipReservationPathsMock,
			nowMs: () => FIXED_NOW_MS,
			readManagedVmDestroyTarget: readDestroyTargetMock,
			readManagedVmOwnershipReservation: readOwnershipReservationMock,
			stateDirectoryForZone: stateDirectoryForZoneMock,
		} as Parameters<typeof createGatewayOwnershipCoordinator>[0] & {
			readonly listManagedVmOwnershipReservationPaths: ListOwnershipReservationPathsMock;
		}),
		createIdMock,
		createReservationMock,
		destroyExactMock,
		listOwnershipReservationPathsMock,
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

interface PendingGatewayDetachedDestroyAttemptPort {
	attemptGatewayDetachedDestroy(
		expectedGateway: GatewayEpochIdentity,
	): Promise<ManagedVmDestroyReceiptV1>;
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

function isPendingGatewayDetachedDestroyAttemptPort(
	coordinator: unknown,
): coordinator is PendingGatewayDetachedDestroyAttemptPort {
	return typeof coordinator !== 'object' || coordinator === null
		? false
		: 'attemptGatewayDetachedDestroy' in coordinator &&
				typeof coordinator.attemptGatewayDetachedDestroy === 'function';
}

function requirePendingGatewayDetachedDestroyAttempt(
	coordinator: unknown,
): PendingGatewayDetachedDestroyAttemptPort {
	if (!isPendingGatewayDetachedDestroyAttemptPort(coordinator)) {
		throw new Error('Gateway ownership coordinator must expose attemptGatewayDetachedDestroy().');
	}
	return coordinator;
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

function createRestartedCoordinator(
	harness: CoordinatorHarness,
	controllerEpoch = CONTROLLER_EPOCH,
	options: { readonly standaloneReservationRoot?: string } = {},
): ReturnType<typeof createGatewayOwnershipCoordinator> {
	return createGatewayOwnershipCoordinator({
		controllerEpoch,
		createId: harness.createIdMock,
		deploymentIdentity: TEST_DEPLOYMENT_IDENTITY,
		createManagedVmOwnershipReservation: harness.createReservationMock,
		destroyManagedVmExact: harness.destroyExactMock,
		listManagedVmOwnershipReservationPaths: harness.listOwnershipReservationPathsMock,
		nowMs: () => FIXED_NOW_MS,
		readManagedVmDestroyTarget: harness.readDestroyTargetMock,
		readManagedVmOwnershipReservation: harness.readOwnershipReservationMock,
		...(options.standaloneReservationRoot === undefined
			? {}
			: { standaloneReservationRoot: options.standaloneReservationRoot }),
		stateDirectoryForZone: harness.stateDirectoryForZoneMock,
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

function errorTreeContainsExactError(error: unknown, expectedError: Error): boolean {
	if (error === expectedError) {
		return true;
	}
	if (error instanceof AggregateError) {
		return error.errors.some((nestedError) =>
			errorTreeContainsExactError(nestedError, expectedError),
		);
	}
	return error instanceof Error && errorTreeContainsExactError(error.cause, expectedError);
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

function createOrphanReservation(
	harness: CoordinatorHarness,
	options: Omit<CreateManagedVmOwnershipReservationOptions, 'reservationRoot'>,
): CreatedManagedVmOwnershipReservation {
	const createdReservation = harness.persistCreatedReservation(
		createFakeReservation({
			...options,
			reservationRoot: path.join(harness.stateDirectory, 'vm-ownership', 'reservations'),
		}),
	);
	harness.listOwnershipReservationPathsMock.mockResolvedValue([createdReservation.reservationPath]);
	return createdReservation;
}

function createStandaloneOrphanReservation(
	harness: CoordinatorHarness,
	reservationRoot: string,
	options: Omit<CreateManagedVmOwnershipReservationOptions, 'reservationRoot'>,
): CreatedManagedVmOwnershipReservation {
	return harness.persistCreatedReservation(createFakeReservation({ ...options, reservationRoot }));
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
			principal: JSON.stringify(gatewayTestPrincipal()),
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
				principal: gatewayTestPrincipal(),
				reservationId: gateway.ownershipReservation.reservationId,
				reservationPath: gateway.ownershipReservation.reservationPath,
				role: 'gateway',
				sessionLabel: 'sunfam-gateway',
				vmId: gateway.gatewayIdentity.gatewayVmId,
			},
			state: 'admitting',
		});
		expect('membershipBarrier' in gateway).toBe(false);
	});

	it('keeps a sealed pending-create Gateway current after an early already-absent exact attempt and admits G2 only after a final receipt', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const gatewayTarget = targetAt(harness, gateway.ownershipReservation.reservationPath);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);
		await sealed.barrier;

		// Act
		const earlyReceipt = await requirePendingGatewayDetachedDestroyAttempt(
			harness.coordinator,
		).attemptGatewayDetachedDestroy(gateway.gatewayIdentity);

		// Assert
		expect(earlyReceipt).toEqual(createDestroyReceipt(gatewayTarget, true));
		expect(harness.destroyExactMock).toHaveBeenCalledWith(gatewayTarget);
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({ state: 'sealed' });
		await expect(
			beginGateway(harness, {
				bootId: 'blocked-successor-boot',
				generationId: 'blocked-successor-generation',
				sessionLabel: 'blocked-successor-before-final-create-disposition',
			}),
		).rejects.toMatchObject({ code: 'gateway-already-current' });

		await harness.coordinator.recordGatewayDestroyReceipt(gateway.gatewayIdentity, earlyReceipt);
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({ state: 'destroyed' });
		await expect(
			beginGateway(harness, {
				bootId: 'admitted-successor-boot',
				generationId: 'admitted-successor-generation',
				sessionLabel: 'admitted-successor-after-final-create-disposition',
			}),
		).resolves.toMatchObject({
			gatewayIdentity: {
				bootId: 'admitted-successor-boot',
				generationId: 'admitted-successor-generation',
			},
		});
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
			principal: JSON.stringify(stableAgentTestPrincipal('main')),
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
				principal: stableAgentTestPrincipal('main'),
				reservationId: ownershipReservation.reservationId,
				reservationPath: ownershipReservation.reservationPath,
				role: 'tool',
				sessionLabel: 'sunfam-main-tool',
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

	it('durably fences a timed-out Tool target and blocks the parent Gateway destroy barrier', async () => {
		// Arrange
		const targetTimeout = new GatewayDestructionTimeoutError(
			'GATEWAY_DESTRUCTION_TARGET_TIMEOUT',
			"tool VM 'tool-vm-timeout'",
			60_000,
		);
		const lateClose = createDeferredPromise<ManagedVmDestroyReceiptV1>();
		const runTarget = vi.fn(
			async (_target: string, operation: () => Promise<unknown>): Promise<never> => {
				void operation();
				throw targetTimeout;
			},
		);
		const destructionBudget = {
			createSubtreeAttempt(): never {
				throw new Error('subtree attempt is not used by the coordinator target test');
			},
			runTarget,
		} satisfies GatewayDestructionBudget;
		const harness = await createCoordinatorHarness({ destructionBudget });
		const gateway = await beginGateway(harness);
		const tool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'target-timeout',
			expectedGateway: gateway.gatewayIdentity,
			sessionLabel: 'sunfam-target-timeout-tool',
		});
		const ownershipReservation = await tool.ready;
		const matchingReceipt = createDestroyReceipt(
			targetAt(harness, ownershipReservation.reservationPath),
			true,
		);
		const closeLiveVm = vi.fn(async () => await lateClose.promise);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);

		// Act
		const toolDestruction = tool.destroyLive(closeLiveVm);

		// Assert
		await expect(toolDestruction).rejects.toMatchObject({ code: 'owner-unsafe' });
		expect(runTarget).toHaveBeenCalledOnce();
		expect(closeLiveVm).toHaveBeenCalledOnce();
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [
				expect.objectContaining({
					observedReservationRevision: 1,
					state: 'owner-unsafe',
				}),
			],
			state: 'owner-unsafe',
		});
		expect(await promiseSettled(sealed.barrier)).toBe(false);

		const gatewayDestruction = harness.coordinator.destroyGatewayDetached(gateway.gatewayIdentity);
		expect(await promiseSettled(gatewayDestruction)).toBe(false);
		expect(harness.destroyExactMock).not.toHaveBeenCalled();

		lateClose.resolve(matchingReceipt);
		await Promise.resolve();
		await Promise.resolve();
		await expect(
			journalForHarness(harness).loadGatewayMembership(gateway.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [expect.objectContaining({ state: 'owner-unsafe' })],
			state: 'owner-unsafe',
		});
		expect(await promiseSettled(sealed.barrier)).toBe(false);
	});

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

	it('keeps owner-unsafe sticky after unavailable destruction even when a later exact receipt arrives', async () => {
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
		).rejects.toMatchObject({ code: 'owner-unsafe' });
		await expect(
			beginGateway(harness, { sessionLabel: 'sunfam-gateway-successor' }),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
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

	it('resolves an exact control identity to a cloned full current Gateway epoch', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness, {
			bootId: 'resolve-control-boot',
			generationId: 'resolve-control-generation',
		});

		// Act
		const resolved = harness.coordinator.resolveGatewayEpoch({
			bootId: gateway.gatewayIdentity.bootId,
			controllerEpoch: gateway.gatewayIdentity.controllerEpoch,
			zoneId: gateway.gatewayIdentity.zoneId,
		});

		// Assert
		expect(resolved).toEqual(gateway.gatewayIdentity);
		expect(resolved).not.toBe(gateway.gatewayIdentity);
		expect(resolved).toMatchObject({
			bootId: 'resolve-control-boot',
			controllerEpoch: CONTROLLER_EPOCH,
			gatewayEpochId: gateway.gatewayIdentity.gatewayEpochId,
			gatewayVmId: gateway.gatewayIdentity.gatewayVmId,
			generationId: 'resolve-control-generation',
			zoneId: ZONE_ID,
		});
		expect(harness.createReservationMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			mutate: (identity: GatewayEpochIdentity) => ({
				bootId: `${identity.bootId}-stale`,
				controllerEpoch: identity.controllerEpoch,
				zoneId: identity.zoneId,
			}),
			name: 'stale boot',
		},
		{
			mutate: (identity: GatewayEpochIdentity) => ({
				bootId: identity.bootId,
				controllerEpoch: `${identity.controllerEpoch}-stale`,
				zoneId: identity.zoneId,
			}),
			name: 'stale controller',
		},
		{
			mutate: (identity: GatewayEpochIdentity) => ({
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				zoneId: `${identity.zoneId}-wrong`,
			}),
			name: 'wrong zone',
		},
	] as const)(
		'rejects $name control identity resolution before leaf admission',
		async ({ mutate }) => {
			// Arrange
			const harness = await createCoordinatorHarness();
			const gateway = await beginGateway(harness);

			// Act / Assert
			expect(() =>
				harness.coordinator.resolveGatewayEpoch(mutate(gateway.gatewayIdentity)),
			).toThrow();
			expect(harness.createReservationMock).toHaveBeenCalledTimes(1);
		},
	);

	it('rejects control identity resolution for an owner-unsafe current Gateway before leaf admission', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const gateway = await beginGateway(harness);
		const sealed = harness.coordinator.sealGatewayEpoch(gateway.gatewayIdentity);
		await sealed.barrier;
		await expect(
			harness.coordinator.recordGatewayDestroyUnavailable(gateway.gatewayIdentity),
		).rejects.toMatchObject({ code: 'owner-unsafe' });

		// Act / Assert
		expect(() =>
			harness.coordinator.resolveGatewayEpoch({
				bootId: gateway.gatewayIdentity.bootId,
				controllerEpoch: gateway.gatewayIdentity.controllerEpoch,
				zoneId: gateway.gatewayIdentity.zoneId,
			}),
		).toThrowError(expect.objectContaining({ code: 'owner-unsafe' }));
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

	it.each([
		{
			fieldName: 'configPath',
			foreignDeploymentIdentity: {
				...TEST_DEPLOYMENT_IDENTITY,
				configPath: '/deployments/foreign/config/system.jsonc',
			},
		},
		{
			fieldName: 'controllerPort',
			foreignDeploymentIdentity: {
				...TEST_DEPLOYMENT_IDENTITY,
				controllerPort: 28_800,
			},
		},
		{
			fieldName: 'projectNamespace',
			foreignDeploymentIdentity: {
				...TEST_DEPLOYMENT_IDENTITY,
				projectNamespace: 'foreign-test-deployment',
			},
		},
	] satisfies readonly {
		readonly fieldName: keyof VmOwnershipDeploymentIdentity;
		readonly foreignDeploymentIdentity: VmOwnershipDeploymentIdentity;
	}[])(
		'refuses persisted Gateway and Tool membership with a foreign $fieldName before exact destruction',
		async ({ foreignDeploymentIdentity }) => {
			// Arrange
			const harness = await createCoordinatorHarness();
			const reservationRoot = path.join(harness.stateDirectory, 'vm-ownership', 'reservations');
			const gatewayIdentity = {
				bootId: 'foreign-deployment-gateway-boot',
				controllerEpoch: 'foreign-deployment-controller-epoch',
				gatewayEpochId: 'foreign-deployment-gateway-epoch',
				gatewayVmId: 'foreign-deployment-gateway-vm',
				generationId: 'foreign-deployment-gateway-generation',
				zoneId: ZONE_ID,
			} satisfies GatewayEpochIdentity;
			const gatewaySessionLabel = 'foreign-deployment-gateway';
			const toolSessionLabel = 'foreign-deployment-tool';
			const foreignGatewayPrincipal = {
				...foreignDeploymentIdentity,
				kind: 'gateway-zone' as const,
				zoneId: ZONE_ID,
			};
			const foreignToolPrincipal = {
				...foreignDeploymentIdentity,
				agentId: 'foreign-agent',
				kind: 'stable-agent' as const,
				zoneId: ZONE_ID,
			};
			const gatewayReservation = harness.persistCreatedReservation(
				createFakeReservation({
					controllerEpoch: gatewayIdentity.controllerEpoch,
					parentGateway: null,
					principal: JSON.stringify(foreignGatewayPrincipal),
					reservationId: 'foreign-deployment-gateway-reservation',
					reservationRoot,
					role: 'gateway',
					sessionLabel: gatewaySessionLabel,
					vmId: gatewayIdentity.gatewayVmId,
				}),
			);
			const toolReservation = harness.persistCreatedReservation(
				createFakeReservation({
					controllerEpoch: gatewayIdentity.controllerEpoch,
					parentGateway: {
						epoch: gatewayIdentity.gatewayEpochId,
						vmId: gatewayIdentity.gatewayVmId,
					},
					principal: JSON.stringify(foreignToolPrincipal),
					reservationId: 'foreign-deployment-tool-reservation',
					reservationRoot,
					role: 'tool',
					sessionLabel: toolSessionLabel,
					vmId: 'foreign-deployment-tool-vm',
				}),
			);
			const foreignMembership = {
				children: [
					{
						controllerEpoch: gatewayIdentity.controllerEpoch,
						expectedRevision: 1,
						observedReservationRevision: 1,
						parentGateway: {
							gatewayEpochId: gatewayIdentity.gatewayEpochId,
							gatewayVmId: gatewayIdentity.gatewayVmId,
						},
						principal: foreignToolPrincipal,
						reservationId: toolReservation.reservation.reservationId,
						reservationPath: toolReservation.reservationPath,
						role: 'tool' as const,
						sessionLabel: toolSessionLabel,
						state: 'provisional' as const,
						vmId: toolReservation.reservation.vmId,
					},
				],
				controllerEpoch: gatewayIdentity.controllerEpoch,
				createdAtMs: FIXED_NOW_MS,
				gateway: gatewayIdentity,
				gatewayReservation: {
					controllerEpoch: gatewayIdentity.controllerEpoch,
					expectedRevision: 1,
					parentGateway: null,
					principal: foreignGatewayPrincipal,
					reservationId: gatewayReservation.reservation.reservationId,
					reservationPath: gatewayReservation.reservationPath,
					role: 'gateway' as const,
					sessionLabel: gatewaySessionLabel,
					vmId: gatewayIdentity.gatewayVmId,
				},
				revision: 1,
				schemaVersion: 1 as const,
				state: 'admitting' as const,
				updatedAtMs: FIXED_NOW_MS,
			} satisfies GatewayMembershipRecord;
			const journal = journalForHarness(harness);
			await journal.createGatewayMembership({ ...foreignMembership, children: [] });
			await journal.replaceGatewayMembership({
				expectedRevision: 1,
				record: { ...foreignMembership, revision: 2 },
			});
			harness.listOwnershipReservationPathsMock.mockResolvedValue([
				gatewayReservation.reservationPath,
				toolReservation.reservationPath,
			]);
			const restartedCoordinator = createRestartedCoordinator(
				harness,
				'current-deployment-controller-epoch',
			);

			// Act / Assert
			await expect(
				restartedCoordinator.reconcileControllerStartup([ZONE_ID]),
			).rejects.toMatchObject({ code: 'owner-unsafe' });
			expect(harness.destroyExactMock).not.toHaveBeenCalled();
		},
	);

	it('reconciles every old child before its Gateway, durably retires the epoch, and adopts nothing', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const oldGateway = await beginGateway(harness);
		const oldTool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'main',
			expectedGateway: oldGateway.gatewayIdentity,
			sessionLabel: 'sunfam-main-tool',
		});
		await oldTool.ready;
		await oldTool.commitCurrent();
		const destroyOrder: string[] = [];
		harness.destroyExactMock.mockImplementation(
			async (target): Promise<ManagedVmDestroyReceiptV1> => {
				destroyOrder.push(`${target.role}:${target.vmId}`);
				return createDestroyReceipt(target, true);
			},
		);
		const restartedCoordinator = createRestartedCoordinator(harness, CONTROLLER_EPOCH);

		// Act
		await restartedCoordinator.reconcileControllerStartup([ZONE_ID]);

		// Assert
		expect(destroyOrder).toEqual([
			`tool:${reservationOptionsAt(harness.createReservationMock, 1).vmId}`,
			`gateway:${oldGateway.gatewayIdentity.gatewayVmId}`,
		]);
		const durableMembership = await journalForHarness(harness).loadGatewayMembership(
			oldGateway.gatewayIdentity.gatewayEpochId,
		);
		expect(durableMembership).toMatchObject({
			children: [expect.objectContaining({ state: 'destroyed' })],
			state: 'destroyed',
		});
		expect(() =>
			restartedCoordinator.resolveGatewayEpoch({
				bootId: oldGateway.gatewayIdentity.bootId,
				controllerEpoch: oldGateway.gatewayIdentity.controllerEpoch,
				zoneId: oldGateway.gatewayIdentity.zoneId,
			}),
		).toThrowError(expect.objectContaining({ code: 'gateway-not-current' }));
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'successor-boot',
				generationId: 'successor-generation',
				sessionLabel: 'sunfam-successor',
				zoneId: ZONE_ID,
			}),
		).resolves.toMatchObject({
			gatewayIdentity: expect.objectContaining({
				bootId: 'successor-boot',
				controllerEpoch: CONTROLLER_EPOCH,
			}),
		});
	});

	it('rejects a concurrent successor side-effect-free until startup reconciliation settles', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const oldGateway = await beginGateway(harness);
		const oldTool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'main',
			expectedGateway: oldGateway.gatewayIdentity,
			sessionLabel: 'sunfam-main-tool',
		});
		await oldTool.ready;
		await oldTool.commitCurrent();
		const firstDestroyStarted = createDeferredPromise<void>();
		const permitFirstDestroy = createDeferredPromise<void>();
		let destroyCount = 0;
		harness.destroyExactMock.mockImplementation(async (target) => {
			destroyCount += 1;
			if (destroyCount === 1) {
				firstDestroyStarted.resolve(undefined);
				await permitFirstDestroy.promise;
			}
			return createDestroyReceipt(target, true);
		});
		const restartedCoordinator = createRestartedCoordinator(
			harness,
			'controller-epoch-after-restart',
		);
		const reservationCountBeforeReconciliation = harness.createReservationMock.mock.calls.length;

		// Act
		const reconciliation = restartedCoordinator.reconcileControllerStartup([ZONE_ID]);
		await firstDestroyStarted.promise;
		const concurrentBeginOutcome = await restartedCoordinator
			.beginGatewayEpoch({
				bootId: 'premature-successor-boot',
				generationId: 'premature-successor-generation',
				sessionLabel: 'premature-successor',
				zoneId: ZONE_ID,
			})
			.then(
				() => ({ kind: 'resolved' as const }),
				(error: unknown) => ({ error, kind: 'rejected' as const }),
			);
		permitFirstDestroy.resolve(undefined);
		const reconciliationOutcome = await reconciliation.then(
			() => ({ kind: 'resolved' as const }),
			(error: unknown) => ({ error, kind: 'rejected' as const }),
		);

		// Assert
		expect(concurrentBeginOutcome).toMatchObject({
			error: expect.objectContaining({ code: 'startup-reconciliation-in-progress' }),
			kind: 'rejected',
		});
		expect(harness.createReservationMock).toHaveBeenCalledTimes(
			reservationCountBeforeReconciliation,
		);
		expect(reconciliationOutcome).toEqual({ kind: 'resolved' });
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'successor-after-reconciliation-boot',
				generationId: 'successor-after-reconciliation-generation',
				sessionLabel: 'successor-after-reconciliation',
				zoneId: ZONE_ID,
			}),
		).resolves.toMatchObject({
			gatewayIdentity: expect.objectContaining({
				bootId: 'successor-after-reconciliation-boot',
				controllerEpoch: 'controller-epoch-after-restart',
			}),
		});
	});

	it('rejects overlapping startup reconciliation without mutating the in-flight reconciliation', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const oldGateway = await beginGateway(harness);
		const oldTool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'main',
			expectedGateway: oldGateway.gatewayIdentity,
			sessionLabel: 'sunfam-main-tool',
		});
		await oldTool.ready;
		const firstDestroyStarted = createDeferredPromise<void>();
		const permitFirstDestroy = createDeferredPromise<void>();
		let destroyCount = 0;
		harness.destroyExactMock.mockImplementation(async (target) => {
			destroyCount += 1;
			if (destroyCount === 1) {
				firstDestroyStarted.resolve(undefined);
				await permitFirstDestroy.promise;
			}
			return createDestroyReceipt(target, true);
		});
		const restartedCoordinator = createRestartedCoordinator(
			harness,
			'controller-epoch-after-restart',
		);

		// Act
		const firstReconciliation = restartedCoordinator.reconcileControllerStartup([ZONE_ID]);
		await firstDestroyStarted.promise;
		const overlappingOutcome = await restartedCoordinator
			.reconcileControllerStartup([ZONE_ID])
			.then(
				() => ({ kind: 'resolved' as const }),
				(error: unknown) => ({ error, kind: 'rejected' as const }),
			);
		const disjointZoneId = 'sunfam-disjoint-reconciliation';
		const disjointOutcome = await restartedCoordinator
			.reconcileControllerStartup([disjointZoneId])
			.then(
				() => ({ kind: 'resolved' as const }),
				(error: unknown) => ({ error, kind: 'rejected' as const }),
			);
		permitFirstDestroy.resolve(undefined);
		const firstOutcome = await firstReconciliation.then(
			() => ({ kind: 'resolved' as const }),
			(error: unknown) => ({ error, kind: 'rejected' as const }),
		);

		// Assert
		expect(overlappingOutcome).toMatchObject({
			error: expect.objectContaining({ code: 'startup-reconciliation-in-progress' }),
			kind: 'rejected',
		});
		expect(disjointOutcome).toMatchObject({
			error: expect.objectContaining({ code: 'startup-reconciliation-in-progress' }),
			kind: 'rejected',
		});
		expect(harness.stateDirectoryForZoneMock).not.toHaveBeenCalledWith(disjointZoneId);
		expect(firstOutcome).toEqual({ kind: 'resolved' });
		expect(destroyCount).toBe(2);
	});

	it('rejects duplicate startup reconciliation zones before reading or mutating ownership state', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const restartedCoordinator = createRestartedCoordinator(
			harness,
			'controller-epoch-after-restart',
		);

		// Act / Assert
		await expect(
			restartedCoordinator.reconcileControllerStartup([ZONE_ID, ZONE_ID]),
		).rejects.toMatchObject({ code: 'startup-reconciliation-in-progress' });
		expect(harness.stateDirectoryForZoneMock).not.toHaveBeenCalled();
		expect(harness.listOwnershipReservationPathsMock).not.toHaveBeenCalled();
		expect(harness.destroyExactMock).not.toHaveBeenCalled();
		await expect(
			restartedCoordinator.reconcileControllerStartup([ZONE_ID]),
		).resolves.toBeUndefined();
	});

	it('clears the startup reconciliation fence after reconciliation rejects', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		await beginGateway(harness);
		harness.destroyExactMock.mockRejectedValue(new Error('startup exact destroy failed'));
		const restartedCoordinator = createRestartedCoordinator(
			harness,
			'controller-epoch-after-restart',
		);

		// Act
		await expect(restartedCoordinator.reconcileControllerStartup([ZONE_ID])).rejects.toMatchObject({
			code: 'owner-unsafe',
		});

		// Assert
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'successor-after-failed-reconciliation',
				generationId: 'successor-after-failed-reconciliation',
				sessionLabel: 'successor-after-failed-reconciliation',
				zoneId: ZONE_ID,
			}),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
	});

	it('attempts every old child and durably aggregates failures before refusing Gateway destruction', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const oldGateway = await beginGateway(harness);
		const currentTool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'current-agent',
			expectedGateway: oldGateway.gatewayIdentity,
			sessionLabel: 'sunfam-current-tool',
		});
		const currentReservation = await currentTool.ready;
		await currentTool.commitCurrent();
		const provisionalTool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'provisional-agent',
			expectedGateway: oldGateway.gatewayIdentity,
			sessionLabel: 'sunfam-provisional-tool',
		});
		const provisionalReservation = await provisionalTool.ready;
		const currentTarget = targetAt(harness, currentReservation.reservationPath);
		const provisionalTarget = targetAt(harness, provisionalReservation.reservationPath);
		const currentDestroyFailure = new Error('current child exact destroy failed');
		const provisionalDestroyFailure = new Error('provisional child exact destroy failed');
		const attemptedVmIds: string[] = [];
		harness.destroyExactMock.mockImplementation(async (target) => {
			attemptedVmIds.push(target.vmId);
			if (target.vmId === currentTarget.vmId) {
				throw currentDestroyFailure;
			}
			if (target.vmId === provisionalTarget.vmId) {
				throw provisionalDestroyFailure;
			}
			return createDestroyReceipt(target, true);
		});
		const restartedCoordinator = createRestartedCoordinator(harness, CONTROLLER_EPOCH);
		let reconciliationError: unknown;

		// Act
		try {
			await restartedCoordinator.reconcileControllerStartup([ZONE_ID]);
		} catch (error) {
			reconciliationError = error;
		}

		// Assert
		expect(reconciliationError).toMatchObject({ code: 'owner-unsafe' });
		expect(errorTreeContainsExactError(reconciliationError, currentDestroyFailure)).toBe(true);
		expect(errorTreeContainsExactError(reconciliationError, provisionalDestroyFailure)).toBe(true);
		expect(attemptedVmIds).toEqual([currentTarget.vmId, provisionalTarget.vmId]);
		expect(attemptedVmIds).not.toContain(oldGateway.gatewayIdentity.gatewayVmId);
		const durableMembership = await journalForHarness(harness).loadGatewayMembership(
			oldGateway.gatewayIdentity.gatewayEpochId,
		);
		expect(durableMembership).toMatchObject({
			children: expect.arrayContaining([
				expect.objectContaining({
					reservationId: currentReservation.reservationId,
					state: 'owner-unsafe',
				}),
				expect.objectContaining({
					reservationId: provisionalReservation.reservationId,
					state: 'owner-unsafe',
				}),
			]),
			state: 'owner-unsafe',
		});
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'forbidden-successor-after-aggregate-child-failure',
				generationId: 'forbidden-successor-generation',
				sessionLabel: 'forbidden-successor',
				zoneId: ZONE_ID,
			}),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
	});

	it('attempts every independent old zone before returning startup reconciliation refusal', async () => {
		// Arrange
		const unsafeZoneId = 'sunfam-unsafe';
		const healthyZoneId = 'sunfam-healthy';
		const unsafeHarness = await createCoordinatorHarness();
		const healthyHarness = await createCoordinatorHarness();
		const unsafeGateway = await beginGateway(unsafeHarness, {
			bootId: 'unsafe-old-boot',
			generationId: 'unsafe-old-generation',
			sessionLabel: 'unsafe-old-gateway',
			zoneId: unsafeZoneId,
		});
		const healthyGateway = await beginGateway(healthyHarness, {
			bootId: 'healthy-old-boot',
			generationId: 'healthy-old-generation',
			sessionLabel: 'healthy-old-gateway',
			zoneId: healthyZoneId,
		});
		const unsafeDestroyFailure = new Error('unsafe zone exact Gateway destroy failed');
		const destroyExactMock = vi.fn(
			async (target: ManagedVmDestroyTargetV1): Promise<ManagedVmDestroyReceiptV1> => {
				if (target.reservationPath === unsafeGateway.ownershipReservation.reservationPath) {
					throw unsafeDestroyFailure;
				}
				return createDestroyReceipt(target, true);
			},
		);
		const reservationByPath = new Map([
			...unsafeHarness.reservationByPath,
			...healthyHarness.reservationByPath,
		]);
		const targetByPath = new Map([...unsafeHarness.targetByPath, ...healthyHarness.targetByPath]);
		const restartedCoordinator = createGatewayOwnershipCoordinator({
			controllerEpoch: 'controller-epoch-after-multi-zone-restart',
			createId: vi.fn(() => 'unused-reconciliation-id'),
			createManagedVmOwnershipReservation: vi.fn(),
			deploymentIdentity: TEST_DEPLOYMENT_IDENTITY,
			destroyManagedVmExact: destroyExactMock,
			nowMs: () => FIXED_NOW_MS,
			readManagedVmDestroyTarget: vi.fn(async (reservationPath: string) => {
				const target = targetByPath.get(reservationPath);
				if (target === undefined) {
					throw new Error(`missing fake destroy target: ${reservationPath}`);
				}
				return structuredClone(target);
			}),
			readManagedVmOwnershipReservation: vi.fn(async (reservationPath: string) => {
				const reservation = reservationByPath.get(reservationPath);
				if (reservation === undefined) {
					throw new Error(`missing fake ownership reservation: ${reservationPath}`);
				}
				return structuredClone(reservation);
			}),
			stateDirectoryForZone: (zoneId): string => {
				if (zoneId === unsafeZoneId) {
					return unsafeHarness.stateDirectory;
				}
				if (zoneId === healthyZoneId) {
					return healthyHarness.stateDirectory;
				}
				throw new Error(`unexpected zone: ${zoneId}`);
			},
		});
		let reconciliationError: unknown;

		// Act
		try {
			await restartedCoordinator.reconcileControllerStartup([unsafeZoneId, healthyZoneId]);
		} catch (error) {
			reconciliationError = error;
		}

		// Assert
		expect(reconciliationError).toMatchObject({ code: 'owner-unsafe' });
		expect(errorTreeContainsExactError(reconciliationError, unsafeDestroyFailure)).toBe(true);
		expect(destroyExactMock).toHaveBeenCalledWith(
			expect.objectContaining({ vmId: unsafeGateway.gatewayIdentity.gatewayVmId }),
		);
		expect(destroyExactMock).toHaveBeenCalledWith(
			expect.objectContaining({ vmId: healthyGateway.gatewayIdentity.gatewayVmId }),
		);
		await expect(
			journalForHarness(unsafeHarness).loadGatewayMembership(
				unsafeGateway.gatewayIdentity.gatewayEpochId,
			),
		).resolves.toMatchObject({ state: 'owner-unsafe' });
		await expect(
			journalForHarness(healthyHarness).loadGatewayMembership(
				healthyGateway.gatewayIdentity.gatewayEpochId,
			),
		).resolves.toMatchObject({ state: 'destroyed' });
	});

	it('fails closed without reading destroy targets when one zone has malformed membership while reconciling an independent safe zone', async () => {
		// Arrange
		const unsafeZoneId = 'sunfam-malformed-membership';
		const safeZoneId = 'sunfam-safe-membership';
		const unsafeHarness = await createCoordinatorHarness();
		const safeHarness = await createCoordinatorHarness();
		const unsafeGateway = await beginGateway(unsafeHarness, {
			bootId: 'unsafe-malformed-membership-boot',
			generationId: 'unsafe-malformed-membership-generation',
			sessionLabel: 'unsafe-malformed-membership-gateway',
			zoneId: unsafeZoneId,
		});
		const safeGateway = await beginGateway(safeHarness, {
			bootId: 'safe-membership-boot',
			generationId: 'safe-membership-generation',
			sessionLabel: 'safe-membership-gateway',
			zoneId: safeZoneId,
		});
		await writeFile(
			journalForHarness(unsafeHarness).membershipPathForTesting(
				unsafeGateway.gatewayIdentity.gatewayEpochId,
			),
			'{"contractVersion":',
			'utf8',
		);
		const reservationByPath = new Map([
			...unsafeHarness.reservationByPath,
			...safeHarness.reservationByPath,
		]);
		const targetByPath = new Map([...unsafeHarness.targetByPath, ...safeHarness.targetByPath]);
		const unsafeReservationRoot = path.join(
			unsafeHarness.stateDirectory,
			'vm-ownership',
			'reservations',
		);
		const safeReservationRoot = path.join(
			safeHarness.stateDirectory,
			'vm-ownership',
			'reservations',
		);
		const listReservationPathsMock = vi.fn(
			async (reservationRoot: string): Promise<readonly string[]> => {
				if (reservationRoot === unsafeReservationRoot) {
					return [...unsafeHarness.reservationByPath.keys()];
				}
				if (reservationRoot === safeReservationRoot) {
					return [...safeHarness.reservationByPath.keys()];
				}
				throw new Error(`unexpected reservation root: ${reservationRoot}`);
			},
		);
		const readDestroyTargetMock = vi.fn(async (reservationPath: string) => {
			const target = targetByPath.get(reservationPath);
			if (target === undefined) {
				throw new Error(`missing fake destroy target: ${reservationPath}`);
			}
			return structuredClone(target);
		});
		const destroyExactMock = vi.fn(
			async (target: ManagedVmDestroyTargetV1): Promise<ManagedVmDestroyReceiptV1> =>
				createDestroyReceipt(target, true),
		);
		const restartedCoordinator = createGatewayOwnershipCoordinator({
			controllerEpoch: 'controller-epoch-after-malformed-membership',
			createId: vi.fn(() => 'unused-reconciliation-id'),
			createManagedVmOwnershipReservation: vi.fn(),
			deploymentIdentity: TEST_DEPLOYMENT_IDENTITY,
			destroyManagedVmExact: destroyExactMock,
			listManagedVmOwnershipReservationPaths: listReservationPathsMock,
			nowMs: () => FIXED_NOW_MS,
			readManagedVmDestroyTarget: readDestroyTargetMock,
			readManagedVmOwnershipReservation: vi.fn(async (reservationPath: string) => {
				const reservation = reservationByPath.get(reservationPath);
				if (reservation === undefined) {
					throw new Error(`missing fake ownership reservation: ${reservationPath}`);
				}
				return structuredClone(reservation);
			}),
			stateDirectoryForZone: (zoneId): string => {
				if (zoneId === unsafeZoneId) {
					return unsafeHarness.stateDirectory;
				}
				if (zoneId === safeZoneId) {
					return safeHarness.stateDirectory;
				}
				throw new Error(`unexpected zone: ${zoneId}`);
			},
		});

		// Act
		const reconciliationError = await restartedCoordinator
			.reconcileControllerStartup([unsafeZoneId, safeZoneId])
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		// Assert
		expect(reconciliationError).toMatchObject({ code: 'owner-unsafe' });
		expect(listReservationPathsMock).not.toHaveBeenCalledWith(unsafeReservationRoot);
		expect(readDestroyTargetMock).not.toHaveBeenCalledWith(
			unsafeGateway.ownershipReservation.reservationPath,
		);
		expect(destroyExactMock).not.toHaveBeenCalledWith(
			expect.objectContaining({
				reservationPath: unsafeGateway.ownershipReservation.reservationPath,
			}),
		);
		expect(readDestroyTargetMock).toHaveBeenCalledWith(
			safeGateway.ownershipReservation.reservationPath,
		);
		expect(destroyExactMock).toHaveBeenCalledWith(
			expect.objectContaining({
				reservationPath: safeGateway.ownershipReservation.reservationPath,
			}),
		);
		await expect(
			journalForHarness(safeHarness).loadGatewayMembership(
				safeGateway.gatewayIdentity.gatewayEpochId,
			),
		).resolves.toMatchObject({ state: 'destroyed' });
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'forbidden-unsafe-successor-boot',
				generationId: 'forbidden-unsafe-successor-generation',
				sessionLabel: 'forbidden-unsafe-successor',
				zoneId: unsafeZoneId,
			}),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
	});

	it('exact-destroys an orphan Gateway reservation before admitting a successor', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const orphanGateway = createOrphanReservation(harness, {
			controllerEpoch: 'controller-epoch-before-membership-registration',
			parentGateway: null,
			principal: JSON.stringify(gatewayTestPrincipal()),
			reservationId: 'orphan-gateway-reservation',
			role: 'gateway',
			sessionLabel: 'sunfam-orphan-gateway',
			vmId: 'orphan-gateway-vm',
		});
		const restartedCoordinator = createRestartedCoordinator(
			harness,
			'controller-epoch-after-orphan-gateway',
		);

		// Act
		await restartedCoordinator.reconcileControllerStartup([ZONE_ID]);
		const successor = await restartedCoordinator.beginGatewayEpoch({
			bootId: 'successor-after-orphan-gateway-boot',
			generationId: 'successor-after-orphan-gateway-generation',
			sessionLabel: 'successor-after-orphan-gateway',
			zoneId: ZONE_ID,
		});

		// Assert
		expect(harness.listOwnershipReservationPathsMock).toHaveBeenCalledWith(
			path.join(harness.stateDirectory, 'vm-ownership', 'reservations'),
		);
		expect(harness.destroyExactMock).toHaveBeenCalledWith(orphanGateway.target);
		expect(harness.destroyExactMock.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			harness.createReservationMock.mock.invocationCallOrder[0] ?? 0,
		);
		expect(successor.gatewayIdentity.gatewayVmId).not.toBe(orphanGateway.target.vmId);
	});

	it('exact-destroys an unreferenced orphan Tool reservation before its parent Gateway and successor', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const oldGateway = await beginGateway(harness);
		const orphanTool = createOrphanReservation(harness, {
			controllerEpoch: oldGateway.gatewayIdentity.controllerEpoch,
			parentGateway: {
				epoch: oldGateway.gatewayIdentity.gatewayEpochId,
				vmId: oldGateway.gatewayIdentity.gatewayVmId,
			},
			principal: JSON.stringify(stableAgentTestPrincipal('orphan')),
			reservationId: 'orphan-tool-reservation',
			role: 'tool',
			sessionLabel: 'sunfam-orphan-tool',
			vmId: 'orphan-tool-vm',
		});
		const restartedCoordinator = createRestartedCoordinator(
			harness,
			'controller-epoch-after-orphan-tool',
		);
		const destroyedVmIds: string[] = [];
		harness.destroyExactMock.mockImplementation(async (target) => {
			destroyedVmIds.push(target.vmId);
			return createDestroyReceipt(target, true);
		});

		// Act
		await restartedCoordinator.reconcileControllerStartup([ZONE_ID]);
		await restartedCoordinator.beginGatewayEpoch({
			bootId: 'successor-after-orphan-tool-boot',
			generationId: 'successor-after-orphan-tool-generation',
			sessionLabel: 'successor-after-orphan-tool',
			zoneId: ZONE_ID,
		});

		// Assert
		expect(destroyedVmIds).toEqual([
			orphanTool.target.vmId,
			oldGateway.gatewayIdentity.gatewayVmId,
		]);
	});

	it.each(['malformed', 'mismatched'] as const)(
		'refuses successor admission when orphan Gateway evidence is %s',
		async (evidenceKind) => {
			// Arrange
			const harness = await createCoordinatorHarness();
			const orphanGateway = createOrphanReservation(harness, {
				controllerEpoch: 'controller-epoch-before-ambiguous-orphan',
				parentGateway: null,
				principal: JSON.stringify(gatewayTestPrincipal()),
				reservationId: `ambiguous-${evidenceKind}-orphan-gateway-reservation`,
				role: 'gateway',
				sessionLabel: `sunfam-${evidenceKind}-orphan-gateway`,
				vmId: `ambiguous-${evidenceKind}-orphan-gateway-vm`,
			});
			if (evidenceKind === 'malformed') {
				harness.readOwnershipReservationMock.mockRejectedValueOnce(
					new Error('orphan Gateway reservation is malformed'),
				);
			} else {
				harness.reservationByPath.set(orphanGateway.reservationPath, {
					...orphanGateway.reservation,
					reservationId: `${orphanGateway.reservation.reservationId}-mismatch`,
				});
			}
			const restartedCoordinator = createRestartedCoordinator(
				harness,
				'controller-epoch-after-ambiguous-orphan',
			);

			// Act / Assert
			await expect(
				restartedCoordinator.reconcileControllerStartup([ZONE_ID]),
			).rejects.toMatchObject({ code: 'owner-unsafe' });
			expect(harness.destroyExactMock).not.toHaveBeenCalled();
			await expect(
				restartedCoordinator.beginGatewayEpoch({
					bootId: `forbidden-${evidenceKind}-orphan-successor-boot`,
					generationId: `forbidden-${evidenceKind}-orphan-successor-generation`,
					sessionLabel: `forbidden-${evidenceKind}-orphan-successor`,
					zoneId: ZONE_ID,
				}),
			).rejects.toMatchObject({ code: 'owner-unsafe' });
		},
	);

	it('refuses parent destruction and successor admission when orphan Tool destruction is incomplete', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const oldGateway = await beginGateway(harness);
		const orphanTool = createOrphanReservation(harness, {
			controllerEpoch: oldGateway.gatewayIdentity.controllerEpoch,
			parentGateway: {
				epoch: oldGateway.gatewayIdentity.gatewayEpochId,
				vmId: oldGateway.gatewayIdentity.gatewayVmId,
			},
			principal: JSON.stringify(stableAgentTestPrincipal('orphan')),
			reservationId: 'incomplete-orphan-tool-reservation',
			role: 'tool',
			sessionLabel: 'sunfam-incomplete-orphan-tool',
			vmId: 'incomplete-orphan-tool-vm',
		});
		harness.destroyExactMock.mockImplementation(async (target) =>
			createDestroyReceipt(target, target.vmId !== orphanTool.target.vmId),
		);
		const restartedCoordinator = createRestartedCoordinator(
			harness,
			'controller-epoch-after-incomplete-orphan-tool',
		);

		// Act / Assert
		await expect(restartedCoordinator.reconcileControllerStartup([ZONE_ID])).rejects.toMatchObject({
			code: 'owner-unsafe',
		});
		expect(harness.destroyExactMock).toHaveBeenCalledWith(orphanTool.target);
		expect(harness.destroyExactMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ vmId: oldGateway.gatewayIdentity.gatewayVmId }),
		);
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'forbidden-incomplete-orphan-tool-successor-boot',
				generationId: 'forbidden-incomplete-orphan-tool-successor-generation',
				sessionLabel: 'forbidden-incomplete-orphan-tool-successor',
				zoneId: ZONE_ID,
			}),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
	});

	it('exact-destroys a prior-controller standalone reservation during startup', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const standaloneReservationRoot = path.join(
			harness.stateDirectory,
			'deployment-runtime',
			'vm-ownership',
			'standalone-reservations',
		);
		const standaloneReservation = createStandaloneOrphanReservation(
			harness,
			standaloneReservationRoot,
			{
				controllerEpoch: 'prior-controller-epoch',
				parentGateway: null,
				principal: JSON.stringify(workerTaskTestPrincipal('prior-worker-task')),
				reservationId: 'prior-controller-standalone-reservation',
				role: 'standalone',
				sessionLabel: 'prior-controller-worker-task',
				vmId: 'prior-controller-standalone-vm',
			},
		);
		harness.listOwnershipReservationPathsMock.mockImplementation(async (reservationRoot) =>
			reservationRoot === standaloneReservationRoot ? [standaloneReservation.reservationPath] : [],
		);
		const restartedCoordinator = createRestartedCoordinator(harness, 'current-controller-epoch', {
			standaloneReservationRoot,
		});

		// Act
		await restartedCoordinator.reconcileControllerStartup([ZONE_ID]);

		// Assert
		expect(harness.listOwnershipReservationPathsMock).toHaveBeenCalledWith(
			standaloneReservationRoot,
		);
		expect(harness.destroyExactMock).toHaveBeenCalledWith(standaloneReservation.target);
	});

	it('scopes standalone cleanup to the selected zone without reading or destroying a sibling target', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const selectedZoneId = 'selected-zone';
		const siblingZoneId = 'sibling-zone';
		const standaloneReservationRoot = path.join(
			harness.stateDirectory,
			'deployment-runtime',
			'vm-ownership',
			'standalone-reservations',
		);
		const selectedReservation = createStandaloneOrphanReservation(
			harness,
			standaloneReservationRoot,
			{
				controllerEpoch: 'prior-selected-controller-epoch',
				parentGateway: null,
				principal: JSON.stringify(workerTaskTestPrincipal('selected-worker-task', selectedZoneId)),
				reservationId: 'selected-standalone-reservation',
				role: 'standalone',
				sessionLabel: 'selected-standalone-worker-task',
				vmId: 'selected-standalone-vm',
			},
		);
		const siblingReservation = createStandaloneOrphanReservation(
			harness,
			standaloneReservationRoot,
			{
				controllerEpoch: 'prior-sibling-controller-epoch',
				parentGateway: null,
				principal: JSON.stringify(workerTaskTestPrincipal('sibling-worker-task', siblingZoneId)),
				reservationId: 'sibling-standalone-reservation',
				role: 'standalone',
				sessionLabel: 'sibling-standalone-worker-task',
				vmId: 'sibling-standalone-vm',
			},
		);
		harness.listOwnershipReservationPathsMock.mockResolvedValue([
			selectedReservation.reservationPath,
			siblingReservation.reservationPath,
		]);
		const restartedCoordinator = createRestartedCoordinator(
			harness,
			'current-selected-controller-epoch',
			{ standaloneReservationRoot },
		);

		// Act
		await restartedCoordinator.reconcileControllerStartup([], {
			standaloneZoneId: selectedZoneId,
		});

		// Assert
		expect(harness.readOwnershipReservationMock).toHaveBeenCalledWith(
			selectedReservation.reservationPath,
		);
		expect(harness.readOwnershipReservationMock).toHaveBeenCalledWith(
			siblingReservation.reservationPath,
		);
		expect(harness.readDestroyTargetMock).toHaveBeenCalledWith(selectedReservation.reservationPath);
		expect(harness.readDestroyTargetMock).not.toHaveBeenCalledWith(
			siblingReservation.reservationPath,
		);
		expect(harness.destroyExactMock).toHaveBeenCalledOnce();
		expect(harness.destroyExactMock).toHaveBeenCalledWith(selectedReservation.target);
		expect(harness.destroyExactMock).not.toHaveBeenCalledWith(siblingReservation.target);
	});

	it.each(['malformed', 'mismatched', 'incomplete'] as const)(
		'refuses startup for %s standalone evidence while still reconciling an unrelated OpenClaw zone',
		async (evidenceKind) => {
			// Arrange
			const harness = await createCoordinatorHarness();
			const oldGateway = await beginGateway(harness);
			const standaloneReservationRoot = path.join(
				harness.stateDirectory,
				'deployment-runtime',
				'vm-ownership',
				'standalone-reservations',
			);
			const standaloneReservation = createStandaloneOrphanReservation(
				harness,
				standaloneReservationRoot,
				{
					controllerEpoch: 'prior-controller-epoch',
					parentGateway: null,
					principal: JSON.stringify(workerTaskTestPrincipal(`${evidenceKind}-worker-task`)),
					reservationId: `${evidenceKind}-standalone-reservation`,
					role: 'standalone',
					sessionLabel: `${evidenceKind}-standalone-worker-task`,
					vmId: `${evidenceKind}-standalone-vm`,
				},
			);
			harness.listOwnershipReservationPathsMock.mockImplementation(async (reservationRoot) =>
				reservationRoot === standaloneReservationRoot
					? [standaloneReservation.reservationPath]
					: [],
			);
			if (evidenceKind === 'malformed') {
				harness.readOwnershipReservationMock.mockImplementation(async (reservationPath) => {
					if (reservationPath === standaloneReservation.reservationPath) {
						throw new Error('standalone reservation is malformed');
					}
					return structuredClone(reservationAt(harness, reservationPath));
				});
			} else if (evidenceKind === 'mismatched') {
				harness.reservationByPath.set(standaloneReservation.reservationPath, {
					...standaloneReservation.reservation,
					reservationId: `${standaloneReservation.reservation.reservationId}-mismatch`,
				});
			} else {
				harness.destroyExactMock.mockImplementation(async (target) =>
					createDestroyReceipt(
						target,
						target.reservationPath !== standaloneReservation.reservationPath,
					),
				);
			}
			const restartedCoordinator = createRestartedCoordinator(harness, 'current-controller-epoch', {
				standaloneReservationRoot,
			});

			// Act / Assert
			await expect(
				restartedCoordinator.reconcileControllerStartup([ZONE_ID], {
					standaloneZoneId: ZONE_ID,
				}),
			).rejects.toMatchObject({ code: 'owner-unsafe' });
			expect(harness.destroyExactMock).toHaveBeenCalledWith(
				expect.objectContaining({ vmId: oldGateway.gatewayIdentity.gatewayVmId }),
			);
			if (evidenceKind === 'incomplete') {
				expect(harness.destroyExactMock).toHaveBeenCalledWith(standaloneReservation.target);
			} else {
				expect(harness.destroyExactMock).not.toHaveBeenCalledWith(standaloneReservation.target);
			}
		},
	);

	it('skips a durably destroyed old epoch during startup reconciliation', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const oldGateway = await beginGateway(harness);
		const sealed = harness.coordinator.sealGatewayEpoch(oldGateway.gatewayIdentity);
		await sealed.barrier;
		await harness.coordinator.destroyGatewayDetached(oldGateway.gatewayIdentity);
		const durableBeforeRestart = await journalForHarness(harness).loadGatewayMembership(
			oldGateway.gatewayIdentity.gatewayEpochId,
		);
		expect(durableBeforeRestart.state).toBe('destroyed');
		harness.destroyExactMock.mockClear();
		const restartedCoordinator = createRestartedCoordinator(harness);

		// Act
		await restartedCoordinator.reconcileControllerStartup([ZONE_ID]);

		// Assert
		expect(harness.destroyExactMock).not.toHaveBeenCalled();
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'successor-after-destroyed-boot',
				generationId: 'successor-after-destroyed-generation',
				sessionLabel: 'sunfam-successor-after-destroyed',
				zoneId: ZONE_ID,
			}),
		).resolves.toBeDefined();
	});

	it('fences successor creation when startup reconciliation cannot parse old reservation evidence', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const oldGateway = await beginGateway(harness);
		const reservationReadFailure = new Error('old ownership reservation is malformed');
		harness.readOwnershipReservationMock.mockRejectedValueOnce(reservationReadFailure);
		const restartedCoordinator = createRestartedCoordinator(harness);

		// Act / Assert
		await expect(restartedCoordinator.reconcileControllerStartup([ZONE_ID])).rejects.toMatchObject({
			code: 'owner-unsafe',
			cause: reservationReadFailure,
		});
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'forbidden-successor-boot',
				generationId: 'forbidden-successor-generation',
				sessionLabel: 'forbidden-successor',
				zoneId: oldGateway.gatewayIdentity.zoneId,
			}),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
	});

	it('fences successor creation when old reservation and destroy-target identities mismatch', async () => {
		// Arrange
		const harness = await createCoordinatorHarness();
		const oldGateway = await beginGateway(harness);
		const gatewayTarget = targetAt(harness, oldGateway.ownershipReservation.reservationPath);
		harness.targetByPath.set(oldGateway.ownershipReservation.reservationPath, {
			...gatewayTarget,
			sessionLabel: `${gatewayTarget.sessionLabel}-mismatched`,
		});
		const restartedCoordinator = createRestartedCoordinator(harness);

		// Act / Assert
		await expect(restartedCoordinator.reconcileControllerStartup([ZONE_ID])).rejects.toMatchObject({
			code: 'owner-unsafe',
		});
		expect(harness.destroyExactMock).not.toHaveBeenCalled();
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'forbidden-successor-boot',
				generationId: 'forbidden-successor-generation',
				sessionLabel: 'forbidden-successor',
				zoneId: oldGateway.gatewayIdentity.zoneId,
			}),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
	});

	it('persists Gateway ownership as unsafe when its startup destruction receipt is unproven', async () => {
		// Arrange
		const harness = await createCoordinatorHarness({ destroyComplete: false });
		const oldGateway = await beginGateway(harness);
		const restartedCoordinator = createRestartedCoordinator(harness);

		// Act / Assert
		await expect(restartedCoordinator.reconcileControllerStartup([ZONE_ID])).rejects.toMatchObject({
			code: 'owner-unsafe',
		});
		expect(harness.destroyExactMock).toHaveBeenCalledOnce();
		const durableMembership = await journalForHarness(harness).loadGatewayMembership(
			oldGateway.gatewayIdentity.gatewayEpochId,
		);
		expect(durableMembership.state).toBe('owner-unsafe');
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'forbidden-successor-boot',
				generationId: 'forbidden-successor-generation',
				sessionLabel: 'forbidden-successor',
				zoneId: oldGateway.gatewayIdentity.zoneId,
			}),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
	});

	it('persists the affected child disposition when startup child destruction is unproven', async () => {
		// Arrange
		const harness = await createCoordinatorHarness({ destroyComplete: false });
		const oldGateway = await beginGateway(harness);
		const oldTool = harness.coordinator.admitProvisionalToolVm({
			agentId: 'main',
			expectedGateway: oldGateway.gatewayIdentity,
			sessionLabel: 'sunfam-main-tool',
		});
		await oldTool.ready;
		await oldTool.commitCurrent();
		const restartedCoordinator = createRestartedCoordinator(harness);

		// Act / Assert
		await expect(restartedCoordinator.reconcileControllerStartup([ZONE_ID])).rejects.toMatchObject({
			code: 'owner-unsafe',
		});
		expect(harness.destroyExactMock).toHaveBeenCalledOnce();
		const durableMembership = await journalForHarness(harness).loadGatewayMembership(
			oldGateway.gatewayIdentity.gatewayEpochId,
		);
		expect(durableMembership).toMatchObject({
			children: [
				expect.objectContaining({
					dispositionReason: 'exact-destroy-unavailable',
					state: 'owner-unsafe',
				}),
			],
			state: 'owner-unsafe',
		});
		await expect(
			restartedCoordinator.beginGatewayEpoch({
				bootId: 'forbidden-successor-after-child-failure-boot',
				generationId: 'forbidden-successor-after-child-failure-generation',
				sessionLabel: 'forbidden-successor-after-child-failure',
				zoneId: oldGateway.gatewayIdentity.zoneId,
			}),
		).rejects.toMatchObject({ code: 'owner-unsafe' });
	});
});
