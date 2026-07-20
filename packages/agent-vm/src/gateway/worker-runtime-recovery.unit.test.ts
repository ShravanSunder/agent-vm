import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVmExactProcessTerminationCapability } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControllerGatewayStateRoot } from '../controller/durable-state/controller-state-paths.js';
import {
	resolveControllerWorkerTaskRuntimeRecordTarget,
	type ControllerWorkerTaskRuntimeRecordTarget,
} from '../controller/durable-state/controller-state-record-paths.js';
import {
	loadWorkerRuntimeRecord,
	type WorkerRuntimeRecord,
	writeWorkerRuntimeRecord,
} from './worker-runtime-record.js';
import {
	cleanupRecordedWorkerRuntimes,
	type WorkerRuntimeRecoveryDependencies,
} from './worker-runtime-recovery.js';

const createdDirectories: string[] = [];
const zoneId = 'worker-zone-a';
const projectNamespace = 'worker-tests-a1b2c3d4';
const expectedConfigPath = '/deployments/worker/config/system.jsonc';
const expectedControllerPort = 18_800;
const defaultTaskId = 'worker-task-a';
const defaultProcessIdentity = {
	command: 'qemu-system-aarch64 -name worker-task-a-vm',
	lstart: 'Sat Jul 11 17:00:00 2026',
} as const;

afterEach(async () => {
	const directoriesToDelete = createdDirectories.splice(0);
	await Promise.all(
		directoriesToDelete.map(async (directoryPath) => {
			await rm(directoryPath, { force: true, recursive: true });
		}),
	);
});

async function createGatewayStateRoot(): Promise<ControllerGatewayStateRoot> {
	const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-worker-runtime-recovery-'));
	createdDirectories.push(directoryPath);
	return { directoryPath, zoneId };
}

function createRuntimeRecordTarget(
	gatewayStateRoot: ControllerGatewayStateRoot,
	taskId: string = defaultTaskId,
): ControllerWorkerTaskRuntimeRecordTarget {
	return resolveControllerWorkerTaskRuntimeRecordTarget({ gatewayStateRoot, taskId });
}

function createWorkerRuntimeRecord(
	options: {
		readonly configPath?: string;
		readonly controllerPort?: number;
		readonly processIdentity?: WorkerRuntimeRecord['processIdentity'];
		readonly projectNamespace?: string;
		readonly qemuPid?: number;
		readonly sessionLabel?: string;
		readonly taskId?: string;
	} = {},
): WorkerRuntimeRecord {
	const taskId = options.taskId ?? defaultTaskId;
	const recordProjectNamespace = options.projectNamespace ?? projectNamespace;
	const vmId = `${taskId}-vm`;
	return {
		configPath: options.configPath ?? expectedConfigPath,
		controllerPort: options.controllerPort ?? expectedControllerPort,
		createdAt: '2026-07-11T17:00:00.000Z',
		gateway: {
			bootId: `${taskId}-boot`,
			controllerEpoch: 'worker-controller-a',
			gatewayEpochId: `${taskId}-ownership`,
			gatewayVmId: vmId,
			generationId: `${taskId}-generation`,
			zoneId,
		},
		guestListenPort: 18_789,
		ingressPort: 18_791,
		processIdentity: options.processIdentity ?? defaultProcessIdentity,
		projectNamespace: recordProjectNamespace,
		qemuPid: options.qemuPid ?? 48_282,
		runtimeKind: 'worker-direct-process',
		schemaVersion: 3,
		sessionLabel: options.sessionLabel ?? `${recordProjectNamespace}:${zoneId}:gateway`,
		taskId,
		vmId,
		zoneId,
	};
}

async function persistWorkerRuntimeRecord(
	gatewayStateRoot: ControllerGatewayStateRoot,
	record: WorkerRuntimeRecord,
): Promise<ControllerWorkerTaskRuntimeRecordTarget> {
	const target = createRuntimeRecordTarget(gatewayStateRoot, record.taskId);
	await writeWorkerRuntimeRecord(target, record);
	return target;
}

