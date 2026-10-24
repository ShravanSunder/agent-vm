import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

import {
	runObservationsSchema,
	type RunObservations,
} from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';
import { waitForProtocolRetryInterval } from '#worker-host/test-fixtures/protocol-observation-interval';
import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

it('boots only the helper once and proves keys, MCP secrets, admission and durable observations', async () => {
	const guard = startWorkerdSocketGuard();
	const stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-helper-smoke-'));
	let worker: Unstable_DevWorker | undefined;
	process.env.WRANGLER_LOG_PATH = path.join(stateDirectory, 'wrangler.log');
	process.env.WRANGLER_SEND_METRICS = 'false';
	const organizationId = '11111111-1111-4111-8111-111111111111';
	const workspaceId = '33333333-3333-4333-8333-333333333333';
	const siblingId = '44444444-4444-4444-8444-444444444444';
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
					TEST_WORKSPACES: JSON.stringify({
						alpha: { organizationId, workspaceId, credential: 'controlled-test-secret' },
						beta: { organizationId, workspaceId: siblingId, credential: 'sibling-test-secret' },
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
		const assertAdmission = async (state: 'member' | 'removed'): Promise<void> => {
			expect(
				(
					await fetchHelper('/admission', 'POST', 'Bearer separate-admission-secret', {
						workspaceId,
						...(state === 'member' ? { persona: 'two' } : {}),
						agentId: 'same-agent',
						state,
					})
				).status,
			).toBe(200);
			expect(
				await (
					await fetchHelper(`/__membership?workspaceId=${workspaceId}&agentId=same-agent`)
				).json(),
			).toEqual(state === 'member' ? { persona: 'two' } : null);
		};
		await assertAdmission('member');
		expect(
			(
				await fetchHelper('/admission', 'POST', 'Bearer separate-admission-secret', {
					workspaceId: siblingId,
					agentId: 'same-agent',
					state: 'member',
					persona: 'one',
				})
			).status,
		).toBe(200);
		await Promise.all(
			(
				[
					['wrong', workspaceId, 401],
					['Bearer separate-admission-secret', '55555555-5555-4555-8555-555555555555', 403],
				] as const
			).map(async ([secret, selectedWorkspace, expectedStatus]): Promise<void> => {
				expect(
					(
						await fetchHelper('/admission', 'POST', secret, {
							workspaceId: selectedWorkspace,
							agentId: 'same-agent',
							state: 'removed',
						})
					).status,
				).toBe(expectedStatus);
			}),
		);
		expect(
			await (
				await fetchHelper(`/__membership?workspaceId=${workspaceId}&agentId=same-agent`)
			).json(),
		).toEqual({ persona: 'two' });
		expect(
			await (await fetchHelper(`/__membership?workspaceId=${siblingId}&agentId=same-agent`)).json(),
		).toEqual({ persona: 'one' });
		await assertAdmission('removed');
		expect(
			await (await fetchHelper(`/__membership?workspaceId=${siblingId}&agentId=same-agent`)).json(),
		).toEqual({ persona: 'one' });
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
		// A pending RPC promise is not a storage/input lock: later snapshot and
		// release RPCs must run while six independently held responses are pending.
		// Live barriers are volatile; this does not claim restart/hibernation durability.
		const heldRunId = 'held-smoke';
		let completed = 0;
		let beforeRelease = { activeCalls: 0, peakCalls: 0, completed: 0 };
		const held = Array.from({ length: 6 }, async (_, index) => {
			const response = await fetchHelper('/mcp/alpha', 'POST', 'controlled-test-secret', {
				...call,
				params: {
					name: 'read',
					arguments: { runId: heldRunId, callId: `held-${String(index)}`, hold: true },
				},
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { content: [{ text: 'ok' }] } });
			completed += 1;
		});
		const readHeld = async (): Promise<RunObservations> =>
			runObservationsSchema.parse(
				await (
					await fetchHelper(
						`/observations?runId=${heldRunId}`,
						'GET',
						'Bearer separate-admission-secret',
					)
				).json(),
			);
		const deadline = Date.now() + 10_000;
		async function waitForSixHeldCalls(): Promise<void> {
			const snapshot = await readHeld();
			if (snapshot.activeCalls === 6) return;
			if (snapshot.activeCalls > 6 || Date.now() >= deadline)
				throw new Error('Real helper did not expose six held calls.');
			await waitForProtocolRetryInterval();
			await waitForSixHeldCalls();
		}
		try {
			await waitForSixHeldCalls();
			expect(completed).toBe(0);
			const heldSnapshot = await readHeld();
			expect(heldSnapshot).toMatchObject({ activeCalls: 6, peakCalls: 6 });
			beforeRelease = {
				activeCalls: heldSnapshot.activeCalls,
				peakCalls: heldSnapshot.peakCalls,
				completed,
			};
		} finally {
			expect(
				(
					await fetchHelper(
						`/observations?runId=${heldRunId}`,
						'POST',
						'Bearer separate-admission-secret',
						{ action: 'release' },
					)
				).status,
			).toBe(200);
			await Promise.all(held);
		}
		expect(completed).toBe(6);
		const releasedSnapshot = await readHeld();
		expect(releasedSnapshot).toMatchObject({ activeCalls: 0, peakCalls: 6 });
		process.stdout.write(
			`${JSON.stringify({ heldRpcProof: { beforeRelease, afterRelease: { activeCalls: releasedSnapshot.activeCalls, peakCalls: releasedSnapshot.peakCalls, completed } } })}\n`,
		);
	} finally {
		try {
			await worker?.stop();
		} finally {
			await guard.stop();
			await rm(stateDirectory, { recursive: true, force: true });
		}
	}
}, 60_000);
