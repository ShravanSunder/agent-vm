import { describe, expect, it } from 'vitest';

import { createLeaseClient } from './lease-client.js';

describe('createLeaseClient', () => {
	it('requests, checks, and releases leases through the controller API', async () => {
		const requests: { method: string; url: string }[] = [];
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async (input, init) => {
				requests.push({
					method: init?.method ?? 'GET',
					url: String(input),
				});

				return new Response(
					JSON.stringify({
						leaseId: 'lease-123',
						ssh: {
							host: 'tool-0.vm.host',
							identityPem: 'pem',
							knownHostsLine: 'known-hosts',
							port: 22,
							user: 'sandbox',
						},
						tcpSlot: 0,
						workdir: '/workspace',
					}),
					{
						headers: {
							'content-type': 'application/json',
						},
						status: 200,
					},
				);
			},
		});

		await leaseClient.requestLease({
			agentWorkspaceDir: '/home/openclaw/workspace',
			profileId: 'standard',
			scopeKey: 'agent:main:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/sandboxes/workspace',
			zoneId: 'shravan',
		});
		await leaseClient.getLeaseStatus('lease-123');
		await leaseClient.releaseLease('lease-123');

		expect(requests).toEqual([
			{ method: 'POST', url: 'http://controller.vm.host:18800/lease' },
			{ method: 'GET', url: 'http://controller.vm.host:18800/lease/lease-123' },
			{ method: 'DELETE', url: 'http://controller.vm.host:18800/lease/lease-123' },
		]);
	});
});