function createCleanupOptions(
	gatewayStateRoot: ControllerGatewayStateRoot,
): Parameters<typeof cleanupRecordedWorkerRuntimes>[0] {
	return {
		expectedConfigPath,
		expectedControllerPort,
		gatewayStateRoot,
		projectNamespace,
	};
}

function createMatchingProcessDependencies(records: readonly WorkerRuntimeRecord[]): Pick<
	WorkerRuntimeRecoveryDependencies,
	'exactProcessTermination' | 'readProcessCommand' | 'readProcessIdentity'
> & {
	readonly alivePids: Set<number>;
	readonly terminateRecordedHostProcess: ReturnType<typeof vi.fn>;
} {
	const recordsByPid = new Map(records.map((record) => [record.qemuPid, record]));
	const alivePids = new Set(records.map((record) => record.qemuPid));
	const terminateRecordedHostProcess = vi.fn(
		async (
			request: Parameters<
				ManagedVmExactProcessTerminationCapability['terminateRecordedHostProcess']
			>[0],
		) => {
			if (!alivePids.has(request.identity.hostProcessId)) {
				return {
					hostProcessId: request.identity.hostProcessId,
					kind: 'already-absent' as const,
				};
			}
			alivePids.delete(request.identity.hostProcessId);
			return {
				hostProcessId: request.identity.hostProcessId,
				kind: 'terminated' as const,
			};
		},
	);
	return {
		alivePids,
		exactProcessTermination: { terminateRecordedHostProcess },
		readProcessCommand: vi.fn(async (pid: number) =>
			alivePids.has(pid) ? (recordsByPid.get(pid)?.processIdentity.command ?? null) : null,
		),
		readProcessIdentity: vi.fn(async (pid: number) =>
			alivePids.has(pid) ? (recordsByPid.get(pid)?.processIdentity ?? null) : null,
		),
		terminateRecordedHostProcess,
	};
}

