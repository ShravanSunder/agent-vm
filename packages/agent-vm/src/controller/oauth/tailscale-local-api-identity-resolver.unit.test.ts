import { describe, expect, it, vi } from 'vitest';

import {
	createTailscaleLocalApiIdentityResolver,
	defaultTailscaleLocalApiSocketPath,
	resolveLocalTailscaleAddress,
} from './tailscale-local-api-identity-resolver.js';

describe('Tailscale LocalAPI identity resolver', () => {
	it('queries WhoIs with the exact IPv4 socket peer and returns its login identity', async () => {
		const getJson = vi.fn(async () => ({
			Node: { Name: 'phone.tailnet.example.' },
			UserProfile: { DisplayName: 'Authorized Human', LoginName: 'human@example.test' },
		}));
		const resolver = createTailscaleLocalApiIdentityResolver({ transport: { getJson } });

		await expect(
			resolver.resolvePeerIdentity({ remoteAddress: '100.100.100.10', remotePort: 48_123 }),
		).resolves.toEqual({ loginName: 'human@example.test' });
		expect(getJson).toHaveBeenCalledWith('/localapi/v0/whois?addr=100.100.100.10%3A48123');
	});

	it('brackets IPv6 peers and fails closed on malformed identity responses', async () => {
		const getJson = vi.fn(async () => ({ UserProfile: {} }));
		const resolver = createTailscaleLocalApiIdentityResolver({ transport: { getJson } });

		await expect(
			resolver.resolvePeerIdentity({
				remoteAddress: 'fd7a:115c:a1e0::1234',
				remotePort: 48_123,
			}),
		).rejects.toThrow();
		expect(getJson).toHaveBeenCalledWith(
			'/localapi/v0/whois?addr=%5Bfd7a%3A115c%3Aa1e0%3A%3A1234%5D%3A48123',
		);
	});

	it('uses the tailscaled socket paths for the supported host platforms', () => {
		expect(defaultTailscaleLocalApiSocketPath('darwin')).toBe('/var/run/tailscaled.socket');
		expect(defaultTailscaleLocalApiSocketPath('linux')).toBe('/var/run/tailscale/tailscaled.sock');
		expect(() => defaultTailscaleLocalApiSocketPath('win32')).toThrow('unsupported');
	});

	it('selects the local Tailscale IPv4 address from LocalAPI status', async () => {
		const getJson = vi.fn(async () => ({
			Self: { TailscaleIPs: ['fd7a:115c:a1e0::1234', '100.100.100.10'] },
		}));

		await expect(resolveLocalTailscaleAddress({ transport: { getJson } })).resolves.toBe(
			'100.100.100.10',
		);
		expect(getJson).toHaveBeenCalledWith('/localapi/v0/status');
	});
});
