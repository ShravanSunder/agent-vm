import { describe, expect, it } from 'vitest';

import { createLeaseClient } from './controller-lease-client.js';

describe('createLeaseClient', () => {
	it('requests, keeps alive, peeks, and releases leases through the controller API', async () => {
		const requests: { body: string | undefined; method: string; url: string }[] = [];
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async (input, init) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				requests.push({
					body: typeof init?.body === 'string' ? init.body : undefined,
					method: init?.method ?? 'GET',
					url,
				});

				const responseBody = url.endsWith('/peek')
					? {
							createdAt: 1,
							lastUsedAt: 1,
							leaseId: 'lease-123',
							profileId: 'standard',
							scopeKey: 'agent:main:session-abc',
							ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
							tcpSlot: 0,
							zoneId: 'shravan',
						}
					: {
							leaseId: 'lease-123',
							ssh: {
								host: 'tool-0.vm.host',
								identityPem: 'pem',
								knownHostsLine: 'known-hosts',
								port: 22,
								user: 'sandbox',
							},
							tcpSlot: 0,
							workdir: '/work',
						};

				return new Response(JSON.stringify(responseBody), {
					headers: {
						'content-type': 'application/json',
					},
					status: 200,
				});
			},
		});

		await leaseClient.requestLease({
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
			scopeKey: 'agent:main:session-abc',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/work',
			zoneId: 'shravan',
		});
		await leaseClient.keepLeaseAlive('lease-123');
		await leaseClient.peekLease('lease-123');
		await leaseClient.releaseLease('lease-123');

		expect(requests).toEqual([
			{
				body: JSON.stringify({
					agentWorkspaceDir: '/home/openclaw/work',
					profileId: 'standard',
					scopeKey: 'agent:main:session-abc',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/work',
					zoneId: 'shravan',
				}),
				method: 'POST',
				url: 'http://controller.vm.host:18800/lease',
			},
			{ body: undefined, method: 'GET', url: 'http://controller.vm.host:18800/lease/lease-123' },
			{
				body: undefined,
				method: 'GET',
				url: 'http://controller.vm.host:18800/lease/lease-123/peek',
			},
			{
				body: undefined,
				method: 'DELETE',
				url: 'http://controller.vm.host:18800/lease/lease-123',
			},
		]);
	});

	it('throws TypeError when the controller returns an invalid lease response', async () => {
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: 'bad request' }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				}),
		});

		await expect(
			leaseClient.requestLease({
				agentWorkspaceDir: '/work',
				profileId: 'standard',
				scopeKey: 'test',
				workMountDir: '/work',
				zoneId: 'shravan',
			}),
		).rejects.toThrow('Controller returned an invalid lease response');
	});

	it('strips trailing slash from controller url', async () => {
		const requests: string[] = [];
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800/',
			fetchImpl: async (input) => {
				requests.push(
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
				);
				return new Response(
					JSON.stringify({
						leaseId: 'lease-1',
						ssh: { host: 'h', identityPem: 'p', knownHostsLine: '', port: 22, user: 'u' },
						tcpSlot: 0,
						workdir: '/w',
					}),
					{ headers: { 'content-type': 'application/json' }, status: 200 },
				);
			},
		});

		await leaseClient.requestLease({
			agentWorkspaceDir: '/work',
			profileId: 'standard',
			scopeKey: 'test',
			workMountDir: '/work',
			zoneId: 'shravan',
		});

		expect(requests[0]).toBe('http://controller.vm.host:18800/lease');
	});

	it('throws when lease keepalive returns a non-ok response', async () => {
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: 'missing lease' }), {
					headers: { 'content-type': 'application/json' },
					status: 404,
				}),
		});

		await expect(leaseClient.keepLeaseAlive('lease-missing')).rejects.toThrow(/HTTP 404/u);
	});
});
