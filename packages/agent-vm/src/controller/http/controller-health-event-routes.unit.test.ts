import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { HealthEventStore } from '../health/health-event-store.js';
import { registerControllerHealthEventRoutes } from './controller-health-event-routes.js';

function createTestHarness(
	options: {
		readonly getLeaseOwner?:
			| ((leaseId: string) => { readonly agentId: string; readonly zoneId: string } | undefined)
			| undefined;
	} = {},
): { readonly app: Hono; readonly store: HealthEventStore } {
	const app = new Hono();
	const store = new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 });
	registerControllerHealthEventRoutes(app, {
		...(options.getLeaseOwner === undefined
			? {}
			: {
					leaseRemediation: {
						getLeaseOwner: options.getLeaseOwner,
					},
				}),
		now: () => 10_000,
		store,
		zoneIds: new Set(['beta']),
	});
	return { app, store };
}

function createTestApp(
	options: {
		readonly getLeaseOwner?:
			| ((leaseId: string) => { readonly agentId: string; readonly zoneId: string } | undefined)
			| undefined;
	} = {},
): Hono {
	return createTestHarness(options).app;
}

function gatewayControlLinkEvent(overrides: Partial<AgentVmHealthEvent> = {}): AgentVmHealthEvent {
	return {
		controllerHost: 'controller.vm.host',
		controllerPort: 18800,
		elapsedMs: 12,
		kind: 'gateway-control-link',
		observedAtMs: 9_000,
		operation: 'controller-health',
		path: '/health',
		result: 'ok',
		zoneId: 'beta',
		...overrides,
	} as AgentVmHealthEvent;
}

