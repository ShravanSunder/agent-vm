import { describe, expect, it } from 'vitest';

import {
	decodePortalMasterKey,
	deriveAgentBearerToken,
	formatMasterKeyFingerprint,
	verifyAgentBearerAuthorization,
} from './agent-bearer-token.js';

describe('agent bearer token helpers', () => {
	it('derives deterministic audience-scoped bearers per agent', () => {
		const masterKey = Buffer.from('master-key');

		expect(deriveAgentBearerToken({ agentId: 'shravan', masterKey })).toBe(
			deriveAgentBearerToken({ agentId: 'shravan', masterKey }),
		);
		expect(deriveAgentBearerToken({ agentId: 'shravan', masterKey })).not.toBe(
			deriveAgentBearerToken({ agentId: 'alevtina', masterKey }),
		);
	});

	it('verifies bearer authorization without accepting wrong agents or schemes', () => {
		const masterKey = Buffer.from('master-key');
		const bearer = deriveAgentBearerToken({ agentId: 'shravan', masterKey });

		expect(
			verifyAgentBearerAuthorization({
				agentId: 'shravan',
				authorizationHeader: `Bearer ${bearer}`,
				masterKey,
			}),
		).toEqual({ ok: true });
		expect(
			verifyAgentBearerAuthorization({
				agentId: 'alevtina',
				authorizationHeader: `Bearer ${bearer}`,
				masterKey,
			}),
		).toEqual({ ok: false, reason: 'signature-mismatch' });
		expect(
			verifyAgentBearerAuthorization({
				agentId: 'shravan',
				authorizationHeader: bearer,
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
