import { describe, expect, it, vi } from 'vitest';

import { createLeaseManager } from './lease-manager.js';
import { createTcpPool } from './tcp-pool.js';

describe('createLeaseManager', () => {
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
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: enableSshMock,
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
				getVmInstance: vi.fn(),
			})),
			now: () => 123,
			tcpPool: createTcpPool({
				basePort: 19000,
				size: 2,
			}),
		});

		const lease = await leaseManager.createLease({
			agentWorkspaceDir: '/home/openclaw/workspace',
			profile: {
				cpus: 1,
				memory: '1G',
				workspaceRoot: '/workspaces/tools',
			},
			profileId: 'standard',
			scopeKey: 'agent:main:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/sandboxes/session/workspace',
			zoneId: 'shravan',
		});

		expect(lease.tcpSlot).toBe(0);
		expect(leaseManager.getLease(lease.id)).toMatchObject({
			id: lease.id,
			zoneId: 'shravan',
		});

		await leaseManager.releaseLease(lease.id);

		expect(closeMock).toHaveBeenCalled();
		expect(leaseManager.getLease(lease.id)).toBeUndefined();
	});

	it('listLeases returns all active leases', async () => {
		const leaseManager = createLeaseManager({
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
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 5 }),
		});

		const lease1 = await leaseManager.createLease({
			agentWorkspaceDir: '/workspace',
			profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
			profileId: 'standard',
			scopeKey: 'scope-a',
			workspaceDir: '/workspace',
			zoneId: 'shravan',
		});
		const lease2 = await leaseManager.createLease({
			agentWorkspaceDir: '/workspace',
			profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
			profileId: 'standard',
			scopeKey: 'scope-b',
			workspaceDir: '/workspace',
			zoneId: 'shravan',
		});

		const all = leaseManager.listLeases();
		expect(all).toHaveLength(2);
		expect(all.map((lease) => lease.id)).toContain(lease1.id);
		expect(all.map((lease) => lease.id)).toContain(lease2.id);
	});

	it('releaseLease is a no-op for non-existent lease ids', async () => {
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		// Should not throw
		await leaseManager.releaseLease('does-not-exist');

		expect(leaseManager.listLeases()).toHaveLength(0);
	});

	it('cleans the host workspace when releasing a lease', async () => {
		const closeMock = vi.fn(async () => {});
		const cleanWorkspace = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			cleanWorkspace,
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
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				id: 'tool-vm-clean',
				setIngressRoutes: vi.fn(),
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		const lease = await leaseManager.createLease({
			agentWorkspaceDir: '/workspace',
			profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
			profileId: 'standard',
			scopeKey: 'scope-clean',
			workspaceDir: '/workspace',
			zoneId: 'shravan',
		});

		await leaseManager.releaseLease(lease.id);

		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(cleanWorkspace).toHaveBeenCalledWith({
			profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
			tcpSlot: 0,
			zoneId: 'shravan',
		});
	});

	it('releases bookkeeping even when vm.close throws', async () => {
		const closeMock = vi.fn(async () => {
			throw new Error('close failed');
		});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
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
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				id: 'tool-vm-close-fail',
				setIngressRoutes: vi.fn(),
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool,
		});

		const lease = await leaseManager.createLease({
			agentWorkspaceDir: '/workspace',
			profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
			profileId: 'standard',
			scopeKey: 'scope-close-fail',
			workspaceDir: '/workspace',
			zoneId: 'shravan',
		});

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow('close failed');
		expect(leaseManager.getLease(lease.id)).toBeUndefined();
		expect(tcpPool.allocate()).toBe(0);
	});

	it('releases bookkeeping even when workspace cleanup throws after vm close', async () => {
		const closeMock = vi.fn(async () => {});
		const cleanWorkspace = vi.fn(async () => {
			throw new Error('cleanup failed');
		});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			cleanWorkspace,
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
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				id: 'tool-vm-cleanup-fail',
				setIngressRoutes: vi.fn(),
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool,
		});

		const lease = await leaseManager.createLease({
			agentWorkspaceDir: '/workspace',
			profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
			profileId: 'standard',
			scopeKey: 'scope-cleanup-fail',
			workspaceDir: '/workspace',
			zoneId: 'shravan',
		});

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow('cleanup failed');
		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(leaseManager.getLease(lease.id)).toBeUndefined();
		expect(tcpPool.allocate()).toBe(0);
	});

	it('releases the tcp slot when VM creation fails', async () => {
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(async () => {
				throw new Error('vm create failed');
			}),
			now: () => 100,
			tcpPool,
		});

		await expect(
			leaseManager.createLease({
				agentWorkspaceDir: '/workspace',
				profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
				profileId: 'standard',
				scopeKey: 'scope-fail',
				workspaceDir: '/workspace',
				zoneId: 'shravan',
			}),
		).rejects.toThrow('vm create failed');

		expect(tcpPool.allocate()).toBe(0);
	});

	it('closes the VM and releases the tcp slot when enabling SSH fails', async () => {
		const closeMock = vi.fn(async () => {});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => {
					throw new Error('ssh setup failed');
				}),
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				id: 'tool-vm-ssh-fail',
				setIngressRoutes: vi.fn(),
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool,
		});

		await expect(
			leaseManager.createLease({
				agentWorkspaceDir: '/workspace',
				profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
				profileId: 'standard',
				scopeKey: 'scope-ssh-fail',
				workspaceDir: '/workspace',
				zoneId: 'shravan',
			}),
		).rejects.toThrow('ssh setup failed');

		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(tcpPool.allocate()).toBe(0);
	});
});
