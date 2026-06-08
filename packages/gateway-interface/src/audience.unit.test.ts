import { describe, expect, it } from 'vitest';

import { gatewayVmAllowedHosts, egressHostsForAudience } from './audience.js';

describe('egressHostsForAudience', () => {
	it('returns gateway and shared hosts for gateway VMs', () => {
		const hosts = egressHostsForAudience(
			[
				{ host: 'discord.com', audience: 'gateway' },
				{ host: 'api.github.com', audience: 'both' },
				{ host: 'api.linear.app', audience: 'tool-vm' },
			],
			'gateway',
		);

		expect(hosts).toEqual(['discord.com', 'api.github.com']);
	});

	it('returns tool VM and shared hosts for Tool VMs', () => {
		const hosts = egressHostsForAudience(
			[
				{ host: 'discord.com', audience: 'gateway' },
				{ host: 'api.github.com', audience: 'both' },
				{ host: 'mcp2.readwise.io', audience: 'tool-vm' },
			],
			'tool-vm',
		);

		expect(hosts).toEqual(['api.github.com', 'mcp2.readwise.io']);
	});

	it('adds the internal controller host to gateway VM allowed hosts', () => {
		const hosts = gatewayVmAllowedHosts([
			{ host: 'controller.vm.host', audience: 'gateway' },
			{ host: 'api.github.com', audience: 'both' },
			{ host: 'mcp2.readwise.io', audience: 'tool-vm' },
		]);

		expect(hosts).toEqual(['controller.vm.host', 'api.github.com']);
	});
});