describe('controller health event routes', () => {
	it('records a valid zone health event and returns a healthy snapshot', async () => {
		const app = createTestApp();

		const postResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify(gatewayControlLinkEvent()),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		expect(postResponse.status).toBe(200);
		await expect(postResponse.json()).resolves.toEqual({ ok: true });

		const snapshotResponse = await app.request('/zones/beta/health-snapshot');
		expect(snapshotResponse.status).toBe(200);
		await expect(snapshotResponse.json()).resolves.toMatchObject({
			kind: 'ok',
			zoneId: 'beta',
		});
	});

	it('rejects invalid events and mismatched route zones', async () => {
		const app = createTestApp();

		const invalidResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({ kind: 'unknown', zoneId: 'beta' }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		expect(invalidResponse.status).toBe(400);
		await expect(invalidResponse.json()).resolves.toMatchObject({
			error: 'invalid-health-event',
		});

		const mismatchResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify(gatewayControlLinkEvent({ zoneId: 'sunfam' })),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		expect(mismatchResponse.status).toBe(400);
		await expect(mismatchResponse.json()).resolves.toMatchObject({
			error: 'health-event-zone-mismatch',
		});
	});

	it('returns HTTP 200 for an unhealthy derived snapshot', async () => {
		const app = createTestApp();

		const postResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify(gatewayControlLinkEvent({ result: 'timeout' })),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		expect(postResponse.status).toBe(200);

		const snapshotResponse = await app.request('/zones/beta/health-snapshot');
		expect(snapshotResponse.status).toBe(200);
		await expect(snapshotResponse.json()).resolves.toMatchObject({
			kind: 'failed',
			issues: [{ kind: 'gateway-control-link-unhealthy' }],
			zoneId: 'beta',
		});
	});

	it('keeps May 30-shaped channel-provider details separate from later recovery blockers', async () => {
		const { app, store } = createTestHarness();

		store.record({
			kind: 'gateway-service-health',
			observedAtMs: 1_780_167_621_217,
			path: '/health',
			port: 18789,
			result: 'ok',
			statusCode: 200,
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent);
		const channelProviderResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				channelProviderId: 'primary-channel',
				details: { closeCode: 1006, providerType: 'discord', reconnecting: true },
				health: 'unhealthy-recoverable',
				kind: 'agent-channel-provider-health',
				observedAtMs: 1_780_164_840_000,
				result: 'failed',
				unhealthySinceMs: 1_780_164_840_000,
				zoneId: 'beta',
			} satisfies AgentVmHealthEvent),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(channelProviderResponse.status).toBe(200);
		const providerSnapshotResponse = await app.request('/zones/beta/health-snapshot');
		expect(providerSnapshotResponse.status).toBe(200);
		await expect(providerSnapshotResponse.json()).resolves.toMatchObject({
			issues: [
				{
					kind: 'agent-channel-provider-unhealthy',
					latestEvent: {
						details: { closeCode: 1006, providerType: 'discord', reconnecting: true },
						kind: 'agent-channel-provider-health',
					},
				},
			],
			kind: 'failed',
		});

		store.record({
			action: 'observe-only',
			consecutiveFailures: 3,
			cooldownMs: 3_660_000,
			elapsedMs: 25,
			errorCode: 'secret-resolution-failed',
			kind: 'gateway-recovery',
			observedAtMs: 1_780_750_126_037,
			reason: 'agent-channel-provider-unhealthy',
			result: 'failed',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent);
		const recoverySnapshotResponse = await app.request('/zones/beta/health-snapshot');
		expect(recoverySnapshotResponse.status).toBe(200);
		await expect(recoverySnapshotResponse.json()).resolves.toMatchObject({
			issues: expect.arrayContaining([
				expect.objectContaining({ kind: 'agent-channel-provider-unhealthy' }),
				expect.objectContaining({
					kind: 'gateway-recovery-failed',
					latestEvent: expect.objectContaining({
						errorCode: 'secret-resolution-failed',
						kind: 'gateway-recovery',
					}),
				}),
			]),
			kind: 'failed',
		});
	});

	it('rejects externally posted controller-owned health event kinds', async () => {
		const app = createTestApp();

		const recoveryResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				action: 'observe-only',
				consecutiveFailures: 3,
				cooldownMs: 3_660_000,
				elapsedMs: 25,
				errorCode: 'secret-resolution-failed',
				kind: 'gateway-recovery',
				observedAtMs: 9_000,
				reason: 'agent-channel-provider-unhealthy',
				result: 'failed',
				zoneId: 'beta',
			} satisfies AgentVmHealthEvent),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		const serviceResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				kind: 'gateway-service-health',
				observedAtMs: 9_000,
				path: '/health',
				port: 18_789,
				result: 'failed',
				zoneId: 'beta',
			} satisfies AgentVmHealthEvent),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(recoveryResponse.status).toBe(400);
		await expect(recoveryResponse.json()).resolves.toMatchObject({
			error: 'externally-managed-health-event-kind',
		});
		expect(serviceResponse.status).toBe(400);
		await expect(serviceResponse.json()).resolves.toMatchObject({
			error: 'externally-managed-health-event-kind',
		});
	});

	it('rejects health event writes and snapshots for unknown zones', async () => {
		const app = createTestApp();

		const postResponse = await app.request('/zones/missing/health-events', {
			body: JSON.stringify(gatewayControlLinkEvent({ zoneId: 'missing' })),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		expect(postResponse.status).toBe(404);
		await expect(postResponse.json()).resolves.toMatchObject({ error: 'unknown-zone' });

		const snapshotResponse = await app.request('/zones/missing/health-snapshot');
		expect(snapshotResponse.status).toBe(404);
		await expect(snapshotResponse.json()).resolves.toMatchObject({ error: 'unknown-zone' });
	});

	it('records same-zone Tool VM SSH health without making the posted event a lease mutation authority', async () => {
		const getLeaseOwner = vi.fn(() => ({ agentId: 'agent-a', zoneId: 'beta' }));
		const { app, store } = createTestHarness({ getLeaseOwner });

		const postResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				agentId: 'agent-a',
				elapsedMs: 5_000,
				errorCode: 'ssh-command-failed',
				kind: 'tool-vm-ssh',
				leaseId: 'lease-a',
				observedAtMs: 9_000,
				operation: 'command',
				result: 'failed',
				zoneId: 'beta',
			} satisfies AgentVmHealthEvent),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(postResponse.status).toBe(200);
		expect(getLeaseOwner).toHaveBeenCalledWith('lease-a');
		expect(store.listLatestEventsForZone('beta')).toContainEqual(
			expect.objectContaining({
				kind: 'tool-vm-ssh',
				leaseId: 'lease-a',
				result: 'failed',
			}),
		);
	});

	it('does not record Tool VM SSH failure unless the lease belongs to the event zone', async () => {
		const getLeaseOwner = vi.fn(() => ({ agentId: 'agent-a', zoneId: 'sunfam' }));
		const { app, store } = createTestHarness({ getLeaseOwner });

		const postResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				agentId: 'agent-a',
				elapsedMs: 5_000,
				errorCode: 'ssh-command-failed',
				kind: 'tool-vm-ssh',
				leaseId: 'lease-a',
				observedAtMs: 9_000,
				operation: 'command',
				result: 'failed',
				zoneId: 'beta',
			} satisfies AgentVmHealthEvent),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(postResponse.status).toBe(200);
		expect(getLeaseOwner).toHaveBeenCalledWith('lease-a');
		expect(store.listLatestEventsForZone('beta')).toEqual([]);
		const snapshotResponse = await app.request('/zones/beta/health-snapshot');
		expect(snapshotResponse.status).toBe(200);
		await expect(snapshotResponse.json()).resolves.toEqual({
			kind: 'unknown',
			reason: 'no-events',
			zoneId: 'beta',
		});
	});

	it('does not record Tool VM SSH failure for a lease owned by another agent', async () => {
		const getLeaseOwner = vi.fn(() => ({ agentId: 'agent-b', zoneId: 'beta' }));
		const { app, store } = createTestHarness({ getLeaseOwner });

		const postResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				agentId: 'agent-a',
				elapsedMs: 5_000,
				errorCode: 'ssh-command-failed',
				kind: 'tool-vm-ssh',
				leaseId: 'lease-a',
				observedAtMs: 9_000,
				operation: 'command',
				result: 'failed',
				zoneId: 'beta',
			} satisfies AgentVmHealthEvent),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(postResponse.status).toBe(200);
		expect(getLeaseOwner).toHaveBeenCalledWith('lease-a');
		expect(store.listLatestEventsForZone('beta')).toEqual([]);
	});

	it('does not let a Tool VM SSH ok event from the wrong owner clear a real failure', async () => {
		const getLeaseOwner = vi.fn(() => ({ agentId: 'agent-b', zoneId: 'beta' }));
		const { app, store } = createTestHarness({ getLeaseOwner });

		store.record({
			agentId: 'agent-a',
			elapsedMs: 5_000,
			errorCode: 'ssh-command-failed',
			kind: 'tool-vm-ssh',
			leaseId: 'lease-a',
			observedAtMs: 8_000,
			operation: 'probe',
			result: 'failed',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent);

		const okSshResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				agentId: 'agent-a',
				elapsedMs: 12,
				kind: 'tool-vm-ssh',
				leaseId: 'lease-a',
				observedAtMs: 9_000,
				operation: 'probe',
				result: 'ok',
				zoneId: 'beta',
			} satisfies AgentVmHealthEvent),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(okSshResponse.status).toBe(200);
		expect(getLeaseOwner).toHaveBeenCalledWith('lease-a');
		expect(store.listLatestEventsForZone('beta')).toEqual([
			expect.objectContaining({
				kind: 'tool-vm-ssh',
				observedAtMs: 8_000,
				result: 'failed',
			}),
		]);
	});

	it('verifies ownership for ok Tool VM SSH and rejects external heartbeat observations', async () => {
		const getLeaseOwner = vi.fn(() => ({ agentId: 'agent-a', zoneId: 'beta' }));
		const app = createTestApp({ getLeaseOwner });

		const okSshResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				agentId: 'agent-a',
				elapsedMs: 12,
				kind: 'tool-vm-ssh',
				leaseId: 'lease-a',
				observedAtMs: 9_000,
				operation: 'probe',
				result: 'ok',
				zoneId: 'beta',
			} satisfies AgentVmHealthEvent),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		const heartbeatResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				agentId: 'agent-a',
				elapsedMs: 5_000,
				errorCode: 'controller-request-timeout',
				kind: 'lease-heartbeat',
				leaseId: 'lease-a',
				observedAtMs: 9_100,
				result: 'timeout',
				useId: 'use-a',
				zoneId: 'beta',
			} satisfies AgentVmHealthEvent),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(okSshResponse.status).toBe(200);
		expect(heartbeatResponse.status).toBe(400);
		await expect(heartbeatResponse.json()).resolves.toMatchObject({
			error: 'externally-managed-health-event-kind',
		});
		expect(getLeaseOwner).toHaveBeenCalledWith('lease-a');
	});
});
