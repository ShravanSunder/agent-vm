import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { createManagedVm } from '@agent-vm/gondolin-adapter';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterAll, describe, expect, it } from 'vitest';

import { shouldRunLiveVmIntegration } from './live-integration-gates.js';

const describeLiveVmIntegration = shouldRunLiveVmIntegration() ? describe : describe.skip;

async function listenOnLoopback(server: Server): Promise<number> {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Expected TCP server address.');
	}
	return address.port;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	server.close();
	await once(server, 'close');
}

function isExpectedGondolinSyntheticIpv4(ipAddress: string): boolean {
	if (ipAddress === '198.18.0.1') {
		return true;
	}
	const match = /^198\.19\.(\d{1,3})\.(\d{1,3})$/u.exec(ipAddress);
	if (!match) {
		return false;
	}
	const thirdOctet = Number(match[1]);
	const fourthOctet = Number(match[2]);
	return (
		Number.isInteger(thirdOctet) &&
		Number.isInteger(fourthOctet) &&
		thirdOctet >= 0 &&
		thirdOctet <= 255 &&
		fourthOctet >= 0 &&
		fourthOctet <= 255
	);
}

describeLiveVmIntegration('live: gateway VM controller tcp.hosts path', () => {
	let gatewayVm: ManagedVm | null = null;
	let controllerServer: Server | null = null;

	afterAll(async () => {
		if (gatewayVm) await gatewayVm.close().catch(() => {});
		if (controllerServer) await closeServer(controllerServer).catch(() => {});
	});

	it('resolves controller.vm.host, reaches the host controller, and bounds stalled responses', async () => {
		controllerServer = createServer((request, response) => {
			if (request.url === '/health') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ ok: true }));
				return;
			}
			if (request.url === '/stall') {
				// Accept the request and leave it open to model a stalled controller response.
				return;
			}
			response.writeHead(404, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ error: 'not found' }));
		});
		const controllerPort = await listenOnLoopback(controllerServer);

		gatewayVm = await createManagedVm({
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [],
			secrets: {},
			vfsMounts: {},
			tcpHosts: {
				'controller.vm.host:18800': `127.0.0.1:${String(controllerPort)}`,
			},
		});

		const dnsResult = await gatewayVm.exec(
			"getent ahostsv4 controller.vm.host | awk 'NR == 1 { print $1 }'",
		);
		expect(dnsResult.exitCode).toBe(0);
		const syntheticIp = dnsResult.stdout.trim();
		expect(isExpectedGondolinSyntheticIpv4(syntheticIp)).toBe(true);
		process.stdout.write(`controller.vm.host synthetic IPv4: ${syntheticIp}\n`);

		const healthResult = await gatewayVm.exec('curl -4 -sS http://controller.vm.host:18800/health');
		expect(healthResult.exitCode).toBe(0);
		expect(healthResult.stdout).toContain('"ok":true');

		const startedAtMs = Date.now();
		const stalledResult = await gatewayVm.exec(
			'curl -4 -sS --max-time 2 http://controller.vm.host:18800/stall',
		);
		const elapsedMs = Date.now() - startedAtMs;

		expect(stalledResult.exitCode).toBe(28);
		expect(stalledResult.stderr).toContain('Operation timed out');
		expect(elapsedMs).toBeLessThan(10_000);
	});
});
