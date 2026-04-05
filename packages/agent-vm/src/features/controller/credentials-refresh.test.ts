import { describe, expect, it } from 'vitest';

import { runControllerCredentialsRefresh } from './credentials-refresh.js';

describe('runControllerCredentialsRefresh', () => {
	it('refreshes secrets and restarts the gateway zone', async () => {
		const actions: string[] = [];

		await expect(
			runControllerCredentialsRefresh(
				{
					zoneId: 'shravan',
				},
				{
					refreshZoneSecrets: async (zoneId: string) => {
						actions.push(`refresh:${zoneId}`);
					},
					restartGatewayZone: async (zoneId: string) => {
						actions.push(`restart:${zoneId}`);
					},
				},
			),
		).resolves.toEqual({
			ok: true,
			zoneId: 'shravan',
		});
		expect(actions).toEqual(['refresh:shravan', 'restart:shravan']);
	});
});
