import { serve } from '@hono/node-server';
import { Hono } from 'hono';
/**
 * Live integration test: gateway API client → controller HTTP surfaces.
 *
 * This test verifies the gateway API client and live controller diagnostic HTTP
 * routes over real HTTP, without requiring a gateway VM or QEMU.
 *
 * The full end-to-end test (gateway VM + OpenClaw + sandbox plugin) is
 * validated through the OpenClaw e2e project or by sending a real
 * WhatsApp/Discord message and checking controller logs.
 *
 * Run: pnpm vitest run packages/agent-vm/src/integration-tests/gateway-api-http.integration.test.ts
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createControllerApp } from '../controller/http/controller-http-routes.js';
import type { Lease } from '../controller/leases/lease-manager.js';
import { OPENCLAW_TOOL_VM_WORKSPACE_MOUNT } from '../controller/leases/lease-work-mount-paths.js';
import { createGatewayApiClient } from '../gateway-api-client/gateway-api-client.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';

type HonoServer = ReturnType<typeof serve>;

function getBoundPort(server: HonoServer): number {
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Failed to determine bound server port.');
	}
	return address.port;
}

async function waitForServerListening(server: HonoServer): Promise<void> {
	if (server.listening) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.once('listening', () => {
			server.off('error', reject);
			resolve();
		});
	});
}

describe('live integration: API client → controller over real HTTP', () => {
	let controllerServer: HonoServer | null = null;
	let gatewayServer: HonoServer | null = null;
	let activeGatewayPort: number | null = null;

	afterAll(async () => {
		if (controllerServer)
			await new Promise<void>((resolve) => controllerServer?.close(() => resolve()));
		if (gatewayServer) await new Promise<void>((resolve) => gatewayServer?.close(() => resolve()));
	});

	it('gateway API client talks to a real Hono HTTP server', async () => {
		// --- Mock gateway that simulates OpenClaw's /tools/invoke and /readyz ---
		const toolInvocations: unknown[] = [];
		const gatewayApp = new Hono();

		gatewayApp.get('/readyz', (context) => context.json({ ready: true, uptimeMs: 123000 }));

		gatewayApp.post('/tools/invoke', async (context) => {
			const authHeader = context.req.header('authorization');
			if (authHeader !== 'Bearer test-gateway-token') {
				return context.json({ error: 'unauthorized' }, 401);
			}
			const body = await context.req.json();
			toolInvocations.push(body);
			return context.json({
				ok: true,
				result: { output: 'hello from sandbox', exitCode: 0 },
			});
		});

		gatewayServer = serve({ fetch: gatewayApp.fetch, hostname: '127.0.0.1', port: 0 });
		await waitForServerListening(gatewayServer);
		const gatewayPort = getBoundPort(gatewayServer);
		activeGatewayPort = gatewayPort;

		// --- Real controller diagnostic HTTP route ---
		const lease: Lease = {
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			createdAt: Date.now(),
			effectiveIdleTtlMs: 30 * 60 * 1000,
			id: 'smoke-lease-001',
			lastUsedAt: Date.now(),
			profileId: 'standard',
			runtimeRecordId: 'smoke-lease-001',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			sshAccess: {
				close: async () => {},
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000,
				serverHostKey: TEST_SSH_SERVER_HOST_KEY,
				user: 'sandbox',
			},
			tcpSlot: 0,
			vm: {
				close: vi.fn(async () => {}),
				enableIngress: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					host: '127.0.0.1',
					port: 18791,
				})),
				enableSsh: vi.fn(async () => ({
					close: async () => {},
					command: 'ssh tool-vm-smoke',
					serverHostKey: TEST_SSH_SERVER_HOST_KEY,
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 19000,
					user: 'sandbox',
				})),
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				id: 'tool-vm-smoke',
				setIngressRoutes: vi.fn(),
				getHostPid: () => null,
				getVmInstance: vi.fn(),
				start: async () => {},
			},
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
			zoneId: 'shravan',
		};
		const controllerApp = createControllerApp({
			readIdentityPem: async () => 'pem-smoke',
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => lease),
				renewLease: vi.fn(async () => ({
					kind: 'renewed' as const,
					lastUsedAt: lease.lastUsedAt,
					lease,
				})),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => [lease]),
				releaseLease: vi.fn(async () => {}),
			},
			resolveLeaseWorkMountDir: async ({ workMountDir }) => ({
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: workMountDir,
			}),
		});
		controllerServer = serve({ fetch: controllerApp.fetch, hostname: '127.0.0.1', port: 0 });
		await waitForServerListening(controllerServer);
		const controllerPort = getBoundPort(controllerServer);

		// --- Exercise the gateway API client ---
		const gatewayClient = createGatewayApiClient({
			gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
			token: 'test-gateway-token',
		});

		// Verify readiness
		const readiness = await gatewayClient.getGatewayStatus();
		expect(readiness).toMatchObject({ ready: true });

		// Verify tool invocation
		const toolResult = await gatewayClient.invokeTool({
			tool: 'shell',
			args: { command: 'echo hello' },
			sessionKey: 'smoke-test',
		});
		expect(toolResult).toMatchObject({ ok: true, result: { output: 'hello from sandbox' } });
		expect(toolInvocations).toHaveLength(1);
		expect(toolInvocations[0]).toMatchObject({ tool: 'shell', args: { command: 'echo hello' } });

		// Verify the old public lease list is not exposed over real HTTP.
		const leasesResponse = await fetch(`http://127.0.0.1:${controllerPort}/leases`);
		expect(leasesResponse.status).toBe(404);
	});

	it('gateway API client rejects unauthorized requests', async () => {
		if (!gatewayServer || activeGatewayPort === null) {
			throw new Error('Expected gateway server to be running from the previous test.');
		}

		const unauthorizedClient = createGatewayApiClient({
			gatewayUrl: `http://127.0.0.1:${activeGatewayPort}`,
			token: 'wrong-token',
		});

		await expect(
			unauthorizedClient.invokeTool({
				tool: 'shell',
				args: { command: 'echo hello' },
			}),
		).rejects.toThrow('Gateway API returned status 401');
	});
});
