import { hashCallArguments } from '@agent-collaboration/tool-access/contracts';
import { describe, it, expect } from 'vitest';

import { createInMemoryApprovalTokenUse } from '#mcp-gateway/call-approvals/approval-token-use';
import type {
	ConsumeApprovalTokenId,
	ConsumeApprovalTokenResult,
} from '#mcp-gateway/call-approvals/models/call-approval';
import { signApprovalToken } from '#mcp-gateway/signed-tokens/approval-token-signing';
import { createHarness, callInput } from '#mcp-gateway/test-fixtures/mcp-gateway-harness';

const key = new Uint8Array(32).fill(23);

const calls = [
	{ id: 'first', namespace: 'alpha', toolName: 'ask', arguments: { value: 42 } },
	{ id: 'second', namespace: 'beta', toolName: 'ask', arguments: { value: 43 } },
];

async function tokenFor(selected = calls, agentId = 'agent-a'): Promise<string> {
	return signApprovalToken({
		key,
		agentId,
		calls: await Promise.all(
			selected.map(async (call) => ({
				namespace: call.namespace,
				toolName: call.toolName,
				argumentsHash: await hashCallArguments(call.arguments),
			})),
		),
		issuedAtMs: 0,
		expiresAtMs: 10000,
		jti: 'one-token',
	});
}

for (const carrier of ['input', 'metadata'] as const) {
	describe(`${carrier} approval through the gateway and dispatcher`, () => {
		async function fixture(
			consumeTokenId: ConsumeApprovalTokenId = createInMemoryApprovalTokenUse({ now: () => 0 }),
		): Promise<{
			h: ReturnType<typeof createHarness>;
			run: (
				token?: string,
				value?: number,
			) => ReturnType<ReturnType<typeof createHarness>['gateway']['call']>;
		}> {
			const h = createHarness(undefined, 'complete', { approvalTokens: { key, consumeTokenId } });
			const catalog = await h.gateway.prepareCatalog();
			return {
				h,
				run: async (token, value = 42) =>
					carrier === 'input'
						? h.gateway.call({
								calls: calls.map((call, index) =>
									index === 0 ? { ...call, arguments: { value } } : call,
								),
								...(token === undefined ? {} : { portalApprovalToken: token }),
							})
						: h.gateway.callDirect({
								name: 'alpha__ask__645775a667',
								arguments: { value },
								item: 'first',
								catalog,
								...(token === undefined
									? {}
									: { _meta: { 'agent-vm/tool-portal-approval-token': token } }),
							}),
			};
		}
		const selected = carrier === 'input' ? calls : [calls[0]].filter((call) => call !== undefined);
		it('runs the exact approved calls once, preserving arguments and giving each a receipt', async () => {
			const { h, run } = await fixture();
			const token = await tokenFor(selected);
			expect((await run(token)).ok).toBe(true);
			expect(h.effects.map((effect) => effect.arguments)).toEqual(
				selected.map((call) => call.arguments),
			);
			expect(
				h.effects.every((effect) => effect.approvalReceiptRef === 'mcp-approval:one-token'),
			).toBe(true);
			expect((await run(token)).ok).toBe(false);
			expect(h.effects).toHaveLength(selected.length);
		});
		it('accepts only one simultaneous use', async () => {
			const { h, run } = await fixture();
			const token = await tokenFor(selected);
			const results = await Promise.all([run(token), run(token)]);
			expect(results.filter((result) => result.ok)).toHaveLength(1);
			expect(h.effects).toHaveLength(selected.length);
		});
		it.each(['missing', 'agent', 'arguments', 'calls', 'order'] as const)(
			'refuses %s approval without an effect',
			async (kind) => {
				const { h, run } = await fixture();
				const signedCalls =
					kind === 'calls'
						? []
						: kind === 'order'
							? carrier === 'input'
								? selected.toReversed()
								: selected.map((call) => ({ ...call, namespace: 'beta' }))
							: selected;
				const token =
					kind === 'missing'
						? undefined
						: await tokenFor(signedCalls, kind === 'agent' ? 'other-agent' : 'agent-a');
				expect((await run(token, kind === 'arguments' ? 999 : 42)).ok).toBe(false);
				expect(h.effects).toEqual([]);
			},
		);
		it.each(['refuses', 'throws', 'no-answer', 'malformed-success'] as const)(
			'does not run if the one-use authority %s',
			async (kind) => {
				const consumeTokenId: ConsumeApprovalTokenId = async () => {
					if (kind === 'throws') throw new Error('private replay-store canary');
					return { ok: false, reason: 'replayed' };
				};
				const { h, run } = await fixture(
					kind === 'no-answer' || kind === 'malformed-success'
						? async () => {
								const result = { ok: false as const, reason: 'replay-store-unavailable' as const };
								if (kind === 'no-answer') Reflect.deleteProperty(result, 'ok');
								else Reflect.set(result, 'ok', 'truthy-but-not-first-use');
								return result;
							}
						: consumeTokenId,
				);
				const result = await run(await tokenFor(selected));
				expect(result.ok).toBe(false);
				expect(JSON.stringify(result)).not.toContain('private replay-store canary');
				expect(h.effects).toEqual([]);
			},
		);
		it('waits for the one-use authority before any effect', async () => {
			const entered = Promise.withResolvers<void>();
			const record = Promise.withResolvers<ConsumeApprovalTokenResult>();
			const { h, run } = await fixture(async () => {
				entered.resolve();
				return record.promise;
			});
			const running = run(await tokenFor(selected));
			await entered.promise;
			expect(h.effects).toEqual([]);
			record.resolve({ ok: true });
			expect((await running).ok).toBe(true);
			expect(h.effects).toHaveLength(selected.length);
		});
		it('keeps a stalled record that later refuses from adding any effect', async () => {
			const entered = Promise.withResolvers<void>();
			const record = Promise.withResolvers<ConsumeApprovalTokenResult>();
			const { h, run } = await fixture(async () => {
				entered.resolve();
				return record.promise;
			});
			const running = run(await tokenFor(selected));
			await entered.promise;
			record.resolve({ ok: false, reason: 'replay-store-unavailable' });
			expect((await running).ok).toBe(false);
			expect(h.effects).toEqual([]);
		});
		it('leaves an unprotected tool callable without a token', async () => {
			const { h } = await fixture();
			expect((await h.gateway.call(callInput())).ok).toBe(true);
			expect(h.effects[0]?.approvalReceiptRef).toBeNull();
		});
	});
}

