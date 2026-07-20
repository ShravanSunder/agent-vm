import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import type { ControllerToolLeaseRecordsTarget } from '../durable-state/controller-state-record-paths.js';
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
const gatewayIdentity = {
	bootId: 'boot-a',
	controllerEpoch: 'controller-epoch-a',
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-instance-1',
	generationId: 'generation-a',
	zoneId: 'sunfam',
} as const;

afterEach(async () => {
	const directoriesToDelete = createdDirectories.splice(0);
	await Promise.all(
		directoriesToDelete.map(async (directoryPath) => {
			await rm(directoryPath, { force: true, recursive: true });
		}),
	);
});

async function createToolLeaseRecordsTarget(
	zoneId: string = gatewayIdentity.zoneId,
): Promise<ControllerToolLeaseRecordsTarget> {
	const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-tool-vm-record-'));
	createdDirectories.push(temporaryDirectoryPath);
	return {
		directoryPath: path.join(temporaryDirectoryPath, 'controller-tool-lease-records'),
		kind: 'controller-tool-lease-records',
		zoneId,
	};
}

function createManagedVmStub(options: {
	readonly hostPid: number;
	readonly id: string;
}): ManagedVm {
	return {
		close: async () => {},
		configureIngressRoutes: () => {},
		enableIngress: async () => ({ close: async () => {}, host: '127.0.0.1', port: 18_791 }),
		enableSsh: async () => ({
			close: async () => {},
			serverHostKey: TEST_SSH_SERVER_HOST_KEY,
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 2222,
			user: 'agent',
		}),
		exec: () => createManagedExecProcessStub({ stdout: '' }),
		getHostProcessId: () => options.hostPid,
		id: options.id,
		start: async () => {},
	};
}

