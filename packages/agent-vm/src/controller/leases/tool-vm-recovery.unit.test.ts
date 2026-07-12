import { describe, expect, it, vi } from 'vitest';

import type { PortOwner } from '../../shared/port-owner.js';
import { cleanupRecordedToolVmRuntimes } from './tool-vm-recovery.js';
import type {
	ToolVmRuntimeRecord,
	ToolVmRuntimeRecordLoadResult,
} from './tool-vm-runtime-record.js';

interface DeferredPromise<TResult> {
	readonly promise: Promise<TResult>;
	readonly resolve: (result: TResult) => void;
}

function createDeferredPromise<TResult>(): DeferredPromise<TResult> {
	let resolveDeferred: ((result: TResult) => void) | null = null;
	const promise = new Promise<TResult>((resolve) => {
		resolveDeferred = resolve;
	});
	return {
		promise,
		resolve: (result: TResult): void => {
			if (resolveDeferred === null) {
				throw new Error('Deferred promise resolve callback was not initialized.');
			}
			resolveDeferred(result);
		},
	};
}

function createToolVmRuntimeRecord(
	overrides: Partial<ToolVmRuntimeRecord> = {},
): ToolVmRuntimeRecord {
	return {
		configPath: '/deployments/shravan-claw/config/system.json',
		controllerPort: 18800,
		createdAt: '2026-04-13T12:34:56.000Z',
		agentId: 'agentA',
		gateway: {
			bootId: 'boot-a',
			controllerEpoch: 'controller-epoch-a',
			gatewayEpochId: 'gateway-epoch-a',
			gatewayVmId: 'gateway-vm-instance-1',
			generationId: 'generation-a',
			zoneId: 'sunfam',
		},
		leaseId: 'sunfam-agentA-1700000000000',
		processIdentity: {
			command: 'qemu-system-x86_64 -m 1G -smp 1 -kernel /vm-images/tool/kernel',
			lstart: 'Mon Apr 13 12:34:56 2026',
		},
		projectNamespace: 'shravan-claw-463c3e5f',
		qemuPid: 48282,
		recordId: '01890f00-0000-7000-8000-000000000001',
		schemaVersion: 2,
		sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:3',
		tcpSlot: 3,
		vmId: 'tool-vm-instance-1',
		zoneId: 'sunfam',
		...overrides,
	};
}

function loadedToolVmRuntimeRecords(
	...records: readonly ToolVmRuntimeRecord[]
): ToolVmRuntimeRecordLoadResult[] {
	return records.map((record) => ({
		kind: 'loaded',
		path: `/state/${record.zoneId}/tool-leases/${record.recordId}.json`,
		record,
	}));
}

function createCleanupOptions(
	overrides: Partial<Parameters<typeof cleanupRecordedToolVmRuntimes>[0]> = {},
): Parameters<typeof cleanupRecordedToolVmRuntimes>[0] {
	return {
		expectedConfigPath: '/deployments/shravan-claw/config/system.json',
		expectedControllerPort: 18800,
		projectNamespace: 'shravan-claw-463c3e5f',
		stateDir: '/state/sunfam',
		zoneId: 'sunfam',
		...overrides,
	};
}

// `readProcessIdentity` returning the same identity as the recorded one
// simulates production: ps confirms the PID is still the same QEMU instance.
function buildMatchingIdentityResolver(
	record: ToolVmRuntimeRecord,
): (pid: number) => Promise<{ command: string; lstart: string } | null> {
	return async (pid) => (pid === record.qemuPid ? record.processIdentity : null);
}

