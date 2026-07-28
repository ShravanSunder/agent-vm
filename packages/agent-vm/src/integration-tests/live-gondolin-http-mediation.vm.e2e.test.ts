import http, { type Server } from 'node:http';

import { createGondolinManagedVmProvider } from '@agent-vm/gondolin-vm-adapter';
import type { ManagedVm } from '@agent-vm/managed-vm';
import { afterAll, describe, expect, it } from 'vitest';

import { createGatewayObservabilityOtlpRequestMediation } from '../gateway/gateway-observability-otlp-request-mediation.js';
import {
	terminateLiveManagedVm,
	type ManagedVmProcessTarget,
} from '../shared/controller-managed-vm-termination.js';
import { readProcessIdentity, sleep } from '../shared/managed-vm-process.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const managedVmProvider = createGondolinManagedVmProvider();
const managedVmFactory = managedVmProvider.factory;

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
		exactProcessTermination: managedVmProvider.exactProcessTermination,
		sleep,
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

interface CapturedOtlpRequest {
	readonly body: string;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	readonly method: string | undefined;
	readonly url: string | undefined;
}

async function createOtlpCaptureServer(): Promise<{
	readonly capturedRequests: CapturedOtlpRequest[];
	readonly port: number;
	readonly server: Server;
}> {
	const capturedRequests: CapturedOtlpRequest[] = [];
	const server = http.createServer((request, response) => {
		const bodyChunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
		request.on('end', () => {
			capturedRequests.push({
				body: Buffer.concat(bodyChunks).toString('utf8'),
				headers: { ...request.headers },
				method: request.method,
				url: request.url,
			});
			response.statusCode = 200;
			response.setHeader('content-type', 'application/x-protobuf');
			response.setHeader('retry-after', '1');
			response.setHeader('set-cookie', 'controller-cookie=must-not-reach-guest');
			response.setHeader('x-controller-internal', 'must-not-reach-guest');
			response.end('collector-ok');
		});
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
		throw new Error('Failed to start local OTLP capture server.');
	}
	return { capturedRequests, port: address.port, server };
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
): (request: Request) => Promise<Request | Response | void> {
	return async (request: Request): Promise<Request | Response | void> => {
		const url = new URL(request.url);
		const requestPort = url.port.length === 0 ? 80 : Number.parseInt(url.port, 10);
		if (url.hostname === mediationUpstreamHost && requestPort === port) {
			return new Response(null, { status: 403, statusText: 'Forbidden' });
		}
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

	it('should prove rewrite-only denial and exact production OTLP Response mediation', async () => {
		if (vmRuntime) {
			await terminateVmRuntime(vmRuntime);
			vmRuntime = null;
		}
		const otlpCaptureServer = await createOtlpCaptureServer();
		const deniedLoopbackPort =
			otlpCaptureServer.port === 65_535 ? otlpCaptureServer.port - 1 : otlpCaptureServer.port + 1;

		try {
			const rewriteOnlyVm = await managedVmFactory.createManagedVm({
				allowedHosts: [mediationHost],
				environment: {},
				imageReference: 'alpine-base:latest',
				mediatedSecrets: [],
				mediation: {
					onRequest: rewriteMediationHostToLoopback(otlpCaptureServer.port),
				},
				mounts: {},
				resources: { cpuCount: 1, memory: '512M' },
				rootfsMode: 'cow',
				sessionLabel: 'gondolin-rewrite-only-http-mediation',
				tcpHosts: [],
			});
			vmRuntime = {
				managedVm: rewriteOnlyVm,
				target: await startVmAndCaptureProcess(rewriteOnlyVm),
			};

			const rewriteOnlyResult = await rewriteOnlyVm.exec(
				`printf 'baseline-payload' | curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/x-protobuf' --data-binary @- http://${mediationHost}/v1/traces`,
			);
			expect(rewriteOnlyResult.exitCode).toBe(0);
			expect(rewriteOnlyResult.stdout).toBe('403');
			expect(otlpCaptureServer.capturedRequests).toHaveLength(0);

			await terminateVmRuntime(vmRuntime);
			vmRuntime = null;

			const exactResponseVm = await managedVmFactory.createManagedVm({
				allowedHosts: [mediationHost],
				environment: {},
				imageReference: 'alpine-base:latest',
				mediatedSecrets: [],
				mediation: {
					onRequest: createGatewayObservabilityOtlpRequestMediation({
						collector: {
							host: mediationHost,
							httpPort: 80,
							targetHost: mediationUpstreamHost,
							targetHttpPort: otlpCaptureServer.port,
						},
					}),
				},
				mounts: {},
				resources: { cpuCount: 1, memory: '512M' },
				rootfsMode: 'cow',
				sessionLabel: 'gondolin-exact-otlp-response-mediation',
				tcpHosts: [],
			});
			vmRuntime = {
				managedVm: exactResponseVm,
				target: await startVmAndCaptureProcess(exactResponseVm),
			};

			const mediatedResult = await exactResponseVm.exec(
				`printf 'trace-payload' | curl -sS -D /tmp/mediation-headers -o /tmp/mediation-response -w '%{http_code}' -X POST -H 'content-type: application/x-protobuf' -H 'authorization: Bearer must-not-forward' -H 'cookie: must-not-forward=true' --data-binary @- http://${mediationHost}/v1/traces`,
			);
			expect(mediatedResult.exitCode).toBe(0);
			expect(mediatedResult.stdout).toBe('200');
			const responseBody = await exactResponseVm.exec('cat /tmp/mediation-response');
			expect(responseBody.stdout).toBe('collector-ok');
			const responseHeaders = await exactResponseVm.exec('cat /tmp/mediation-headers');
			expect(responseHeaders.stdout.toLowerCase()).toContain(
				'content-type: application/x-protobuf',
			);
			expect(responseHeaders.stdout.toLowerCase()).toContain('retry-after: 1');
			expect(responseHeaders.stdout.toLowerCase()).not.toContain('set-cookie');
			expect(responseHeaders.stdout.toLowerCase()).not.toContain('x-controller-internal');
			expect(otlpCaptureServer.capturedRequests).toEqual([
				expect.objectContaining({
					body: 'trace-payload',
					method: 'POST',
					url: '/v1/traces',
				}),
			]);
			const capturedHeaders = otlpCaptureServer.capturedRequests[0]?.headers;
			expect(capturedHeaders?.['content-type']).toBe('application/x-protobuf');
			expect(capturedHeaders?.authorization).toBeUndefined();
			expect(capturedHeaders?.cookie).toBeUndefined();
			expect(capturedHeaders?.forwarded).toBeUndefined();
			expect(capturedHeaders?.['x-forwarded-for']).toBeUndefined();

			const invalidPathResult = await exactResponseVm.exec(
				`printf 'invalid-payload' | curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/x-protobuf' --data-binary @- http://${mediationHost}/v1/unknown`,
			);
			expect(invalidPathResult.exitCode).toBe(0);
			expect(invalidPathResult.stdout).toBe('404');
			expect(otlpCaptureServer.capturedRequests).toHaveLength(1);

			const directTargetResult = await exactResponseVm.exec(
				`curl -sS -o /dev/null -w '%{http_code}' http://${mediationUpstreamHost}:${String(otlpCaptureServer.port)}/v1/traces`,
			);
			expect(directTargetResult.exitCode).toBe(7);
			expect(directTargetResult.stdout).toBe('000');

			const otherPortResult = await exactResponseVm.exec(
				`curl -sS -o /dev/null -w '%{http_code}' http://${mediationUpstreamHost}:${String(deniedLoopbackPort)}/headers`,
			);
			expect(otherPortResult.exitCode).toBe(7);
			expect(otherPortResult.stdout).toBe('000');
			expect(otlpCaptureServer.capturedRequests).toHaveLength(1);
		} finally {
			await closeServer(otlpCaptureServer.server);
		}
	}, 120_000);
});
