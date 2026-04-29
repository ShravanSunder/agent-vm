import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { describe, expect, it, vi } from 'vitest';

import { createLeaseManager, LeaseScopeConflictError } from './lease-manager.js';
import { createTcpPool } from './tcp-pool.js';

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
		exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
		id,
		setIngressRoutes: vi.fn(),
		getVmInstance: vi.fn(),
	};
}

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
			agentWorkspaceDir: '/home/openclaw/work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'agent:main:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/sandboxes/session/work',
			zoneId: 'shravan',
		});

		expect(lease.tcpSlot).toBe(0);
		expect(leaseManager.getLease(lease.id)).toMatchObject({
			id: lease.id,
			agentWorkspaceDir: '/home/openclaw/work',
			workspaceDir: '/home/openclaw/.openclaw/sandboxes/session/work',
			zoneId: 'shravan',
		});

		await leaseManager.releaseLease(lease.id);

		expect(closeMock).toHaveBeenCalled();
		expect(leaseManager.getLease(lease.id)).toBeUndefined();
	});

	it('reuses a live lease for the same zone scope profile and workspace', async () => {
		let now = 100;
		const createManagedVm = vi.fn(async () => createManagedVmStub());
		const leaseManager = createLeaseManager({
			createManagedVm,
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'agent:main',
			workspaceDir: '/host/sandbox-work',
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

	it('rejects same-scope lease reuse when the workspace changes', async () => {
		const closeMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease({
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'agent:main',
			workspaceDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(
			leaseManager.createLease({
				agentWorkspaceDir: '/host/agent-work',
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				scopeKey: 'agent:main',
				workspaceDir: '/host/other-sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			"Tool VM lease scope conflict for zone 'shravan' scopeKey 'agent:main': existing workspaceDir '/host/sandbox-work' does not match requested workspaceDir '/host/other-sandbox-work'.",
		);
		expect(closeMock).not.toHaveBeenCalled();
	});

	it('rejects same-scope lease reuse when the profile changes', async () => {
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease({
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'agent:main',
			workspaceDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(
			leaseManager.createLease({
				agentWorkspaceDir: '/host/agent-work',
				profile: {
					cpus: 2,
					memory: '2G',
					imageProfile: 'large',
				},
				profileId: 'large',
				scopeKey: 'agent:main',
				workspaceDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toBeInstanceOf(LeaseScopeConflictError);
	});

	it('rejects same-scope lease reuse when the agent workspace changes', async () => {
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease({
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'agent:main',
			workspaceDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(
			leaseManager.createLease({
				agentWorkspaceDir: '/host/other-agent-work',
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				scopeKey: 'agent:main',
				workspaceDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toBeInstanceOf(LeaseScopeConflictError);
	});

	it('does not reuse matching scope keys across zones', async () => {
		const createManagedVm = vi.fn(async () =>
			createManagedVmStub(`tool-vm-${createManagedVm.mock.calls.length}`),
		);
		const leaseManager = createLeaseManager({
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});
		const request = {
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'agent:main',
			workspaceDir: '/host/sandbox-work',
		};

		const firstLease = await leaseManager.createLease({ ...request, zoneId: 'shravan' });
		const secondLease = await leaseManager.createLease({ ...request, zoneId: 'alex' });

		expect(secondLease.id).not.toBe(firstLease.id);
		expect(secondLease.tcpSlot).toBe(1);
		expect(createManagedVm).toHaveBeenCalledTimes(2);
	});

	it('evicts a stale same-scope lease before creating a replacement', async () => {
		const staleClose = vi.fn(async () => {});
		const staleVm = {
			...createManagedVmStub('stale-vm'),
			close: staleClose,
			exec: vi.fn(async () => {
				throw new Error('vm is gone');
			}),
		};
		const freshVm = createManagedVmStub('fresh-vm');
		const createManagedVm = vi.fn(async () =>
			createManagedVm.mock.calls.length === 1 ? staleVm : freshVm,
		);
		const leaseManager = createLeaseManager({
			createManagedVm,
			now: () => createManagedVm.mock.calls.length * 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'agent:main',
			workspaceDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};

		const firstLease = await leaseManager.createLease(request);
		const secondLease = await leaseManager.createLease(request);

		expect(secondLease.id).not.toBe(firstLease.id);
		expect(secondLease.vm.id).toBe('fresh-vm');
		expect(staleClose).toHaveBeenCalled();
		expect(createManagedVm).toHaveBeenCalledTimes(2);
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
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});
		const request = {
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'agent:main',
			workspaceDir: '/host/sandbox-work',
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
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'scope-a',
			workspaceDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});
		const lease2 = await leaseManager.createLease({
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'scope-b',
			workspaceDir: '/host/sandbox-work',
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
			agentWorkspaceDir: '/host/agent-work',
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			scopeKey: 'scope-close-fail',
			workspaceDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow('close failed');
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
				agentWorkspaceDir: '/host/agent-work',
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				scopeKey: 'scope-fail',
				workspaceDir: '/host/sandbox-work',
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
				agentWorkspaceDir: '/host/agent-work',
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				scopeKey: 'scope-ssh-fail',
				workspaceDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toThrow('ssh setup failed');

		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(tcpPool.allocate()).toBe(0);
	});
});
