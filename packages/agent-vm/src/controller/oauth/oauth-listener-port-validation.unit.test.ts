import { describe, expect, it } from 'vitest';

import {
	assertOAuthListenerPortAvailable,
	type OAuthListenerPortSystemConfig,
} from './oauth-listener-port-validation.js';

function systemConfig(): OAuthListenerPortSystemConfig {
	return {
		host: {
			controllerPort: 18_800,
			observability: {
				enabled: true,
				ports: { collector: 18_850 },
			},
		},
		tcpPool: { basePort: 19_000, size: 5 },
		zones: [{ gateway: { port: 18_792 } }],
	};
}

describe('OAuth listener port validation', () => {
	it.each([18_800, 18_792, 18_850, 19_000, 19_004])(
		'rejects reserved host port %i',
		(oauthPort) => {
			expect(() =>
				assertOAuthListenerPortAvailable({ oauthPort, systemConfig: systemConfig() }),
			).toThrow(`OAuth listener port ${String(oauthPort)} collides with another host port.`);
		},
	);

	it('accepts a port outside every reserved set', () => {
		expect(() =>
			assertOAuthListenerPortAvailable({ oauthPort: 18_900, systemConfig: systemConfig() }),
		).not.toThrow();
	});
});
