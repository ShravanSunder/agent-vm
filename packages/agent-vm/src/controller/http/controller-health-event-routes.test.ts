import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { HealthEventStore } from '../health/health-event-store.js';
import { registerControllerHealthEventRoutes } from './controller-health-event-routes.js';

function createTestApp(): Hono {
	const app = new Hono();
	registerControllerHealthEventRoutes(app, {
		now: () => 10_000,
		store: new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 }),
		zoneIds: new Set(['beta']),
	});
	return app;
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
});
