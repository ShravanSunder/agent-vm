import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm, ManagedVmInstance } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it } from 'vitest';

import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../../testing/managed-vm-test-helpers.js';
import {
	buildToolVmRuntimeRecord,
	deleteToolVmRuntimeRecord,
	loadAllToolVmRuntimeRecords,
	loadToolVmRuntimeRecord,
	quarantineToolVmRuntimeRecord,
	type ToolVmRuntimeRecord,
	writeToolVmRuntimeRecord,
} from './tool-vm-runtime-record.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

function createStateDirectory(): string {
	const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-tool-vm-record-'));
	createdDirectories.push(directoryPath);
	return directoryPath;
}

function createVmInstanceStub(hostPid: number): ManagedVmInstance {
	return {
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
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

function createManagedVmStub(options: { id: string; hostPid: number }): ManagedVm {
	return {
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
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
		configPath: '/etc/agent-vm/system.json',
		controllerPort: 18800,
		createdAt: '2026-05-22T10:00:00.000Z',
		leaseId: 'sunfam-agentA-1700000000000',
		processIdentity: {
			command: 'qemu-system-x86_64 -m 1G -smp 1 -kernel /vm-images/tool/kernel',
			lstart: 'Fri May 22 10:00:00 2026',
		},
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid: 48282,
		schemaVersion: 1,
		scopeKey: 'agentA',
		sessionLabel: 'claw-tests-a1b2c3d4:sunfam:tool:3',
		tcpSlot: 3,
		vmId: 'tool-vm-instance-1',
		zoneId: 'sunfam',
		...overrides,
	};
}

describe('tool-vm-runtime-record', () => {
	it('round-trips write + load', async () => {
		const stateDir = createStateDirectory();
		const record = buildSampleRecord();
		await writeToolVmRuntimeRecord(stateDir, record);
		const loaded = await loadToolVmRuntimeRecord(stateDir, record.leaseId);
		expect(loaded).toEqual(record);
	});

	it('write places the record at $stateDir/tool-leases/<leaseId>.json with 0600 perms', async () => {
		const stateDir = createStateDirectory();
		const record = buildSampleRecord();
		await writeToolVmRuntimeRecord(stateDir, record);
		const recordPath = path.join(stateDir, 'tool-leases', `${record.leaseId}.json`);
		const stat = fs.statSync(recordPath);
		// File mode lower 9 bits
		expect(stat.mode & 0o777).toBe(0o600);
		// Round-trip via reading the file directly
		const raw = await readFile(recordPath, 'utf8');
		expect(JSON.parse(raw)).toEqual(record);
	});

	it('load returns null when the record file is missing', async () => {
		const stateDir = createStateDirectory();
		const loaded = await loadToolVmRuntimeRecord(stateDir, 'no-such-lease');
		expect(loaded).toBeNull();
	});

	it('load quarantines and returns null on malformed JSON', async () => {
		const stateDir = createStateDirectory();
		const leaseId = 'sunfam-agentA-malformed';
		fs.mkdirSync(path.join(stateDir, 'tool-leases'), { recursive: true });
		fs.writeFileSync(path.join(stateDir, 'tool-leases', `${leaseId}.json`), '{not-json');
		const messages: string[] = [];
		const loaded = await loadToolVmRuntimeRecord(stateDir, leaseId, {
			log: (message) => messages.push(message),
		});
		expect(loaded).toBeNull();
		const entries = fs.readdirSync(path.join(stateDir, 'tool-leases'));
		expect(entries.some((entry) => entry.includes('.invalid.'))).toBe(true);
		expect(
			messages.some((message) => /Quarantined malformed tool VM runtime record/.test(message)),
		).toBe(true);
	});

	it('load quarantines and returns null on schema mismatch', async () => {
		const stateDir = createStateDirectory();
		const leaseId = 'sunfam-agentA-bad-shape';
		fs.mkdirSync(path.join(stateDir, 'tool-leases'), { recursive: true });
		fs.writeFileSync(
			path.join(stateDir, 'tool-leases', `${leaseId}.json`),
			JSON.stringify({ leaseId, qemuPid: 'not-a-number' }),
		);
		const loaded = await loadToolVmRuntimeRecord(stateDir, leaseId, { log: () => {} });
		expect(loaded).toBeNull();
		const entries = fs.readdirSync(path.join(stateDir, 'tool-leases'));
		expect(entries.some((entry) => entry.includes('.invalid.'))).toBe(true);
	});

	it('load quarantines a record that is missing required schemaVersion or processIdentity', async () => {
		// Records lacking the v1-required fields (e.g. a record from a future
		// schema version that drops or renames a field) must fail safeParse,
		// trigger quarantine, and return null. We do NOT silently backfill —
		// there is no legacy/v0 on-disk format in production for tool VMs.
		const stateDir = createStateDirectory();
		const leaseId = 'sunfam-agentA-missing-version';
		fs.mkdirSync(path.join(stateDir, 'tool-leases'), { recursive: true });
		fs.writeFileSync(
			path.join(stateDir, 'tool-leases', `${leaseId}.json`),
			JSON.stringify({
				configPath: '/etc/agent-vm/system.json',
				controllerPort: 18800,
				createdAt: '2026-05-22T10:00:00.000Z',
				leaseId,
				projectNamespace: 'claw-tests-a1b2c3d4',
				qemuPid: 48282,
				// missing: schemaVersion, processIdentity
				scopeKey: 'agentA',
				sessionLabel: 'claw-tests-a1b2c3d4:sunfam:tool:3',
				tcpSlot: 3,
				vmId: 'tool-vm-instance-1',
				zoneId: 'sunfam',
			}),
		);
		const loaded = await loadToolVmRuntimeRecord(stateDir, leaseId, { log: () => {} });
		expect(loaded).toBeNull();
		const entries = fs.readdirSync(path.join(stateDir, 'tool-leases'));
		expect(entries.some((entry) => entry.includes('.invalid.'))).toBe(true);
	});

	it('loadAll returns an empty array when the tool-leases directory is missing', async () => {
		const stateDir = createStateDirectory();
		const records = await loadAllToolVmRuntimeRecords(stateDir);
		expect(records).toEqual([]);
	});

	it('loadAll skips quarantined and invalid files', async () => {
		const stateDir = createStateDirectory();
		const validRecord = buildSampleRecord({ leaseId: 'sunfam-agentA-1' });
		await writeToolVmRuntimeRecord(stateDir, validRecord);
		// Hand-create quarantined + invalid files alongside the valid one.
		const dir = path.join(stateDir, 'tool-leases');
		fs.writeFileSync(
			path.join(dir, 'sunfam-agentA-2.quarantined.1700000001000.json'),
			JSON.stringify(buildSampleRecord({ leaseId: 'sunfam-agentA-2' })),
		);
		fs.writeFileSync(
			path.join(dir, 'sunfam-agentA-3.invalid.1700000002000.json'),
			JSON.stringify(buildSampleRecord({ leaseId: 'sunfam-agentA-3' })),
		);
		const records = await loadAllToolVmRuntimeRecords(stateDir, { log: () => {} });
		expect(records).toHaveLength(1);
		expect(records[0]?.leaseId).toBe('sunfam-agentA-1');
	});

	it('loadAll returns records sorted by createdAt', async () => {
		const stateDir = createStateDirectory();
		const newer = buildSampleRecord({
			createdAt: '2026-05-22T10:00:01.000Z',
			leaseId: 'sunfam-agentA-newer',
		});
		const older = buildSampleRecord({
			createdAt: '2026-05-22T10:00:00.000Z',
			leaseId: 'sunfam-agentB-older',
		});
		await writeToolVmRuntimeRecord(stateDir, newer);
		await writeToolVmRuntimeRecord(stateDir, older);
		const records = await loadAllToolVmRuntimeRecords(stateDir);
		expect(records.map((record) => record.leaseId)).toEqual([older.leaseId, newer.leaseId]);
	});

	it('delete removes the record file when present, no-op when absent', async () => {
		const stateDir = createStateDirectory();
		const record = buildSampleRecord();
		await writeToolVmRuntimeRecord(stateDir, record);
		expect(fs.existsSync(path.join(stateDir, 'tool-leases', `${record.leaseId}.json`))).toBe(true);
		await deleteToolVmRuntimeRecord(stateDir, record.leaseId);
		expect(fs.existsSync(path.join(stateDir, 'tool-leases', `${record.leaseId}.json`))).toBe(false);
		// Idempotent
		await deleteToolVmRuntimeRecord(stateDir, record.leaseId);
	});

	it('quarantine renames the record to <leaseId>.quarantined.<ts>.json', async () => {
		const stateDir = createStateDirectory();
		const record = buildSampleRecord();
		await writeToolVmRuntimeRecord(stateDir, record);
		const messages: string[] = [];
		await quarantineToolVmRuntimeRecord(stateDir, record.leaseId, {
			log: (message) => messages.push(message),
			reason: 'scope mismatch',
		});
		const entries = fs.readdirSync(path.join(stateDir, 'tool-leases'));
		expect(entries.some((entry) => entry.startsWith(`${record.leaseId}.quarantined.`))).toBe(true);
		expect(entries.includes(`${record.leaseId}.json`)).toBe(false);
		expect(messages.some((message) => /scope mismatch/.test(message))).toBe(true);
	});

	it('quarantine is a no-op when the record is already absent', async () => {
		const stateDir = createStateDirectory();
		await quarantineToolVmRuntimeRecord(stateDir, 'no-such-lease', {
			log: () => {},
			reason: 'whatever',
		});
		// no throw, no side effects
	});

	it('buildToolVmRuntimeRecord computes sessionLabel + captures processIdentity + schemaVersion', async () => {
		const stubIdentity = {
			command: 'qemu-system-x86_64 -m 1G -smp 1',
			lstart: 'Fri May 22 10:00:00 2026',
		};
		const record = await buildToolVmRuntimeRecord({
			controllerPort: 18800,
			leaseId: 'sunfam-agentA-1700000000000',
			managedVm: createManagedVmStub({ hostPid: 48282, id: 'tool-vm-instance-1' }),
			projectNamespace: 'claw-tests-a1b2c3d4',
			readProcessIdentity: async () => stubIdentity,
			scopeKey: 'agentA',
			systemConfigPath: '/etc/agent-vm/system.json',
			tcpSlot: 3,
			zoneId: 'sunfam',
		});
		expect(record).toMatchObject({
			configPath: '/etc/agent-vm/system.json',
			controllerPort: 18800,
			leaseId: 'sunfam-agentA-1700000000000',
			processIdentity: stubIdentity,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 48282,
			schemaVersion: 1,
			scopeKey: 'agentA',
			sessionLabel: 'claw-tests-a1b2c3d4:sunfam:tool:3',
			tcpSlot: 3,
			vmId: 'tool-vm-instance-1',
			zoneId: 'sunfam',
		});
		expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
	});

	it('buildToolVmRuntimeRecord throws when ps cannot resolve process identity', async () => {
		await expect(
			buildToolVmRuntimeRecord({
				controllerPort: 18800,
				leaseId: 'sunfam-agentA-1700000000000',
				managedVm: createManagedVmStub({ hostPid: 48282, id: 'tool-vm-instance-1' }),
				projectNamespace: 'claw-tests-a1b2c3d4',
				readProcessIdentity: async () => null,
				scopeKey: 'agentA',
				systemConfigPath: '/etc/agent-vm/system.json',
				tcpSlot: 3,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow(/Failed to capture process identity/u);
	});

	it('buildToolVmRuntimeRecord throws when Gondolin does not expose an active host PID', async () => {
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({
				command: 'ssh ...',
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 2222,
				user: 'agent',
			}),
			exec: () => createManagedExecProcessStub({ stdout: '' }),
			fs: createManagedVmFsStub(),
			getHostPid: () => null,
			getVmInstance: () => createVmInstanceStub(48282),
			id: 'tool-vm-no-pid',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;

		await expect(
			buildToolVmRuntimeRecord({
				controllerPort: 18800,
				leaseId: 'sunfam-agentA-1700000000000',
				managedVm,
				projectNamespace: 'claw-tests-a1b2c3d4',
				readProcessIdentity: async () => null,
				scopeKey: 'agentA',
				systemConfigPath: '/etc/agent-vm/system.json',
				tcpSlot: 3,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow(/does not expose an active host pid/u);
	});

	it('buildToolVmRuntimeRecord throws when the Managed VM wrapper is missing getHostPid', async () => {
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({
				command: 'ssh ...',
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 2222,
				user: 'agent',
			}),
			exec: () => createManagedExecProcessStub({ stdout: '' }),
			fs: createManagedVmFsStub(),
			getVmInstance: () => createVmInstanceStub(48282),
			id: 'tool-vm-no-getHostPid',
			setIngressRoutes: () => {},
		} as unknown as ManagedVm;

		await expect(
			buildToolVmRuntimeRecord({
				controllerPort: 18800,
				leaseId: 'sunfam-agentA-1700000000000',
				managedVm,
				projectNamespace: 'claw-tests-a1b2c3d4',
				readProcessIdentity: async () => null,
				scopeKey: 'agentA',
				systemConfigPath: '/etc/agent-vm/system.json',
				tcpSlot: 3,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow(/missing getHostPid/u);
	});

	it('buildToolVmRuntimeRecord throws when Gondolin exposes an invalid host PID', async () => {
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({
				command: 'ssh ...',
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 2222,
				user: 'agent',
			}),
			exec: () => createManagedExecProcessStub({ stdout: '' }),
			fs: createManagedVmFsStub(),
			getHostPid: () => 0,
			getVmInstance: () => createVmInstanceStub(48282),
			id: 'tool-vm-invalid-pid',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;

		await expect(
			buildToolVmRuntimeRecord({
				controllerPort: 18800,
				leaseId: 'sunfam-agentA-1700000000000',
				managedVm,
				projectNamespace: 'claw-tests-a1b2c3d4',
				readProcessIdentity: async () => null,
				scopeKey: 'agentA',
				systemConfigPath: '/etc/agent-vm/system.json',
				tcpSlot: 3,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow(/invalid host pid/u);
	});

	it('write rejects invalid runtime records before touching disk', async () => {
		const stateDir = createStateDirectory();
		const invalidRecord = {
			...buildSampleRecord(),
			qemuPid: -1,
		} as ToolVmRuntimeRecord;
		await expect(writeToolVmRuntimeRecord(stateDir, invalidRecord)).rejects.toThrow();
		// no tool-leases dir should have been created with a file
		const dir = path.join(stateDir, 'tool-leases');
		const exists = fs.existsSync(dir);
		if (exists) {
			expect(fs.readdirSync(dir)).toEqual([]);
		}
	});

	it('write refuses to derive a path from a leaseId containing parent-dir segments', async () => {
		const stateDir = createStateDirectory();
		const escapingRecord = buildSampleRecord({
			leaseId: 'shravan-agent:main:../../../escape-1700000000000',
		});
		await expect(writeToolVmRuntimeRecord(stateDir, escapingRecord)).rejects.toThrow(
			/unsafe leaseId/u,
		);
		// Nothing should exist outside tool-leases/
		const parentEscape = path.join(stateDir, '..', 'escape-1700000000000.json');
		expect(fs.existsSync(parentEscape)).toBe(false);
	});

	it('write refuses to derive a path from a leaseId containing path separators', async () => {
		const stateDir = createStateDirectory();
		const escapingRecord = buildSampleRecord({
			leaseId: 'shravan/agent-main-1700000000000',
		});
		await expect(writeToolVmRuntimeRecord(stateDir, escapingRecord)).rejects.toThrow(
			/unsafe leaseId/u,
		);
	});

	it('quarantine refuses to operate on an unsafe leaseId', async () => {
		const stateDir = createStateDirectory();
		await expect(
			quarantineToolVmRuntimeRecord(stateDir, '../escape', {
				log: () => {},
				reason: 'whatever',
			}),
		).rejects.toThrow(/unsafe leaseId/u);
	});

	it('delete refuses to operate on an unsafe leaseId', async () => {
		const stateDir = createStateDirectory();
		await expect(deleteToolVmRuntimeRecord(stateDir, '../escape')).rejects.toThrow(
			/unsafe leaseId/u,
		);
	});
});
