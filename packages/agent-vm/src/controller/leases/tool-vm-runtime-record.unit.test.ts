import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm, ManagedVmInstance } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../../testing/managed-vm-test-helpers.js';
import {
	buildToolVmRuntimeRecord,
	deleteToolVmRuntimeRecord,
	loadAllToolVmRuntimeRecords,
	loadToolVmRuntimeRecord,
	toolVmRuntimeRecordFilename,
	toolVmRuntimeRecordSchema,
	type ToolVmRuntimeRecord,
	writeToolVmRuntimeRecord,
} from './tool-vm-runtime-record.js';

const createdDirectories: string[] = [];
const sampleLeaseId = '01890f00-0000-7000-8000-000000000000';
const sampleRecordId = '01890f00-0000-7000-8000-000000000111';

afterEach(async () => {
	const directoriesToDelete = createdDirectories.splice(0);
	await Promise.all(
		directoriesToDelete.map(async (directoryPath) => {
			await rm(directoryPath, { force: true, recursive: true });
		}),
	);
});

async function createStateDirectory(): Promise<string> {
	const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-tool-vm-record-'));
	createdDirectories.push(directoryPath);
	return directoryPath;
}

function createVmInstanceStub(hostPid: number): ManagedVmInstance {
	return {
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18_791 }),
		enableSsh: async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 2222,
			user: 'agent',
		}),
		exec: () => createManagedExecProcessStub({ stdout: '' }),
		fs: createManagedVmFsStub(),
		getHostPid: () => hostPid,
		id: 'vm-instance-stub',
		setIngressRoutes: () => {},
	};
}

function createManagedVmStub(options: {
	readonly hostPid: number;
	readonly id: string;
}): ManagedVm {
	return {
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18_791 }),
		enableSsh: async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 2222,
			user: 'agent',
		}),
		exec: () => createManagedExecProcessStub({ stdout: '' }),
		fs: createManagedVmFsStub(),
		getHostPid: () => options.hostPid,
		getVmInstance: () => createVmInstanceStub(options.hostPid),
		id: options.id,
		setIngressRoutes: () => {},
	};
}

function buildSampleRecord(overrides: Partial<ToolVmRuntimeRecord> = {}): ToolVmRuntimeRecord {
	return {
		agentId: 'beta',
		configPath: '/etc/agent-vm/system.json',
		controllerPort: 18_800,
		createdAt: '2026-05-22T10:00:00.000Z',
		gateway: {
			sessionLabel: 'claw-tests-a1b2c3d4:sunfam:gateway',
			vmId: 'gateway-vm-instance-1',
		},
		leaseId: sampleLeaseId,
		processIdentity: {
			command: 'qemu-system-x86_64 -m 1G -smp 1 -kernel /vm-images/tool/kernel',
			lstart: 'Fri May 22 10:00:00 2026',
		},
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid: 48_282,
		recordId: sampleRecordId,
		schemaVersion: 1,
		sessionLabel: 'claw-tests-a1b2c3d4:sunfam:tool:0',
		tcpSlot: 0,
		vmId: 'tool-vm-instance-1',
		zoneId: 'sunfam',
		...overrides,
	};
}

function loadedRecords(
	results: Awaited<ReturnType<typeof loadAllToolVmRuntimeRecords>>,
): ToolVmRuntimeRecord[] {
	return results.flatMap((result) => (result.kind === 'loaded' ? [result.record] : []));
}

