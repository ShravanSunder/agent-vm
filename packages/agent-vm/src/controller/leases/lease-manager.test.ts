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
			guestWorkdir: '/work',
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
			zoneId: 'shravan',
		});

		expect(lease.tcpSlot).toBe(0);
		expect(leaseManager.keepLeaseAlive(lease.id)?.lease).toMatchObject({
			id: lease.id,
			agentWorkspaceDir: '/home/openclaw/work',
			guestWorkdir: '/work',
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
			zoneId: 'shravan',
		});

		await leaseManager.releaseLease(lease.id);

		expect(closeMock).toHaveBeenCalled();
		expect(leaseManager.keepLeaseAlive(lease.id)).toBeUndefined();
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
			guestWorkdir: '/work',
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

	it('peeks a lease without extending its idle timestamp', async () => {
		let now = 100;
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(async () => createManagedVmStub()),
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
			guestWorkdir: '/work',
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};
		const lease = await leaseManager.createLease(request);
		now = 150;

		const peekedLease = leaseManager.peekLease(lease.id)?.lease;
		const keptAliveLease = leaseManager.keepLeaseAlive(lease.id)?.lease;

		expect(peekedLease).toMatchObject({ id: lease.id, lastUsedAt: 100 });
		expect(keptAliveLease).toMatchObject({ id: lease.id, lastUsedAt: 150 });
		expect(leaseManager.peekLease('missing-lease')).toBeUndefined();
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
			guestWorkdir: '/work',
			hostWorkMountDir: '/host/sandbox-work',
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
				guestWorkdir: '/work',
				hostWorkMountDir: '/host/other-sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			"Tool VM lease scope conflict for zone 'shravan' scopeKey 'agent:main': existing hostWorkMountDir '/host/sandbox-work' does not match requested hostWorkMountDir '/host/other-sandbox-work'.",
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
			guestWorkdir: '/work',
			hostWorkMountDir: '/host/sandbox-work',
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
				guestWorkdir: '/work',
				hostWorkMountDir: '/host/sandbox-work',
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
			guestWorkdir: '/work',
			hostWorkMountDir: '/host/sandbox-work',
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
				guestWorkdir: '/work',
				hostWorkMountDir: '/host/sandbox-work',
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
			guestWorkdir: '/work',
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
			guestWorkdir: '/work',
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};

		try {
			const firstLease = await leaseManager.createLease(request);
			const secondLease = await leaseManager.createLease(request);

			expect(secondLease.id).not.toBe(firstLease.id);
			expect(secondLease.vm.id).toBe('fresh-vm');
			expect(staleClose).toHaveBeenCalled();
			expect(createManagedVm).toHaveBeenCalledTimes(2);
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some((message) =>
					message.includes("liveness check failed for lease 'shravan-agent:main-100'"),
				),
			).toBe(true);
			expect(
				loggedMessages.some((message) =>
					message.includes("failed to close evicted lease 'shravan-agent:main-100'"),
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
			guestWorkdir: '/work',
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
			exec: vi.fn(async () => {
				markExecStarted?.();
				await execCanFinish;
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
		};
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(async () => vm),
			now: () => 100,
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
			guestWorkdir: '/work',
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
		expect(leaseManager.keepLeaseAlive(lease.id)).toBeUndefined();
	});

	it('does not release a lease that was touched after an idle reaper snapshot', async () => {
		let now = 100;
		const closeMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
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
			guestWorkdir: '/work',
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};
		const lease = await leaseManager.createLease(request);
		now = 200;
		await leaseManager.createLease(request);

		await leaseManager.releaseLease(lease.id, { ifLastUsedAtBeforeOrAt: 150 });

		expect(closeMock).not.toHaveBeenCalled();
		expect(leaseManager.keepLeaseAlive(lease.id)?.lease).toMatchObject({ id: lease.id });
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
			guestWorkdir: '/work',
			hostWorkMountDir: '/host/sandbox-work',
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
			guestWorkdir: '/work',
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
			guestWorkdir: '/work',
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow('close failed');
		expect(leaseManager.keepLeaseAlive(lease.id)).toBeUndefined();
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
				guestWorkdir: '/work',
				hostWorkMountDir: '/host/sandbox-work',
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
				guestWorkdir: '/work',
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
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => {
					throw new Error('ssh setup failed');
				}),
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				id: 'tool-vm-ssh-fail-close-fail',
				setIngressRoutes: vi.fn(),
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool,
		});

		try {
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
					guestWorkdir: '/work',
					hostWorkMountDir: '/host/sandbox-work',
					zoneId: 'shravan',
				}),
			).rejects.toThrow('ssh setup failed');

			expect(closeMock).toHaveBeenCalledTimes(1);
			expect(tcpPool.allocate()).toBe(0);
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some((message) =>
					message.includes(
						"failed to close partially-created lease VM for zone 'shravan' scope 'scope-ssh-fail'",
					),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});
});
