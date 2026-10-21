/* oxlint-disable no-await-in-loop -- These controls sequence the same live host/provider state so effects, failure changes and replay races remain attributable. */
import type { PortalCallRequest } from '@agent-collaboration/tool-access/contracts';
import { ToolPortalMcpClient } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client';
import { createNodeToolPortalMcpTransport } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport';
import { expect, it } from 'vitest';

import type { NodeHostBearerCredentialSet } from '#node-host/ingress/bearer-credentials';
import {
	createStandaloneToolPortalApprovalToken,
	type StandaloneToolPortalApprovalBatchIntent,
} from '#node-host/standalone/standalone-batch-approval';
import {
	startStandaloneToolPortalHttpServer,
	startStandaloneToolPortalMcpHttpServer,
	STANDALONE_TOOL_PORTAL_HTTP_APPROVAL_HEADER,
} from '#node-host/standalone/standalone-http-servers';
import { startControlledProvider } from '#node-host/test-fixtures/node-host-fixture';
import {
	createStandaloneHostFixture,
	standaloneCredentials,
	standaloneKey,
} from '#node-host/test-fixtures/standalone-host-fixture';

const call = (id: string, value = 42): PortalCallRequest['calls'][number] => ({
	id,
	namespace: 'example',
	name: 'ask',
	arguments: { value },
});
async function setup(
	getCredentialSet: () => NodeHostBearerCredentialSet = () => standaloneCredentials,
): Promise<{
	readonly provider: Awaited<ReturnType<typeof startControlledProvider>>;
	readonly fixture: Awaited<ReturnType<typeof createStandaloneHostFixture>>;
	readonly host: Awaited<ReturnType<typeof startStandaloneToolPortalMcpHttpServer>>;
	readonly client: ToolPortalMcpClient;
	readonly close: () => Promise<void>;
}> {
	const provider = await startControlledProvider('approval');
	const fixture = await createStandaloneHostFixture(
		provider,
		'example',
		undefined,
		getCredentialSet,
	);
	const host = await startStandaloneToolPortalMcpHttpServer({
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/portal',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		credentialSet: getCredentialSet(),
		service: fixture.service,
		artifactReader: fixture.artifactReader,
	});
	const client = new ToolPortalMcpClient({
		transport: createNodeToolPortalMcpTransport({
			kind: 'http',
			endpoint: host.endpoint,
			authorization: 'credential-agent-a',
		}),
	});
	await client.connect();
	return {
		provider,
		fixture,
		host,
		client,
		close: async () => {
			await client.close();
			await host.retire();
			await fixture.close();
			await provider.close();
		},
	};
}
function lastIntent(
	fixture: Awaited<ReturnType<typeof createStandaloneHostFixture>>,
): StandaloneToolPortalApprovalBatchIntent {
	const intent = fixture.approvalIntents.at(-1);
	if (intent === undefined) throw new Error('Expected actual batch admission.');
	return intent;
}
let tokenSequence = 100;
function token(
	intent: StandaloneToolPortalApprovalBatchIntent,
	expiresAt: string,
	keyVersion = 1,
): string {
	tokenSequence++;
	return createStandaloneToolPortalApprovalToken({
		intent,
		expiresAt,
		hmacKey: standaloneKey,
		keyVersion,
		tokenId: `10000000-0000-4000-8000-${String(tokenSequence).padStart(12, '0')}`,
	});
}