describe('tool-vm-runtime-record', () => {
	it('stores agent, lease, vm, and pid identity but rejects scopeKey', () => {
		const record = buildSampleRecord();

		expect(toolVmRuntimeRecordSchema.parse(record)).toMatchObject({
			agentId: 'beta',
			leaseId: sampleLeaseId,
			qemuPid: 48_282,
			recordId: sampleRecordId,
			tcpSlot: 0,
			vmId: 'tool-vm-instance-1',
		});

		expect(() =>
			toolVmRuntimeRecordSchema.parse({
				...record,
				scopeKey: 'agent:beta:discord:channel:123',
			}),
		).toThrow(ZodError);
	});

	it('uses recordId as the only filename identity', () => {
		const record = buildSampleRecord({
			leaseId: sampleLeaseId,
			recordId: sampleRecordId,
		});

		expect(toolVmRuntimeRecordFilename(record)).toBe(`${sampleRecordId}.json`);
	});

	it('round-trips write and load by recordId', async () => {
		const stateDir = await createStateDirectory();
		const record = buildSampleRecord();

		await writeToolVmRuntimeRecord(stateDir, record);

		const loaded = await loadToolVmRuntimeRecord(stateDir, record.recordId);
		expect(loaded).toEqual(record);
	});

	it('write places the record at $stateDir/tool-leases/<recordId>.json with 0600 perms', async () => {
		const stateDir = await createStateDirectory();
		const record = buildSampleRecord();

		await writeToolVmRuntimeRecord(stateDir, record);

		const recordPath = path.join(stateDir, 'tool-leases', `${record.recordId}.json`);
		const fileStat = await stat(recordPath);
		expect(fileStat.mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(recordPath, 'utf8')) as unknown).toEqual(record);
	});

	it('load returns null when the record file is missing', async () => {
		const stateDir = await createStateDirectory();

		const loaded = await loadToolVmRuntimeRecord(stateDir, sampleRecordId);

		expect(loaded).toBeNull();
	});

	it('loadAll returns an empty array when the tool-leases directory is missing', async () => {
		const stateDir = await createStateDirectory();

		const records = await loadAllToolVmRuntimeRecords(stateDir);

		expect(records).toEqual([]);
	});

	it('loadAll returns parse errors without mutating malformed files', async () => {
		const stateDir = await createStateDirectory();
		const leasesDirectory = path.join(stateDir, 'tool-leases');
		await writeToolVmRuntimeRecord(stateDir, buildSampleRecord());
		const malformedRecordPath = path.join(leasesDirectory, 'broken.json');
		await writeFile(malformedRecordPath, '{not-json');

		const results = await loadAllToolVmRuntimeRecords(stateDir);

		expect(results.map((result) => result.kind).toSorted()).toEqual(['loaded', 'parse-error']);
		expect(results.find((result) => result.kind === 'parse-error')).toMatchObject({
			path: malformedRecordPath,
		});
		expect(await readFile(malformedRecordPath, 'utf8')).toBe('{not-json');
	});

	it('loadAll returns loaded records sorted by createdAt', async () => {
		const stateDir = await createStateDirectory();
		const newer = buildSampleRecord({
			createdAt: '2026-05-22T10:00:01.000Z',
			leaseId: '01890f00-0000-7000-8000-000000000002',
			recordId: '01890f00-0000-7000-8000-000000000002',
		});
		const older = buildSampleRecord({
			createdAt: '2026-05-22T10:00:00.000Z',
			leaseId: '01890f00-0000-7000-8000-000000000001',
			recordId: '01890f00-0000-7000-8000-000000000001',
		});
		await writeToolVmRuntimeRecord(stateDir, newer);
		await writeToolVmRuntimeRecord(stateDir, older);

		const records = loadedRecords(await loadAllToolVmRuntimeRecords(stateDir));

		expect(records.map((record) => record.leaseId)).toEqual([older.leaseId, newer.leaseId]);
	});

	it('delete removes the record file when present and is idempotent when absent', async () => {
		const stateDir = await createStateDirectory();
		const record = buildSampleRecord();
		await writeToolVmRuntimeRecord(stateDir, record);

		await deleteToolVmRuntimeRecord(stateDir, record.recordId);
		await deleteToolVmRuntimeRecord(stateDir, record.recordId);

		const entries = await readdir(path.join(stateDir, 'tool-leases'));
		expect(entries).toEqual([]);
	});

	it('buildToolVmRuntimeRecord computes labels and captures process identity', async () => {
		const stubIdentity = {
			command: 'qemu-system-x86_64 -m 1G -smp 1',
			lstart: 'Fri May 22 10:00:00 2026',
		};

		const record = await buildToolVmRuntimeRecord({
			agentId: 'beta',
			controllerPort: 18_800,
			gateway: {
				sessionLabel: 'claw-tests-a1b2c3d4:sunfam:gateway',
				vmId: 'gateway-vm-instance-1',
			},
			leaseId: sampleLeaseId,
			managedVm: createManagedVmStub({ hostPid: 48_282, id: 'tool-vm-instance-1' }),
			projectNamespace: 'claw-tests-a1b2c3d4',
			readProcessIdentity: async () => stubIdentity,
			recordId: sampleRecordId,
			systemConfigPath: '/etc/agent-vm/system.json',
			tcpSlot: 0,
			zoneId: 'sunfam',
		});

		expect(record).toMatchObject({
			agentId: 'beta',
			configPath: '/etc/agent-vm/system.json',
			controllerPort: 18_800,
			gateway: {
				sessionLabel: 'claw-tests-a1b2c3d4:sunfam:gateway',
				vmId: 'gateway-vm-instance-1',
			},
			leaseId: sampleLeaseId,
			processIdentity: stubIdentity,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 48_282,
			recordId: sampleRecordId,
			schemaVersion: 1,
			sessionLabel: 'claw-tests-a1b2c3d4:sunfam:tool:0',
			tcpSlot: 0,
			vmId: 'tool-vm-instance-1',
			zoneId: 'sunfam',
		});
		expect(record).not.toHaveProperty('scopeKey');
		expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
	});

	it('buildToolVmRuntimeRecord throws when ps cannot resolve process identity', async () => {
		await expect(
			buildToolVmRuntimeRecord({
				agentId: 'beta',
				controllerPort: 18_800,
				gateway: {
					sessionLabel: 'claw-tests-a1b2c3d4:sunfam:gateway',
				},
				leaseId: sampleLeaseId,
				managedVm: createManagedVmStub({ hostPid: 48_282, id: 'tool-vm-instance-1' }),
				projectNamespace: 'claw-tests-a1b2c3d4',
				readProcessIdentity: async () => null,
				recordId: sampleRecordId,
				systemConfigPath: '/etc/agent-vm/system.json',
				tcpSlot: 3,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow(
			"Failed to capture process identity for Tool VM 'tool-vm-instance-1' pid 48282.",
		);
	});

	it('buildToolVmRuntimeRecord throws when getHostPid returns null', async () => {
		const managedVm = {
			...createManagedVmStub({ hostPid: 48_282, id: 'tool-vm-instance-1' }),
			getHostPid: () => null,
		} satisfies ManagedVm;

		await expect(
			buildToolVmRuntimeRecord({
				agentId: 'beta',
				controllerPort: 18_800,
				gateway: {
					sessionLabel: 'claw-tests-a1b2c3d4:sunfam:gateway',
				},
				leaseId: sampleLeaseId,
				managedVm,
				projectNamespace: 'claw-tests-a1b2c3d4',
				recordId: sampleRecordId,
				systemConfigPath: '/etc/agent-vm/system.json',
				tcpSlot: 3,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow('does not expose an active host pid');
	});

	it('buildToolVmRuntimeRecord throws when getHostPid returns an invalid pid', async () => {
		const managedVm = {
			...createManagedVmStub({ hostPid: 48_282, id: 'tool-vm-instance-1' }),
			getHostPid: () => 0,
		} satisfies ManagedVm;

		await expect(
			buildToolVmRuntimeRecord({
				agentId: 'beta',
				controllerPort: 18_800,
				gateway: {
					sessionLabel: 'claw-tests-a1b2c3d4:sunfam:gateway',
				},
				leaseId: sampleLeaseId,
				managedVm,
				projectNamespace: 'claw-tests-a1b2c3d4',
				recordId: sampleRecordId,
				systemConfigPath: '/etc/agent-vm/system.json',
				tcpSlot: 3,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow('invalid host pid');
	});

	it('write rejects invalid records before touching disk', async () => {
		const stateDir = await createStateDirectory();
		const invalidRecord = {
			...buildSampleRecord(),
			recordId: 'not-a-uuid',
		};

		await expect(writeToolVmRuntimeRecord(stateDir, invalidRecord)).rejects.toThrow(ZodError);

		await expect(readdir(path.join(stateDir, 'tool-leases'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
});
