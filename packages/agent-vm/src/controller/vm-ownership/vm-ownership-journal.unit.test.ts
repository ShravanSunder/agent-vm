import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { VmOwnershipDeploymentIdentity } from './vm-ownership-contracts.js';
import {
	VmOwnershipJournalError,
	createVmOwnershipJournal,
	type GatewayMembershipRecord,
} from './vm-ownership-journal.js';

const TEST_DEPLOYMENT_IDENTITY = {
	configPath: '/deployments/sunfam/config/system.jsonc',
	controllerPort: 18_800,
	projectNamespace: 'sunfam-test-deployment',
} satisfies VmOwnershipDeploymentIdentity;

const temporaryDirectories: string[] = [];

async function createTemporaryStateDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'agent-vm-ownership-journal-'));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => {
			await rm(directory, { force: true, recursive: true });
		}),
	);
});

function createMembershipRecord(
	gatewayEpochId: string,
	reservationPath: string,
	overrides: Partial<GatewayMembershipRecord> = {},
): GatewayMembershipRecord {
	return {
		children: [],
		controllerEpoch: 'controller-epoch-a',
		createdAtMs: 1_720_000_000_000,
		gateway: {
			bootId: `boot-${gatewayEpochId}`,
			controllerEpoch: 'controller-epoch-a',
			gatewayEpochId,
			gatewayVmId: `vm-${gatewayEpochId}`,
			generationId: `generation-${gatewayEpochId}`,
			zoneId: 'sunfam',
		},
		gatewayReservation: {
			controllerEpoch: 'controller-epoch-a',
			expectedRevision: 1,
			parentGateway: null,
			principal: { ...TEST_DEPLOYMENT_IDENTITY, kind: 'gateway-zone', zoneId: 'sunfam' },
			reservationId: `reservation-${gatewayEpochId}`,
			reservationPath,
			role: 'gateway',
			sessionLabel: `gateway:${gatewayEpochId}`,
			vmId: `vm-${gatewayEpochId}`,
		},
		revision: 1,
		schemaVersion: 1,
		state: 'admitting',
		updatedAtMs: 1_720_000_000_000,
		...overrides,
	};
}

type ToolVmChildMembership = GatewayMembershipRecord['children'][number];

function createChildMembership(
	parentRecord: GatewayMembershipRecord,
	reservationId: string,
	reservationPath: string,
	overrides: Partial<ToolVmChildMembership> = {},
): ToolVmChildMembership {
	return {
		controllerEpoch: parentRecord.controllerEpoch,
		expectedRevision: 1,
		observedReservationRevision: 1,
		parentGateway: {
			gatewayEpochId: parentRecord.gateway.gatewayEpochId,
			gatewayVmId: parentRecord.gateway.gatewayVmId,
		},
		principal: {
			...TEST_DEPLOYMENT_IDENTITY,
			agentId: `agent-${reservationId}`,
			kind: 'stable-agent',
			zoneId: parentRecord.gateway.zoneId,
		},
		reservationId,
		reservationPath,
		role: 'tool',
		sessionLabel: `tool:${reservationId}`,
		state: 'provisional',
		vmId: `vm-${reservationId}`,
		...overrides,
	};
}

function moveMembershipRecordToZone(
	record: GatewayMembershipRecord,
	zoneId: string,
): GatewayMembershipRecord {
	return {
		...record,
		gateway: { ...record.gateway, zoneId },
		gatewayReservation: {
			...record.gatewayReservation,
			principal: { ...record.gatewayReservation.principal, zoneId },
		},
	};
}

interface CrossRecordAliasingContext {
	readonly candidate: GatewayMembershipRecord;
	readonly candidateChild: ToolVmChildMembership;
	readonly first: GatewayMembershipRecord;
	readonly firstChild: ToolVmChildMembership;
}