it('the actual route binds args, ordered protected set, caller/profile/credential/surface and expiry, then permits one concurrent winner', async () => {
	const { client, fixture, provider, close } = await setup();
	const request = { calls: [call('first'), call('second')] };
	try {
		const challenge = await client.call(request);
		expect(challenge.items.every((item) => item.status === 'approval_required')).toBe(true);
		expect(provider.effects).toHaveLength(0);
		const intent = lastIntent(fixture);
		const expiresAt = new Date(fixture.now() + 60_000).toISOString();
		const changedIntents = [
			{
				...intent,
				authenticatedEnvelope: {
					...intent.authenticatedEnvelope,
					principal: { ...intent.authenticatedEnvelope.principal, agentId: 'agent-b' },
				},
			},
			{
				...intent,
				authenticatedEnvelope: {
					...intent.authenticatedEnvelope,
					principal: {
						...intent.authenticatedEnvelope.principal,
						toolPortalProfileId: 'another-profile',
					},
				},
			},
			{
				...intent,
				authenticatedEnvelope: {
					...intent.authenticatedEnvelope,
					principal: { ...intent.authenticatedEnvelope.principal, credentialVersion: 2 },
				},
			},
			{ ...intent, surfaceClass: 'http' as const },
			{ ...intent, protectedCalls: intent.protectedCalls.toReversed() },
		];
		for (const changed of changedIntents) {
			const refusal = await client.call(request, { approvalToken: token(changed, expiresAt) });
			expect(refusal.ok).toBe(false);
			expect(refusal.items.every((item) => item.outcome.kind === 'not-dispatched')).toBe(true);
			expect(provider.effects).toHaveLength(0);
		}
		const changedArgs = await client.call(
			{ calls: [call('first', 43), call('second')] },
			{ approvalToken: token(intent, expiresAt) },
		);
		expect(changedArgs.ok).toBe(false);
		expect(provider.effects).toHaveLength(0);
		const expired = await client.call(request, {
			approvalToken: token(intent, new Date(fixture.now() - 1).toISOString()),
		});
		expect(expired.ok).toBe(false);
		expect(provider.effects).toHaveLength(0);
		const approvalToken = token(intent, expiresAt);
		const held = provider.holdCalls();
		const first = client.call(request, { approvalToken });
		await held.entered;
		const replay = await client.call(request, { approvalToken });
		expect(replay.items.every((item) => item.outcome.kind === 'ambiguous')).toBe(true);
		held.release();
		expect((await first).ok).toBe(true);
		expect(provider.effects).toHaveLength(2);
	} finally {
		await close();
	}
});

it('executes an exact 50-item approved batch once and rejects 0/51 at the public client boundary', async () => {
	const { client, fixture, provider, close } = await setup();
	const request = { calls: Array.from({ length: 50 }, (_, index) => call(`item-${index}`)) };
	try {
		await expect(client.call({ calls: [] })).rejects.toThrow();
		await expect(client.call({ calls: [...request.calls, call('overflow')] })).rejects.toThrow();
		expect(provider.effects).toHaveLength(0);
		const challenge = await client.call(request);
		expect(challenge.items).toHaveLength(50);
		expect(challenge.items.every((item) => item.status === 'approval_required')).toBe(true);
		expect(provider.effects).toHaveLength(0);
		const intent = lastIntent(fixture);
		expect(intent.protectedCalls.map((item) => item.call.id)).toEqual(
			request.calls.map((item) => item.id),
		);
		const approvalToken = token(intent, new Date(fixture.now() + 60_000).toISOString());
		expect((await client.call(request, { approvalToken })).ok).toBe(true);
		expect(provider.effects).toHaveLength(50);
		expect(
			(await client.call(request, { approvalToken })).items.every(
				(item) => item.outcome.kind === 'ambiguous',
			),
		).toBe(true);
		expect(provider.effects).toHaveLength(50);
	} finally {
		await close();
	}
});

