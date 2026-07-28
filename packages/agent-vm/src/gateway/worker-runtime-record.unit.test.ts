import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import type { ControllerGatewayStateRoot } from '../controller/durable-state/controller-state-paths.js';
import {
	resolveControllerGatewayRecordTargets,
	resolveControllerWorkerTaskRuntimeRecordTarget,
	type ControllerWorkerTaskRuntimeRecordTarget,
} from '../controller/durable-state/controller-state-record-paths.js';
import type { ManagedVmProcessTarget } from '../shared/controller-managed-vm-termination.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../testing/managed-vm-test-helpers.js';
import {
	assertWorkerRuntimeRecordMatchesLiveGateway,
	buildWorkerRuntimeRecord,
	deleteWorkerRuntimeRecord,
	listWorkerRuntimeRecordTargets,
	loadWorkerRuntimeRecord,
	loadWorkerRuntimeRecordResult,
	type WorkerRuntimeRecord,
	workerRuntimeRecordSchema,
	writeWorkerRuntimeRecord,
} from './worker-runtime-record.js';

const createdDirectories: string[] = [];
const gatewayIdentity = {
	bootId: 'worker-boot-a',
	controllerEpoch: 'worker-controller-a',
	gatewayEpochId: 'worker-ownership-a',
	gatewayVmId: 'worker-vm-a',
	generationId: 'worker-generation-a',
	zoneId: 'worker-zone-a',
} as const;
const processIdentity = {
	command: 'qemu-system-aarch64 -name worker-vm-a',
	lstart: 'Sat Jul 11 17:00:00 2026',
} as const;
const capturedProcessTarget = {
	hostPid: 48_282,
	processIdentity,
	vmId: gatewayIdentity.gatewayVmId,
} satisfies ManagedVmProcessTarget;
const workerTaskId = 'worker-task-a';
const processSpec = {
	bootstrapCommand: 'bootstrap-worker',
	guestListenPort: 18_789,
	healthCheck: { path: '/health', port: 18_789, type: 'http' },
	logPath: '/tmp/worker.log',
	startCommand: 'agent-vm-worker serve',
} as const;

afterEach(async () => {
	const directoriesToDelete = createdDirectories.splice(0);
	await Promise.all(
		directoriesToDelete.map(async (directoryPath) => {
			await rm(directoryPath, { force: true, recursive: true });
		}),
	);
});

async function createStateDirectory(): Promise<string> {
	const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-worker-runtime-record-'));
	createdDirectories.push(directoryPath);
	return directoryPath;
}

function createRuntimeRecordTarget(options: {
	readonly stateDirectory: string;
	readonly taskId?: string;
	readonly zoneId?: string;
}): ControllerWorkerTaskRuntimeRecordTarget {
	return resolveControllerWorkerTaskRuntimeRecordTarget({
		gatewayStateRoot: createGatewayStateRoot({
			stateDirectory: options.stateDirectory,
			...(options.zoneId === undefined ? {} : { zoneId: options.zoneId }),
		}),
		taskId: options.taskId ?? workerTaskId,
	});
}

function createGatewayStateRoot(options: {
	readonly stateDirectory: string;
	readonly zoneId?: string;
}): ControllerGatewayStateRoot {
	return {
		directoryPath: options.stateDirectory,
		zoneId: options.zoneId ?? gatewayIdentity.zoneId,
	};
}

function createManagedVmStub(options: {
	readonly hostPid: number | null;
	readonly id: string;
}): ManagedVm {
	return {
		close: async () => {},
		configureIngressRoutes: () => {},
		enableIngress: async () => ({ close: async () => {}, host: '127.0.0.1', port: 18_791 }),
		enableSsh: async () => ({
			close: async () => {},
			command: 'ssh worker-vm',
			host: '127.0.0.1',
			identityFile: '/tmp/worker-identity',
			port: 22_222,
			serverHostKey: TEST_SSH_SERVER_HOST_KEY,
			user: 'root',
		}),
		exec: () => createManagedExecProcessStub(),
		getHostProcessId: () => options.hostPid,
		id: options.id,
		start: async () => {},
	};
}

function createSampleRecord(overrides: Partial<WorkerRuntimeRecord> = {}): WorkerRuntimeRecord {
	return {
		configPath: '/deployments/worker/config/system.jsonc',
		controllerPort: 18_800,
		createdAt: '2026-07-11T17:00:00.000Z',
		gateway: gatewayIdentity,
		guestListenPort: processSpec.guestListenPort,
		ingressPort: 18_791,
		processIdentity,
		projectNamespace: 'worker-tests-a1b2c3d4',
		qemuPid: 48_282,
		runtimeKind: 'worker-direct-process',
		schemaVersion: 3,
		sessionLabel: 'worker-tests-a1b2c3d4:worker-zone-a:gateway',
		taskId: workerTaskId,
		vmId: gatewayIdentity.gatewayVmId,
		zoneId: gatewayIdentity.zoneId,
		...overrides,
	};
}

