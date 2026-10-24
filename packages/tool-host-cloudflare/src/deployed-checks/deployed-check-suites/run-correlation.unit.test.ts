import { resolveToolLoading } from '@agent-collaboration/tool-engine/mcp-gateway';
import { checkHostedCaller } from '@agent-collaboration/tool-host-core';
import { expect, it } from 'vitest';

it('runId is inert for both loading modes, token organization, sender and caller response', async () => {
	const evaluate = async (query: string): Promise<unknown> => ({
		loading: resolveToolLoading(`https://portal.invalid/mcp?${query}`),
		caller: await checkHostedCaller({
			sessionClientId: 'central',
			organizationId: '11111111-1111-4111-8111-111111111111',
			workspaceId: '11111111-1111-4111-8111-111111111111',
			toolPortalOrigin: 'https://portal.invalid',
			request: new Request(`https://portal.invalid/mcp?${query}`, {
				headers: { authorization: 'Bearer controlled' },
			}),
			verifier: {
				verify: async () => ({
					kind: 'verified',
					proof: {
						deployment: 'https://issuer.invalid',
						clientId: 'sender',
						organizationId: '11111111-1111-4111-8111-111111111111',
						workspaceId: '11111111-1111-4111-8111-111111111111',
						audience: 'test',
						principal: { kind: 'bot', bot_id: '22222222-2222-4222-8222-222222222222' },
						persona: { kind: 'named', name: 'operator' },
						grantRevision: 7,
						grantExpiresAt: 1_800_000_300,
						expiresAt: 2_000_000_000,
					},
				}),
			},
		}),
	});
	expect(await evaluate('runId=test-run')).toEqual(await evaluate(''));
	expect(await evaluate('tools=direct&runId=test-run')).toEqual(await evaluate('tools=direct'));
});