it('rejects a valid old-generation token with the same HMAC key and revokes an old key through the real route', async () => {
	let credentials: NodeHostBearerCredentialSet = standaloneCredentials;
	const first = await setup(() => credentials);
	const request = { calls: [call('generation')] };
	let oldToken = '';
	try {
		await first.client.call(request);
		oldToken = token(
			lastIntent(first.fixture),
			new Date(first.fixture.now() + 60_000).toISOString(),
		);
	} finally {
		await first.close();
	}
	credentials = { ...standaloneCredentials, serviceGeneration: 'standalone-process:2' };
	const current = await setup(() => credentials);
	let rotatedClient: ToolPortalMcpClient | undefined;
	try {
		expect(
			(await current.client.call(request, { approvalToken: oldToken })).items[0],
		).toMatchObject({
			status: 'error',
			outcome: { kind: 'not-dispatched' },
			error: { message: expect.stringContaining('stale-generation') },
		});
		expect(current.provider.effects).toHaveLength(0);
		await current.client.call(request);
		const intent = lastIntent(current.fixture);
		const oldKeyToken = token(intent, new Date(current.fixture.now() + 60_000).toISOString());
		current.fixture.coordinator.activateCredentials([
			{ agentId: 'agent-a', hmacKey: standaloneKey, keyVersion: 2 },
			{ agentId: 'agent-b', hmacKey: standaloneKey, keyVersion: 2 },
		]);
		expect((await current.client.call(request, { approvalToken: oldKeyToken })).ok).toBe(false);
		expect(current.provider.effects).toHaveLength(0);
		credentials = {
			...credentials,
			credentials: credentials.credentials.map((entry) => ({
				...entry,
				credentialVersion: 2,
				bearerToken: entry.bearerToken + '-v2',
			})),
		};
		await current.host.activateCredentialSet(credentials);
		rotatedClient = new ToolPortalMcpClient({
			transport: createNodeToolPortalMcpTransport({
				kind: 'http',
				endpoint: current.host.endpoint,
				authorization: 'credential-agent-a-v2',
			}),
		});
		await rotatedClient.connect();
		await rotatedClient.call(request);
		const rotatedIntent = lastIntent(current.fixture);
		expect(
			(
				await rotatedClient.call(request, {
					approvalToken: token(
						rotatedIntent,
						new Date(current.fixture.now() + 60_000).toISOString(),
						2,
					),
				})
			).ok,
		).toBe(true);
		expect(current.provider.effects).toHaveLength(1);
	} finally {
		await rotatedClient?.close();
		await current.close();
	}
});

it('the JSON route forwards only its existing approval header to the same real batch authority', async () => {
	const { fixture, provider, host, close } = await setup();
	const json = await startStandaloneToolPortalHttpServer({
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/json',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		credentialSet: standaloneCredentials,
		service: fixture.service,
	});
	const request = { calls: [call('json-approved')] };
	const post = async (approvalToken?: string): Promise<unknown> => {
		const response = await fetch(json.endpoint, {
			method: 'POST',
			headers: {
				authorization: 'Bearer credential-agent-a',
				'content-type': 'application/json',
				...(approvalToken === undefined
					? {}
					: { [STANDALONE_TOOL_PORTAL_HTTP_APPROVAL_HEADER]: approvalToken }),
			},
			body: JSON.stringify({ operation: 'call', request }),
		});
		expect(response.status).toBe(200);
		return response.json();
	};
	try {
		expect(await post()).toMatchObject({ ok: false, items: [{ status: 'approval_required' }] });
		expect(provider.effects).toHaveLength(0);
		const intent = lastIntent(fixture);
		expect(intent.surfaceClass).toBe('http');
		const approvalToken = token(intent, new Date(fixture.now() + 60_000).toISOString());
		expect(await post(approvalToken)).toMatchObject({ ok: true });
		expect(provider.effects).toHaveLength(1);
		expect(await post(approvalToken)).toMatchObject({
			ok: false,
			items: [{ outcome: { kind: 'ambiguous' } }],
		});
		expect(provider.effects).toHaveLength(1);
		for (const endpoint of [host.endpoint, json.endpoint]) {
			const guessed = new URL('approve', endpoint);
			const response = await fetch(guessed, {
				method: 'POST',
				headers: { authorization: 'Bearer credential-agent-a' },
			});
			expect(response.status).toBe(404);
			await response.text();
		}
	} finally {
		await json.retire();
		await close();
	}
});
