import { describe, expect, it } from 'vitest';

import { createControllerClient } from './controller-client.js';

describe('createControllerClient', () => {
	it('calls the controller service routes for operational commands', async () => {
		const requests: { method: string; url: string }[] = [];
		const controllerClient = createControllerClient({
			baseUrl: 'http://127.0.0.1:18800',
			fetchImpl: async (input: string | URL, init?: RequestInit) => {
				requests.push({
					method: init?.method ?? 'GET',
					url: String(input),
				});

				return new Response(JSON.stringify({ ok: true, zoneId: 'shravan' }), {
					headers: {
						'content-type': 'application/json',
					},
					status: 200,
				});
			},
		});

		await controllerClient.getControllerStatus();
		await controllerClient.getZoneLogs('shravan');
		await controllerClient.execInZone?.('shravan', 'echo hi');
		await controllerClient.refreshZoneCredentials('shravan');
		await controllerClient.destroyZone('shravan', true);
		await controllerClient.upgradeZone('shravan');

		expect(requests).toEqual([
			{ method: 'GET', url: 'http://127.0.0.1:18800/controller-status' },
			{ method: 'GET', url: 'http://127.0.0.1:18800/zones/shravan/logs' },
			{ method: 'POST', url: 'http://127.0.0.1:18800/zones/shravan/execute-command' },
			{ method: 'POST', url: 'http://127.0.0.1:18800/zones/shravan/credentials/refresh' },
			{ method: 'POST', url: 'http://127.0.0.1:18800/zones/shravan/destroy' },
			{ method: 'POST', url: 'http://127.0.0.1:18800/zones/shravan/upgrade' },
		]);
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
