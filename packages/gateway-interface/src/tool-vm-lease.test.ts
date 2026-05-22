import { describe, expect, it } from 'vitest';

import { isToolVmLeasePeek, isToolVmSshLease } from './tool-vm-lease.js';

describe('Tool VM SSH lease types', () => {
	it('accepts an SSH lease capability and does not model filesystem methods', () => {
		const lease = {
			leaseId: 'zone-scope-123',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'known-hosts',
				port: 22,
				user: 'root',
			},
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/work',
		};

		expect(isToolVmSshLease(lease)).toBe(true);
		expect('readFile' in lease).toBe(false);
		expect('writeFile' in lease).toBe(false);
	});

	it('accepts read-only lease peek snapshots without private key material', () => {
		expect(
			isToolVmLeasePeek({
				createdAt: 1,
				lastUsedAt: 2,
				leaseId: 'zone-scope-123',
				profileId: 'standard',
				scopeKey: 'agent-session',
				ssh: {
					host: 'tool-0.vm.host',
					port: 22,
					user: 'root',
				},
				tcpSlot: 0,
				transport: 'ssh-sandbox',
				workdir: '/work',
				zoneId: 'default',
			}),
		).toBe(true);
	});
});
