import { describe, expect, it } from 'vitest';

import { createControllerClient } from './controller-client.js';

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

				return new Response(JSON.stringify({ ok: true, zoneId: 'shravan' }), {
					headers: {
						'content-type': 'application/json',
					},
					status: 200,
				});
			},
		});

		if (
			!controllerClient.getZoneHealth ||
			!controllerClient.getZoneHealthSnapshot ||
			!controllerClient.getZoneServiceHealth
		) {
			throw new Error('Expected controller client to include zone health methods.');
		}
		await controllerClient.getControllerStatus();
		await controllerClient.getZoneHealth('shravan');
		await controllerClient.getZoneHealthSnapshot('shravan');
		await controllerClient.getZoneServiceHealth('shravan');
		await controllerClient.getZoneLogs('shravan');
		await controllerClient.execInZone?.('shravan', 'echo hi', { adminToken: 'admin-token' });
		await controllerClient.refreshZoneCredentials('shravan');
		await controllerClient.retireCredentialedRuntime?.('shravan', 'google workspace', {
			adminToken: 'admin-token',
			agentId: 'sun',
			force: true,
		});
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

		expect(requests).toEqual([
			{ method: 'GET', url: 'http://127.0.0.1:18800/controller-status' },
			{ method: 'GET', url: 'http://127.0.0.1:18800/zones/shravan/health' },
			{ method: 'GET', url: 'http://127.0.0.1:18800/zones/shravan/health-snapshot' },
			{ method: 'GET', url: 'http://127.0.0.1:18800/zones/shravan/service-health' },
			{ method: 'GET', url: 'http://127.0.0.1:18800/zones/shravan/logs' },
			{
				body: JSON.stringify({ adminToken: 'admin-token', command: 'echo hi' }),
				method: 'POST',
				url: 'http://127.0.0.1:18800/zones/shravan/execute-command',
			},
			{ method: 'POST', url: 'http://127.0.0.1:18800/zones/shravan/credentials/refresh' },
			{
				body: JSON.stringify({ adminToken: 'admin-token', agentId: 'sun', force: true }),
				method: 'POST',
				url: 'http://127.0.0.1:18800/zones/shravan/credentialed-runtimes/google%20workspace/retire',
			},
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
		]);
	});

	it('does not expose deleted VM-facing lease peek or release client methods', () => {
		const controllerClient = createControllerClient({
			baseUrl: 'http://127.0.0.1:18800',
			fetchImpl: async () => new Response('{}', { status: 200 }),
		});

		expect('peekLease' in controllerClient).toBe(false);
		expect('releaseLease' in controllerClient).toBe(false);
		expect('listLeases' in controllerClient).toBe(false);
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
