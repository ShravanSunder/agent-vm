import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../../testing/managed-vm-test-helpers.js';
import {
	AgentLeaseCompatibilityConflictError,
	createLeaseManager,
	LeaseActiveUseConflictError,
} from './lease-manager.js';
import { createTcpPool } from './tcp-pool.js';
import { deleteToolVmRuntimeRecord, writeToolVmRuntimeRecord } from './tool-vm-runtime-record.js';

// Runtime-record persistence is exercised by tool-vm-runtime-record.test.ts.
// In lease-manager tests we only need the in-memory lease lifecycle behavior,
// so default the write/delete to no-ops via injection. readProcessIdentity is
// stubbed to a synthetic value so buildToolVmRuntimeRecord doesn't shell out
// to `ps` against the fake pid.
const defaultRuntimeRecordOptions = {
	controllerPort: 18800,
	deleteToolVmRuntimeRecord: vi.fn(async () => {}),
	projectNamespace: 'claw-tests-a1b2c3d4',
	readProcessIdentity: async () => ({
		command: 'qemu-system-x86_64 -m 1G',
		lstart: 'Fri May 22 10:00:00 2026',
	}),
	stateDirFor: (zoneId: string) => `/tmp/lease-manager-tests/${zoneId}`,
	systemConfigPath: '/etc/agent-vm/system.json',
	writeToolVmRuntimeRecord: vi.fn(async () => {}),
};

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';

function createManagedVmStub(id: string = 'tool-vm-1'): ManagedVm {
	return {
		close: vi.fn(async () => {}),
		enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
		enableSsh: vi.fn(async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19000,
			user: 'sandbox',
		})),
		exec: vi.fn(() => createManagedExecProcessStub()),
		fs: createManagedVmFsStub(),
		id,
		setIngressRoutes: vi.fn(),
		getHostPid: () => 12345,
		getVmInstance: vi.fn(),
	};
}

