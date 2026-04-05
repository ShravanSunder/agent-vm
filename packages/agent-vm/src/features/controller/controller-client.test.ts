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

		await controllerClient.getStatus();
		await controllerClient.getLogs('shravan');
		await controllerClient.refreshCredentials('shravan');
		await controllerClient.destroyZone('shravan', true);
		await controllerClient.upgradeZone('shravan');

		expect(requests).toEqual([
			{ method: 'GET', url: 'http://127.0.0.1:18800/status' },
			{ method: 'GET', url: 'http://127.0.0.1:18800/zones/shravan/logs' },
			{ method: 'POST', url: 'http://127.0.0.1:18800/zones/shravan/credentials/refresh' },
			{ method: 'POST', url: 'http://127.0.0.1:18800/zones/shravan/destroy' },
			{ method: 'POST', url: 'http://127.0.0.1:18800/zones/shravan/upgrade' },
		]);
	});
});
