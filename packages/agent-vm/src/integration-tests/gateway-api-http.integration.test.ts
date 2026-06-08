import net from 'node:net';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
/**
 * Live e2e test: gateway API client → controller lease API round-trip.
 *
 * This test verifies the gateway API client and controller lease API work
 * together over real HTTP, without requiring a gateway VM or QEMU.
 *
 * The full end-to-end test (gateway VM + OpenClaw + sandbox plugin) is
 * validated manually via scripts/live-sandbox-manual.mjs or by sending
 * a message through WhatsApp/Discord and checking controller logs.
 *
 * Run: pnpm vitest run packages/agent-vm/src/integration-tests/gateway-api-http.integration.test.ts
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { createControllerApp } from '../controller/http/controller-http-routes.js';
import type { controllerLeaseCreateRequestSchema } from '../controller/http/controller-request-schemas.js';
import type { Lease } from '../controller/leases/lease-manager.js';
import { OPENCLAW_TOOL_VM_WORKSPACE_MOUNT } from '../controller/leases/lease-work-mount-paths.js';
import { createGatewayApiClient } from '../gateway-api-client/gateway-api-client.js';
import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';

type ControllerLeaseCreateRequestBody = z.input<typeof controllerLeaseCreateRequestSchema>;

function createLeaseRequestBody(
	overrides: Partial<ControllerLeaseCreateRequestBody> = {},
): ControllerLeaseCreateRequestBody {
	return {
		agentId: 'main',
		agentWorkspaceDir: '/work',
		profileId: 'standard',
		sessionKey: 'agent:main:smoke-test',
		workMountDir: '/work',
		zoneId: 'shravan',
		...overrides,
	};
}

async function findAvailablePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Failed to determine an available port.')));
				return;
			}
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

describe('live integration: API client → controller over real HTTP', () => {
	let controllerServer: { close: (cb?: () => void) => void } | null = null;
	let gatewayServer: { close: (cb?: () => void) => void } | null = null;
	let activeGatewayPort: number | null = null;

	afterAll(async () => {
		if (controllerServer)
			await new Promise<void>((resolve) => controllerServer?.close(() => resolve()));
		if (gatewayServer) await new Promise<void>((resolve) => gatewayServer?.close(() => resolve()));
	});

	it('gateway API client talks to a real Hono HTTP server', async () => {
		const gatewayPort = await findAvailablePort();
		const controllerPort = await findAvailablePort();
		activeGatewayPort = gatewayPort;

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

		gatewayServer = serve({ fetch: gatewayApp.fetch, port: gatewayPort });

		// --- Real controller lease API ---
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
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000,
				user: 'sandbox',
			},
			tcpSlot: 0,
			vm: {
				close: vi.fn(async () => {}),
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({
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
			},
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
			zoneId: 'shravan',
		};
		const createLease = vi.fn(async () => lease);
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
				createLease,
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
		controllerServer = serve({ fetch: controllerApp.fetch, port: controllerPort });

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

		// Verify controller lease API works over real HTTP
		const leaseResponse = await fetch(`http://127.0.0.1:${controllerPort}/lease`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(
				createLeaseRequestBody({
					agentId: 'smoke-test',
					sessionKey: 'agent:smoke-test:integration',
				}),
			),
		});
		const leaseBody = (await leaseResponse.json()) as { leaseId: string };
		expect(leaseResponse.status).toBe(200);
		expect(leaseBody.leaseId).toBe('smoke-lease-001');
		expect(createLease).toHaveBeenCalled();

		// Verify lease list over real HTTP
		const leasesResponse = await fetch(`http://127.0.0.1:${controllerPort}/leases`);
		const leasesBody = (await leasesResponse.json()) as unknown[];
		expect(leasesBody).toHaveLength(1);
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