describe('createLeaseManager', () => {
	function createAgentLeaseOptions(
		overrides: Partial<Parameters<ReturnType<typeof createLeaseManager>['createLease']>[0]> & {
			readonly agentId?: string;
		} = {},
	): Parameters<ReturnType<typeof createLeaseManager>['createLease']>[0] & {
		readonly agentId: string;
	} {
		return {
			agentId: 'beta',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
			...overrides,
		};
	}

	it('creates opaque UUIDv7 lease ids instead of encoding zone, agent, or createdAt', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000000',
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 1_700_000_000_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});

		const lease = await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
			}),
		);

		expect(lease.id).toBe('01890f00-0000-7000-8000-000000000000');
		expect(lease.id).not.toContain('beta');
		expect(lease.id).not.toContain('shravan');
		expect(lease.id).not.toContain('1700000000000');
	});

	it('evicts and refuses to renew an expired lease instead of resurrecting it', async () => {
		let now = 1_000;
		const closeMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000001',
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease(
			createAgentLeaseOptions({
				effectiveIdleTtlMs: 1_000,
			}),
		);
		now = 2_001;

		const renewal = await leaseManager.renewLease(lease.id);

		expect(renewal).toEqual({ kind: 'not-found', reason: 'expired' });
		expect(closeMock).toHaveBeenCalledOnce();
		expect(leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('evicts and refuses to renew a lease whose VM liveness check fails', async () => {
		const closeMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000002',
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
				exec: vi.fn(() =>
					createManagedExecProcessStub({ exitCode: 1, stderr: 'dead', stdout: '' }),
				),
			})),
			now: () => 1_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease(createAgentLeaseOptions());

		const renewal = await leaseManager.renewLease(lease.id);

		expect(renewal).toEqual({ kind: 'not-found', reason: 'dead' });
		expect(closeMock).toHaveBeenCalledOnce();
		expect(leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('reaps dead idle leases without treating active-use heartbeat as liveness', async () => {
		const closeMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000003',
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
				exec: vi.fn(() =>
					createManagedExecProcessStub({ exitCode: 1, stderr: 'dead', stdout: '' }),
				),
			})),
			now: () => 1_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease(createAgentLeaseOptions());

		await leaseManager.reapDeadIdleLeases();

		expect(closeMock).toHaveBeenCalledOnce();
		expect(leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('does not expire a lease while an active operation is heartbeating', async () => {
		let now = 1_000;
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000005',
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease({
			...createAgentLeaseOptions(),
			effectiveIdleTtlMs: 1_000,
		});
		leaseManager.startActiveUse(lease.id, {
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		now = 2_001;

		expect(await leaseManager.renewLease(lease.id)).toMatchObject({ kind: 'renewed' });
	});

	it('creates, stores, and releases a lease while returning its tcp slot', async () => {
		const closeMock = vi.fn(async () => {});
		const enableSshMock = vi.fn(async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19000,
			user: 'sandbox',
		}));
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: enableSshMock,
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
				getHostPid: () => 12345,
				getVmInstance: vi.fn(),
			})),
			now: () => 123,
			tcpPool: createTcpPool({
				basePort: 19000,
				size: 2,
			}),
		});

		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
			zoneId: 'shravan',
		});

		expect(lease.tcpSlot).toBe(0);
		await expect(leaseManager.renewLease(lease.id)).resolves.toMatchObject({
			kind: 'renewed',
			lease: {
				id: lease.id,
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/work',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
				zoneId: 'shravan',
			},
		});

		await leaseManager.releaseLease(lease.id);

		expect(closeMock).toHaveBeenCalled();
		await expect(leaseManager.renewLease(lease.id)).resolves.toEqual({
			kind: 'not-found',
			reason: 'missing',
		});
	});

	it('closes VM, releases tcpSlot, and clears the lease when writeToolVmRuntimeRecord throws', async () => {
		const closeMock = vi.fn(async () => {});
		const createManagedVm = vi.fn(async () => ({
			close: closeMock,
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				command: 'ssh ...',
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			id: 'tool-vm-write-fails',
			setIngressRoutes: vi.fn(),
			getHostPid: () => 12345,
			getVmInstance: vi.fn(),
		}));
		const tcpPool = createTcpPool({ basePort: 19000, size: 2 });
		const writeFailure = new Error('disk full');
		// Throw on first call (the lease we want to verify gets rolled back),
		// succeed afterward so the subsequent reuse-after-failure createLease
		// can verify the tcpSlot was released cleanly.
		const writeToolVmRuntimeRecordMock = vi
			.fn()
			.mockImplementationOnce(async () => {
				throw writeFailure;
			})
			.mockImplementation(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 200,
			tcpPool,
			writeToolVmRuntimeRecord: writeToolVmRuntimeRecordMock,
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/work',
				profile: { cpus: 1, memory: '1G', imageProfile: 'default' },
				profileId: 'standard',
				guestWorkdir: '/work',
				hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/x/work',
				zoneId: 'shravan',
			}),
		).rejects.toBe(writeFailure);

		expect(writeToolVmRuntimeRecordMock).toHaveBeenCalledTimes(1);
		// VM must be closed to avoid a leaked QEMU/krun process.
		expect(closeMock).toHaveBeenCalledTimes(1);
		// No in-memory lease left behind.
		expect(leaseManager.listLeases()).toHaveLength(0);
		// tcp slot must be reusable for a subsequent createLease.
		const reusable = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profile: { cpus: 1, memory: '1G', imageProfile: 'default' },
			profileId: 'standard',
			guestWorkdir: '/work',
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/y/work',
			zoneId: 'shravan',
		});
		expect(reusable.tcpSlot).toBe(0);
	});

	it('preserves the runtime record on disk when releaseLease vm.close() throws', async () => {
		const closeMock = vi.fn(async () => {
			throw new Error('close hung');
		});
		const createManagedVm = vi.fn(async () => ({
			close: closeMock,
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				command: 'ssh ...',
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			id: 'tool-vm-close-fails',
			setIngressRoutes: vi.fn(),
			getHostPid: () => 12345,
			getVmInstance: vi.fn(),
		}));
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const deleteToolVmRuntimeRecordMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			deleteToolVmRuntimeRecord: deleteToolVmRuntimeRecordMock,
			now: () => 300,
			tcpPool,
		});

		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profile: { cpus: 1, memory: '1G', imageProfile: 'default' },
			profileId: 'standard',
			guestWorkdir: '/work',
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/z/work',
			zoneId: 'shravan',
		});

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow(/close hung/u);

		// Invariant: runtime record must NOT be deleted when vm.close fails so
		// the next controller's Phase A cleanup can scope-fence + signal the
		// orphan QEMU.
		expect(deleteToolVmRuntimeRecordMock).not.toHaveBeenCalled();
	});

	it('reuses a live lease for the same zone scope profile and workspace', async () => {
		let now = 100;
		const createManagedVm = vi.fn(async () => createManagedVmStub());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};

		const firstLease = await leaseManager.createLease(request);
		now = 150;
		const secondLease = await leaseManager.createLease(request);

		expect(secondLease.id).toBe(firstLease.id);
		expect(secondLease.tcpSlot).toBe(0);
		expect(secondLease.lastUsedAt).toBe(150);
		expect(createManagedVm).toHaveBeenCalledTimes(1);
	});

	it('reuses the same live Tool VM for different scope keys under one agent', async () => {
		const createManagedVm = vi.fn(async () => createManagedVmStub());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		const firstLease = await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
			}),
		);
		const secondLease = await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
			}),
		);

		expect(secondLease.id).toBe(firstLease.id);
		expect(secondLease.agentId).toBe('beta');
		expect(createManagedVm).toHaveBeenCalledTimes(1);
	});

	it('creates separate Tool VMs for separate agents in the same zone', async () => {
		const createManagedVm = vi.fn(async () =>
			createManagedVmStub(`tool-vm-${createManagedVm.mock.calls.length}`),
		);
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		const betaLease = await leaseManager.createLease(createAgentLeaseOptions({ agentId: 'beta' }));
		const lauraLease = await leaseManager.createLease(
			createAgentLeaseOptions({ agentId: 'laura' }),
		);

		expect(lauraLease.id).not.toBe(betaLease.id);
		expect(leaseManager.listLeases()).toHaveLength(2);
		expect(createManagedVm).toHaveBeenCalledTimes(2);
	});

	it('does not put agent provenance into lease id', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});

		const lease = await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
			}),
		);

		expect(lease.id).not.toContain('agent:');
		expect(lease.id).not.toContain('beta');
		expect(lease.id).not.toContain('shravan');
	});

	it('rejects an incompatible workspace request for an existing agent lease', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
				hostWorkMountDir: '/tmp/beta-workspace-a',
			}),
		);

		await expect(
			leaseManager.createLease(
				createAgentLeaseOptions({
					agentId: 'beta',
					hostWorkMountDir: '/tmp/beta-workspace-b',
				}),
			),
		).rejects.toThrow(/existing Tool VM lease for agent 'beta' is not compatible/u);
	});

	it('rejects an incompatible profile request for an existing agent lease', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
				profileId: 'standard',
			}),
		);

		await expect(
			leaseManager.createLease(
				createAgentLeaseOptions({
					agentId: 'beta',
					profile: { cpus: 2, memory: '2G', imageProfile: 'large' },
					profileId: 'large',
				}),
			),
		).rejects.toThrow(/existing Tool VM lease for agent 'beta' is not compatible/u);
	});

	it('peeks a lease without extending its idle timestamp', async () => {
		let now = 100;
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};
		const lease = await leaseManager.createLease(request);
		now = 150;

		const peekedLease = leaseManager.peekLease(lease.id)?.lease;
		const renewal = await leaseManager.renewLease(lease.id);
		const renewedLease = renewal.kind === 'renewed' ? renewal.lease : undefined;

		expect(peekedLease).toMatchObject({ id: lease.id, lastUsedAt: 100 });
		expect(renewedLease).toMatchObject({ id: lease.id, lastUsedAt: 150 });
		expect(leaseManager.peekLease('missing-lease')).toBeUndefined();
	});

	it('rejects same-scope lease reuse when the workspace changes', async () => {
		const closeMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/host/agent-work',
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/host/other-sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/existing Tool VM lease for agent 'main' is not compatible/u);
		expect(closeMock).not.toHaveBeenCalled();
	});

	it('rejects same-scope lease reuse when the profile changes', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/host/agent-work',
				profile: {
					cpus: 2,
					memory: '2G',
					imageProfile: 'large',
				},
				profileId: 'large',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toBeInstanceOf(AgentLeaseCompatibilityConflictError);
	});

	it('rejects same-scope lease reuse when the agent workspace changes', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/host/other-agent-work',
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toBeInstanceOf(AgentLeaseCompatibilityConflictError);
	});

	it('does not reuse matching scope keys across zones', async () => {
		const createManagedVm = vi.fn(async () =>
			createManagedVmStub(`tool-vm-${createManagedVm.mock.calls.length}`),
		);
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
		};

		const firstLease = await leaseManager.createLease({ ...request, zoneId: 'shravan' });
		const secondLease = await leaseManager.createLease({ ...request, zoneId: 'alex' });

		expect(secondLease.id).not.toBe(firstLease.id);
		expect(secondLease.tcpSlot).toBe(1);
		expect(createManagedVm).toHaveBeenCalledTimes(2);
	});

	it('evicts a stale same-scope lease before creating a replacement', async () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const staleClose = vi.fn(async () => {
			throw new Error('stale close failed');
		});
		const staleVm = {
			...createManagedVmStub('stale-vm'),
			close: staleClose,
			exec: vi.fn(() => {
				throw new Error('vm is gone');
			}),
		};
		const freshVm = createManagedVmStub('fresh-vm');
		const createManagedVm = vi.fn(async () =>
			createManagedVm.mock.calls.length === 1 ? staleVm : freshVm,
		);
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => createManagedVm.mock.calls.length * 100,
			// Pool size 2: when the stale VM's close fails, slot 0 is
			// quarantined (host port may still be held). The replacement lease
			// must get slot 1 — that's the correct, port-safe behavior.
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};

		try {
			const firstLease = await leaseManager.createLease(request);
			const secondLease = await leaseManager.createLease(request);

			expect(secondLease.id).not.toBe(firstLease.id);
			expect(secondLease.vm.id).toBe('fresh-vm');
			// Slot 0 must be quarantined since the stale VM's close threw.
			expect(secondLease.tcpSlot).toBe(1);
			expect(staleClose).toHaveBeenCalled();
			expect(createManagedVm).toHaveBeenCalledTimes(2);
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some((message) =>
					message.includes(`liveness check failed for lease '${firstLease.id}'`),
				),
			).toBe(true);
			expect(
				loggedMessages.some((message) =>
					message.includes(`failed to close evicted lease '${firstLease.id}'`),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('serializes concurrent createLease calls for the same zone scope', async () => {
		let releaseCreate: (() => void) | undefined;
		let markCreateStarted: (() => void) | undefined;
		const createStarted = new Promise<void>((resolve) => {
			markCreateStarted = resolve;
		});
		const createCanFinish = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		const createManagedVm = vi.fn(async () => {
			markCreateStarted?.();
			await createCanFinish;
			return createManagedVmStub();
		});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};

		const firstLeasePromise = leaseManager.createLease(request);
		const secondLeasePromise = leaseManager.createLease(request);
		await createStarted;
		expect(createManagedVm).toHaveBeenCalledTimes(1);
		releaseCreate?.();
		const [firstLease, secondLease] = await Promise.all([firstLeasePromise, secondLeasePromise]);

		expect(secondLease.id).toBe(firstLease.id);
		expect(createManagedVm).toHaveBeenCalledTimes(1);
	});

	it('serializes releaseLease with same-scope createLease reuse', async () => {
		let releaseExec: (() => void) | undefined;
		let markExecStarted: (() => void) | undefined;
		const execStarted = new Promise<void>((resolve) => {
			markExecStarted = resolve;
		});
		const execCanFinish = new Promise<void>((resolve) => {
			releaseExec = resolve;
		});
		const closeMock = vi.fn(async () => {});
		const vm = {
			...createManagedVmStub(),
			close: closeMock,
			exec: vi.fn(() =>
				createManagedExecProcessStub({
					beforeResolve: () => markExecStarted?.(),
					waitFor: execCanFinish,
				}),
			),
		};
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => vm),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};
		const lease = await leaseManager.createLease(request);

		const reusePromise = leaseManager.createLease(request);
		await execStarted;
		const releasePromise = leaseManager.releaseLease(lease.id);
		await Promise.resolve();
		expect(closeMock).not.toHaveBeenCalled();
		releaseExec?.();
		const reusedLease = await reusePromise;
		await releasePromise;

		expect(reusedLease.id).toBe(lease.id);
		expect(closeMock).toHaveBeenCalledTimes(1);
		await expect(leaseManager.renewLease(lease.id)).resolves.toEqual({
			kind: 'not-found',
			reason: 'missing',
		});
	});

	it('rejects new active uses while the lease is releasing', async () => {
		let releaseClose: (() => void) | undefined;
		let markCloseStarted: (() => void) | undefined;
		const closeStarted = new Promise<void>((resolve) => {
			markCloseStarted = resolve;
		});
		const closeCanFinish = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: vi.fn(async () => {
					markCloseStarted?.();
					await closeCanFinish;
				}),
			})),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		const releasePromise = leaseManager.releaseLease(lease.id);
		await closeStarted;

		expect(() =>
			leaseManager.startActiveUse(lease.id, {
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		).toThrow(LeaseActiveUseConflictError);

		releaseClose?.();
		await releasePromise;
		expect(leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('does not release a lease that was touched after an idle reaper snapshot', async () => {
		let now = 100;
		const closeMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};
		const lease = await leaseManager.createLease(request);
		now = 200;
		await leaseManager.createLease(request);

		await leaseManager.releaseLease(lease.id, { ifLastUsedAtBeforeOrAt: 150 });

		expect(closeMock).not.toHaveBeenCalled();
		await expect(leaseManager.renewLease(lease.id)).resolves.toMatchObject({
			kind: 'renewed',
			lease: { id: lease.id },
		});
	});

	it('listLeases returns all active leases across agents', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				close: vi.fn(async () => {}),
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({
					command: 'ssh ...',
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 19000,
					user: 'sandbox',
				})),
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
				getHostPid: () => 12345,
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 5 }),
		});

		const lease1 = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});
		const lease2 = await leaseManager.createLease({
			agentId: 'laura',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		const all = leaseManager.listLeases();
		expect(all).toHaveLength(2);
		expect(all.map((lease) => lease.id)).toContain(lease1.id);
		expect(all.map((lease) => lease.id)).toContain(lease2.id);
	});

	it('releaseLease is a no-op for non-existent lease ids', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		// Should not throw
		await leaseManager.releaseLease('does-not-exist');

		expect(leaseManager.listLeases()).toHaveLength(0);
	});

	it('releases bookkeeping even when vm.close throws', async () => {
		const closeMock = vi.fn(async () => {
			throw new Error('close failed');
		});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({
					command: 'ssh ...',
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 19000,
					user: 'sandbox',
				})),
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				id: 'tool-vm-close-fail',
				setIngressRoutes: vi.fn(),
				getHostPid: () => 12345,
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool,
		});

		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow('close failed');
		await expect(leaseManager.renewLease(lease.id)).resolves.toEqual({
			kind: 'not-found',
			reason: 'missing',
		});
		// When close fails the QEMU may still hold the host port. The slot
		// must be quarantined — NOT re-allocatable until proven safe — to
		// prevent a same-process port collision.
		expect(tcpPool.isQuarantined(0)).toBe(true);
		expect(() => tcpPool.allocate()).toThrow('No TCP slots available');
	});

	it('releases the tcp slot when VM creation fails', async () => {
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => {
				throw new Error('vm create failed');
			}),
			now: () => 100,
			tcpPool,
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/host/agent-work',
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toThrow('vm create failed');

		expect(tcpPool.allocate()).toBe(0);
	});

	it('stores effective idle TTLs and rejects reuse with a mismatched requested TTL', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			effectiveIdleTtlMs: 60_000,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};

		const lease = await leaseManager.createLease(request);
		const reusedLease = await leaseManager.createLease(request);

		expect(lease.effectiveIdleTtlMs).toBe(60_000);
		expect(reusedLease.id).toBe(lease.id);
		await expect(
			leaseManager.createLease({
				...request,
				effectiveIdleTtlMs: 120_000,
			}),
		).rejects.toBeInstanceOf(AgentLeaseCompatibilityConflictError);
	});

	it('tracks active uses, heartbeats, tombstones, and forced release cleanup', async () => {
		let now = 1_000;
		const closeMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
			toolVmUsePolicy: {
				endedUseTombstoneTtlMs: 10_000,
				heartbeatAfterMs: 1_000,
				heartbeatStaleMs: 4_000,
			},
		});
		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			effectiveIdleTtlMs: 60_000,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		const startedUse = leaseManager.startActiveUse(lease.id, {
			correlation: { toolName: 'shell' },
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		const repeatedStart = leaseManager.startActiveUse(lease.id, {
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		now = 2_000;
		const heartbeat = leaseManager.heartbeatActiveUse(
			lease.id,
			'01890f00-0000-7000-8000-000000000000',
			{},
		);
		leaseManager.endActiveUse(lease.id, '01890f00-0000-7000-8000-000000000000', {
			outcome: 'completed',
		});

		expect(startedUse).toEqual({
			expiresAt: 5_000,
			heartbeatAfterMs: 1_000,
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(repeatedStart).toEqual(startedUse);
		expect(heartbeat).toEqual({ expiresAt: 6_000, heartbeatAfterMs: 1_000 });
		expect(leaseManager.getActiveUseCount(lease.id)).toBe(0);
		expect(() =>
			leaseManager.startActiveUse(lease.id, {
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		).toThrow(/already ended/u);
		expect(() =>
			leaseManager.startActiveUse(lease.id, {
				useId: '1b5c5d78-91b4-4c8e-a15e-f475dced59ef',
			}),
		).toThrow(/UUIDv7/u);

		await leaseManager.releaseLease(lease.id, { force: true });

		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(leaseManager.getActiveUseCount(lease.id)).toBe(0);
	});

	it('replaces active-use operation reports instead of accumulating report history', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000004',
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 1_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease(createAgentLeaseOptions());
		leaseManager.startActiveUse(lease.id, {
			report: { observedAtMs: 1_000, phase: 'starting' },
			useId: '01890f00-0000-7000-8000-000000000000',
		});

		leaseManager.heartbeatActiveUse(lease.id, '01890f00-0000-7000-8000-000000000000', {
			report: {
				observedAtMs: 1_001,
				phase: 'failed',
				ssh: {
					failure: {
						kind: 'ssh-command-timed-out',
						message: 'SSH command exceeded 30000ms.',
					},
				},
			},
		});

		expect(leaseManager.getActiveUses(lease.id)).toEqual([
			expect.objectContaining({
				latestReport: {
					observedAtMs: 1_001,
					phase: 'failed',
					ssh: {
						failure: {
							kind: 'ssh-command-timed-out',
							message: 'SSH command exceeded 30000ms.',
						},
					},
				},
			}),
		]);
	});

	it('reaps stale active uses and expired tombstones without closing the lease', async () => {
		let now = 1_000;
		const closeMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
			toolVmUsePolicy: {
				endedUseTombstoneTtlMs: 3_000,
				heartbeatAfterMs: 1_000,
				heartbeatStaleMs: 4_000,
			},
		});
		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			effectiveIdleTtlMs: 60_000,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		leaseManager.startActiveUse(lease.id, {
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		leaseManager.startActiveUse(lease.id, {
			useId: '01890f00-0000-7000-8000-000000000001',
		});
		now = 2_000;
		leaseManager.heartbeatActiveUse(lease.id, '01890f00-0000-7000-8000-000000000001', {});
		now = 5_001;

		leaseManager.reapExpiredActiveUses();

		expect(leaseManager.getActiveUseCount(lease.id)).toBe(1);
		expect(closeMock).not.toHaveBeenCalled();

		leaseManager.endActiveUse(lease.id, '01890f00-0000-7000-8000-000000000001', {
			outcome: 'completed',
		});
		now = 9_000;
		leaseManager.reapExpiredActiveUses();

		expect(leaseManager.getActiveUseCount(lease.id)).toBe(0);
		expect(closeMock).not.toHaveBeenCalled();
	});

	it('closes the VM and releases the tcp slot when enabling SSH fails', async () => {
		const closeMock = vi.fn(async () => {});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => {
					throw new Error('ssh setup failed');
				}),
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				id: 'tool-vm-ssh-fail',
				setIngressRoutes: vi.fn(),
				getHostPid: () => 12345,
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool,
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/host/agent-work',
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toThrow('ssh setup failed');

		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(tcpPool.allocate()).toBe(0);
	});

	it('logs rollback close failures when enabling SSH fails', async () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const closeMock = vi.fn(async () => {
			throw new Error('rollback close failed');
		});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => {
					throw new Error('ssh setup failed');
				}),
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				id: 'tool-vm-ssh-fail-close-fail',
				setIngressRoutes: vi.fn(),
				getHostPid: () => 12345,
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool,
		});

		try {
			await expect(
				leaseManager.createLease({
					agentId: 'main',
					agentWorkspaceDir: '/host/agent-work',
					profile: {
						cpus: 1,
						memory: '1G',
						imageProfile: 'default',
					},
					profileId: 'standard',
					guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
					hostWorkMountDir: '/host/sandbox-work',
					zoneId: 'shravan',
				}),
			).rejects.toThrow('ssh setup failed');

			expect(closeMock).toHaveBeenCalledTimes(1);
			// VM created but close failed → slot must be quarantined, not freed,
			// because the QEMU may still hold the host port.
			expect(tcpPool.isQuarantined(0)).toBe(true);
			expect(() => tcpPool.allocate()).toThrow('No TCP slots available');
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some((message) =>
					message.includes(
						"failed to close partially-created lease VM for zone 'shravan' agent 'main'",
					),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});
});

