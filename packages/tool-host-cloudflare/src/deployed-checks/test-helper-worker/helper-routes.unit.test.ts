import { describe, expect, it } from 'vitest';

import { handleHelperRequest } from '#worker-host/deployed-checks/test-helper-worker/helper-routes';
import {
	publicJwksSchema,
	type HelperRoutePorts,
	type RunObservations,
} from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';
import {
	beginObservation,
	emptyObservations,
	finishObservation,
} from '#worker-host/deployed-checks/test-helper-worker/observation-counters';

const organizationId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '33333333-3333-4333-8333-333333333333';
const credential = 'controlled-test-credential';
const publicJwks = {
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
};
function fixture(): { readonly ports: HelperRoutePorts; readonly admissions: unknown[] } {
	let snapshot = emptyObservations('unit-run');
	const admissions: unknown[] = [];
	return {
		admissions,
		ports: {
			publicJwks,
			workspaces: { alpha: { organizationId, workspaceId, credential } },
			admissionSecret: 'admission-test-secret',
			observations: () => ({
				begin: async (call): Promise<void> => {
					snapshot = beginObservation(snapshot, call);
				},
				finish: async (callId): Promise<void> => {
					snapshot = finishObservation(snapshot, callId);
				},
				snapshot: async (): Promise<RunObservations> => snapshot,
				reset: async (): Promise<void> => {
					snapshot = emptyObservations('unit-run');
				},
				hold: async (): Promise<void> => {},
				release: async (): Promise<void> => {},
			}),
		},
	};
}
function request(path: string, secret?: string, body?: unknown, method = 'POST'): Request {
	return new Request(`https://helper.invalid${path}`, {
		method,
		headers: secret === undefined ? {} : { authorization: secret },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
describe('controlled helper routes and counters', () => {
	it.each(['discovery-probe', 0])(
		'returns method-not-found for an unknown request with id %s',
		async (id) => {
			const { ports } = fixture();
			const response = await handleHelperRequest(
				request('/mcp/alpha', credential, {
					jsonrpc: '2.0',
					id,
					method: 'server/discover',
				}),
				ports,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				jsonrpc: '2.0',
				id,
				error: { code: -32601, message: 'Method not found' },
			});
			expect((await ports.observations('unit-run').snapshot()).calls).toEqual([]);
		},
	);
	it('accepts a notification without a JSON-RPC response or controlled effect', async () => {
		const { ports } = fixture();
		const response = await handleHelperRequest(
			request('/mcp/alpha', credential, {
				jsonrpc: '2.0',
				method: 'notifications/initialized',
			}),
			ports,
		);
		expect(response.status).toBe(202);
		expect(await response.text()).toBe('');
		expect((await ports.observations('unit-run').snapshot()).calls).toEqual([]);
	});
	it('serves only public EC keys and rejects private signing material', async () => {
		const { ports } = fixture();
		expect(
			await (
				await handleHelperRequest(request('/jwks', undefined, undefined, 'GET'), ports)
			).json(),
		).toEqual(publicJwks);
		expect(() =>
			publicJwksSchema.parse({ keys: [{ ...publicJwks.keys[0], d: 'private' }] }),
		).toThrow();
	});
	it.each(['/observations?runId=unit-run', '/mcp/alpha'])(
		'refuses an absent or wrong credential on %s without effects',
		async (path) => {
			const { ports, admissions } = fixture();
			await Promise.all(
				[undefined, 'wrong', credential].map(async (secret): Promise<void> => {
					if (path === '/mcp/alpha' && secret === credential) return;
					expect((await handleHelperRequest(request(path, secret), ports)).status).toBe(401);
				}),
			);
			expect(admissions).toEqual([]);
			expect((await ports.observations('unit-run').snapshot()).calls).toEqual([]);
		},
	);
	it('counts every real effect and credential, serves exact response size and resets a run', async () => {
		const { ports } = fixture();
		const repeatCall = async (): Promise<void> => {
			const response = await handleHelperRequest(
				request('/mcp/alpha', credential, {
					jsonrpc: '2.0',
					id: 'rpc',
					method: 'tools/call',
					params: {
						name: 'read',
						arguments: { runId: 'unit-run', callId: 'one', responseBytes: 1024 },
					},
				}),
				ports,
			);
			const value = await response.json();
			if (typeof value !== 'object' || value === null || !('result' in value))
				throw new Error('Missing controlled result.');
			expect(JSON.stringify(value.result).length).toBe(1024);
		};
		await repeatCall();
		await repeatCall();
		expect((await ports.observations('unit-run').snapshot()).calls).toEqual([
			{
				workspaceLabel: 'alpha',
				callId: 'one',
				credential,
				toolName: 'read',
				effects: 2,
				inFlight: 0,
			},
		]);
		await handleHelperRequest(
			request('/observations?runId=unit-run', 'Bearer admission-test-secret', undefined, 'DELETE'),
			ports,
		);
		expect((await ports.observations('unit-run').snapshot()).calls).toEqual([]);
	});
	it('tracks overlap and refuses identity reuse or an unmatched completion', () => {
		const call = { workspaceLabel: 'alpha', credential, toolName: 'read', callId: 'one' };
		const entered = beginObservation(beginObservation(emptyObservations('unit-run'), call), {
			...call,
			callId: 'two',
		});
		expect(entered.activeCalls).toBe(2);
		expect(entered.peakCalls).toBe(2);
		expect(finishObservation(entered, 'one').activeCalls).toBe(1);
		expect(() => beginObservation(entered, { ...call, credential: 'other' })).toThrow();
		expect(() => finishObservation(entered, 'missing')).toThrow();
	});
});
