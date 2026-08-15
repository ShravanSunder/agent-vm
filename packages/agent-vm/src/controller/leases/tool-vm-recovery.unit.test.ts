import type { ManagedVmExactProcessTerminationCapability } from '@agent-vm/managed-vm';
import { describe, expect, it, vi } from 'vitest';

import type { PortOwner } from '../../shared/port-owner.js';
import type { ControllerToolLeaseRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import {
	cleanupRecordedToolVmRuntimes,
	type ToolVmRecoveryDependencies,
} from './tool-vm-recovery.js';
import type {
	ToolVmRuntimeRecord,
	ToolVmRuntimeRecordLoadResult,
} from './tool-vm-runtime-record.js';

interface DeferredPromise<TResult> {
	readonly promise: Promise<TResult>;
	readonly resolve: (result: TResult) => void;
}

const toolVmRecordsTarget = {
	directoryPath: '/state/sunfam',
	kind: 'controller-tool-lease-records',
	zoneId: 'sunfam',
} satisfies ControllerToolLeaseRecordsTarget;

function createToolVmRecordsTarget(
	overrides: Partial<ControllerToolLeaseRecordsTarget> = {},
): ControllerToolLeaseRecordsTarget {
	return {
		...toolVmRecordsTarget,
		...overrides,
	};
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
		recordsTarget: toolVmRecordsTarget,
		...overrides,
	};
}

interface StatefulToolVmProcessFixture {
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly readProcessCommand: NonNullable<ToolVmRecoveryDependencies['readProcessCommand']>;
	readonly readProcessIdentity: NonNullable<ToolVmRecoveryDependencies['readProcessIdentity']>;
	readonly terminateRecordedHostProcess: ReturnType<typeof vi.fn>;
}

function createStatefulToolVmProcessFixture(
	records: readonly ToolVmRuntimeRecord[],
): StatefulToolVmProcessFixture {
	const recordsByPid = new Map(records.map((record) => [record.qemuPid, record]));
	const livePids = new Set(recordsByPid.keys());
	const terminateRecordedHostProcess = vi.fn(async ({ identity }) => {
		if (!livePids.has(identity.hostProcessId)) {
			return { hostProcessId: identity.hostProcessId, kind: 'already-absent' as const };
		}
		livePids.delete(identity.hostProcessId);
		return { hostProcessId: identity.hostProcessId, kind: 'terminated' as const };
	});
	return {
		exactProcessTermination: { terminateRecordedHostProcess },
		readProcessCommand: vi.fn(async (pid: number) => {
			if (!livePids.has(pid)) {
				return null;
			}
			return recordsByPid.get(pid)?.processIdentity.command ?? null;
		}),
		readProcessIdentity: vi.fn(async (pid: number) => {
			if (!livePids.has(pid)) {
				return null;
			}
			return recordsByPid.get(pid)?.processIdentity ?? null;
		}),
		terminateRecordedHostProcess,
	};
}

function createExactProcessTerminationFixture(
	kind: 'already-absent' | 'terminated' = 'already-absent',
): {
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly terminateRecordedHostProcess: ReturnType<typeof vi.fn>;
} {
	const terminateRecordedHostProcess = vi.fn(async ({ identity }) => ({
		hostProcessId: identity.hostProcessId,
		kind,
	}));
	return {
		exactProcessTermination: { terminateRecordedHostProcess },
		terminateRecordedHostProcess,
	};
}

