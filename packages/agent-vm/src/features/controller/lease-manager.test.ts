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
});
