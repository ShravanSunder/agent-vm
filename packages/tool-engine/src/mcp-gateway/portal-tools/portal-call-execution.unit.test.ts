import { hashCallArguments } from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';

import { createInMemoryApprovalTokenUse } from '#mcp-gateway/call-approvals/approval-token-use';
import { signApprovalToken } from '#mcp-gateway/signed-tokens/approval-token-signing';
import { createHarness } from '#mcp-gateway/test-fixtures/mcp-gateway-harness';

const approvalKey = new Uint8Array(32).fill(23);
const refusedTokens = [
	{
		kind: 'replayed',
		message: 'MCP Portal approval token is invalid: replayed.',
		reason: 'replayed',
	},
	{
		kind: 'forged',
		message: 'MCP Portal approval token is invalid: signature-mismatch.',
		reason: 'signature-mismatch',
	},
] as const;

for (const mode of ['indirect', 'direct'] as const) {
	describe(`${mode} refused approval item errors`, () => {
		it.each(refusedTokens)(
			'preserves the exact 08f9e426 $kind error and prevents another effect',
			async ({ kind, message, reason }) => {
				const harness = createHarness(undefined, 'complete', {
					approvalTokens: {
						key: approvalKey,
						consumeTokenId: createInMemoryApprovalTokenUse({ now: () => 0 }),
					},
				});
				const request = {
					id: 'protected',
					namespace: 'alpha',
					toolName: 'ask',
					arguments: { value: 42 },
				};
				const token = await signApprovalToken({
					key: kind === 'forged' ? new Uint8Array(32).fill(47) : approvalKey,
					agentId: 'agent-a',
					issuedAtMs: 0,
					expiresAtMs: 10_000,
					jti: 'refused-token-parity',
					calls: [
						{
							argumentsHash: await hashCallArguments({ value: 42 }),
							namespace: 'alpha',
							toolName: 'ask',
						},
					],
				});
				const catalog = await harness.gateway.prepareCatalog();
				const run = (): ReturnType<typeof harness.gateway.call> =>
					mode === 'indirect'
						? harness.gateway.call({ calls: [request], portalApprovalToken: token })
						: harness.gateway.callDirect({
								name: 'alpha__ask__645775a667',
								arguments: { value: 42 },
								item: 'protected',
								catalog,
								_meta: { 'agent-vm/tool-portal-approval-token': token },
							});
				if (kind === 'replayed') expect((await run()).ok).toBe(true);
				const effectsBeforeRefusal = harness.effects.length;
				const result = await run();
				// Oracle: 08f9e426 core/portal-tools.ts:942–952, not the engine projection.
				expect(result.results.protected).toEqual({
					ok: false,
					input: request,
					error: {
						kind: 'approval_token_invalid',
						message,
						namespace: 'alpha',
						reason,
						toolName: 'ask',
					},
				});
				expect(result.ok).toBe(false);
				expect(harness.effects).toHaveLength(effectsBeforeRefusal);
				expect(harness.effects).toHaveLength(kind === 'replayed' ? 1 : 0);
			},
		);
	});
}