describe('createLeaseManager — runtime record disk integration', () => {
	const createdDirectories: string[] = [];
	afterEach(() => {
		for (const directoryPath of createdDirectories.splice(0)) {
			fs.rmSync(directoryPath, { force: true, recursive: true });
		}
	});

	function createTempStateDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-lease-mgr-fs-'));
		createdDirectories.push(dir);
		return dir;
	}

	function makeIntegrationManagedVm(): ManagedVm & { closeMock: ReturnType<typeof vi.fn> } {
		const closeMock = vi.fn(async () => {});
		return {
			close: closeMock,
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				command: 'ssh ...',
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			id: 'tool-vm-integration',
			setIngressRoutes: vi.fn(),
			getHostPid: () => 31337,
			getVmInstance: vi.fn(),
			closeMock,
		} as ManagedVm & { closeMock: ReturnType<typeof vi.fn> };
	}

	const integrationLeaseRequest = {
		agentId: 'main',
		agentWorkspaceDir: '/home/openclaw/work',
		profile: { cpus: 1, memory: '1G', imageProfile: 'default' as const },
		profileId: 'standard' as const,
		guestWorkdir: '/work',
		hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/integration/work',
		zoneId: 'shravan',
	};

	it('createLease writes a real file to $stateDir/tool-leases/ and releaseLease deletes it on success', async () => {
		const stateDir = createTempStateDir();
		const vm = makeIntegrationManagedVm();
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => vm),
			createRuntimeRecordId: () => '01890f00-0000-7000-8000-000000000001',
			// override the no-op defaults with the real fs writers
			deleteToolVmRuntimeRecord,
			writeToolVmRuntimeRecord,
			stateDirFor: () => stateDir,
			now: () => 1_700_000_000_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});

		const lease = await leaseManager.createLease(integrationLeaseRequest);
		const recordPath = path.join(stateDir, 'tool-leases', `${lease.runtimeRecordId}.json`);
		expect(fs.existsSync(recordPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			agentId: 'main',
			configPath: '/etc/agent-vm/system.json',
			controllerPort: 18800,
			gateway: {
				sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			},
			leaseId: lease.id,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 31337,
			recordId: '01890f00-0000-7000-8000-000000000001',
			schemaVersion: 1,
			tcpSlot: 0,
			vmId: 'tool-vm-integration',
			zoneId: 'shravan',
		});
		expect(parsed).not.toHaveProperty('scopeKey');

		await leaseManager.releaseLease(lease.id);
		expect(fs.existsSync(recordPath)).toBe(false);
	});

	it('releaseLease preserves the record on disk when vm.close() throws', async () => {
		const stateDir = createTempStateDir();
		const vm = makeIntegrationManagedVm();
		vm.closeMock.mockRejectedValueOnce(new Error('close hung'));
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => vm),
			createRuntimeRecordId: () => '01890f00-0000-7000-8000-000000000002',
			deleteToolVmRuntimeRecord,
			writeToolVmRuntimeRecord,
			stateDirFor: () => stateDir,
			now: () => 1_700_000_000_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});

		const lease = await leaseManager.createLease(integrationLeaseRequest);
		const recordPath = path.join(stateDir, 'tool-leases', `${lease.runtimeRecordId}.json`);
		expect(fs.existsSync(recordPath)).toBe(true);

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow(/close hung/u);
		// Critical invariant: record must remain so the next controller startup's
		// Phase A cleanup can scope-fence + signal the orphan QEMU.
		expect(fs.existsSync(recordPath)).toBe(true);
	});
});
