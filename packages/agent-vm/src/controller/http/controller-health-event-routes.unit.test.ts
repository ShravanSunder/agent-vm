import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { HealthEventStore } from '../health/health-event-store.js';
import { registerControllerHealthEventRoutes } from './controller-health-event-routes.js';

function createTestHarness(): { readonly app: Hono; readonly store: HealthEventStore } {
	const app = new Hono();
	const store = new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 });
	registerControllerHealthEventRoutes(app, {
		now: () => 10_000,
		store,
		zoneIds: new Set(['beta']),
	});
	return { app, store };
}

describe('controller health event routes', () => {
	it('keeps health snapshots readable from controller-owned state', async () => {
		const { app, store } = createTestHarness();
		store.record({
			domain: 'gateway_control',
			elapsedMs: 12,
			kind: 'gateway-control-session',
			observedAtMs: 9_000,
			operation: 'control-session-heartbeat',
			peerId: 'gateway-beta',
			result: 'ok',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent);

		const snapshotResponse = await app.request('/zones/beta/health-snapshot');

		expect(snapshotResponse.status).toBe(200);
		await expect(snapshotResponse.json()).resolves.toMatchObject({
			kind: 'ok',
			zoneId: 'beta',
		});
	});

	it('returns HTTP 200 for an unhealthy derived snapshot', async () => {
		const { app, store } = createTestHarness();
		store.record({
			domain: 'gateway_control',
			elapsedMs: 12,
			kind: 'gateway-control-session',
			observedAtMs: 9_000,
			operation: 'control-session-heartbeat',
			peerId: 'gateway-beta',
			result: 'timeout',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent);

		const snapshotResponse = await app.request('/zones/beta/health-snapshot');

		expect(snapshotResponse.status).toBe(200);
		await expect(snapshotResponse.json()).resolves.toMatchObject({
			kind: 'failed',
			issues: [{ kind: 'gateway-control-session-unhealthy' }],
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
		store.record({
			channelProviderId: 'primary-channel',
			details: { closeCode: 1006, providerType: 'discord', reconnecting: true },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 1_780_164_840_000,
			result: 'failed',
			unhealthySinceMs: 1_780_164_840_000,
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent);

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

	it('returns unknown for a known zone with no recorded events', async () => {
		const { app } = createTestHarness();

		const snapshotResponse = await app.request('/zones/beta/health-snapshot');

		expect(snapshotResponse.status).toBe(200);
		await expect(snapshotResponse.json()).resolves.toEqual({
			kind: 'unknown',
			reason: 'no-events',
			zoneId: 'beta',
		});
	});

	it('rejects health snapshots for unknown zones', async () => {
		const { app } = createTestHarness();

		const snapshotResponse = await app.request('/zones/missing/health-snapshot');

		expect(snapshotResponse.status).toBe(404);
		await expect(snapshotResponse.json()).resolves.toMatchObject({ error: 'unknown-zone' });
	});

	it('deletes the old VM-facing health event mutation route', async () => {
		const { app, store } = createTestHarness();

		const postResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				domain: 'gateway_control',
				elapsedMs: 12,
				kind: 'gateway-control-session',
				observedAtMs: 9_000,
				operation: 'control-session-heartbeat',
				peerId: 'gateway-beta',
				result: 'ok',
				zoneId: 'beta',
			} satisfies AgentVmHealthEvent),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(postResponse.status).toBe(404);
		expect(store.listLatestEventsForZone('beta')).toEqual([]);
	});
});
