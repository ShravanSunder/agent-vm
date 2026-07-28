import { describe, expect, it } from 'vitest';

import {
	decodePortalMasterKey,
	deriveAudienceScopedAgentBearerToken,
	deriveAgentBearerToken,
	formatMasterKeyFingerprint,
	verifyAudienceScopedAgentBearerAuthorization,
	verifyAgentBearerAuthorization,
} from './agent-bearer-token.js';

describe('agent bearer token helpers', () => {
	it('cryptographically separates product audiences', () => {
		const masterKey = Buffer.from('master-key');
		const mcpPortalBearer = deriveAudienceScopedAgentBearerToken({
			agentId: 'shravan',
			audience: 'mcp-portal:agent',
			credentialVersion: 1,
			masterKey,
		});
		const toolPortalBearer = deriveAudienceScopedAgentBearerToken({
			agentId: 'shravan',
			audience: 'tool-portal:agent',
			credentialVersion: 1,
			masterKey,
		});

		expect(mcpPortalBearer).not.toBe(toolPortalBearer);
		expect(
			verifyAudienceScopedAgentBearerAuthorization({
				agentId: 'shravan',
				audience: 'tool-portal:agent',
				authorizationHeader: `Bearer ${mcpPortalBearer}`,
				credentialVersion: 1,
				masterKey,
			}),
		).toEqual({ ok: false, reason: 'signature-mismatch' });
		expect(
			verifyAudienceScopedAgentBearerAuthorization({
				agentId: 'shravan',
				audience: 'tool-portal:agent',
				authorizationHeader: `Bearer ${toolPortalBearer}`,
				credentialVersion: 1,
				masterKey,
			}),
		).toEqual({ ok: true });
	});

	it('rejects an empty audience instead of falling back', () => {
		expect(() =>
			deriveAudienceScopedAgentBearerToken({
				agentId: 'shravan',
				audience: '',
				credentialVersion: 1,
				masterKey: Buffer.from('master-key'),
			}),
		).toThrow(/audience/u);
	});

	it('derives deterministic audience-scoped bearers per agent', () => {
		const masterKey = Buffer.from('master-key');

		expect(deriveAgentBearerToken({ agentId: 'shravan', credentialVersion: 1, masterKey })).toBe(
			deriveAgentBearerToken({ agentId: 'shravan', credentialVersion: 1, masterKey }),
		);
		expect(
			deriveAgentBearerToken({ agentId: 'shravan', credentialVersion: 1, masterKey }),
		).not.toBe(deriveAgentBearerToken({ agentId: 'alevtina', credentialVersion: 1, masterKey }));
	});

	it('verifies bearer authorization without accepting wrong agents or schemes', () => {
		const masterKey = Buffer.from('master-key');
		const bearer = deriveAgentBearerToken({ agentId: 'shravan', credentialVersion: 1, masterKey });

		expect(
			verifyAgentBearerAuthorization({
				agentId: 'shravan',
				authorizationHeader: `Bearer ${bearer}`,
				credentialVersion: 1,
				masterKey,
			}),
		).toEqual({ ok: true });
		expect(
			verifyAgentBearerAuthorization({
				agentId: 'alevtina',
				authorizationHeader: `Bearer ${bearer}`,
				credentialVersion: 1,
				masterKey,
			}),
		).toEqual({ ok: false, reason: 'signature-mismatch' });
		expect(
			verifyAgentBearerAuthorization({
				agentId: 'shravan',
				authorizationHeader: bearer,
				credentialVersion: 1,
				masterKey,
			}),
		).toEqual({ ok: false, reason: 'malformed' });
	});

	it('binds bearer authorization to the agent credential version', () => {
		const masterKey = Buffer.from('master-key');
		const versionOneBearer = deriveAgentBearerToken({
			agentId: 'shravan',
			credentialVersion: 1,
			masterKey,
		});
		const versionTwoBearer = deriveAgentBearerToken({
			agentId: 'shravan',
			credentialVersion: 2,
			masterKey,
		});

		expect(versionOneBearer).not.toBe(versionTwoBearer);
		expect(
			verifyAgentBearerAuthorization({
				agentId: 'shravan',
				authorizationHeader: `Bearer ${versionOneBearer}`,
				credentialVersion: 2,
				masterKey,
			}),
		).toEqual({ ok: false, reason: 'signature-mismatch' });
		expect(
			verifyAgentBearerAuthorization({
				agentId: 'shravan',
				authorizationHeader: `Bearer ${versionTwoBearer}`,
				credentialVersion: 2,
				masterKey,
			}),
		).toEqual({ ok: true });
	});

	it('formats a stable non-secret master-key fingerprint', () => {
		const fingerprint = formatMasterKeyFingerprint(Buffer.from('master-key'));

		expect(fingerprint).toMatch(/^sha256:[A-Za-z0-9_-]+$/u);
		expect(fingerprint).toBe(formatMasterKeyFingerprint(Buffer.from('master-key')));
	});

	it('decodes only canonical base64url master keys with enough entropy bytes', () => {
		const masterKey = Buffer.from('0123456789abcdef0123456789abcdef');
		const encodedMasterKey = masterKey.toString('base64url');

		expect(decodePortalMasterKey(encodedMasterKey)).toEqual(masterKey);
		expect(() => decodePortalMasterKey('external-master-key')).toThrow(/at least 32 bytes/u);
		expect(() => decodePortalMasterKey(`${encodedMasterKey}=`)).toThrow(/base64url/u);
	});
});