describe('Worker direct-process runtime record', () => {
	it('accepts only strict Worker v3 records without managed Gateway authority', () => {
		// Arrange
		const record = createSampleRecord();
		const { taskId: _taskId, ...recordWithoutTaskId } = record;

		// Act / Assert
		expect(workerRuntimeRecordSchema.parse(record)).toEqual(record);
		for (const rejectedValue of [
			{ ...record, schemaVersion: 2 },
			{ ...record, gatewayType: 'worker' },
			{ ...record, expectedCohort: { semanticRevision: 'managed-only' } },
			recordWithoutTaskId,
		]) {
			expect(() => workerRuntimeRecordSchema.parse(rejectedValue)).toThrow(ZodError);
		}
	});

	it('builds v3 evidence from the direct Worker process specification', async () => {
		// Arrange
		const managedVm = createManagedVmStub({ hostPid: 48_282, id: gatewayIdentity.gatewayVmId });

		// Act
		const record = await buildWorkerRuntimeRecord({
			controllerPort: 18_800,
			gatewayIdentity,
			ingressPort: 18_791,
			managedVm,
			processSpec,
			projectNamespace: 'worker-tests-a1b2c3d4',
			readProcessIdentity: async () => processIdentity,
			systemConfigPath: '/deployments/worker/config/system.jsonc',
			taskId: workerTaskId,
			zoneId: gatewayIdentity.zoneId,
		});

		// Assert
		expect(record).toMatchObject({
			gateway: gatewayIdentity,
			guestListenPort: processSpec.guestListenPort,
			processIdentity,
			qemuPid: 48_282,
			runtimeKind: 'worker-direct-process',
			schemaVersion: 3,
			taskId: workerTaskId,
		});
		expect(record).not.toHaveProperty('expectedCohort');
	});

	it('persists mode-0600 Worker evidence', async () => {
		// Arrange
		const stateDirectory = await createStateDirectory();
		const runtimeRecordTarget = createRuntimeRecordTarget({ stateDirectory });
		const record = createSampleRecord();

		// Act
		await writeWorkerRuntimeRecord(runtimeRecordTarget, record);

		// Assert
		await expect(loadWorkerRuntimeRecord(runtimeRecordTarget)).resolves.toEqual(record);
		expect((await stat(runtimeRecordTarget.filePath)).mode & 0o777).toBe(0o600);
		expect(await readdir(stateDirectory)).toEqual(['worker-tasks']);
		expect(await readdir(path.dirname(runtimeRecordTarget.filePath))).toEqual([
			'gateway-runtime.json',
		]);
	});

	it('returns an immutable empty collection when the Worker task record root is absent', async () => {
		// Arrange
		const stateDirectory = await createStateDirectory();
		const gatewayStateRoot = createGatewayStateRoot({ stateDirectory });

		// Act
		const targets = await listWorkerRuntimeRecordTargets({ gatewayStateRoot });

		// Assert
		expect(targets).toEqual([]);
		expect(Object.isFrozen(targets)).toBe(true);
	});

	it('lists deterministic zone-and-task-bound targets from exact one-file task directories', async () => {
		// Arrange
		const stateDirectory = await createStateDirectory();
		const gatewayStateRoot = createGatewayStateRoot({ stateDirectory });
		await Promise.all(
			['worker-task-z', 'worker-task-a'].map(async (taskId) => {
				await writeWorkerRuntimeRecord(
					resolveControllerWorkerTaskRuntimeRecordTarget({ gatewayStateRoot, taskId }),
					createSampleRecord({ taskId }),
				);
			}),
		);

		// Act
		const targets = await listWorkerRuntimeRecordTargets({ gatewayStateRoot });

		// Assert
		expect(targets).toEqual([
			{
				filePath: path.join(
					stateDirectory,
					'worker-tasks',
					'worker-task-a',
					'gateway-runtime.json',
				),
				kind: 'controller-worker-task-runtime-record',
				taskId: 'worker-task-a',
				zoneId: gatewayIdentity.zoneId,
			},
			{
				filePath: path.join(
					stateDirectory,
					'worker-tasks',
					'worker-task-z',
					'gateway-runtime.json',
				),
				kind: 'controller-worker-task-runtime-record',
				taskId: 'worker-task-z',
				zoneId: gatewayIdentity.zoneId,
			},
		]);
		expect(Object.isFrozen(targets)).toBe(true);
		expect(targets.every((target) => Object.isFrozen(target))).toBe(true);
	});

	it('refuses a symlinked Worker task record collection', async () => {
		// Arrange
		const stateDirectory = await createStateDirectory();
		const gatewayStateRoot = createGatewayStateRoot({ stateDirectory });
		const workerTaskRecords = resolveControllerGatewayRecordTargets({
			gatewayStateRoot,
		}).workerTaskRecords;
		const externalCollection = path.join(stateDirectory, 'external-worker-tasks');
		await mkdir(externalCollection);
		await symlink(externalCollection, workerTaskRecords.directoryPath);

		// Act / Assert
		await expect(listWorkerRuntimeRecordTargets({ gatewayStateRoot })).rejects.toThrow(
			/must be a real directory/u,
		);
	});

	it.each([
		{
			label: 'symlinked task directory',
			prepareInvalidTopology: async (workerTaskRecordsDirectoryPath: string) => {
				const externalTaskDirectory = path.join(
					path.dirname(workerTaskRecordsDirectoryPath),
					'external-worker-task',
				);
				await mkdir(externalTaskDirectory);
				await symlink(
					externalTaskDirectory,
					path.join(workerTaskRecordsDirectoryPath, workerTaskId),
				);
			},
		},
		{
			label: 'unsafe task name',
			prepareInvalidTopology: async (workerTaskRecordsDirectoryPath: string) => {
				await mkdir(path.join(workerTaskRecordsDirectoryPath, 'unsafe\\task'));
			},
		},
		{
			label: 'unexpected collection residue',
			prepareInvalidTopology: async (workerTaskRecordsDirectoryPath: string) => {
				await writeFile(path.join(workerTaskRecordsDirectoryPath, 'unexpected.txt'), 'residue');
			},
		},
	])('refuses a $label before returning any targets', async ({ prepareInvalidTopology }) => {
		// Arrange
		const stateDirectory = await createStateDirectory();
		const gatewayStateRoot = createGatewayStateRoot({ stateDirectory });
		const workerTaskRecords = resolveControllerGatewayRecordTargets({
			gatewayStateRoot,
		}).workerTaskRecords;
		await mkdir(workerTaskRecords.directoryPath, { recursive: true });
		await prepareInvalidTopology(workerTaskRecords.directoryPath);

		// Act / Assert
		await expect(listWorkerRuntimeRecordTargets({ gatewayStateRoot })).rejects.toThrow();
	});

	it.each([
		{
			label: 'missing gateway-runtime.json',
			prepareInvalidTaskDirectory: async (_taskDirectoryPath: string) => {},
		},
		{
			label: 'unexpected extra residue',
			prepareInvalidTaskDirectory: async (taskDirectoryPath: string) => {
				await writeFile(path.join(taskDirectoryPath, 'gateway-runtime.json'), '{}');
				await writeFile(path.join(taskDirectoryPath, 'unexpected.txt'), 'residue');
			},
		},
		{
			label: 'symlinked gateway-runtime.json',
			prepareInvalidTaskDirectory: async (taskDirectoryPath: string) => {
				const externalRecordPath = path.join(
					path.dirname(path.dirname(taskDirectoryPath)),
					'external-worker-runtime.json',
				);
				await writeFile(externalRecordPath, '{}');
				await symlink(externalRecordPath, path.join(taskDirectoryPath, 'gateway-runtime.json'));
			},
		},
	])('refuses a task directory with $label', async ({ prepareInvalidTaskDirectory }) => {
		// Arrange
		const stateDirectory = await createStateDirectory();
		const gatewayStateRoot = createGatewayStateRoot({ stateDirectory });
		const workerTaskRecords = resolveControllerGatewayRecordTargets({
			gatewayStateRoot,
		}).workerTaskRecords;
		const taskDirectoryPath = path.join(workerTaskRecords.directoryPath, workerTaskId);
		await mkdir(taskDirectoryPath, { recursive: true });
		await prepareInvalidTaskDirectory(taskDirectoryPath);

		// Act / Assert
		await expect(listWorkerRuntimeRecordTargets({ gatewayStateRoot })).rejects.toThrow(
			/must contain only one real gateway-runtime\.json file/u,
		);
	});

	it('binds cleanup evidence to the exact live Worker VM and lifecycle identity', async () => {
		// Arrange
		const record = createSampleRecord();
		const managedVm = createManagedVmStub({ hostPid: record.qemuPid, id: record.vmId });
		const matchingInput = {
			expectedProcessTarget: capturedProcessTarget,
			gatewayIdentity,
			managedVm,
			readProcessIdentity: async () => processIdentity,
			record,
		} as const;

		// Act / Assert
		await expect(
			assertWorkerRuntimeRecordMatchesLiveGateway(matchingInput),
		).resolves.toBeUndefined();
		const mismatchedInputs = [
			{
				...matchingInput,
				managedVm: createManagedVmStub({ hostPid: record.qemuPid, id: 'other-worker-vm' }),
			},
			{
				...matchingInput,
				managedVm: createManagedVmStub({ hostPid: 99_999, id: record.vmId }),
			},
			{
				...matchingInput,
				gatewayIdentity: { ...gatewayIdentity, generationId: 'other-generation' },
			},
			{
				...matchingInput,
				readProcessIdentity: async () => ({
					...processIdentity,
					lstart: 'Sun Jul 12 17:00:00 2026',
				}),
			},
		] as const;
		await Promise.all(
			mismatchedInputs.map(async (mismatchedInput) =>
				expect(assertWorkerRuntimeRecordMatchesLiveGateway(mismatchedInput)).rejects.toThrow(
					/does not match/u,
				),
			),
		);
	});

	it.each([
		{
			label: 'recorded PID',
			record: createSampleRecord({ qemuPid: 99_999 }),
		},
		{
			label: 'recorded process command',
			record: createSampleRecord({
				processIdentity: { ...processIdentity, command: 'qemu-system-aarch64 -name stale-worker' },
			}),
		},
		{
			label: 'recorded process start time',
			record: createSampleRecord({
				processIdentity: { ...processIdentity, lstart: 'Sun Jul 12 17:00:00 2026' },
			}),
		},
	])(
		'refuses detached-handle cleanup when the $label mismatches the captured target',
		async ({ record }) => {
			// Arrange
			const stateDirectory = await createStateDirectory();
			const runtimeRecordTarget = createRuntimeRecordTarget({ stateDirectory });
			await writeWorkerRuntimeRecord(runtimeRecordTarget, record);
			const persistedRecord = await loadWorkerRuntimeRecord(runtimeRecordTarget);
			if (persistedRecord === null) {
				throw new Error('Expected persisted Worker runtime record.');
			}
			const originalRecord = structuredClone(persistedRecord);
			const detachedManagedVm = createManagedVmStub({ hostPid: null, id: persistedRecord.vmId });

			// Act
			const assertion = assertWorkerRuntimeRecordMatchesLiveGateway({
				expectedProcessTarget: capturedProcessTarget,
				gatewayIdentity,
				managedVm: detachedManagedVm,
				readProcessIdentity: async () => {
					throw new Error('Detached handles must not require live process identity reads.');
				},
				record: persistedRecord,
			});

			// Assert
			await expect(assertion).rejects.toThrow(/does not match/u);
			await expect(loadWorkerRuntimeRecord(runtimeRecordTarget)).resolves.toEqual(originalRecord);
		},
	);

	it.each([
		{ label: 'zone', targetOverrides: { zoneId: 'other-zone' } },
		{ label: 'task', targetOverrides: { taskId: 'other-task' } },
	])(
		'rejects a valid Worker record bound to a different controller $label on read and write',
		async ({ targetOverrides }) => {
			// Arrange
			const readStateDirectory = await createStateDirectory();
			const crossIdentityReadTarget = createRuntimeRecordTarget({
				stateDirectory: readStateDirectory,
				...targetOverrides,
			});
			await mkdir(path.dirname(crossIdentityReadTarget.filePath), { recursive: true });
			await writeFile(
				crossIdentityReadTarget.filePath,
				`${JSON.stringify(createSampleRecord())}\n`,
			);

			// Act / Assert
			await expect(loadWorkerRuntimeRecordResult(crossIdentityReadTarget)).resolves.toMatchObject({
				kind: 'parse-error',
			});
			await expect(loadWorkerRuntimeRecord(crossIdentityReadTarget)).rejects.toThrow(/target/u);

			const writeStateDirectory = await createStateDirectory();
			const crossIdentityWriteTarget = createRuntimeRecordTarget({
				stateDirectory: writeStateDirectory,
				...targetOverrides,
			});
			await expect(
				writeWorkerRuntimeRecord(crossIdentityWriteTarget, createSampleRecord()),
			).rejects.toThrow(/target/u);
			expect(await readdir(writeStateDirectory)).toEqual([]);
		},
	);

	it('reports missing records and deletes persisted evidence', async () => {
		// Arrange
		const stateDirectory = await createStateDirectory();
		const runtimeRecordTarget = createRuntimeRecordTarget({ stateDirectory });
		await writeWorkerRuntimeRecord(runtimeRecordTarget, createSampleRecord());

		// Act
		await deleteWorkerRuntimeRecord(runtimeRecordTarget);

		// Assert
		await expect(loadWorkerRuntimeRecordResult(runtimeRecordTarget)).resolves.toMatchObject({
			kind: 'missing',
			path: runtimeRecordTarget.filePath,
		});
		await expect(stat(path.dirname(runtimeRecordTarget.filePath))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
});
