import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

let worker: Unstable_DevWorker;
let guard: ReturnType<typeof startWorkerdSocketGuard>;
let stateDirectory: string;
async function control(input: Readonly<Record<string, unknown>>): Promise<unknown> {
	const response = await worker.fetch('/', { method: 'POST', body: JSON.stringify(input) });
	expect(response.status).toBe(200);
	return response.json();
}
describe('organization authorization in local workerd', () => {
	beforeAll(async () => {
		guard = startWorkerdSocketGuard();
		stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-s6-object-'));
		// Isolate Wrangler service discovery from other tests and local dev sessions.
		process.env.WRANGLER_REGISTRY_PATH = path.join(stateDirectory, 'registry');
		process.env.WRANGLER_LOG_PATH = path.join(stateDirectory, 'wrangler.log');
		process.env.WRANGLER_SEND_METRICS = 'false';
		worker = await unstable_dev(
			'packages/tool-host-cloudflare/src/test-fixtures/object-proof-entrypoint.ts',
			{
				config: 'packages/tool-host-cloudflare/wrangler.example.jsonc',
				local: true,
				persist: true,
				persistTo: stateDirectory,
				logLevel: 'error',
				experimental: { disableExperimentalWarning: true },
			},
		);
	});
	afterAll(async () => {
		try {
			await guard?.stop();
		} finally {
			await worker?.stop();
		}
		if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
	});
	it('atomically records one first-use answer under concurrent requests', async () => {
		const input = {
			kind: 'consume',
			organizationId: 'one',
			tokenId: 'race',
			expiresAtMs: Date.now() + 60_000,
		};
		const answers = await Promise.all(Array.from({ length: 12 }, async () => control(input)));
		expect(answers.filter((answer) => JSON.stringify(answer) === '{"ok":true}')).toHaveLength(1);
		expect(
			answers.filter((answer) => JSON.stringify(answer) === '{"ok":false,"reason":"replayed"}'),
		).toHaveLength(11);
		expect(await control({ ...input, organizationId: 'two' })).toEqual({ ok: true });
	});
	it('prunes expired use records when recording another use', async () => {
		const input = {
			kind: 'consume',
			organizationId: 'expiry',
			tokenId: 'expired',
			expiresAtMs: Date.now() - 1,
		};
		expect(await control(input)).toEqual({ ok: true });
		expect(await control({ ...input, tokenId: 'fresh', expiresAtMs: Date.now() + 60_000 })).toEqual(
			{ ok: true },
		);
		expect(await control({ ...input, expiresAtMs: Date.now() + 60_000 })).toEqual({ ok: true });
	});
});