const crossRecordAliasingCases = [
	{
		name: 'Gateway reservation id and canonical path alias an existing child',
		operation: 'create-gateway',
		mutateCandidate: ({ candidate, firstChild }: CrossRecordAliasingContext) => ({
			...candidate,
			gatewayReservation: {
				...candidate.gatewayReservation,
				reservationId: firstChild.reservationId,
				reservationPath: firstChild.reservationPath,
			},
		}),
	},
	{
		name: 'Gateway VM id aliases an existing child',
		operation: 'create-gateway',
		mutateCandidate: ({ candidate, candidateChild, firstChild }: CrossRecordAliasingContext) => ({
			...candidate,
			children: [
				{
					...candidateChild,
					parentGateway: {
						...candidateChild.parentGateway,
						gatewayVmId: firstChild.vmId,
					},
				},
			],
			gateway: { ...candidate.gateway, gatewayVmId: firstChild.vmId },
			gatewayReservation: { ...candidate.gatewayReservation, vmId: firstChild.vmId },
		}),
	},
	{
		name: 'child reservation id and canonical path alias an existing Gateway',
		operation: 'append-child',
		mutateCandidate: ({ candidate, candidateChild, first }: CrossRecordAliasingContext) => ({
			...candidate,
			children: [
				{
					...candidateChild,
					reservationId: first.gatewayReservation.reservationId,
					reservationPath: first.gatewayReservation.reservationPath,
				},
			],
		}),
	},
	{
		name: 'child VM id aliases an existing Gateway',
		operation: 'append-child',
		mutateCandidate: ({ candidate, candidateChild, first }: CrossRecordAliasingContext) => ({
			...candidate,
			children: [{ ...candidateChild, vmId: first.gateway.gatewayVmId }],
		}),
	},
	{
		name: 'child reservation id and canonical path alias an existing child',
		operation: 'append-child',
		mutateCandidate: ({ candidate, candidateChild, firstChild }: CrossRecordAliasingContext) => ({
			...candidate,
			children: [
				{
					...candidateChild,
					reservationId: firstChild.reservationId,
					reservationPath: firstChild.reservationPath,
				},
			],
		}),
	},
	{
		name: 'child VM id aliases an existing child',
		operation: 'append-child',
		mutateCandidate: ({ candidate, candidateChild, firstChild }: CrossRecordAliasingContext) => ({
			...candidate,
			children: [{ ...candidateChild, vmId: firstChild.vmId }],
		}),
	},
] satisfies readonly {
	readonly name: string;
	readonly operation: 'append-child' | 'create-gateway';
	readonly mutateCandidate: (context: CrossRecordAliasingContext) => GatewayMembershipRecord;
}[];

async function createMembershipWithProvisionalChild(options: {
	readonly child: ToolVmChildMembership;
	readonly journal: ReturnType<typeof createVmOwnershipJournal>;
	readonly record: GatewayMembershipRecord;
}): Promise<GatewayMembershipRecord> {
	await options.journal.createGatewayMembership(options.record);
	return await options.journal.replaceGatewayMembership({
		expectedRevision: 1,
		record: { ...options.record, children: [options.child], revision: 2 },
	});
}

async function transitionGatewayToDestroyed(options: {
	readonly journal: ReturnType<typeof createVmOwnershipJournal>;
	readonly record: GatewayMembershipRecord;
}): Promise<GatewayMembershipRecord> {
	const sealed = await options.journal.replaceGatewayMembership({
		expectedRevision: options.record.revision,
		record: { ...options.record, revision: options.record.revision + 1, state: 'sealed' },
	});
	const destroying = await options.journal.replaceGatewayMembership({
		expectedRevision: sealed.revision,
		record: { ...sealed, revision: sealed.revision + 1, state: 'destroying' },
	});
	return await options.journal.replaceGatewayMembership({
		expectedRevision: destroying.revision,
		record: { ...destroying, revision: destroying.revision + 1, state: 'destroyed' },
	});
}

