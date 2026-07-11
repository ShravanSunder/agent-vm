import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
	createManagedVm,
	createManagedVmOwnershipReservation,
	type ManagedVm,
	type ManagedVmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertVmDestructionComplete } from '../shared/vm-destruction-receipt.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const TEST_SECRET_VALUE = 'agent-vm-http-mediation-test-secret';
const mediationHost = 'mediation-test.vm.host';
const mediationUpstreamHost = '127.0.0.1';
const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;

async function createStandaloneOwnershipReservation(
	testDeploymentRoot: string,
): Promise<ManagedVmOwnershipReservationReferenceV1> {
	const vmIdentity = randomUUID();
	const ownershipReservation = await createManagedVmOwnershipReservation({
		controllerEpoch: 'live-http-mediation-e2e',
		parentGateway: null,
		reservationId: `reservation-${vmIdentity}`,
		reservationRoot: path.join(testDeploymentRoot, 'state', 'vm-ownership'),
		role: 'standalone',
		sessionLabel: 'agent-vm-live-http-mediation-test',
		vmId: `vm-${vmIdentity}`,
	});
	return ownershipReservation.reference;
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
		throw new Error('Failed to start local HTTP mediation echo server.');
	}
	return { port: address.port, server };
}

async function closeServer(server: Server | null): Promise<void> {
	if (server === null) return;
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

async function closeVmAndRequireCompleteReceipt(managedVm: ManagedVm | null): Promise<void> {
	if (managedVm === null) return;
	const receipt = await managedVm.close();
	assertVmDestructionComplete(receipt, 'HTTP mediation VM cleanup');
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

describeLiveVmIntegration('live HTTP mediation', () => {
	let echoServer: Server | null = null;
	let vm: ManagedVm | null = null;
	let testDeploymentRoot: string | null = null;

	beforeAll(async () => {
		testDeploymentRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-http-mediation-e2e-'));
		const headerEchoServer = await createHeaderEchoServer();
		echoServer = headerEchoServer.server;
		vm = await createManagedVm({
			ownershipReservation: await createStandaloneOwnershipReservation(testDeploymentRoot),
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [mediationHost, mediationUpstreamHost],
			secrets: {
				TEST_TOKEN: {
					hosts: [mediationHost, mediationUpstreamHost],
					value: TEST_SECRET_VALUE,
				},
			},
			onRequest: rewriteMediationHostToLoopback(headerEchoServer.port),
			tcpHosts: {
				[`${mediationUpstreamHost}:${String(headerEchoServer.port)}`]: `${mediationUpstreamHost}:${String(headerEchoServer.port)}`,
			},
			vfsMounts: {},
			sessionLabel: 'agent-vm-live-http-mediation-test',
		});
	}, 60_000);

	afterAll(async () => {
		const cleanupResults = await Promise.allSettled([
			closeVmAndRequireCompleteReceipt(vm),
			closeServer(echoServer),
		]);
		const cleanupErrors: unknown[] = [];
		for (const result of cleanupResults) {
			if (result.status === 'rejected') {
				cleanupErrors.push(result.reason as unknown);
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, 'HTTP mediation E2E cleanup failed');
		}
		vm = null;
		echoServer = null;
		if (testDeploymentRoot !== null) {
			await rm(testDeploymentRoot, { force: true, recursive: true });
			testDeploymentRoot = null;
		}
	});

	it('keeps the real secret out of the VM env and injects it for an allowed host', async () => {
		if (!vm) throw new Error('VM was not initialized.');

		const envCheck = await vm.exec('printf "%s" "$TEST_TOKEN"');

		expect(envCheck.exitCode).toBe(0);
		expect(envCheck.stdout.trim()).toContain('GONDOLIN_SECRET_');
		expect(envCheck.stdout.trim()).not.toBe(TEST_SECRET_VALUE);

		const curlResult = await vm.exec(
			`curl -sS --max-time 10 -H "Authorization: Bearer $TEST_TOKEN" http://${mediationHost}/headers`,
		);

		expect(curlResult.exitCode).toBe(0);
		const parsedResponse = JSON.parse(curlResult.stdout) as {
			readonly headers?: { readonly Authorization?: string };
		};
		expect(parsedResponse.headers?.Authorization).toBe(`Bearer ${TEST_SECRET_VALUE}`);
	}, 30_000);

	it('blocks requests to hosts outside the allowlist', async () => {
		if (!vm) throw new Error('VM was not initialized.');

		const curlResult = await vm.exec(
			'curl -sS --max-time 10 -o /tmp/agent-vm-denied.txt -w "%{http_code}" http://example.com/; printf "\\n"; cat /tmp/agent-vm-denied.txt 2>/dev/null || true',
		);

		expect(curlResult.exitCode).toBe(0);
		expect(curlResult.stdout.startsWith('403\n')).toBe(true);
		expect(curlResult.stdout).toContain('403 Forbidden');
	}, 30_000);
});
