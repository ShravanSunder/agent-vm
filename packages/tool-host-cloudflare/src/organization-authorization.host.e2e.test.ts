import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

let worker: Unstable_DevWorker;
let stateDirectory: string;
async function control(input: Readonly<Record<string, unknown>>): Promise<unknown> {
	const response = await worker.fetch('/', { method: 'POST', body: JSON.stringify(input) });
	expect(response.status).toBe(200);
	return response.json();
}
describe('organization authorization in local workerd', () => {
	beforeAll(async () => {
		stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-s6-object-'));
		process.env.WRANGLER_LOG_PATH = path.join(stateDirectory, 'wrangler.log');
		process.env.WRANGLER_SEND_METRICS = 'false';
		worker = await unstable_dev(
			'packages/tool-host-cloudflare/src/test-fixtures/object-proof-entrypoint.ts',
			{
				config: 'packages/tool-host-cloudflare/wrangler.local.jsonc',
				local: true,
			persist: true,
			persistTo: stateDirectory,
				logLevel: 'error',
				experimental: { disableExperimentalWarning: true },
			},
		);
	});
	afterAll(async () => {
		await worker?.stop();
		if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
	});
	it('reads current admission and keeps identical agent IDs apart by organization', async () => {
		const sameAgent = { agentId: 'same-agent' };
		expect(await control({ kind: 'listed', organizationId: 'one', ...sameAgent })).toEqual({
			listed: false,
		});
		await control({ kind: 'admission', organizationId: 'one', ...sameAgent, state: 'listed' });
		expect(await control({ kind: 'listed', organizationId: 'one', ...sameAgent })).toEqual({
			listed: true,
		});
		expect(await control({ kind: 'listed', organizationId: 'two', ...sameAgent })).toEqual({
			listed: false,
		});
		await control({ kind: 'admission', organizationId: 'one', ...sameAgent, state: 'removed' });
		expect(await control({ kind: 'listed', organizationId: 'one', ...sameAgent })).toEqual({
			listed: false,
		});
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
