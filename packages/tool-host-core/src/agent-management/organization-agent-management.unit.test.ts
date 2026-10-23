import { createPersonTokenVerifier } from '@agent-collaboration/tool-access/contracts';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';

import {
	createOrganizationAgentManagement,
	type AgentClientManagementPort,
} from '#tool-host-core/agent-management/organization-agent-management';
import { createOrganizationAuthority } from '#tool-host-core/organization-authority/organization-authority';
import { createVolatileAuthorityStore } from '#tool-host-core/organization-authority/volatile-authority-store';

const organizationId = '11111111-1111-4111-8111-111111111111';
const requestId = 'b015079b-19b6-4aa2-9b82-1298efcb2f79';
const issuer = 'https://issuer.invalid';
const audience = 'https://portal.invalid/management';

interface ManagementFixtureState {
	active: boolean;
	failDisable: boolean;
	disabled: boolean;
	changes: number;
	failAdmission: boolean;
	strongerLevel: 'fresh-verified-uv' | 'exact-operation-binding' | null;
}

async function fixture(): Promise<{
	handle: (request: Request) => Promise<Response>;
	request: (
		method: string,
		clientId?: string,
		changes?: JWTPayload,
		body?: unknown,
	) => Promise<Response>;
	authority: ReturnType<typeof createOrganizationAuthority>;
	store: ReturnType<typeof createVolatileAuthorityStore>;
	state: ManagementFixtureState;
}> {
	const keys = await generateKeyPair('EdDSA');
	const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), alg: 'EdDSA', kid: 'key-one' }] };
	const store = createVolatileAuthorityStore();
	const authority = createOrganizationAuthority({ store, clock: { nowMs: () => 100 }, cap: 1024 });
	const state: ManagementFixtureState = {
		active: true,
		failDisable: false,
		disabled: false,
		changes: 0,
		failAdmission: false,
		strongerLevel: null,
	};
	const signIn: AgentClientManagementPort = {
		humanCheckStatus: async () =>
			state.strongerLevel === null
				? { kind: 'ready', level: 'remembered-login' }
				: { kind: 'not-implemented', level: state.strongerLevel },
		isLiveOwner: async () => state.active,
		ownsAgentClient: async ({ clientId }) => clientId === 'agent-one',
		changeClient: async ({ operation }) => {
			state.changes += 1;
			if (operation.kind === 'register')
				return { kind: 'registered', clientId: 'agent-one', clientSecret: 'once-only-secret' };
			if (state.failDisable) return { kind: 'incomplete', clientId: operation.clientId };
			state.disabled = true;
			return { kind: 'disabled', clientId: operation.clientId };
		},
	};
	const { handle } = createOrganizationAgentManagement({
		verifier: createPersonTokenVerifier({
			deployment: issuer,
			audience,
			jwksUrl: new URL(`${issuer}/jwks`),
			now: () => 100_000,
			jwksFetch: async () => Response.json(jwks),
		}),
		signIn,
		organizations: {
			forOrganization: () => ({
				...authority,
				setAgentAdmission: async (clientId, admission) => {
					if (state.failAdmission) throw new Error('Controlled admission write failure');
					await authority.setAgentAdmission(clientId, admission);
				},
			}),
		},
	});
	return {
		handle,
		store,
		authority,
		state,
		async request(method, clientId, changes = {}, body = { requestId }): Promise<Response> {
			const token = await new SignJWT({
				iss: issuer,
				sub: 'owner-one',
				aud: audience,
				sid: 'session-one',
				iat: 100,
				exp: 400,
				client_id: 'owner-cli',
				azp: 'owner-cli',
				scope: 'tool-portal:management',
				jti: 'token-one',
				...changes,
			})
				.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: 'key-one' })
				.sign(keys.privateKey);
			return handle(
				new Request(
					`https://portal.invalid/management/organizations/${organizationId}/agents${clientId === undefined ? '' : `/${clientId}`}`,
					{
						method,
						headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
						...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
					},
				),
			);
		},
	};
}