function buildSampleRecord(overrides: Partial<ToolVmRuntimeRecord> = {}): ToolVmRuntimeRecord {
	return {
		agentId: 'beta',
		configPath: '/etc/agent-vm/system.json',
		controllerPort: 18_800,
		createdAt: '2026-05-22T10:00:00.000Z',
		gateway: gatewayIdentity,
		leaseId: sampleLeaseId,
		processIdentity: {
			command: 'qemu-system-x86_64 -m 1G -smp 1 -kernel /vm-images/tool/kernel',
			lstart: 'Fri May 22 10:00:00 2026',
		},
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid: 48_282,
		recordId: sampleRecordId,
		schemaVersion: 2,
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
	it('rejects schema-v1 and unknown newer Tool VM runtime records', () => {
		expect(() =>
			toolVmRuntimeRecordSchema.parse({ ...buildSampleRecord(), schemaVersion: 1 }),
		).toThrow(ZodError);
		expect(() =>
			toolVmRuntimeRecordSchema.parse({ ...buildSampleRecord(), schemaVersion: 3 }),
		).toThrow(ZodError);
	});

	it('requires the exact parent Gateway epoch identity', () => {
		const { gateway: _gateway, ...recordWithoutGatewayIdentity } = buildSampleRecord();

		expect(() => toolVmRuntimeRecordSchema.parse(recordWithoutGatewayIdentity)).toThrow(ZodError);
		expect(() =>
			toolVmRuntimeRecordSchema.parse({
				...buildSampleRecord(),
				gateway: { ...gatewayIdentity, gatewayVmId: undefined },
			}),
		).toThrow(ZodError);
		expect(() =>
			toolVmRuntimeRecordSchema.parse({
				...buildSampleRecord(),
				gateway: { ...gatewayIdentity, zoneId: 'different-zone' },
			}),
		).toThrow(/must match the Tool VM runtime record zone/u);
	});

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
		const recordsTarget = await createToolLeaseRecordsTarget();
		const record = buildSampleRecord();

		await writeToolVmRuntimeRecord(recordsTarget, record);

		const loaded = await loadToolVmRuntimeRecord(recordsTarget, record.recordId);
		expect(loaded).toEqual(record);
	});

	it('writes directly to the typed Tool lease collection with 0600 permissions', async () => {
		const recordsTarget = await createToolLeaseRecordsTarget();
		const record = buildSampleRecord();

		await writeToolVmRuntimeRecord(recordsTarget, record);

		const recordPath = path.join(recordsTarget.directoryPath, `${record.recordId}.json`);
		const fileStat = await stat(recordPath);
		expect(fileStat.mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(recordPath, 'utf8')) as unknown).toEqual(record);
	});

	it('load returns null when the record file is missing', async () => {
		const recordsTarget = await createToolLeaseRecordsTarget();

		const loaded = await loadToolVmRuntimeRecord(recordsTarget, sampleRecordId);

		expect(loaded).toBeNull();
	});

	it('loadAll returns an empty array when the typed collection directory is missing', async () => {
		const recordsTarget = await createToolLeaseRecordsTarget();

		const records = await loadAllToolVmRuntimeRecords(recordsTarget);

		expect(records).toEqual([]);
	});

	it('loadAll returns parse errors without mutating malformed files', async () => {
		const recordsTarget = await createToolLeaseRecordsTarget();
		const leasesDirectory = recordsTarget.directoryPath;
		await writeToolVmRuntimeRecord(recordsTarget, buildSampleRecord());
		const malformedRecordPath = path.join(leasesDirectory, 'broken.json');
		await writeFile(malformedRecordPath, '{not-json');

		const results = await loadAllToolVmRuntimeRecords(recordsTarget);

		expect(results.map((result) => result.kind).toSorted()).toEqual(['loaded', 'parse-error']);
		expect(results.find((result) => result.kind === 'parse-error')).toMatchObject({
			path: malformedRecordPath,
		});
		expect(await readFile(malformedRecordPath, 'utf8')).toBe('{not-json');
	});

	it('loadAll returns loaded records sorted by createdAt', async () => {
		const recordsTarget = await createToolLeaseRecordsTarget();
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
		await writeToolVmRuntimeRecord(recordsTarget, newer);
		await writeToolVmRuntimeRecord(recordsTarget, older);

		const records = loadedRecords(await loadAllToolVmRuntimeRecords(recordsTarget));

		expect(records.map((record) => record.leaseId)).toEqual([older.leaseId, newer.leaseId]);
	});

	it('delete removes the record file when present and is idempotent when absent', async () => {
		const recordsTarget = await createToolLeaseRecordsTarget();
		const record = buildSampleRecord();
		await writeToolVmRuntimeRecord(recordsTarget, record);

		await deleteToolVmRuntimeRecord(recordsTarget, record.recordId);
		await deleteToolVmRuntimeRecord(recordsTarget, record.recordId);

		const entries = await readdir(recordsTarget.directoryPath);
		expect(entries).toEqual([]);
	});

	it('rejects malformed record ids before deriving a Tool lease record path', async () => {
		const recordsTarget = await createToolLeaseRecordsTarget();

		await expect(loadToolVmRuntimeRecord(recordsTarget, '../escape')).rejects.toThrow(ZodError);
		await expect(deleteToolVmRuntimeRecord(recordsTarget, '../escape')).rejects.toThrow(ZodError);
		await expect(readdir(recordsTarget.directoryPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('rejects cross-zone records on write, direct load, and collection load', async () => {
		const foreignRecordsTarget = await createToolLeaseRecordsTarget('zone-b');
		const localRecordsTarget = {
			...foreignRecordsTarget,
			zoneId: gatewayIdentity.zoneId,
		} satisfies ControllerToolLeaseRecordsTarget;
		const foreignRecord = buildSampleRecord({
			gateway: { ...gatewayIdentity, zoneId: 'zone-b' },
			zoneId: 'zone-b',
		});
		await writeToolVmRuntimeRecord(foreignRecordsTarget, foreignRecord);

		await expect(writeToolVmRuntimeRecord(localRecordsTarget, foreignRecord)).rejects.toThrow(
			/record zone.*zone-b.*target zone.*sunfam/iu,
		);
		await expect(
			loadToolVmRuntimeRecord(localRecordsTarget, foreignRecord.recordId),
		).rejects.toThrow(/record zone.*zone-b.*target zone.*sunfam/iu);
		const results = await loadAllToolVmRuntimeRecords(localRecordsTarget);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			kind: 'parse-error',
			path: path.join(localRecordsTarget.directoryPath, `${foreignRecord.recordId}.json`),
		});
	});

	it('buildToolVmRuntimeRecord computes labels and captures process identity', async () => {
		const stubIdentity = {
			command: 'qemu-system-x86_64 -m 1G -smp 1',
			lstart: 'Fri May 22 10:00:00 2026',
		};

		const record = await buildToolVmRuntimeRecord({
			agentId: 'beta',
			controllerPort: 18_800,
			gatewayIdentity,
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
			gateway: gatewayIdentity,
			leaseId: sampleLeaseId,
			processIdentity: stubIdentity,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 48_282,
			recordId: sampleRecordId,
			schemaVersion: 2,
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
				gatewayIdentity,
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
			getHostProcessId: () => null,
		} satisfies ManagedVm;

		await expect(
			buildToolVmRuntimeRecord({
				agentId: 'beta',
				controllerPort: 18_800,
				gatewayIdentity,
				leaseId: sampleLeaseId,
				managedVm,
				projectNamespace: 'claw-tests-a1b2c3d4',
				recordId: sampleRecordId,
				systemConfigPath: '/etc/agent-vm/system.json',
				tcpSlot: 3,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow('does not expose an active host process id');
	});

	it('buildToolVmRuntimeRecord throws when getHostProcessId returns an invalid pid', async () => {
		const managedVm = {
			...createManagedVmStub({ hostPid: 48_282, id: 'tool-vm-instance-1' }),
			getHostProcessId: () => 0,
		} satisfies ManagedVm;

		await expect(
			buildToolVmRuntimeRecord({
				agentId: 'beta',
				controllerPort: 18_800,
				gatewayIdentity,
				leaseId: sampleLeaseId,
				managedVm,
				projectNamespace: 'claw-tests-a1b2c3d4',
				recordId: sampleRecordId,
				systemConfigPath: '/etc/agent-vm/system.json',
				tcpSlot: 3,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow('invalid host process id');
	});

	it('write rejects invalid records before touching disk', async () => {
		const recordsTarget = await createToolLeaseRecordsTarget();
		const invalidRecord = {
			...buildSampleRecord(),
			recordId: 'not-a-uuid',
		};

		await expect(writeToolVmRuntimeRecord(recordsTarget, invalidRecord)).rejects.toThrow(ZodError);

		await expect(readdir(recordsTarget.directoryPath)).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
});
