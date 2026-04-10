import { describe, expect, it } from 'vitest';

import { runControllerLogs } from './zone-logs.js';

describe('runControllerLogs', () => {
	it('returns streamed gateway output for the requested zone', async () => {
		await expect(
			runControllerLogs(
				{
					zoneId: 'shravan',
				},
				{
					readGatewayLogs: async (zoneId: string) => `logs:${zoneId}`,
				},
			),
		).resolves.toEqual({
			output: 'logs:shravan',
			zoneId: 'shravan',
		});
	});
});
