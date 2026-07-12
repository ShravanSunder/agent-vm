import http, { type Server } from 'node:http';

import { createGondolinManagedVmProvider } from '@agent-vm/gondolin-vm-adapter';
import type { ManagedVm } from '@agent-vm/managed-vm';
import { afterAll, describe, expect, it } from 'vitest';

import {
	terminateLiveManagedVm,
	type ManagedVmProcessTarget,
} from '../shared/controller-managed-vm-termination.js';
import {
	isProcessAlive,
	killProcess,
	readProcessCommand,
	readProcessIdentity,
	sleep,
} from '../shared/managed-vm-process.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const managedVmFactory = createGondolinManagedVmProvider().factory;

const mediationHost = 'gondolin-mediation-test.vm.host';
const mediationUpstreamHost = '127.0.0.1';
const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;

async function startVmAndCaptureProcess(managedVm: ManagedVm): Promise<ManagedVmProcessTarget> {
	await managedVm.start();
	const hostPid = managedVm.getHostProcessId();
	if (hostPid === null) {
		throw new Error(`Expected started VM '${managedVm.id}' to expose its host pid.`);
	}
	const processIdentity = await readProcessIdentity(hostPid);
	if (processIdentity === null) {
		throw new Error(`Expected started VM '${managedVm.id}' process identity.`);
	}
	return { hostPid, processIdentity, vmId: managedVm.id };
}

async function terminateVmRuntime(
	runtime: { readonly managedVm: ManagedVm; readonly target: ManagedVmProcessTarget } | null,
): Promise<void> {
	if (runtime === null) return;
	await terminateLiveManagedVm({
		contextLabel: 'Gondolin HTTP mediation VM cleanup',
		dependencies: { isProcessAlive, killProcess, readProcessCommand, readProcessIdentity, sleep },
		target: runtime.target,
		vm: runtime.managedVm,
	});
}

async function createHeaderEchoServer(): Promise<{
	readonly port: number;
	readonly server: Server;
}> {
	const server = http.createServer((request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(
			JSON.stringify({
				headers: {
					Authorization: request.headers.authorization ?? '',
				},
			}),
		);
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		server.close();
		throw new Error('Failed to start local Gondolin mediation echo server.');
	}
	return { port: address.port, server };
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function rewriteMediationHostToLoopback(
	port: number,
): (request: Request) => Promise<Request | void> {
	return async (request: Request): Promise<Request | void> => {
		const url = new URL(request.url);
		if (url.hostname !== mediationHost) {
			return;
		}

		url.hostname = mediationUpstreamHost;
		url.port = String(port);
		return new Request(url, {
			headers: request.headers,
			method: request.method,
		});
	};
}

describeLiveVmIntegration('live e2e: real Gondolin HTTP mediation', () => {
	let vmRuntime: { readonly managedVm: ManagedVm; readonly target: ManagedVmProcessTarget } | null =
		null;

	afterAll(async () => {
		await terminateVmRuntime(vmRuntime);
		vmRuntime = null;
	});

	it('should support HTTP mediation with secret injection', async () => {
		if (vmRuntime) {
			await terminateVmRuntime(vmRuntime);
			vmRuntime = null;
		}
		const headerEchoServer = await createHeaderEchoServer();

		try {
			const vm = await managedVmFactory.createManagedVm({
				allowedHosts: [mediationHost, mediationUpstreamHost],
				environment: {},
				imageReference: 'alpine-base:latest',
				mediatedSecrets: [
					{
						allowedHosts: [mediationHost, mediationUpstreamHost],
						environmentVariable: 'TEST_TOKEN',
						value: 'real-secret-value-12345',
					},
				],
				mediation: { onRequest: rewriteMediationHostToLoopback(headerEchoServer.port) },
				mounts: {},
				resources: { cpuCount: 1, memory: '512M' },
				rootfsMode: 'cow',
				sessionLabel: 'gondolin-http-mediation',
				tcpHosts: [
					{
						guestHost: `${mediationUpstreamHost}:${String(headerEchoServer.port)}`,
						target: `${mediationUpstreamHost}:${String(headerEchoServer.port)}`,
					},
				],
			});
			vmRuntime = { managedVm: vm, target: await startVmAndCaptureProcess(vm) };

			const envCheck = await vm.exec('echo $TEST_TOKEN');
			expect(envCheck.stdout.trim()).not.toBe('real-secret-value-12345');
			expect(envCheck.stdout.trim()).toContain('GONDOLIN_SECRET_');

			const curlResult = await vm.exec(
				`curl -sS -H "Authorization: Bearer $TEST_TOKEN" http://${mediationHost}/headers`,
			);

			expect(curlResult.stdout).toContain('real-secret-value-12345');
			expect(curlResult.exitCode).toBe(0);
		} finally {
			await closeServer(headerEchoServer.server);
		}
	}, 60_000);
});
