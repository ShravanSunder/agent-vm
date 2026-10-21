import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

it('boots only the helper once and proves keys, MCP secrets, admission and durable observations', async () => {
	const guard = startWorkerdSocketGuard();
	const stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-helper-smoke-'));
	let worker: Unstable_DevWorker | undefined;
	process.env.WRANGLER_LOG_PATH = path.join(stateDirectory, 'wrangler.log');
	process.env.WRANGLER_SEND_METRICS = 'false';
	const organizationId = '11111111-1111-4111-8111-111111111111';
	try {
		worker = await unstable_dev(
			'packages/tool-host-cloudflare/src/deployed-checks/test-helper-worker/test-fixtures/local-helper-entrypoint.ts',
			{
				config:
					'packages/tool-host-cloudflare/src/deployed-checks/test-helper-worker/test-fixtures/wrangler.helper-local.jsonc',
				local: true,
				persist: true,
				persistTo: stateDirectory,
				logLevel: 'error',
				vars: {
					TEST_PUBLIC_JWKS: JSON.stringify({
						keys: [
							{
								kty: 'EC',
								crv: 'P-256',
								x: 'public-x',
								y: 'public-y',
								kid: 'controlled',
								alg: 'ES256',
								use: 'sig',
							},
						],
					}),
					TEST_ORGANIZATIONS: JSON.stringify({
						alpha: { organizationId, credential: 'controlled-test-secret' },
					}),
					ADMISSION_SECRET: 'separate-admission-secret',
				},
				experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
			},
		);
		const fetchHelper = async (
			route: string,
			method = 'GET',
			secret?: string,
			body?: unknown,
		): Promise<Awaited<ReturnType<Unstable_DevWorker['fetch']>>> => {
			guard.check();
			if (worker === undefined) throw new Error('No helper.');
			return worker.fetch(route, {
				method,
				headers: {
					connection: 'close',
					...(secret === undefined ? {} : { authorization: secret }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(10_000),
			});
		};
		expect((await fetchHelper('/jwks')).status).toBe(200);
		const call = {
			jsonrpc: '2.0',
			id: 'smoke',
			method: 'tools/call',
			params: { name: 'read', arguments: { runId: 'smoke', callId: 'one' } },
		};
		expect((await fetchHelper('/mcp/alpha', 'POST', 'wrong', call)).status).toBe(401);
		expect(
			await (await fetchHelper('/mcp/alpha', 'POST', 'controlled-test-secret', call)).json(),
		).toMatchObject({ result: { content: [{ text: 'ok' }] } });
		const assertAdmission = async (state: 'listed' | 'removed'): Promise<void> => {
			expect(
				(
					await fetchHelper('/admission', 'POST', 'Bearer separate-admission-secret', {
						organizationId,
						agentId: 'same-agent',
						state,
					})
				).status,
			).toBe(200);
			expect(
				await (
					await fetchHelper(`/__listed?organizationId=${organizationId}&agentId=same-agent`)
				).json(),
			).toEqual({ listed: state === 'listed' });
		};
		await assertAdmission('listed');
		await assertAdmission('removed');
		expect((await fetchHelper('/observations?runId=smoke')).status).toBe(401);
		expect(
			await (
				await fetchHelper('/observations?runId=smoke', 'GET', 'Bearer separate-admission-secret')
			).json(),
		).toMatchObject({
			runId: 'smoke',
			activeCalls: 0,
			peakCalls: 1,
			calls: [{ callId: 'one', effects: 1, credential: 'controlled-test-secret' }],
		});
	} finally {
		try {
			await worker?.stop();
		} finally {
			await guard.stop();
			await rm(stateDirectory, { recursive: true, force: true });
		}
	}
}, 60_000);
