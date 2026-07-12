import { describe, expect, it } from 'vitest';

import {
	isVmCapabilityLease,
	isVmSshEndpoint,
	isVmSshPublicEndpoint,
} from './vm-capability-lease.js';

describe('VM capability lease primitives', () => {
	it('accepts transport-tagged capability leases and rejects wrong transports', () => {
		expect(
			isVmCapabilityLease(
				{
					leaseId: 'lease-123',
					transport: 'ssh-sandbox',
				},
				'ssh-sandbox',
			),
		).toBe(true);

		expect(
			isVmCapabilityLease(
				{
					leaseId: 'lease-123',
					transport: 'vm-rpc',
				},
				'ssh-sandbox',
			),
		).toBe(false);
	});

	it('accepts complete SSH endpoints and rejects partial endpoints', () => {
		expect(
			isVmSshEndpoint({
				host: 'tool-0.vm.host',
				identityPem: '-----BEGIN OPENSSH PRIVATE KEY-----',
				knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
				port: 22,
				user: 'root',
			}),
		).toBe(true);

		expect(
			isVmSshEndpoint({
				host: 'tool-0.vm.host',
				port: 22,
				user: 'root',
			}),
		).toBe(false);

		expect(
			isVmSshEndpoint({
				host: 'tool-0.vm.host',
				identityPem: '   ',
				knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
				port: 22,
				user: 'root',
			}),
		).toBe(false);
	});

	it('accepts only public SSH endpoint fields without private key material', () => {
		expect(
			isVmSshPublicEndpoint({
				host: 'tool-0.vm.host',
				port: 22,
				user: 'root',
			}),
		).toBe(true);

		expect(
			isVmSshPublicEndpoint({
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				port: 22,
				user: 'root',
			}),
		).toBe(false);

		expect(
			isVmSshPublicEndpoint({
				host: 'tool-0.vm.host',
				identityPem: undefined,
				port: 22,
				user: 'root',
			}),
		).toBe(false);

		expect(
			isVmSshPublicEndpoint({
				host: 'tool-0.vm.host',
				knownHostsLine: undefined,
				port: 22,
				user: 'root',
			}),
		).toBe(false);

		expect(
			isVmSshPublicEndpoint({
				host: 'tool-0.vm.host',
				port: 22,
				user: 'root',
				unexpected: 'field',
			}),
		).toBe(false);
	});
});