describe('cleanupRecordedToolVmRuntimes', () => {
	it('returns zero counts when no records exist', async () => {
		const processTermination = createExactProcessTerminationFixture();
		const result = await cleanupRecordedToolVmRuntimes(
			{
				...processTermination,
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				projectNamespace: 'shravan-claw-463c3e5f',
				recordsTarget: toolVmRecordsTarget,
			},
			{
				...processTermination,
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
		const processTermination = createExactProcessTerminationFixture();
		const logRecords: Array<readonly [message: string, level: 'info' | 'warning']> = [];

		const result = await cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'in-process-recovery' }),
			{
				...processTermination,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: (message, level) => {
					logRecords.push([message, level]);
				},
				portForSlot: () => 19_500,
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			},
		);

		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
		expect(result.cleanedCount).toBe(0);
		expect(result.warnings.join('\n')).toContain('cannot reuse port 19500');
		expect(logRecords).toContainEqual([
			expect.stringContaining('cannot reuse port 19500'),
			'warning',
		]);
	});

	it('throws in offline cleanup when a tool VM port is held by a different pid', async () => {
		const record = createToolVmRuntimeRecord({
			qemuPid: 111,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});
		const processTermination = createExactProcessTerminationFixture();

		await expect(
			cleanupRecordedToolVmRuntimes(createCleanupOptions({ mode: 'offline-cleanup' }), {
				...processTermination,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				portForSlot: () => 19_500,
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			}),
		).rejects.toThrow(/cannot reuse port 19500 because it is held by pid 222/u);
		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
	});

	it('does not mistake a controller-owned Tool SSH listener for the VM runner', async () => {
		const record = createToolVmRuntimeRecord({
			qemuPid: 111,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});
		const processTermination = createExactProcessTerminationFixture();

		const result = await cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'in-process-recovery' }),
			{
				...processTermination,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: () => {},
				portForSlot: () => 19_500,
				readTcpListenPortOwner: async () => ({ command: 'node agent-vm controller', pid: 333 }),
			},
		);

		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
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
		const processTermination = createExactProcessTerminationFixture();

		const result = await cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'in-process-recovery' }),
			{
				...processTermination,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: () => {},
				portForSlot: () => 19_500,
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 111 }),
			},
		);

		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
		expect(result.cleanedCount).toBe(0);
		expect(result.warnings.join('\n')).toContain('cannot reuse port 19500');
	});

	it('kills the recorded qemu pid and deletes the record when scope matches', async () => {
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const record = createToolVmRuntimeRecord();
		const processFixture = createStatefulToolVmProcessFixture([record]);
		const logRecords: Array<readonly [message: string, level: 'info' | 'warning']> = [];
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				projectNamespace: 'shravan-claw-463c3e5f',
				recordsTarget: toolVmRecordsTarget,
			},
			{
				...processFixture,
				deleteToolVmRuntimeRecord,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: (message, level) => {
					logRecords.push([message, level]);
				},
			},
		);
		expect(processFixture.terminateRecordedHostProcess).toHaveBeenCalledWith(
			expect.objectContaining({ identity: expect.objectContaining({ hostProcessId: 48282 }) }),
		);
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith(toolVmRecordsTarget, record.recordId);
		expect(result).toMatchObject({
			cleanedCount: 1,
			killedPids: [48282],
			quarantinedCount: 0,
		});
		expect(logRecords.map(([, level]) => level)).toEqual(['info', 'info']);
	});

	it('skips signaling when the recorded pid is already dead and still deletes the record', async () => {
		const processTermination = createExactProcessTerminationFixture();
		const readProcessCommand = vi.fn(async () => null);
		const readProcessIdentity = vi.fn(async () => null);
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				projectNamespace: 'shravan-claw-463c3e5f',
				recordsTarget: toolVmRecordsTarget,
			},
			{
				deleteToolVmRuntimeRecord,
				...processTermination,
				loadAllToolVmRuntimeRecords: async () =>
					loadedToolVmRuntimeRecords(createToolVmRuntimeRecord()),
				log: () => {},
				readProcessCommand,
				readProcessIdentity,
			},
		);
		expect(processTermination.terminateRecordedHostProcess).toHaveBeenCalledOnce();
		expect(readProcessCommand).not.toHaveBeenCalled();
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ cleanedCount: 1, killedPids: [], quarantinedCount: 0 });
	});

	it('kills the recorded qemu pid before deleting when the tool VM port is already free', async () => {
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const record = createToolVmRuntimeRecord({
			qemuPid: 111,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});
		const processFixture = createStatefulToolVmProcessFixture([record]);

		const result = await cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'in-process-recovery' }),
			{
				...processFixture,
				deleteToolVmRuntimeRecord,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: () => {},
				portForSlot: () => 19_500,
				readTcpListenPortOwner: async () => null,
			},
		);

		expect(processFixture.terminateRecordedHostProcess).toHaveBeenCalledWith(
			expect.objectContaining({ identity: expect.objectContaining({ hostProcessId: 111 }) }),
		);
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith(toolVmRecordsTarget, record.recordId);
		expect(result).toMatchObject({
			cleanedCount: 1,
			killedPids: [111],
			quarantinedCount: 0,
		});
	});

	it('deletes a port-free stale record without signaling when the recorded pid was reused', async () => {
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const processTermination = createExactProcessTerminationFixture();
		const record = createToolVmRuntimeRecord({
			qemuPid: 111,
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});

		const result = await cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'offline-cleanup' }),
			{
				deleteToolVmRuntimeRecord,
				...processTermination,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: () => {},
				portForSlot: () => 19_500,
				readProcessCommand: async () => 'node /tmp/not-tool-vm.js',
				readProcessIdentity: async () => ({
					command: 'node /tmp/not-tool-vm.js',
					lstart: 'Tue Apr 14 15:00:00 2026',
				}),
				readTcpListenPortOwner: async () => null,
			},
		);

		expect(processTermination.terminateRecordedHostProcess).toHaveBeenCalledOnce();
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith(toolVmRecordsTarget, record.recordId);
		expect(result).toMatchObject({ cleanedCount: 1, killedPids: [], quarantinedCount: 0 });
	});

	it('preflights every Tool VM identity before signaling any sibling record', async () => {
		const firstRecord = createToolVmRuntimeRecord({
			agentId: 'first-agent',
			leaseId: 'lease-first-agent',
			qemuPid: 111,
			recordId: '01890f00-0000-7000-8000-000000000011',
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:0',
			tcpSlot: 0,
		});
		const secondRecord = createToolVmRuntimeRecord({
			agentId: 'second-agent',
			leaseId: 'lease-second-agent',
			qemuPid: 222,
			recordId: '01890f00-0000-7000-8000-000000000022',
			sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:1',
			tcpSlot: 1,
		});
		const processTermination = createExactProcessTerminationFixture();
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});

		await expect(
			cleanupRecordedToolVmRuntimes(createCleanupOptions({ mode: 'offline-cleanup' }), {
				deleteToolVmRuntimeRecord,
				...processTermination,
				loadAllToolVmRuntimeRecords: async () =>
					loadedToolVmRuntimeRecords(firstRecord, secondRecord),
				log: () => {},
				readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
				readProcessIdentity: async (pid) =>
					pid === firstRecord.qemuPid
						? {
								...firstRecord.processIdentity,
								command: 'qemu-system-aarch64 -name inconsistent-command',
							}
						: secondRecord.processIdentity,
			}),
		).rejects.toThrow(/same process start.*command changed/u);

		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
		expect(deleteToolVmRuntimeRecord).not.toHaveBeenCalled();
	});

	it('deletes a stale record without signaling when a different process reused its pid', async () => {
		const deleteToolVmRuntimeRecord = vi.fn(async () => {});
		const processTermination = createExactProcessTerminationFixture();
		const record = createToolVmRuntimeRecord();
		// Recorded identity is the original QEMU; live identity is a different
		// process (different start time + different command) on the same PID.
		// The different start time proves the recorded predecessor is absent.
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				projectNamespace: 'shravan-claw-463c3e5f',
				recordsTarget: toolVmRecordsTarget,
			},
			{
				deleteToolVmRuntimeRecord,
				...processTermination,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(record),
				log: () => {},
				readProcessCommand: async () => '/usr/local/bin/postgres -D /var/lib/postgres',
				readProcessIdentity: async () => ({
					command: '/usr/local/bin/postgres -D /var/lib/postgres',
					lstart: 'Tue Apr 14 15:00:00 2026',
				}),
			},
		);

		expect(processTermination.terminateRecordedHostProcess).toHaveBeenCalledOnce();
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith(toolVmRecordsTarget, record.recordId);
		expect(result).toMatchObject({ cleanedCount: 1, killedPids: [], quarantinedCount: 0 });
	});

	it('skips a record from another project namespace in in-process-recovery mode', async () => {
		const processTermination = createExactProcessTerminationFixture();
		// configPath/controllerPort match the deployment; only projectNamespace
		// (the third fence) differs. This exercises the projectNamespace fence
		// in isolation.
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				mode: 'in-process-recovery',
				projectNamespace: 'shravan-claw-beta-25319b68',
				recordsTarget: createToolVmRecordsTarget({ directoryPath: '/state/beta' }),
			},
			{
				...processTermination,
				loadAllToolVmRuntimeRecords: async () =>
					loadedToolVmRuntimeRecords(
						createToolVmRuntimeRecord({
							projectNamespace: 'shravan-claw-463c3e5f',
							sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:3',
						}),
					),
				log: () => {},
				readProcessCommand: async () => 'qemu-system-aarch64',
			},
		);
		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
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
					recordsTarget: createToolVmRecordsTarget({ directoryPath: '/state/beta' }),
				},
				{
					...createExactProcessTerminationFixture(),
					loadAllToolVmRuntimeRecords: async () =>
						loadedToolVmRuntimeRecords(
							createToolVmRuntimeRecord({
								projectNamespace: 'shravan-claw-463c3e5f',
								sessionLabel: 'shravan-claw-463c3e5f:sunfam:tool:3',
							}),
						),
					log: () => {},
					readProcessCommand: async () => 'qemu-system-aarch64',
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
				recordsTarget: toolVmRecordsTarget,
			},
			{
				...createExactProcessTerminationFixture(),
				loadAllToolVmRuntimeRecords: async () =>
					loadedToolVmRuntimeRecords(createToolVmRuntimeRecord(fixture)),
				log: () => {},
				readProcessCommand: async () => 'qemu-system-aarch64',
			},
		);
		expect(result.warnings[0]).toMatch(expectedReason);
		expect(result.cleanedCount).toBe(0);
		expect(result.quarantinedCount).toBe(0);
	});

	it('processes mixed records independently — kills the matching one, skips the foreign one', async () => {
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
		const processFixture = createStatefulToolVmProcessFixture([matchingRecord, foreignRecord]);
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				mode: 'in-process-recovery',
				projectNamespace: 'shravan-claw-463c3e5f',
				recordsTarget: toolVmRecordsTarget,
			},
			{
				...processFixture,
				deleteToolVmRuntimeRecord,
				loadAllToolVmRuntimeRecords: async () =>
					loadedToolVmRuntimeRecords(matchingRecord, foreignRecord),
				log: () => {},
			},
		);
		expect(processFixture.terminateRecordedHostProcess).toHaveBeenCalledWith(
			expect.objectContaining({ identity: expect.objectContaining({ hostProcessId: 100 }) }),
		);
		expect(processFixture.terminateRecordedHostProcess).not.toHaveBeenCalledWith(
			expect.objectContaining({ identity: expect.objectContaining({ hostProcessId: 200 }) }),
		);
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith(
			toolVmRecordsTarget,
			matchingRecord.recordId,
		);
		expect(deleteToolVmRuntimeRecord).not.toHaveBeenCalledWith(
			toolVmRecordsTarget,
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
		const processFixture = createStatefulToolVmProcessFixture([recordA, recordB]);
		const readTcpListenPortOwner = vi.fn((port: number): Promise<PortOwner | null> => {
			if (port === 19_500) {
				return firstPortLookup.promise;
			}
			return Promise.resolve(null);
		});

		const cleanupPromise = cleanupRecordedToolVmRuntimes(
			createCleanupOptions({ mode: 'in-process-recovery' }),
			{
				...processFixture,
				deleteToolVmRuntimeRecord,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(recordA, recordB),
				log: () => {},
				portForSlot: (slot) => 19_500 + slot,
				readTcpListenPortOwner,
			},
		);

		await Promise.resolve();

		expect(readTcpListenPortOwner).toHaveBeenCalledWith(19_500);
		expect(readTcpListenPortOwner).toHaveBeenCalledWith(19_501);

		firstPortLookup.resolve(null);
		const result = await cleanupPromise;

		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith(toolVmRecordsTarget, recordA.recordId);
		expect(deleteToolVmRuntimeRecord).toHaveBeenCalledWith(toolVmRecordsTarget, recordB.recordId);
		expect(result.cleanedCount).toBe(2);
	});

	it('records a warning when delete fails but proceeds with subsequent records', async () => {
		const deleteToolVmRuntimeRecord = vi
			.fn<(recordsTarget: ControllerToolLeaseRecordsTarget, recordId: string) => Promise<void>>()
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
		const processFixture = createStatefulToolVmProcessFixture([recordA, recordB]);
		const result = await cleanupRecordedToolVmRuntimes(
			{
				expectedConfigPath: '/deployments/shravan-claw/config/system.json',
				expectedControllerPort: 18800,
				mode: 'in-process-recovery',
				projectNamespace: 'shravan-claw-463c3e5f',
				recordsTarget: toolVmRecordsTarget,
			},
			{
				...processFixture,
				deleteToolVmRuntimeRecord,
				loadAllToolVmRuntimeRecords: async () => loadedToolVmRuntimeRecords(recordA, recordB),
				log: () => {},
			},
		);
		expect(result.warnings.some((warning) => /disk full/u.test(warning))).toBe(true);
		// Second record still cleaned successfully
		expect(result.cleanedCount).toBe(1);
		expect(result.killedPids).toContain(200);
		expect(result.killedPids).toContain(100); // still killed even though first record's delete failed
	});
});
