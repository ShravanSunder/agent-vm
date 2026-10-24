import type { AgentTokenVerifier } from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';

import { checkHostedCaller } from '#tool-host-core/caller-admission/caller-check';

const organizationId = '11111111-1111-4111-8111-111111111111';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const toolPortalOrigin = 'https://portal.invalid';
const verifier: AgentTokenVerifier = {
	verify: async (_token, expected) => {
		expect(expected).toEqual({
			workspaceId,
			audience: `${toolPortalOrigin}/workspaces/${workspaceId}/mcp`,
		});
		return {
			kind: 'verified',
			proof: {
				deployment: 'https://issuer.invalid',
				clientId: 'sender',
				organizationId,
				workspaceId,
				audience: expected.audience,
				expiresAt: 2_000_000_000,
			},
		};
	},
};
function request(): Request {
	return new Request(
		`https://attacker.invalid/workspaces/${workspaceId}/mcp?organizationId=other&agent=other`,
		{
			headers: {
				authorization: 'Bearer test-token',
				'x-organization-id': 'other',
				'x-agent-id': 'other',
				host: 'attacker.invalid',
			},
		},
	);
}
describe('Worker caller workspace routing', () => {
	it('uses the address workspace, configured audience and signed sender, ignoring routing labels', async () => {
		const checked: string[] = [];
		const result = await checkHostedCaller({
			request: request(),
			workspaceId,
			toolPortalOrigin,
			verifier,
			workspaces: {
				forWorkspace: (selected) => ({
					readMembership: async (agent) => {
						checked.push(selected, agent);
						return { persona: 'reader' };
					},
				}),
			},
		});
		expect(result).toEqual({
			kind: 'verified',
			organizationId,
			workspaceId,
			agentClientId: 'sender',
			persona: 'reader',
		});
		expect(checked).toEqual([workspaceId, 'sender']);
	});
	it('reads membership and its persona again after each change', async () => {
		let member: { readonly persona: string } | null = { persona: 'reader' };
		const props = {
			request: request(),
			workspaceId,
			toolPortalOrigin,
			verifier,
			workspaces: { forWorkspace: () => ({ readMembership: async () => member }) },
		};
		expect(await checkHostedCaller(props)).toMatchObject({ kind: 'verified', persona: 'reader' });
		member = { persona: 'writer' };
		expect(await checkHostedCaller(props)).toMatchObject({ kind: 'verified', persona: 'writer' });
		member = null;
		expect(await checkHostedCaller(props)).toEqual({ kind: 'refused', reason: 'removed-agent' });
	});
	it('fails closed on an unavailable object without leaking its error', async () => {
		expect(
			await checkHostedCaller({
				request: request(),
				workspaceId,
				toolPortalOrigin,
				verifier,
				workspaces: {
					forWorkspace: () => ({
						readMembership: async () => {
							throw new Error('secret-canary');
						},
					}),
				},
			}),
		).toEqual({ kind: 'unavailable', reason: 'admission-unavailable' });
	});
	it('refuses a missing token before asking admission', async () => {
		expect(
			await checkHostedCaller({
				request: new Request('https://portal.invalid'),
				workspaceId,
				toolPortalOrigin,
				verifier,
				workspaces: {
					forWorkspace: () => {
						throw new Error('Must not run');
					},
				},
			}),
		).toEqual({ kind: 'refused', reason: 'missing-token' });
	});
	it('preserves verifier refusal without asking admission', async () => {
		expect(
			await checkHostedCaller({
				request: request(),
				workspaceId,
				toolPortalOrigin,
				verifier: { verify: async () => ({ kind: 'refused', reason: 'expired' }) },
				workspaces: {
					forWorkspace: () => {
						throw new Error('Must not run');
					},
				},
			}),
		).toEqual({ kind: 'refused', reason: 'expired' });
	});
});
