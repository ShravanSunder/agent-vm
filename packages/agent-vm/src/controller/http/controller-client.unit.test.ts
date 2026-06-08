import { describe, expect, it } from 'vitest';

import { createControllerClient } from './controller-client.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';

describe('createControllerClient', () => {
	it('calls the controller service routes for operational commands', async () => {
		const requests: { body?: string; method: string; url: string }[] = [];
		const controllerClient = createControllerClient({
			baseUrl: 'http://127.0.0.1:18800',
			fetchImpl: async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				requests.push({
					...(typeof init?.body === 'string' ? { body: init.body } : {}),
					method: init?.method ?? 'GET',
					url,
				});

				const responseBody = url.endsWith('/lease/lease-123/peek')
					? {
							agentId: 'main',
							createdAt: 1,
							idleTtlMs: 6_000_000,
							lastUsedAt: 1,
							leaseId: '01890f00-0000-7000-8000-000000000000',
							profileId: 'standard',
							ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
							tcpSlot: 0,
							transport: 'ssh-sandbox',
							workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
							zoneId: 'shravan',
						}
					: { ok: true, zoneId: 'shravan' };

				return new Response(JSON.stringify(responseBody), {
					headers: {
						'content-type': 'application/json',
					},
					status: 200,
				});
			},
		});

		await controllerClient.getControllerStatus();
		await controllerClient.getZoneLogs('shravan');
		await controllerClient.execInZone?.('shravan', 'echo hi', { adminToken: 'admin-token' });
		await controllerClient.refreshZoneCredentials('shravan');
		await controllerClient.enableZoneSsh('shravan', {
			adminToken: 'admin-token',
			secretEnv: 'gateway-token',
		});
		await controllerClient.enableZoneSsh('shravan', {
			adminToken: 'admin-token',
			secretEnv: 'all-secrets',
		});
		await controllerClient.destroyZone('shravan', true);
		await controllerClient.upgradeZone('shravan');
		const leasePeek = await controllerClient.peekLease('lease-123');

		expect(requests).toEqual([
			{ method: 'GET', url: 'http://127.0.0.1:18800/controller-status' },
			{ method: 'GET', url: 'http://127.0.0.1:18800/zones/shravan/logs' },
			{
				body: JSON.stringify({ adminToken: 'admin-token', command: 'echo hi' }),
				method: 'POST',
				url: 'http://127.0.0.1:18800/zones/shravan/execute-command',
			},
			{ method: 'POST', url: 'http://127.0.0.1:18800/zones/shravan/credentials/refresh' },
			{
				body: JSON.stringify({ adminToken: 'admin-token', secretEnv: 'gateway-token' }),
				method: 'POST',
				url: 'http://127.0.0.1:18800/zones/shravan/enable-ssh',
			},
			{
				body: JSON.stringify({ adminToken: 'admin-token', secretEnv: 'all-secrets' }),
				method: 'POST',
				url: 'http://127.0.0.1:18800/zones/shravan/enable-ssh',
			},
			{
				body: JSON.stringify({ purge: true }),
				method: 'POST',
				url: 'http://127.0.0.1:18800/zones/shravan/destroy',
			},
			{ method: 'POST', url: 'http://127.0.0.1:18800/zones/shravan/upgrade' },
			{ method: 'GET', url: 'http://127.0.0.1:18800/lease/lease-123/peek' },
		]);
		expect(leasePeek.agentId).toBe('main');
	});

	it('surfaces a readable error when a controller route returns non-json failure text', async () => {
		const controllerClient = createControllerClient({
			baseUrl: 'http://127.0.0.1:18800',
			fetchImpl: async () =>
				new Response('Internal Server Error', {
					headers: {
						'content-type': 'text/plain',
					},
					status: 500,
				}),
		});

		await expect(controllerClient.getZoneLogs('shravan')).rejects.toThrow(
			"Get logs for zone 'shravan' failed with HTTP 500: Internal Server Error",
		);
	});

	it('preserves the invalid response body when a success response is not JSON', async () => {
		const controllerClient = createControllerClient({
			baseUrl: 'http://127.0.0.1:18800',
			fetchImpl: async () =>
				new Response('not-json-body', {
					headers: {
						'content-type': 'text/plain',
					},
					status: 200,
				}),
		});

		await expect(controllerClient.getControllerStatus()).rejects.toThrow(
			'Get controller status returned invalid JSON: Unexpected token',
		);
		await expect(controllerClient.getControllerStatus()).rejects.toThrow('Body: not-json-body');
	});
});
