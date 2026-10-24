import {
	decodeTokenBytes,
	encodeTokenBytes,
	signTokenBytes,
	verifyTokenBytes,
} from '#mcp-gateway/signed-tokens/token-signing-primitives';

export interface DeriveAgentBearerTokenProps {
	readonly agentId: string;
	readonly credentialVersion: number;
	readonly masterKey: Uint8Array;
}

export interface DeriveAudienceScopedAgentBearerTokenProps extends DeriveAgentBearerTokenProps {
	readonly audience: string;
}

export interface VerifyAgentBearerAuthorizationProps extends DeriveAgentBearerTokenProps {
	readonly authorizationHeader: string | undefined;
}

export interface VerifyAudienceScopedAgentBearerAuthorizationProps extends DeriveAudienceScopedAgentBearerTokenProps {
	readonly authorizationHeader: string | undefined;
}

export type VerifyAgentBearerAuthorizationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: 'malformed' | 'missing' | 'signature-mismatch' };

export const mcpPortalAgentBearerAudience = 'mcp-proxy:agent';

const minimumMasterKeyBytes = 32;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

export function decodePortalMasterKey(encodedMasterKey: string): Uint8Array {
	const trimmedMasterKey = encodedMasterKey.trim();
	if (!base64UrlPattern.test(trimmedMasterKey)) {
		throw new Error('MCP Portal masterKey must be base64url-encoded key material.');
	}
	const masterKey = decodeTokenBytes(trimmedMasterKey);
	if (masterKey.length < minimumMasterKeyBytes) {
		throw new Error(
			`MCP Portal masterKey must decode to at least ${String(minimumMasterKeyBytes)} bytes.`,
		);
	}
	if (encodeTokenBytes(masterKey) !== trimmedMasterKey) {
		throw new Error('MCP Portal masterKey must be canonical base64url without padding.');
	}
	return masterKey;
}

export async function deriveAgentBearerToken(props: DeriveAgentBearerTokenProps): Promise<string> {
	return deriveAudienceScopedAgentBearerToken({
		...props,
		audience: mcpPortalAgentBearerAudience,
	});
}

export async function deriveAudienceScopedAgentBearerToken(
	props: DeriveAudienceScopedAgentBearerTokenProps,
): Promise<string> {
	assertCredentialAudience(props.audience);
	return signTokenBytes(
		props.masterKey,
		`${props.audience}:${props.agentId}:v${String(props.credentialVersion)}`,
	);
}

export async function formatMasterKeyFingerprint(masterKey: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(masterKey));
	return `sha256:${encodeTokenBytes(new Uint8Array(digest))}`;
}

export async function verifyAgentBearerAuthorization(
	props: VerifyAgentBearerAuthorizationProps,
): Promise<VerifyAgentBearerAuthorizationResult> {
	return verifyAudienceScopedAgentBearerAuthorization({
		...props,
		audience: mcpPortalAgentBearerAudience,
	});
}

export async function verifyAudienceScopedAgentBearerAuthorization(
	props: VerifyAudienceScopedAgentBearerAuthorizationProps,
): Promise<VerifyAgentBearerAuthorizationResult> {
	assertCredentialAudience(props.audience);
	const input = `${props.audience}:${props.agentId}:v${String(props.credentialVersion)}`;

	if (props.authorizationHeader === undefined) {
		return { ok: false, reason: 'missing' };
	}
	const [scheme, token, extra] = props.authorizationHeader.split(/\s+/u);
	if (scheme !== 'Bearer' || token === undefined || token.length === 0 || extra !== undefined) {
		return { ok: false, reason: 'malformed' };
	}
	let signature: Uint8Array;
	try {
		signature = decodeTokenBytes(token);
		if (encodeTokenBytes(signature) !== token) return { ok: false, reason: 'signature-mismatch' };
	} catch {
		return { ok: false, reason: 'signature-mismatch' };
	}
	if (!(await verifyTokenBytes({ key: props.masterKey, input, signature }))) {
		return { ok: false, reason: 'signature-mismatch' };
	}
	return { ok: true };
}

function assertCredentialAudience(audience: string): void {
	if (audience.length === 0 || audience !== audience.trim() || audience.includes('\0')) {
		throw new Error('Portal credential audience must be a non-empty canonical string.');
	}
}
