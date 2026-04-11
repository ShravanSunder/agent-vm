import { serve } from '@hono/node-server';
import { Hono } from 'hono';
/**
 * Live smoke test: gateway API client → controller lease API round-trip.
 *
 * This test verifies the gateway API client and controller lease API work
 * together over real HTTP, without requiring a gateway VM or QEMU.
 *
 * The full end-to-end test (gateway VM + OpenClaw + sandbox plugin) is
 * validated manually via scripts/live-sandbox-manual.mjs or by sending
 * a message through WhatsApp/Discord and checking controller logs.
 *
 * Run: pnpm vitest run packages/agent-vm/src/integration-tests/live-api-smoke.test.ts
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createControllerApp } from '../controller/controller-http-routes.js';
import type { Lease } from '../controller/lease-manager.js';
import { createGatewayApiClient } from '../gateway-api-client/gateway-api-client.js';

describe('live smoke: API client → controller over real HTTP', () => {
	let controllerServer: { close: (cb?: () => void) => void } | null = null;
	let gatewayServer: { close: (cb?: () => void) => void } | null = null;

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

		gatewayServer = serve({ fetch: gatewayApp.fetch, port: 18792 });

		// --- Real controller lease API ---
		const lease: Lease = {
			createdAt: Date.now(),
			id: 'smoke-lease-001',
			lastUsedAt: Date.now(),
			profileId: 'standard',
			scopeKey: 'agent:main:smoke',
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
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				id: 'tool-vm-smoke',
				setIngressRoutes: vi.fn(),
			},
			zoneId: 'shravan',
		};
		const createLease = vi.fn(async () => lease);
		const controllerApp = createControllerApp({
			readIdentityPem: async () => 'pem-smoke',
			toolProfiles: { standard: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' } },
			leaseManager: {
				createLease,
				getLease: vi.fn(() => lease),
				listLeases: vi.fn(() => [lease]),
				releaseLease: vi.fn(async () => {}),
			},
		});
		controllerServer = serve({ fetch: controllerApp.fetch, port: 18801 });

		// --- Exercise the gateway API client ---
		const gatewayClient = createGatewayApiClient({
			gatewayUrl: 'http://127.0.0.1:18792',
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
		const leaseResponse = await fetch('http://127.0.0.1:18801/lease', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				agentWorkspaceDir: '/workspace',
				profileId: 'standard',
				scopeKey: 'smoke-test',
				workspaceDir: '/workspace',
				zoneId: 'shravan',
			}),
		});
		const leaseBody = (await leaseResponse.json()) as { leaseId: string };
		expect(leaseResponse.status).toBe(200);
		expect(leaseBody.leaseId).toBe('smoke-lease-001');
		expect(createLease).toHaveBeenCalled();

		// Verify lease list over real HTTP
		const leasesResponse = await fetch('http://127.0.0.1:18801/leases');
		const leasesBody = (await leasesResponse.json()) as unknown[];
		expect(leasesBody).toHaveLength(1);
	});

	it('gateway API client rejects unauthorized requests', async () => {
		const unauthorizedClient = createGatewayApiClient({
			gatewayUrl: 'http://127.0.0.1:18792',
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
