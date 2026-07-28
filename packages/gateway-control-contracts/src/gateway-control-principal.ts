import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
	type GatewayRuntimeTrustedInvocationPrincipal,
	type GatewayStablePrincipalDigest,
	GatewayStablePrincipalDigestSchema,
} from '@agent-vm/agent-portal-sdk/contracts';

function lengthPrefixedUtf8(value: string): string {
	return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function canonicalStablePrincipalMaterial(
	principal: GatewayRuntimeTrustedInvocationPrincipal,
): string {
	const frameworkIdentityValue =
		principal.frameworkIdentity.kind === 'openclaw'
			? principal.frameworkIdentity.agentId
			: principal.frameworkIdentity.profileName;
	return [
		principal.agentId,
		principal.frameworkIdentity.kind,
		frameworkIdentityValue,
		principal.toolPortalProfileId,
		principal.profileAssignmentRevision,
	]
		.map(lengthPrefixedUtf8)
		.join('');
}

export function deriveGatewayControlStablePrincipal(options: {
	readonly principal: GatewayRuntimeTrustedInvocationPrincipal;
}): GatewayStablePrincipalDigest {
	return GatewayStablePrincipalDigestSchema.parse(
		createHash('sha256')
			.update('agent-vm-gateway-stable-principal-v4', 'utf8')
			.update('\0')
			.update(canonicalStablePrincipalMaterial(options.principal), 'utf8')
			.digest('hex'),
	);
}
