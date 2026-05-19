import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface DeriveAgentBearerTokenProps {
	readonly agentId: string;
	readonly masterKey: Buffer;
}

export interface VerifyAgentBearerAuthorizationProps extends DeriveAgentBearerTokenProps {
	readonly authorizationHeader: string | undefined;
}

export type VerifyAgentBearerAuthorizationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: 'malformed' | 'missing' | 'signature-mismatch' };

const bearerPurposePrefix = 'mcp-proxy:agent:';
const minimumMasterKeyBytes = 32;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

export function decodePortalMasterKey(encodedMasterKey: string): Buffer {
	const trimmedMasterKey = encodedMasterKey.trim();
	if (!base64UrlPattern.test(trimmedMasterKey)) {
		throw new Error('MCP Portal masterKey must be base64url-encoded key material.');
	}
	const masterKey = Buffer.from(trimmedMasterKey, 'base64url');
	if (masterKey.length < minimumMasterKeyBytes) {
		throw new Error(
			`MCP Portal masterKey must decode to at least ${String(minimumMasterKeyBytes)} bytes.`,
		);
	}
	if (masterKey.toString('base64url') !== trimmedMasterKey) {
		throw new Error('MCP Portal masterKey must be canonical base64url without padding.');
	}
	return masterKey;
}

export function deriveAgentBearerToken(props: DeriveAgentBearerTokenProps): string {
	return createHmac('sha256', props.masterKey)
		.update(`${bearerPurposePrefix}${props.agentId}`)
		.digest('base64url');
}

export function formatMasterKeyFingerprint(masterKey: Buffer): string {
	return `sha256:${createHash('sha256').update(masterKey).digest('base64url')}`;
}

function timingSafeEqualToken(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyAgentBearerAuthorization(
	props: VerifyAgentBearerAuthorizationProps,
): VerifyAgentBearerAuthorizationResult {
	if (props.authorizationHeader === undefined) {
		return { ok: false, reason: 'missing' };
	}
	const [scheme, token, extra] = props.authorizationHeader.split(/\s+/u);
	if (scheme !== 'Bearer' || token === undefined || token.length === 0 || extra !== undefined) {
		return { ok: false, reason: 'malformed' };
	}
	const expectedToken = deriveAgentBearerToken({
		agentId: props.agentId,
		masterKey: props.masterKey,
	});
	if (!timingSafeEqualToken(token, expectedToken)) {
		return { ok: false, reason: 'signature-mismatch' };
	}
	return { ok: true };
}