describe('cleanupRecordedWorkerRuntimes', () => {
	it('terminates an exact live Worker identity and deletes its task-bound record', async () => {
		// Arrange
		const gatewayStateRoot = await createGatewayStateRoot();
		const record = createWorkerRuntimeRecord();
		const target = await persistWorkerRuntimeRecord(gatewayStateRoot, record);
		const processDependencies = createMatchingProcessDependencies([record]);

		// Act
		const result = await cleanupRecordedWorkerRuntimes(
			createCleanupOptions(gatewayStateRoot),
			processDependencies,
		);

		// Assert
		expect(processDependencies.terminateRecordedHostProcess).toHaveBeenCalledWith(
			expect.objectContaining({
				identity: expect.objectContaining({ hostProcessId: record.qemuPid }),
			}),
		);
		expect(result).toEqual({ cleanedCount: 1, killedPids: [record.qemuPid] });
		await expect(loadWorkerRuntimeRecord(target)).resolves.toBeNull();
		await expect(stat(path.dirname(target.filePath))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('deletes an already-dead stale record without sending a signal', async () => {
		// Arrange
		const gatewayStateRoot = await createGatewayStateRoot();
		const record = createWorkerRuntimeRecord();
		const target = await persistWorkerRuntimeRecord(gatewayStateRoot, record);
		const processTermination = createMatchingProcessDependencies([]);

		// Act
		const result = await cleanupRecordedWorkerRuntimes(createCleanupOptions(gatewayStateRoot), {
			...processTermination,
			readProcessCommand: async () => null,
			readProcessIdentity: async () => null,
		});

		// Assert
		expect(result).toEqual({ cleanedCount: 1, killedPids: [] });
		expect(processTermination.terminateRecordedHostProcess).toHaveBeenCalledOnce();
		await expect(loadWorkerRuntimeRecord(target)).resolves.toBeNull();
	});

	it('fails closed on a malformed record without signaling or deleting it', async () => {
		// Arrange
		const gatewayStateRoot = await createGatewayStateRoot();
		const target = createRuntimeRecordTarget(gatewayStateRoot);
		await mkdir(path.dirname(target.filePath), { recursive: true });
		await writeFile(target.filePath, '{"schemaVersion":3,"broken":true}\n');
		const processTermination = createMatchingProcessDependencies([]);
		const deleteWorkerRuntimeRecord = vi.fn(async () => {});

		// Act
		const cleanup = cleanupRecordedWorkerRuntimes(createCleanupOptions(gatewayStateRoot), {
			...processTermination,
			deleteWorkerRuntimeRecord,
			readProcessCommand: async () => 'qemu-system-aarch64',
			readProcessIdentity: async () => defaultProcessIdentity,
		});

		// Assert
		await expect(cleanup).rejects.toThrow(/failed to parse/u);
		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
		expect(deleteWorkerRuntimeRecord).not.toHaveBeenCalled();
		await expect(stat(target.filePath)).resolves.toBeDefined();
	});

	it.each([
		{
			expectedMessage: /configPath/u,
			overrides: { configPath: '/deployments/other/config/system.jsonc' },
		},
		{
			expectedMessage: /controllerPort/u,
			overrides: { controllerPort: 19_999 },
		},
		{
			expectedMessage: /projectNamespace/u,
			overrides: { projectNamespace: 'other-worker-tests' },
		},
	])('fails closed on a scoped authority mismatch', async ({ expectedMessage, overrides }) => {
		// Arrange
		const gatewayStateRoot = await createGatewayStateRoot();
		const record = createWorkerRuntimeRecord(overrides);
		const target = await persistWorkerRuntimeRecord(gatewayStateRoot, record);
		const processDependencies = createMatchingProcessDependencies([record]);
		const deleteWorkerRuntimeRecord = vi.fn(async () => {});

		// Act
		const cleanup = cleanupRecordedWorkerRuntimes(createCleanupOptions(gatewayStateRoot), {
			...processDependencies,
			deleteWorkerRuntimeRecord,
		});

		// Assert
		await expect(cleanup).rejects.toThrow(expectedMessage);
		expect(processDependencies.terminateRecordedHostProcess).not.toHaveBeenCalled();
		expect(deleteWorkerRuntimeRecord).not.toHaveBeenCalled();
		await expect(loadWorkerRuntimeRecord(target)).resolves.toEqual(record);
	});

	it('treats a reused PID with a different start time as predecessor absence', async () => {
		// Arrange
		const gatewayStateRoot = await createGatewayStateRoot();
		const record = createWorkerRuntimeRecord();
		const target = await persistWorkerRuntimeRecord(gatewayStateRoot, record);
		const processTermination = createMatchingProcessDependencies([]);

		// Act
		const result = await cleanupRecordedWorkerRuntimes(createCleanupOptions(gatewayStateRoot), {
			...processTermination,
			readProcessCommand: async () => 'qemu-system-aarch64 -name reused-pid',
			readProcessIdentity: async () => ({
				command: 'qemu-system-aarch64 -name reused-pid',
				lstart: 'Sun Jul 12 17:00:00 2026',
			}),
		});

		// Assert
		expect(result).toEqual({ cleanedCount: 1, killedPids: [] });
		expect(processTermination.terminateRecordedHostProcess).toHaveBeenCalledOnce();
		await expect(loadWorkerRuntimeRecord(target)).resolves.toBeNull();
	});

	it('preverifies every record before sending the first signal', async () => {
		// Arrange
		const gatewayStateRoot = await createGatewayStateRoot();
		const records = [
			createWorkerRuntimeRecord({ qemuPid: 48_201, taskId: 'worker-task-a' }),
			createWorkerRuntimeRecord({
				processIdentity: {
					command: 'qemu-system-aarch64 -name worker-task-b-vm',
					lstart: 'Sat Jul 11 17:01:00 2026',
				},
				qemuPid: 48_202,
				taskId: 'worker-task-b',
			}),
		];
		await Promise.all(
			records.map(async (record) => await persistWorkerRuntimeRecord(gatewayStateRoot, record)),
		);
		const processDependencies = createMatchingProcessDependencies(records);
		const preverifiedPids = new Set<number>();
		const readProcessIdentity = vi.fn(async (pid: number) => {
			preverifiedPids.add(pid);
			return processDependencies.alivePids.has(pid)
				? (records.find((record) => record.qemuPid === pid)?.processIdentity ?? null)
				: null;
		});
		const terminateRecordedHostProcess = vi.fn(async ({ identity }) => {
			expect(preverifiedPids).toEqual(new Set(records.map((record) => record.qemuPid)));
			processDependencies.alivePids.delete(identity.hostProcessId);
			return { hostProcessId: identity.hostProcessId, kind: 'terminated' as const };
		});

		// Act
		const result = await cleanupRecordedWorkerRuntimes(createCleanupOptions(gatewayStateRoot), {
			...processDependencies,
			exactProcessTermination: { terminateRecordedHostProcess },
			readProcessIdentity,
		});

		// Assert
		expect(terminateRecordedHostProcess).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ cleanedCount: 2, killedPids: [48_201, 48_202] });
	});

	it('sends no signal when any record fails collection-wide preverification', async () => {
		// Arrange
		const gatewayStateRoot = await createGatewayStateRoot();
		const matchingRecord = createWorkerRuntimeRecord({ qemuPid: 48_201 });
		const inconsistentRecord = createWorkerRuntimeRecord({
			processIdentity: {
				command: 'qemu-system-aarch64 -name worker-task-b-vm',
				lstart: 'Sat Jul 11 17:01:00 2026',
			},
			qemuPid: 48_202,
			taskId: 'worker-task-b',
		});
		await Promise.all(
			[matchingRecord, inconsistentRecord].map(
				async (record) => await persistWorkerRuntimeRecord(gatewayStateRoot, record),
			),
		);
		const processTermination = createMatchingProcessDependencies([]);
		const deleteWorkerRuntimeRecord = vi.fn(async () => {});

		// Act
		const cleanup = cleanupRecordedWorkerRuntimes(createCleanupOptions(gatewayStateRoot), {
			...processTermination,
			deleteWorkerRuntimeRecord,
			readProcessCommand: async () => 'qemu-system-aarch64',
			readProcessIdentity: async (pid: number) =>
				pid === matchingRecord.qemuPid
					? matchingRecord.processIdentity
					: {
							...inconsistentRecord.processIdentity,
							command: 'qemu-system-aarch64 -name inconsistent-worker-task-b-vm',
						},
		});

		// Assert
		await expect(cleanup).rejects.toThrow(/same process start identity.*command changed/u);
		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
		expect(deleteWorkerRuntimeRecord).not.toHaveBeenCalled();
	});

	it('surfaces record deletion failure and leaves cleanup incomplete', async () => {
		// Arrange
		const gatewayStateRoot = await createGatewayStateRoot();
		const record = createWorkerRuntimeRecord();
		const target = await persistWorkerRuntimeRecord(gatewayStateRoot, record);
		const processDependencies = createMatchingProcessDependencies([record]);
		const deleteWorkerRuntimeRecord = vi.fn(async () => {
			throw new Error('disk full while deleting Worker record');
		});

		// Act
		const cleanup = cleanupRecordedWorkerRuntimes(createCleanupOptions(gatewayStateRoot), {
			...processDependencies,
			deleteWorkerRuntimeRecord,
		});

		// Assert
		await expect(cleanup).rejects.toThrow(/disk full while deleting Worker record/u);
		expect(processDependencies.terminateRecordedHostProcess).toHaveBeenCalledWith(
			expect.objectContaining({
				identity: expect.objectContaining({ hostProcessId: record.qemuPid }),
			}),
		);
		expect(deleteWorkerRuntimeRecord).toHaveBeenCalledWith(target);
		await expect(loadWorkerRuntimeRecord(target)).resolves.toEqual(record);
	});
});
