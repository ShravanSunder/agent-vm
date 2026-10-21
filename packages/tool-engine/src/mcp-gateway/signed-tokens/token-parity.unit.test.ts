import * as legacyBearer from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
import * as legacyApproval from '@agent-vm/mcp-portal/portal-auth/hmac-token';
import { describe, it, expect } from 'vitest';

import { createInMemoryApprovalTokenUse } from '#mcp-gateway/call-approvals/approval-token-use';
import * as bearer from '#mcp-gateway/signed-tokens/agent-bearer-tokens';
import * as approval from '#mcp-gateway/signed-tokens/approval-token-signing';

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

describe('unchanged legacy token bytes on Web Crypto', () => {
	it.each(['agent-a', '☃:你好\nagent'])(
		'keeps bearer and audience token bytes for %s',
		async (agentId) => {
			const props = { agentId, credentialVersion: 7, masterKey: key };
			expect(await bearer.deriveAgentBearerToken(props)).toBe(
				legacyBearer.deriveAgentBearerToken(props),
			);
			expect(await bearer.formatMasterKeyFingerprint(key)).toBe(
				legacyBearer.formatMasterKeyFingerprint(key),
			);
			expect(bearer.decodePortalMasterKey(key.toString('base64url'))).toEqual(new Uint8Array(key));
			await Promise.all(
				['mcp-proxy:agent', 'standalone:☃'].map(async (audience) => {
					const scoped = { ...props, audience };
					const token = legacyBearer.deriveAudienceScopedAgentBearerToken(scoped);
					expect(await bearer.deriveAudienceScopedAgentBearerToken(scoped)).toBe(token);
					await Promise.all(
						[
							undefined,
							'Basic nope',
							`Bearer ${token}`,
							`Bearer ${token} extra`,
							`Bearer ${token.slice(1)}`,
							`Bearer ${token}=`,
							'Bearer ?????',
						].map(async (authorizationHeader) => {
							const input = { ...scoped, authorizationHeader };
							expect(await bearer.verifyAudienceScopedAgentBearerAuthorization(input)).toEqual(
								legacyBearer.verifyAudienceScopedAgentBearerAuthorization(input),
							);
						}),
					);
				}),
			);
		},
	);
	it.each([
		{ z: ['☃', '\n"\\'], a: { b: true, a: null } },
		{ a: 1, z: 2 },
	])('keeps approval bytes and verifies both directions for %j', async (args) => {
		const calls = [
			{
				namespace: 'tools/你好',
				toolName: 'echo',
				argumentsHash: legacyApproval.hashCallArguments(args),
			},
		];
		expect(await approval.hashCallArguments(args)).toBe(calls[0]?.argumentsHash);
		const props = {
			key,
			agentId: 'agent:☃',
			calls,
			issuedAtMs: 100,
			expiresAtMs: 10000,
			jti: 'fixed-☃',
		};
		expect(await approval.signApprovalToken(props)).toBe(legacyApproval.signApprovalToken(props));
		await Promise.all(
			['mcp-portal:approval', 'other:audience'].map(async (audience) => {
				const scoped = { ...props, audience };
				const token = await approval.signAudienceScopedApprovalToken(scoped);
				expect(token).toBe(legacyApproval.signAudienceScopedApprovalToken(scoped));
				expect(
					legacyApproval.verifyAudienceScopedApprovalToken({ ...scoped, token, nowMs: 1000 }),
				).toEqual({ ok: true });
				const consumeTokenId = createInMemoryApprovalTokenUse({ now: () => 1000 });
				const verified = { ...scoped, token, nowMs: 1000, consumeTokenId };
				expect(await approval.verifyAudienceScopedApprovalToken(verified)).toEqual({ ok: true });
				expect(await approval.verifyAudienceScopedApprovalToken(verified)).toEqual({
					ok: false,
					reason: 'replayed',
				});
			}),
		);
	});
	it('requires a successful awaited use record, rejecting absent, malformed and failed answers', async () => {
		const props = { key, agentId: 'a', calls: [], issuedAtMs: 0, expiresAtMs: 10000, jti: 'j' };
		const token = await approval.signApprovalToken(props);
		await Promise.all(
			[undefined, null, {}, { ok: 'yes' }, { ok: 1 }, { ok: false, reason: 'replayed' }].map(
				async (response) => {
					const input = {
						...props,
						token,
						nowMs: 1,
						consumeTokenId: async () => ({ ok: true as const }),
					};
					Reflect.set(input, 'consumeTokenId', async () => response);
					expect((await approval.verifyApprovalToken(input)).ok).toBe(false);
				},
			),
		);
		const input = {
			...props,
			token,
			nowMs: 1,
			consumeTokenId: async () => ({ ok: true as const }),
		};
		Reflect.deleteProperty(input, 'consumeTokenId');
		expect(await approval.verifyApprovalToken(input)).toEqual({
			ok: false,
			reason: 'replay-store-unavailable',
		});
	});
});