// Legacy approval evaluation authorizes these siblings independently of the token.
describe('mixed approval batches keep independent unprotected work', () => {
	it.each(['invalid', 'replayed'] as const)(
		'keeps the unprotected sibling when the protected token is %s',
		async (kind) => {
			const h = createHarness(undefined, 'complete', {
				approvalTokens: { key, consumeTokenId: createInMemoryApprovalTokenUse({ now: () => 0 }) },
			});
			const protectedCall = {
				id: 'protected',
				namespace: 'alpha',
				toolName: 'ask',
				arguments: { value: 42 },
			};
			const valid = await tokenFor([protectedCall]);
			if (kind === 'replayed')
				expect(
					(await h.gateway.call({ calls: [protectedCall], portalApprovalToken: valid })).ok,
				).toBe(true);
			const before = h.effects.length;
			const result = await h.gateway.call({
				calls: [
					{ id: 'free', namespace: 'alpha', toolName: 'read', arguments: { value: 42 } },
					{ ...protectedCall, id: 'new-protected-item' },
				],
				portalApprovalToken: kind === 'invalid' ? 'invalid.token' : valid,
			});
			expect(result.results.free?.ok).toBe(true);
			expect(result.results['new-protected-item']).toMatchObject({
				ok: false,
				error: { kind: 'approval_token_invalid' },
			});
			expect(h.effects.slice(before).map((effect) => effect.capability)).toEqual([
				{ namespace: 'alpha', tool: 'read' },
			]);
		},
	);
});