describe('VmOwnershipJournal', () => {
	it('creates 0700 directories and a durable 0600 membership record', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});

		// Act
		await journal.createGatewayMembership(
			createMembershipRecord(
				'gateway-epoch-a',
				journal.reservationPathFor('reservation-gateway-epoch-a'),
			),
		);
		const loaded = await journal.loadGatewayMembership('gateway-epoch-a');
		const fileStats = await journal.inspectMembershipFile('gateway-epoch-a');

		// Assert
		expect(loaded.gateway.gatewayEpochId).toBe('gateway-epoch-a');
		expect(fileStats.directoryMode).toBe(0o700);
		expect(fileStats.fileMode).toBe(0o600);
	});

	it('rejects duplicate and ambiguous Gateway membership identities', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});
		const firstRecord = createMembershipRecord(
			'gateway-epoch-a',
			journal.reservationPathFor('reservation-gateway-epoch-a'),
		);
		await journal.createGatewayMembership(firstRecord);

		// Act / Assert
		await expect(journal.createGatewayMembership(firstRecord)).rejects.toMatchObject({
			code: 'membership-duplicate',
		});
		const ambiguousRecord = createMembershipRecord(
			'gateway-epoch-b',
			journal.reservationPathFor('reservation-gateway-epoch-b'),
		);
		await expect(
			journal.createGatewayMembership({
				...ambiguousRecord,
				gateway: {
					...ambiguousRecord.gateway,
					gatewayVmId: firstRecord.gateway.gatewayVmId,
				},
				gatewayReservation: {
					...ambiguousRecord.gatewayReservation,
					vmId: firstRecord.gateway.gatewayVmId,
				},
			}),
		).rejects.toMatchObject({ code: 'membership-ambiguous' });
	});

	it.each(['provisional', 'current'] as const)(
		'refuses a newly appended %s child after the Gateway membership is sealed',
		async (childState) => {
			// Arrange
			const stateDirectory = await createTemporaryStateDirectory();
			const journal = createVmOwnershipJournal({
				nowMs: () => 1_720_000_000_000,
				stateDirectory,
			});
			const admittingRecord = createMembershipRecord(
				'gateway-epoch-a',
				journal.reservationPathFor('reservation-gateway-epoch-a'),
			);
			await journal.createGatewayMembership(admittingRecord);
			const sealedRecord = await journal.replaceGatewayMembership({
				expectedRevision: 1,
				record: { ...admittingRecord, revision: 2, state: 'sealed' },
			});
			const lateChild = createChildMembership(
				sealedRecord,
				`late-${childState}-child`,
				journal.reservationPathFor(`late-${childState}-child`),
				{ state: childState },
			);

			// Act / Assert
			await expect(
				journal.replaceGatewayMembership({
					expectedRevision: 2,
					record: { ...sealedRecord, children: [lateChild], revision: 3 },
				}),
			).rejects.toMatchObject({ code: 'membership-state-transition-refused' });
		},
	);

	it('refuses a second non-destroyed Gateway membership for the same zone', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});
		await journal.createGatewayMembership(
			createMembershipRecord(
				'gateway-epoch-a',
				journal.reservationPathFor('reservation-gateway-epoch-a'),
			),
		);
		const successor = createMembershipRecord(
			'gateway-epoch-b',
			journal.reservationPathFor('reservation-gateway-epoch-b'),
		);

		// Act / Assert
		await expect(journal.createGatewayMembership(successor)).rejects.toMatchObject({
			code: 'membership-ambiguous',
		});
	});

	it('serializes same-zone Gateway creation across journal instances', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const firstJournal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});
		const secondJournal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_001,
			stateDirectory,
		});
		await Promise.all([firstJournal.ensureStorage(), secondJournal.ensureStorage()]);
		const firstRecord = createMembershipRecord(
			'gateway-epoch-concurrent-a',
			firstJournal.reservationPathFor('reservation-gateway-epoch-concurrent-a'),
		);
		const secondRecord = createMembershipRecord(
			'gateway-epoch-concurrent-b',
			secondJournal.reservationPathFor('reservation-gateway-epoch-concurrent-b'),
		);

		// Act
		const results = await Promise.allSettled([
			firstJournal.createGatewayMembership(firstRecord),
			secondJournal.createGatewayMembership(secondRecord),
		]);

		// Assert
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		await expect(firstJournal.loadAllGatewayMemberships()).resolves.toSatisfy(
			(records: readonly GatewayMembershipRecord[]) =>
				records.filter((record) => record.state !== 'destroyed').length === 1,
		);
	});

	it('serializes same-revision replacement across journal instances without a lost update', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const firstJournal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});
		const secondJournal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_001,
			stateDirectory,
		});
		const record = createMembershipRecord(
			'gateway-epoch-concurrent-replace',
			firstJournal.reservationPathFor('reservation-gateway-epoch-concurrent-replace'),
		);
		await firstJournal.createGatewayMembership(record);

		// Act
		const results = await Promise.allSettled([
			firstJournal.replaceGatewayMembership({
				expectedRevision: 1,
				record: { ...record, revision: 2, state: 'sealed' },
			}),
			secondJournal.replaceGatewayMembership({
				expectedRevision: 1,
				record: { ...record, revision: 2, state: 'owner-unsafe' },
			}),
		]);
		const successfulResults = results.filter((result) => result.status === 'fulfilled');

		// Assert
		expect(successfulResults).toHaveLength(1);
		const loaded = await firstJournal.loadGatewayMembership(record.gateway.gatewayEpochId);
		expect(loaded).toEqual(successfulResults[0]?.value);
	});

	it('reports lock release failure without masking the primary error or poisoning the local queue', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const operationLockJournalPath = path.join(
			stateDirectory,
			'vm-ownership',
			'journal-operation.lock-journal',
		);
		let acquiredLockCount = 0;
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			onCrossProcessLockAcquired: async (): Promise<void> => {
				acquiredLockCount += 1;
				if (acquiredLockCount === 1) {
					await unlink(operationLockJournalPath);
				}
			},
			stateDirectory,
		});
		const invalidRecord = createMembershipRecord(
			'gateway-epoch-release-failure',
			journal.reservationPathFor('reservation-gateway-epoch-release-failure'),
			{ revision: 2 },
		);

		// Act
		const firstError = await journal
			.createGatewayMembership(invalidRecord)
			.catch((error: unknown) => error);
		const secondRecords = await journal.loadAllGatewayMemberships();

		// Assert
		expect.soft(firstError).toBeInstanceOf(AggregateError);
		if (firstError instanceof AggregateError) {
			expect(firstError.errors[0]).toMatchObject({ code: 'membership-revision-regressed' });
			expect(String(firstError.errors[1])).toContain('disk I/O error');
		}
		expect(secondRecords).toEqual([]);
		expect(acquiredLockCount).toBe(2);
	});

	it('preserves a durable membership and releases the local queue when lock release fails', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const operationLockJournalPath = path.join(
			stateDirectory,
			'vm-ownership',
			'journal-operation.lock-journal',
		);
		let acquiredLockCount = 0;
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			onCrossProcessLockAcquired: async (): Promise<void> => {
				acquiredLockCount += 1;
				if (acquiredLockCount === 1) {
					await unlink(operationLockJournalPath);
				}
			},
			stateDirectory,
		});
		const record = createMembershipRecord(
			'gateway-epoch-durable-release-failure',
			journal.reservationPathFor('reservation-gateway-epoch-durable-release-failure'),
		);

		// Act
		const createError = await journal
			.createGatewayMembership(record)
			.catch((error: unknown) => error);
		const serializedRecord = JSON.parse(
			await readFile(journal.membershipPathForTesting(record.gateway.gatewayEpochId), 'utf8'),
		) as unknown;
		const secondRecord = await journal.loadGatewayMembership(record.gateway.gatewayEpochId);

		// Assert
		expect(String(createError)).toContain('disk I/O error');
		expect(serializedRecord).toEqual(record);
		expect(secondRecord).toEqual(record);
		expect(acquiredLockCount).toBe(2);
	});

	it.each(['provisional', 'current'] as const)(
		'refuses a non-empty initial children array containing a %s child',
		async (childState) => {
			// Arrange
			const stateDirectory = await createTemporaryStateDirectory();
			const journal = createVmOwnershipJournal({
				nowMs: () => 1_720_000_000_000,
				stateDirectory,
			});
			const emptyRecord = createMembershipRecord(
				`gateway-epoch-initial-${childState}`,
				journal.reservationPathFor(`reservation-gateway-epoch-initial-${childState}`),
			);
			const child = createChildMembership(
				emptyRecord,
				`initial-${childState}-child`,
				journal.reservationPathFor(`initial-${childState}-child`),
				{ state: childState },
			);

			// Act / Assert
			await expect(
				journal.createGatewayMembership({ ...emptyRecord, children: [child] }),
			).rejects.toMatchObject({ code: 'membership-state-transition-refused' });
		},
	);

	it('fails a single-epoch load closed when another on-disk membership is globally ambiguous', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});
		const firstRecord = createMembershipRecord(
			'gateway-epoch-load-a',
			journal.reservationPathFor('reservation-gateway-epoch-load-a'),
		);
		await journal.createGatewayMembership(firstRecord);
		const ambiguousRecord = createMembershipRecord(
			'gateway-epoch-load-b',
			journal.reservationPathFor('reservation-gateway-epoch-load-b'),
		);
		await writeFile(
			journal.membershipPathForTesting(ambiguousRecord.gateway.gatewayEpochId),
			`${JSON.stringify(ambiguousRecord, null, 2)}\n`,
			{ encoding: 'utf8', mode: 0o600 },
		);

		// Act / Assert
		await expect(
			journal.loadGatewayMembership(firstRecord.gateway.gatewayEpochId),
		).rejects.toMatchObject({ code: 'membership-ambiguous' });
	});

	it.each([
		{
			name: 'observed reservation revision',
			mutateChild: (child: ToolVmChildMembership): ToolVmChildMembership => ({
				...child,
				observedReservationRevision: child.observedReservationRevision + 1,
			}),
		},
		{
			name: 'disposition reason',
			mutateChild: (child: ToolVmChildMembership): ToolVmChildMembership => ({
				...child,
				dispositionReason: 'exact-destroy-incomplete',
			}),
		},
	] as const)("refuses direct mutation of a destroyed child's $name", async (testCase) => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});
		const emptyRecord = createMembershipRecord(
			'gateway-epoch-destroyed-child',
			journal.reservationPathFor('reservation-gateway-epoch-destroyed-child'),
		);
		const provisionalChild = createChildMembership(
			emptyRecord,
			'destroyed-child-reservation',
			journal.reservationPathFor('destroyed-child-reservation'),
		);
		const withProvisionalChild = await createMembershipWithProvisionalChild({
			child: provisionalChild,
			journal,
			record: emptyRecord,
		});
		const destroyedChild = {
			...provisionalChild,
			observedReservationRevision: 2,
			state: 'destroyed' as const,
		};
		const withDestroyedChild = await journal.replaceGatewayMembership({
			expectedRevision: withProvisionalChild.revision,
			record: {
				...withProvisionalChild,
				children: [destroyedChild],
				revision: withProvisionalChild.revision + 1,
			},
		});

		// Act / Assert
		await expect(
			journal.replaceGatewayMembership({
				expectedRevision: withDestroyedChild.revision,
				record: {
					...withDestroyedChild,
					children: [testCase.mutateChild(destroyedChild)],
					revision: withDestroyedChild.revision + 1,
				},
			}),
		).rejects.toMatchObject({ code: 'membership-state-transition-refused' });
	});

	it('permits a same-zone successor after the prior Gateway is fully destroyed', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});
		const firstRecord = createMembershipRecord(
			'gateway-epoch-retired-a',
			journal.reservationPathFor('reservation-gateway-epoch-retired-a'),
		);
		await journal.createGatewayMembership(firstRecord);
		await transitionGatewayToDestroyed({ journal, record: firstRecord });
		const successor = createMembershipRecord(
			'gateway-epoch-retired-b',
			journal.reservationPathFor('reservation-gateway-epoch-retired-b'),
		);

		// Act / Assert
		await expect(journal.createGatewayMembership(successor)).resolves.toEqual(successor);
	});

	it.each(crossRecordAliasingCases)(
		'refuses global identity aliasing when $name',
		async (testCase) => {
			// Arrange
			const stateDirectory = await createTemporaryStateDirectory();
			const journal = createVmOwnershipJournal({
				nowMs: () => 1_720_000_000_000,
				stateDirectory,
			});
			const firstWithoutChildren = moveMembershipRecordToZone(
				createMembershipRecord(
					'gateway-epoch-a',
					journal.reservationPathFor('reservation-gateway-epoch-a'),
				),
				'zone-a',
			);
			const firstChild = createChildMembership(
				firstWithoutChildren,
				'first-child-reservation',
				journal.reservationPathFor('first-child-reservation'),
			);
			const first = await createMembershipWithProvisionalChild({
				child: firstChild,
				journal,
				record: firstWithoutChildren,
			});

			const candidateWithoutChildren = moveMembershipRecordToZone(
				createMembershipRecord(
					'gateway-epoch-b',
					journal.reservationPathFor('reservation-gateway-epoch-b'),
				),
				'zone-b',
			);
			const candidateChild = createChildMembership(
				candidateWithoutChildren,
				'candidate-child-reservation',
				journal.reservationPathFor('candidate-child-reservation'),
			);
			const candidate = { ...candidateWithoutChildren, children: [candidateChild] };
			const mutatedCandidate = testCase.mutateCandidate({
				candidate,
				candidateChild,
				first,
				firstChild,
			});

			// Act / Assert
			if (testCase.operation === 'create-gateway') {
				await expect(
					journal.createGatewayMembership({ ...mutatedCandidate, children: [] }),
				).rejects.toMatchObject({ code: 'membership-ambiguous' });
				return;
			}
			await journal.createGatewayMembership(candidateWithoutChildren);
			await expect(
				journal.replaceGatewayMembership({
					expectedRevision: 1,
					record: { ...mutatedCandidate, revision: 2 },
				}),
			).rejects.toMatchObject({ code: 'membership-ambiguous' });
		},
	);

	it('fails closed for missing records and revision regression', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});
		const record = createMembershipRecord(
			'gateway-epoch-a',
			journal.reservationPathFor('reservation-gateway-epoch-a'),
		);
		await journal.createGatewayMembership(record);

		// Act / Assert
		await expect(journal.loadGatewayMembership('gateway-epoch-missing')).rejects.toMatchObject({
			code: 'membership-missing',
		});
		await expect(
			journal.replaceGatewayMembership({
				expectedRevision: 1,
				record: { ...record, revision: 1 },
			}),
		).rejects.toMatchObject({ code: 'membership-revision-regressed' });
	});

	it('rejects malformed records without leaking their path', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});
		await journal.ensureStorage();
		const recordPath = journal.membershipPathForTesting('gateway-epoch-a');
		await writeFile(recordPath, '{"schemaVersion":1,"secret":"must-not-leak"}', {
			encoding: 'utf8',
			mode: 0o600,
		});

		// Act
		const caughtError = await journal
			.loadGatewayMembership('gateway-epoch-a')
			.catch((error: unknown) => error);

		// Assert
		expect(caughtError).toBeInstanceOf(VmOwnershipJournalError);
		expect(caughtError).toMatchObject({ code: 'membership-malformed' });
		expect(String(caughtError)).not.toContain(recordPath);
		expect(String(caughtError)).not.toContain('must-not-leak');
	});

	it('refuses a symlinked ownership directory or membership file', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const outsideDirectory = await createTemporaryStateDirectory();
		await symlink(outsideDirectory, path.join(stateDirectory, 'vm-ownership'));
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});

		// Act / Assert
		await expect(journal.ensureStorage()).rejects.toMatchObject({
			code: 'ownership-path-symlink',
		});

		await rm(path.join(stateDirectory, 'vm-ownership'));
		await journal.ensureStorage();
		const outsideFile = path.join(outsideDirectory, 'outside.json');
		await writeFile(
			outsideFile,
			JSON.stringify(
				createMembershipRecord(
					'gateway-epoch-a',
					journal.reservationPathFor('reservation-gateway-epoch-a'),
				),
			),
		);
		await symlink(outsideFile, journal.membershipPathForTesting('gateway-epoch-a'));
		await expect(journal.loadGatewayMembership('gateway-epoch-a')).rejects.toMatchObject({
			code: 'ownership-path-symlink',
		});
	});

	it('refuses an unsafe caller-supplied state root', async () => {
		// Arrange
		const parentDirectory = await createTemporaryStateDirectory();
		const outsideDirectory = await createTemporaryStateDirectory();
		const linkedStateDirectory = path.join(parentDirectory, 'linked-state');
		await mkdir(outsideDirectory, { recursive: true });
		await symlink(outsideDirectory, linkedStateDirectory);
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory: linkedStateDirectory,
		});

		// Act / Assert
		await expect(journal.ensureStorage()).rejects.toMatchObject({
			code: 'ownership-path-symlink',
		});
	});

	it('refuses reservation paths outside the owned exact layout', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});

		// Act / Assert
		expect(journal.reservationPathFor('reservation-a')).toBe(
			path.join(
				stateDirectory,
				'vm-ownership',
				'reservations',
				'reservation-a',
				'reservation-v1.json',
			),
		);
		expect(() =>
			journal.assertReservationPathOwned('/tmp/outside/reservation-v1.json', 'reservation-a'),
		).toThrow(expect.objectContaining({ code: 'ownership-storage-unsafe' }));
		expect(() =>
			journal.assertReservationPathOwned(
				path.join(
					stateDirectory,
					'vm-ownership',
					'reservations',
					'nested',
					'extra',
					'reservation-v1.json',
				),
				'reservation-a',
			),
		).toThrow(expect.objectContaining({ code: 'ownership-storage-unsafe' }));
		expect(() =>
			journal.assertReservationPathOwned(
				path.join(
					stateDirectory,
					'vm-ownership',
					'reservations',
					'reservation-a',
					'reservation.json',
				),
				'reservation-a',
			),
		).toThrow(expect.objectContaining({ code: 'ownership-storage-unsafe' }));
		expect(() =>
			journal.assertReservationPathOwned(
				journal.reservationPathFor('reservation-gateway-epoch-a'),
				'reservation-gateway-epoch-b',
			),
		).toThrow(expect.objectContaining({ code: 'membership-identity-mismatch' }));
		expect(() =>
			journal.assertReservationPathOwned(
				journal.reservationPathFor('reservation-gateway-epoch-a'),
				'reservation-gateway-epoch-a',
			),
		).not.toThrow();
		await expect(
			journal.createGatewayMembership(
				createMembershipRecord('gateway-epoch-a', '/tmp/outside/reservation-v1.json'),
			),
		).rejects.toMatchObject({ code: 'ownership-storage-unsafe' });
	});

	it('serializes a canonical record without unbounded error or diagnostic fields', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_000,
			stateDirectory,
		});
		await journal.createGatewayMembership(
			createMembershipRecord(
				'gateway-epoch-a',
				journal.reservationPathFor('reservation-gateway-epoch-a'),
			),
		);

		// Act
		const serialized = await readFile(journal.membershipPathForTesting('gateway-epoch-a'), 'utf8');

		// Assert
		expect(serialized).not.toContain('errorMessage');
		expect(serialized).not.toContain('stack');
		expect(JSON.parse(serialized)).toMatchObject({
			gateway: { gatewayEpochId: 'gateway-epoch-a' },
			schemaVersion: 1,
		});
	});
});
