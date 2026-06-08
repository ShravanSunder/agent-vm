import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

import { createManagedVm } from '@agent-vm/gondolin-adapter';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { shouldRunLiveVmIntegration } from './live-integration-gates.js';

const describeLiveVmIntegration = shouldRunLiveVmIntegration() ? describe : describe.skip;
const wrapperEvidenceSchema = z.object({
	code: z.literal('controller-request-timeout'),
	elapsedMs: z.number().nonnegative(),
	name: z.string(),
	ok: z.literal(true),
	operation: z.literal('gateway-control-link'),
});

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
		const pluginDistIndexPath = new URL(
			'../../../openclaw-agent-vm-plugin/dist/index.js',
			import.meta.url,
		);
		if (!existsSync(pluginDistIndexPath)) {
			throw new Error(
				'Plugin not built. Run: pnpm --filter @agent-vm/openclaw-agent-vm-plugin build',
			);
		}
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
			vfsMounts: {
				'/repo': {
					kind: 'realfs-readonly',
					hostPath: process.cwd(),
				},
			},
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

		const wrapperResult =
			await gatewayVm.exec(`env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy NO_PROXY=controller.vm.host no_proxy=controller.vm.host node --input-type=module <<'NODE'
import {
	ControllerRequestPolicyTransportError,
	fetchControllerWithPolicy,
} from 'file:///repo/packages/openclaw-agent-vm-plugin/dist/index.js';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

const startedAtMs = Date.now();
try {
	const response = await fetchControllerWithPolicy({
		fetchImpl: fetch,
		init: { method: 'GET' },
		input: 'http://controller.vm.host:18800/stall',
		operation: 'gateway-control-link',
		policy: {
			idempotency: 'read',
			maxAttempts: 1,
			retryBaseDelayMs: 0,
			retryEnabled: false,
			retryStatuses: [],
			timeoutMs: 500,
		},
	});
	console.log(JSON.stringify({
		body: await response.text().catch((error) => String(error)),
		name: 'unexpected-success',
		ok: false,
		status: response.status,
	}));
	process.exit(1);
} catch (error) {
	console.log(JSON.stringify({
		code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
		elapsedMs: Date.now() - startedAtMs,
		name: error instanceof Error ? error.name : String(error),
		ok: error instanceof ControllerRequestPolicyTransportError
			&& error.code === 'controller-request-timeout',
		operation: error && typeof error === 'object' && 'operation' in error ? error.operation : undefined,
	}));
}
NODE`);
		if (wrapperResult.exitCode !== 0) {
			throw new Error(
				`controller wrapper script failed: stdout=${wrapperResult.stdout} stderr=${wrapperResult.stderr}`,
			);
		}
		expect(wrapperResult.exitCode).toBe(0);
		const wrapperEvidence = wrapperEvidenceSchema.parse(JSON.parse(wrapperResult.stdout));
		expect(wrapperEvidence.elapsedMs).toBeLessThan(10_000);
	});
});
