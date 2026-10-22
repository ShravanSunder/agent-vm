import {
	hashCallArguments,
	signApprovalToken,
	verifyApprovalToken,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import { createOrganizationAuthority } from '#tool-host-core/organization-authority/organization-authority';
import { createApprovalExecutionGateway } from '#tool-host-core/organization-authority/test-fixtures/approval-execution-gateway';
import { createVolatileAuthorityStore } from '#tool-host-core/organization-authority/volatile-authority-store';

const testSigningKey = new Uint8Array(32).fill(23);

it('rejects expired signed approvals after replay pruning while an unexpired approval succeeds exactly once', async () => {
	await hegel.testAsync(
		async (tc) => {
			const issuedAtMs = tc.draw(generators.integers({ minValue: 0, maxValue: 10000 }));
			const lifetimeMs = tc.draw(generators.integers({ minValue: 1, maxValue: 1000 }));
			const lateByMs = tc.draw(generators.integers({ minValue: 0, maxValue: 1000 }));
			const argumentsValue = tc.draw(generators.integers({ minValue: -100, maxValue: 100 }));
			const expiresAtMs = issuedAtMs + lifetimeMs;
			let nowMs = issuedAtMs;
			const store = createVolatileAuthorityStore();
			const clock = { nowMs: () => nowMs };
			let authority = createOrganizationAuthority({ store, clock, cap: 4096 });
			const calls = [
				{
					namespace: 'fixture',
					toolName: 'protected-call',
					argumentsHash: await hashCallArguments({ value: argumentsValue }),
				},
			];
			const token = await signApprovalToken({
				key: testSigningKey,
				agentId: 'agent-a',
				calls,
				issuedAtMs,
				expiresAtMs,
				jti: 'original-token',
			});
			const verification = {
				key: testSigningKey,
				agentId: 'agent-a',
				calls,
				token,
				consumeTokenId: async (tokenId: string, expiry: number) =>
					authority.consumeApprovalToken(tokenId, expiry),
			};
			const { gateway, effects } = createApprovalExecutionGateway({
				key: testSigningKey,
				consumeTokenId: verification.consumeTokenId,
				nowMs: clock.nowMs,
			});
			const runCall = (): ReturnType<typeof gateway.call> =>
				gateway.call({
					calls: [
						{
							id: 'protected',
							namespace: 'fixture',
							toolName: 'protected-call',
							arguments: { value: argumentsValue },
						},
					],
					portalApprovalToken: token,
				});
			expect((await runCall()).ok).toBe(true);
			expect(effects).toEqual([{ value: argumentsValue }]);
			expect((await runCall()).ok).toBe(false);
			expect(effects).toHaveLength(1);
			nowMs = expiresAtMs + lateByMs;
			authority = createOrganizationAuthority({ store, clock, cap: 4096 });
			// A different first use prunes the original replay record, including exactly at expiry.
			expect(await authority.consumeApprovalToken('pruning-token', nowMs + 100)).toEqual({
				ok: true,
			});
			expect(await store.read('approval-uses-v1')).toEqual({ 'pruning-token': nowMs + 100 });
			expect(await verifyApprovalToken({ ...verification, nowMs })).toEqual({
				ok: false,
				reason: 'expired',
			});
			expect((await runCall()).ok).toBe(false);
			expect(effects).toEqual([{ value: argumentsValue }]);
			expect(await store.read('approval-uses-v1')).toEqual({ 'pruning-token': nowMs + 100 });
			// Prove the refusal came from signed expiry: the store itself permits this id again.
			expect(await authority.consumeApprovalToken('original-token', expiresAtMs)).toEqual({
				ok: true,
			});
		},
		{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
	);
});
