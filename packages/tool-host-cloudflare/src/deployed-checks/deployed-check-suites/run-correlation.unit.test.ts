import { resolveToolLoading } from '@agent-collaboration/tool-engine/mcp-gateway';
import { expect, it } from 'vitest';

import { checkWorkerCaller } from '#worker-host/caller-authorization/caller-check';

it('runId is inert for both loading modes, token organization, sender and caller response', async () => {
	const evaluate = async (query: string): Promise<unknown> => ({
		loading: resolveToolLoading(`https://portal.invalid/mcp?${query}`),
		caller: await checkWorkerCaller({
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
						audience: 'test',
						expiresAt: 2_000_000_000,
					},
				}),
			},
			organizations: { forOrganization: () => ({ isAgentListed: async () => true }) },
		}),
	});
	expect(await evaluate('runId=test-run')).toEqual(await evaluate(''));
	expect(await evaluate('tools=direct&runId=test-run')).toEqual(await evaluate('tools=direct'));
});