describe('cleanupRecordedToolVmRuntimes', () => {
	it('returns zero counts when no records exist', async () => {
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				projectNamespace: 'shravan-claw-463c3e5f',
				stateDir: '/state/sunfam',
				zoneId: 'sunfam',
			},
			{
				loadAllToolVmRuntimeRecords: async () => [],
				log: () => {},
			},
		);
		expect(result).toEqual({ cleanedCount: 0, killedPids: [], quarantinedCount: 0, warnings: [] });
	});

	it('skips without signaling when a tool VM port is held by a different pid', async () => {
		const record = createToolVmRuntimeRecord({
			qemuPid: 111,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});
		const killProcess = vi.fn();
		const logMessages: string[] = [];

		const result = await cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'in-process-recovery' }),
			{
				killProcess,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: (message) => {
					logMessages.push(message);
				},
				portForSlot: () => 19_500,
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			},
		);

		expect(killProcess).not.toHaveBeenCalled();
		expect(result.cleanedCount).toBe(0);
		expect(result.warnings.join('\n')).toContain('cannot reuse port 19500');
		expect(logMessages.join('\n')).toContain('cannot reuse port 19500');
	});

	it('throws in offline cleanup when a tool VM port is held by a different pid', async () => {
		const record = createToolVmRuntimeRecord({
			qemuPid: 111,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});
		const killProcess = vi.fn();

		await expect(
			cleanupRecordedToolVmRuntimes(createCleanupOptions({ mode: 'offline-cleanup' }), {
				killProcess,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				portForSlot: () => 19_500,
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			}),
		).rejects.toThrow(/cannot reuse port 19500 because it is held by pid 222/u);
		expect(killProcess).not.toHaveBeenCalled();
	});

	it('does not mistake a controller-owned Tool SSH listener for the VM runner', async () => {
		const record = createToolVmRuntimeRecord({
			qemuPid: 111,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});
		const killProcess = vi.fn();

		const result = await cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'in-process-recovery' }),
			{
				killProcess,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: () => {},
				portForSlot: () => 19_500,
				readTcpListenPortOwner: async () => ({ command: 'node agent-vm controller', pid: 333 }),
			},
		);

		expect(killProcess).not.toHaveBeenCalled();
		expect(result.cleanedCount).toBe(0);
		expect(result.warnings.join('\n')).toContain(
			'Stock Gondolin owns the Tool SSH listener in the controller process',
		);
	});

	it('refuses slot reuse even when a listener happens to report the recorded VM pid', async () => {
		const record = createToolVmRuntimeRecord({
			qemuPid: 111,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});
		const killProcess = vi.fn();

		const result = await cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'in-process-recovery' }),
			{
				killProcess,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: () => {},
				portForSlot: () => 19_500,
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 111 }),
			},
		);

		expect(killProcess).not.toHaveBeenCalled();
		expect(result.cleanedCount).toBe(0);
		expect(result.warnings.join('\n')).toContain('cannot reuse port 19500');
	});

	it('kills the recorded qemu pid and deletes the record when scope matches', async () => {
		const killProcess = vi.fn();
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const record = createToolVmRuntimeRecord();
		// isProcessAlive sequence: alive at entry → alive at first liveness probe →
		// dead before SIGTERM grace expires (simulates a well-behaved QEMU
		// honoring SIGTERM after one poll cycle).
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				projectNamespace: 'shravan-claw-463c3e5f',
				stateDir: '/state/sunfam',
				zoneId: 'sunfam',
			},
			{
				deleteToolVmRuntimeRecord,
				isProcessAlive,
				killProcess,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: () => {},
				readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
				readProcessIdentity: buildMatchingIdentityResolver(record),
				sleep: async () => {},
			},
		);
		expect(killProcess).toHaveBeenCalledWith(48282, 'SIGTERM');
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith('/state/sunfam', record.recordId);
		expect(result).toMatchObject({
			cleanedCount: 1,
			killedPids: [48282],
			quarantinedCount: 0,
		});
	});

	it('skips signaling when the recorded pid is already dead and still deletes the record', async () => {
		const killProcess = vi.fn();
		const readProcessCommand = vi.fn(async () => null);
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				projectNamespace: 'shravan-claw-463c3e5f',
				stateDir: '/state/sunfam',
				zoneId: 'sunfam',
			},
			{
				deleteToolVmRuntimeRecord,
				isProcessAlive: () => false,
				killProcess,
				loadAllToolVmRuntimeRecords: async () =>
					loadedToolVmRuntimeRecords(createToolVmRuntimeRecord()),
				log: () => {},
				readProcessCommand,
				sleep: async () => {},
			},
		);
		expect(killProcess).not.toHaveBeenCalled();
		expect(readProcessCommand).not.toHaveBeenCalled();
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ cleanedCount: 1, killedPids: [], quarantinedCount: 0 });
	});

	it('kills the recorded qemu pid before deleting when the tool VM port is already free', async () => {
		const killProcess = vi.fn();
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const record = createToolVmRuntimeRecord({
			qemuPid: 111,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);

		const result = await cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'in-process-recovery' }),
			{
				deleteToolVmRuntimeRecord,
				isProcessAlive,
				killProcess,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: () => {},
				portForSlot: () => 19_500,
				readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
				readProcessIdentity: buildMatchingIdentityResolver(record),
				readTcpListenPortOwner: async () => null,
				sleep: async () => {},
			},
		);

		expect(killProcess).toHaveBeenCalledWith(111, 'SIGTERM');
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith('/state/sunfam', record.recordId);
		expect(result).toMatchObject({
			cleanedCount: 1,
			killedPids: [111],
			quarantinedCount: 0,
		});
	});

	it('refuses to delete a port-free tool VM record when the recorded pid was reused', async () => {
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const killProcess = vi.fn();
		const record = createToolVmRuntimeRecord({
			qemuPid: 111,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});

		await expect(
			cleanupRecordedToolVmRuntimes(createCleanupOptions({ mode: 'offline-cleanup' }), {
				deleteToolVmRuntimeRecord,
				isProcessAlive: () => true,
				killProcess,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: () => {},
				portForSlot: () => 19_500,
				readProcessCommand: async () => 'node /tmp/not-tool-vm.js',
				readProcessIdentity: async () => ({
					command: 'node /tmp/not-tool-vm.js',
					lstart: 'Tue Apr 14 15:00:00 2026',
				}),
				readTcpListenPortOwner: async () => null,
				sleep: async () => {},
			}),
		).rejects.toThrow(/refusing SIGTERM to pid 111: process identity changed/u);
		expect(killProcess).not.toHaveBeenCalled();
		expect(deleteToolVmRuntimeRecord).not.toHaveBeenCalled();
	});

	it('refuses to signal when the live PID identity does not match the recorded one (PID reuse defense)', async () => {
		const killProcess = vi.fn();
		// Recorded identity is the original QEMU; live identity is a different
		// process (different start time + different command) on the same PID.
		// Cleanup must REFUSE the signal.
		await expect(
			cleanupRecordedToolVmRuntimes(
				{
					expectedConfigPath: '/deployments/shravan-claw/config/system.json',
					expectedControllerPort: 18800,
					projectNamespace: 'shravan-claw-463c3e5f',
					stateDir: '/state/sunfam',
					zoneId: 'sunfam',
				},
				{
					deleteToolVmRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => true,
					killProcess,
					loadAllToolVmRuntimeRecords: async () =>
						loadedToolVmRuntimeRecords(createToolVmRuntimeRecord()),
					log: () => {},
					readProcessCommand: async () => '/usr/local/bin/postgres -D /var/lib/postgres',
					readProcessIdentity: async () => ({
						command: '/usr/local/bin/postgres -D /var/lib/postgres',
						lstart: 'Tue Apr 14 15:00:00 2026',
					}),
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/refusing SIGTERM to pid 48282: process identity changed/u);
		expect(killProcess).not.toHaveBeenCalled();
	});

	it('skips a record from another project namespace in in-process-recovery mode', async () => {
		const killProcess = vi.fn();
		// configPath/controllerPort match the deployment; only projectNamespace
		// (the third fence) differs. This exercises the projectNamespace fence
		// in isolation.
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				mode: 'in-process-recovery',
				projectNamespace: 'shravan-claw-beta-25319b68',
				stateDir: '/state/beta',
				zoneId: 'sunfam',
			},
			{
				isProcessAlive: () => true,
				killProcess,
				loadAllToolVmRuntimeRecords: async () =>
					loadedToolVmRuntimeRecords(
						createToolVmRuntimeRecord({
							projectNamespace: 'shravan-claw-463c3e5f',
							sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:3',
						}),
					),
				log: () => {},
				readProcessCommand: async () => 'qemu-system-aarch64',
				sleep: async () => {},
			},
		);
		expect(killProcess).not.toHaveBeenCalled();
		expect(result).toMatchObject({ cleanedCount: 0, quarantinedCount: 0 });
		expect(result.warnings[0]).toMatch(/belongs to projectNamespace 'shravan-claw-463c3e5f'/u);
	});

	it('throws in offline-cleanup mode when scope does not match', async () => {
		await expect(
			cleanupRecordedToolVmRuntimes(
				{
					expectedConfigPath: '/deployments/shravan-claw/config/system.json',
					expectedControllerPort: 18800,
					mode: 'offline-cleanup',
					projectNamespace: 'shravan-claw-beta-25319b68',
					stateDir: '/state/beta',
					zoneId: 'sunfam',
				},
				{
					isProcessAlive: () => true,
					killProcess: vi.fn(),
					loadAllToolVmRuntimeRecords: async () =>
						loadedToolVmRuntimeRecords(
							createToolVmRuntimeRecord({
								projectNamespace: 'shravan-claw-463c3e5f',
								sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:3',
							}),
						),
					log: () => {},
					readProcessCommand: async () => 'qemu-system-aarch64',
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/belongs to projectNamespace 'shravan-claw-463c3e5f'/u);
	});

	it.each([
		{
			expectedReason: /belongs to configPath '/u,
			fixture: { configPath: '/deployments/OTHER/config/system.json' },
			label: 'configPath fence',
		},
		{
			expectedReason: /belongs to controllerPort '19999'/u,
			fixture: { controllerPort: 19999 },
			label: 'controllerPort fence',
		},
		{
			expectedReason: /belongs to zone 'someOtherZone'/u,
			fixture: { zoneId: 'someOtherZone' },
			label: 'zoneId fence',
		},
		{
			expectedReason: /session label .* does not match expected/u,
			fixture: { sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:9' },
			label: 'sessionLabel fence',
		},
	])('skips on $label mismatch (in-process-recovery)', async ({ expectedReason, fixture }) => {
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				mode: 'in-process-recovery',
				projectNamespace: 'shravan-claw-463c3e5f',
				stateDir: '/state/sunfam',
				zoneId: 'sunfam',
			},
			{
				isProcessAlive: () => true,
				killProcess: vi.fn(),
				loadAllToolVmRuntimeRecords: async () =>
					loadedToolVmRuntimeRecords(createToolVmRuntimeRecord(fixture)),
				log: () => {},
				readProcessCommand: async () => 'qemu-system-aarch64',
				sleep: async () => {},
			},
		);
		expect(result.warnings[0]).toMatch(expectedReason);
		expect(result.cleanedCount).toBe(0);
		expect(result.quarantinedCount).toBe(0);
	});

	it('processes mixed records independently — kills the matching one, skips the foreign one', async () => {
		const killProcess = vi.fn();
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const matchingRecord = createToolVmRuntimeRecord({
			leaseId: 'sunfam-agentA-1',
			qemuPid: 100,
			recordId: '01890f00-0000-7000-8000-000000000002',
		});
		const foreignRecord = createToolVmRuntimeRecord({
			leaseId: 'sunfam-agentB-2',
			projectNamespace: 'shravan-claw-beta-25319b68',
			qemuPid: 200,
			recordId: '01890f00-0000-7000-8000-000000000003',
			sessionLabel: 'shravan-claw-beta-25319b68:sunfam:tool:4',
			tcpSlot: 4,
		});
		// First record (matching scope) goes through the kill flow:
		//   entry alive → poll alive → poll dead. Foreign record is
		//   skipped and never reaches the kill path.
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				mode: 'in-process-recovery',
				projectNamespace: 'shravan-claw-463c3e5f',
				stateDir: '/state/sunfam',
				zoneId: 'sunfam',
			},
			{
				deleteToolVmRuntimeRecord,
				isProcessAlive,
				killProcess,
				loadAllToolVmRuntimeRecords: async () =>
					loadedToolVmRuntimeRecords(matchingRecord, foreignRecord),
				log: () => {},
				readProcessCommand: async () => 'qemu-system-aarch64',
				readProcessIdentity: async (pid) =>
					pid === matchingRecord.qemuPid ? matchingRecord.processIdentity : null,
				sleep: async () => {},
			},
		);
		expect(killProcess).toHaveBeenCalledWith(100, 'SIGTERM');
		expect(killProcess).not.toHaveBeenCalledWith(200, expect.anything());
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith(
			'/state/sunfam',
			matchingRecord.recordId,
		);
		expect(deleteToolVmRuntimeRecord).not.toHaveBeenCalledWith(
			'/state/sunfam',
			foreignRecord.recordId,
		);
		expect(result).toMatchObject({
			cleanedCount: 1,
			killedPids: [100],
			quarantinedCount: 0,
		});
	});

	it('starts cleanup for valid child records in parallel', async () => {
		const recordA = createToolVmRuntimeRecord({
			leaseId: 'sunfam-agentA-1',
			qemuPid: 100,
			recordId: '01890f00-0000-7000-8000-000000000002',
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});
		const recordB = createToolVmRuntimeRecord({
			leaseId: 'sunfam-agentA-2',
			qemuPid: 200,
			recordId: '01890f00-0000-7000-8000-000000000003',
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:1',
			tcpSlot: 1,
		});
		const firstPortLookup = createDeferredPromise<PortOwner | null>();
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		const readTcpListenPortOwner = vi.fn((port: number): Promise<PortOwner | null> => {
			if (port === 19_500) {
				return firstPortLookup.promise;
			}
			return Promise.resolve(null);
		});

		const cleanupPromise = cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'in-process-recovery' }),
			{
				deleteToolVmRuntimeRecord,
				isProcessAlive,
				killProcess: vi.fn(),
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(recordA, recordB),
				log: () => {},
				portForSlot: (slot) => 19_500 + slot,
				readProcessCommand: async () => 'qemu-system-aarch64',
				readProcessIdentity: async (pid) => {
					if (pid === recordA.qemuPid) return recordA.processIdentity;
					if (pid === recordB.qemuPid) return recordB.processIdentity;
					return null;
				},
				readTcpListenPortOwner,
				sleep: async () => {},
			},
		);

		await Promise.resolve();

		expect(readTcpListenPortOwner).toHaveBeenCalledWith(19_500);
		expect(readTcpListenPortOwner).toHaveBeenCalledWith(19_501);

		firstPortLookup.resolve(null);
		const result = await cleanupPromise;

		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith('/state/sunfam', recordA.recordId);
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith('/state/sunfam', recordB.recordId);
		expect(result.cleanedCount).toBe(2);
	});

	it('records a warning when delete fails but proceeds with subsequent records', async () => {
		const deleteToolVmRuntimeRecord = vi
			.fn<(stateDir: string, leaseId: string) => Promise<void>>()
			.mockImplementationOnce(async () => {
				throw new Error('disk full');
			})
			.mockImplementation(async () => {});
		const recordA = createToolVmRuntimeRecord({ leaseId: 'sunfam-agentA-1', qemuPid: 100 });
		const recordB = createToolVmRuntimeRecord({
			leaseId: 'sunfam-agentB-2',
			qemuPid: 200,
			tcpSlot: 4,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:4',
		});
		// Two records, each goes through the kill flow (entry alive → poll alive → dead).
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				mode: 'in-process-recovery',
				projectNamespace: 'shravan-claw-463c3e5f',
				stateDir: '/state/sunfam',
				zoneId: 'sunfam',
			},
			{
				deleteToolVmRuntimeRecord,
				isProcessAlive,
				killProcess: vi.fn(),
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(recordA, recordB),
				log: () => {},
				readProcessCommand: async () => 'qemu-system-aarch64',
				readProcessIdentity: async (pid) => {
					if (pid === recordA.qemuPid) return recordA.processIdentity;
					if (pid === recordB.qemuPid) return recordB.processIdentity;
					return null;
				},
				sleep: async () => {},
			},
		);
		expect(result.warnings.some((warning) => /disk full/u.test(warning))).toBe(true);
		// Second record still cleaned successfully
		expect(result.cleanedCount).toBe(1);
		expect(result.killedPids).toContain(200);
		expect(result.killedPids).toContain(100); // still killed even though first record's delete failed
	});
});
