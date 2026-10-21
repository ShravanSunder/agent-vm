import type { AgentTokenVerifier } from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';

import { checkHostedCaller } from '#tool-host-core/caller-admission/caller-check';

const organizationId = '11111111-1111-4111-8111-111111111111';
// This unit test isolates the edge's routing rule. Signed JWT/JWKS HTTP is proved in workerd.
const verifier: AgentTokenVerifier = {
	verify: async () => ({
		kind: 'verified',
		proof: {
			deployment: 'https://issuer.invalid',
			clientId: 'sender',
			organizationId,
			audience: 'https://portal.invalid',
			expiresAt: 2_000_000_000,
		},
	}),
};
function request(): Request {
	return new Request('https://portal.invalid/other-org/mcp?organizationId=other&agent=other', {
		headers: {
			authorization: 'Bearer test-token',
			'x-organization-id': 'other',
			'x-agent-id': 'other',
		},
	});
}
describe('Worker caller edge routing', () => {
	it('routes only to the token organization and sender', async () => {
		const checked: string[] = [];
		const result = await checkHostedCaller({
			request: request(),
			verifier,
			organizations: {
				forOrganization: (selected) => ({
					isAgentListed: async (agent) => {
						checked.push(selected, agent);
						return true;
					},
				}),
			},
		});
		expect(result).toEqual({ kind: 'verified', organizationId, agentClientId: 'sender' });
		expect(checked).toEqual([organizationId, 'sender']);
	});
	it('checks admission again on the next request after a removal', async () => {
		let listed = true;
		const props = {
			request: request(),
			verifier,
			organizations: {
				forOrganization: () => ({ isAgentListed: async () => listed }),
			},
		};
		expect((await checkHostedCaller(props)).kind).toBe('verified');
		listed = false;
		expect(await checkHostedCaller(props)).toEqual({ kind: 'refused', reason: 'removed-agent' });
	});
	it('fails closed on an unavailable object without leaking its error', async () => {
		expect(
			await checkHostedCaller({
				request: request(),
				verifier,
				organizations: {
					forOrganization: () => ({
						isAgentListed: async () => {
							throw new Error('secret-canary');
						},
					}),
				},
			}),
		).toEqual({ kind: 'unavailable', reason: 'admission-unavailable' });
	});
	it('refuses a missing token before calling admission', async () => {
		expect(
			await checkHostedCaller({
				request: new Request('https://portal.invalid'),
				verifier,
				organizations: {
					forOrganization: () => {
						throw new Error('must not run');
					},
				},
			}),
		).toEqual({ kind: 'refused', reason: 'missing-token' });
	});
	it('preserves a verifier refusal without asking admission', async () => {
		expect(
			await checkHostedCaller({
				request: request(),
				verifier: {
					verify: async () => ({ kind: 'refused', reason: 'expired' }),
				},
				organizations: {
					forOrganization: () => {
						throw new Error('must not run');
					},
				},
			}),
		).toEqual({ kind: 'refused', reason: 'expired' });
	});
});
