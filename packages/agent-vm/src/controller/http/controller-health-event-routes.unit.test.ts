import type { AgentVmHealthEvent } from '@agent-vm/gateway-contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { stableTelemetryHash } from '../../observability/health-event-telemetry.js';
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

	it('redacts raw Tool VM lease lifecycle ids from the public health snapshot', async () => {
		const { app, store } = createTestHarness();
		const rawLeaseId = '01890f00-0000-7000-8000-000000000001';
		const rawReplacementLeaseId = '01890f00-0000-7000-8000-000000000002';
		const rawActiveUseId = '66666666-6666-4666-8666-666666666666';
		const rawTransitionId = '77777777-7777-4777-8777-777777777777';
		store.record({
			activeUseId: rawActiveUseId,
			agentId: 'main',
			callerContextState: 'ok',
			elapsedMs: 10,
			kind: 'tool-vm-ssh',
			leaseId: rawReplacementLeaseId,
			lifecycleEventRole: 'controller_final',
			lifecycleTransition: 'stale_to_reacquired',
			observedAtMs: 9_000,
			oldLeaseId: rawLeaseId,
			operation: 'file-bridge',
			replacementLeaseId: rawReplacementLeaseId,
			result: 'ok',
			transitionId: rawTransitionId,
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent);

		const snapshotResponse = await app.request('/zones/beta/health-snapshot');
		const snapshotBody = await snapshotResponse.json();
		const serializedSnapshot = JSON.stringify(snapshotBody);

		expect(snapshotResponse.status).toBe(200);
		expect(serializedSnapshot).not.toContain(rawLeaseId);
		expect(serializedSnapshot).not.toContain(rawReplacementLeaseId);
		expect(serializedSnapshot).not.toContain(rawActiveUseId);
		expect(serializedSnapshot).not.toContain(rawTransitionId);
		expect(serializedSnapshot).toContain(stableTelemetryHash(rawLeaseId));
		expect(serializedSnapshot).toContain(stableTelemetryHash(rawReplacementLeaseId));
		expect(serializedSnapshot).toContain(stableTelemetryHash(rawActiveUseId));
		expect(serializedSnapshot).toContain(stableTelemetryHash(rawTransitionId));
		expect(snapshotBody).toMatchObject({
			kind: 'ok',
			latestEvents: [
				{
					activeUseIdHash: stableTelemetryHash(rawActiveUseId),
					leaseIdHash: stableTelemetryHash(rawReplacementLeaseId),
					oldLeaseIdHash: stableTelemetryHash(rawLeaseId),
					replacementLeaseIdHash: stableTelemetryHash(rawReplacementLeaseId),
					transitionIdHash: stableTelemetryHash(rawTransitionId),
				},
			],
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