// Signature verification, coordination and atomic decision logic are real; issuer and storage are doubles.
describe('organization agent management', () => {
	const strongerLevels: readonly ('fresh-verified-uv' | 'exact-operation-binding')[] = [
		'fresh-verified-uv',
		'exact-operation-binding',
	];
	it.each(strongerLevels)(
		'refuses the unimplemented %s level without downgrading or changing state',
		async (level) => {
			const target = await fixture();
			target.state.strongerLevel = level;
			const responses = await Promise.all(
				['POST', 'GET', 'DELETE'].map((method) =>
					target.request(method, method === 'POST' ? undefined : 'agent-one'),
				),
			);
			expect(responses.map((response) => response.status)).toEqual([501, 501, 501]);
			expect(await responses[0]?.json()).toEqual({
				error: 'management-human-check-not-implemented',
				level,
			});
			expect(target.state.changes).toBe(0);
			expect(await target.authority.readAgentRetirement('agent-one')).toBeNull();
		},
	);
	it('releases a credential only after issuer registration and admission readback', async () => {
		const target = await fixture();
		expect(await (await target.request('POST')).json()).toEqual({
			kind: 'registered',
			clientId: 'agent-one',
			clientSecret: 'once-only-secret',
		});
		expect(await target.authority.isAgentListed('agent-one')).toBe(true);
	});
	it('releases no credential when admission fails', async () => {
		const target = await fixture();
		target.state.failAdmission = true;
		const response = await target.request('POST');
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain('once-only-secret');
		expect(await target.authority.isAgentListed('agent-one')).toBe(false);
	});
	it('keeps removal pending and calls refused when disabling fails; the next owner GET retries', async () => {
		const target = await fixture();
		await target.authority.setAgentAdmission('agent-one', 'listed');
		target.state.failDisable = true;
		expect((await target.request('DELETE', 'agent-one')).status).toBe(202);
		expect(await target.authority.isAgentListed('agent-one')).toBe(false);
		expect(await target.store.read('agent-retirement:agent-one')).toEqual({
			kind: 'pending',
			requestId,
		});
		expect(target.state.disabled).toBe(false);
		target.state.failDisable = false;
		expect(await (await target.request('GET', 'agent-one')).json()).toEqual({
			kind: 'removed',
			clientId: 'agent-one',
		});
		expect(target.state.disabled).toBe(true);
		expect(await target.authority.readAgentRetirement('agent-one')).toEqual({
			kind: 'complete',
			requestId,
		});
	});
	it.each(['POST', 'DELETE', 'GET'])(
		'refuses agent and management tokens missing a person session on %s',
		async (method) => {
			await Promise.all(
				['tool-portal:agent', 'tool-portal:management'].map(async (scope) => {
					const target = await fixture();
					expect(
						(
							await target.request(method, method === 'POST' ? undefined : 'agent-one', {
								sid: undefined,
								sub: 'agent-one',
								scope,
							})
						).status,
					).toBe(403);
					expect(target.state.changes).toBe(0);
					expect(await target.authority.readAgentRetirement('agent-one')).toBeNull();
				}),
			);
		},
	);
	it('refuses a removed owner with an unexpired valid signature on every route', async () => {
		const target = await fixture();
		target.state.active = false;
		await Promise.all(
			['POST', 'DELETE', 'GET'].map(async (method) =>
				expect(
					(await target.request(method, method === 'POST' ? undefined : 'agent-one')).status,
				).toBe(403),
			),
		);
		expect(target.state.changes).toBe(0);
	});
	it('does not accept actor, owner or organization authority supplied in a body', async () => {
		const target = await fixture();
		expect(
			(
				await target.request(
					'POST',
					undefined,
					{},
					{ requestId, actor: 'owner-one', organizationId, owner: true },
				)
			).status,
		).toBe(400);
		expect(target.state.changes).toBe(0);
	});
	it('does not remove admission or create pending work for a foreign client', async () => {
		const target = await fixture();
		expect((await target.request('DELETE', 'foreign-agent')).status).toBe(403);
		expect(await target.authority.readAgentRetirement('foreign-agent')).toBeNull();
		expect(target.state.changes).toBe(0);
	});
});
