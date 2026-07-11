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

const mediationHost = 'gondolin-mediation-test.vm.host';
const mediationUpstreamHost = '127.0.0.1';
const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;

async function createStandaloneOwnershipReservation(
	testDeploymentRoot: string,
): Promise<ManagedVmOwnershipReservationReferenceV1> {
	const vmIdentity = randomUUID();
	const ownershipReservation = await createManagedVmOwnershipReservation({
		controllerEpoch: 'live-gondolin-http-mediation-e2e',
		parentGateway: null,
		reservationId: `reservation-${vmIdentity}`,
		reservationRoot: path.join(testDeploymentRoot, 'state', 'vm-ownership'),
		role: 'standalone',
		sessionLabel: 'live-gondolin-http-mediation',
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
	let vm: ManagedVm | null = null;
	let testDeploymentRoot: string | null = null;

	beforeAll(async () => {
		testDeploymentRoot = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-gondolin-http-mediation-e2e-'),
		);
	});

	afterAll(async () => {
		if (vm) {
			const receipt = await vm.close();
			assertVmDestructionComplete(receipt, 'Gondolin HTTP mediation VM cleanup');
			vm = null;
		}
		if (testDeploymentRoot !== null) {
			await rm(testDeploymentRoot, { force: true, recursive: true });
			testDeploymentRoot = null;
		}
	});

	it('should support HTTP mediation with secret injection', async () => {
		if (testDeploymentRoot === null) throw new Error('test deployment root is unavailable');
		if (vm) {
			const receipt = await vm.close();
			assertVmDestructionComplete(receipt, 'prior Gondolin HTTP mediation VM cleanup');
			vm = null;
		}
		const headerEchoServer = await createHeaderEchoServer();

		try {
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
						value: 'real-secret-value-12345',
					},
				},
				onRequest: rewriteMediationHostToLoopback(headerEchoServer.port),
				tcpHosts: {
					[`${mediationUpstreamHost}:${String(headerEchoServer.port)}`]: `${mediationUpstreamHost}:${String(headerEchoServer.port)}`,
				},
				vfsMounts: {},
			});

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
