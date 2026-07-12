import { createHmac } from 'node:crypto';

import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayControlCallerContextAgentAuthority,
	type GatewayControlCallerContextProof,
	type GatewayControlCallerContextProofPayloadInput,
} from '@agent-vm/gateway-control-contracts';

export function signGatewayControlCallerContextProof(options: {
	readonly input: GatewayControlCallerContextProofPayloadInput;
	readonly proofKey: string;
}): GatewayControlCallerContextProof {
	return {
		algorithm: 'hmac-sha256',
		digest: createHmac('sha256', options.proofKey)
			.update(buildGatewayControlCallerContextProofPayload(options.input), 'utf8')
			.digest('base64url'),
	};
}

export function signGatewayControlCallerContextAgentAuthority(options: {
	readonly input: GatewayControlCallerContextProofPayloadInput;
	readonly keyId: string;
	readonly key: string;
}): GatewayControlCallerContextAgentAuthority {
	return {
		algorithm: 'hmac-sha256',
		digest: createHmac('sha256', options.key)
			.update(buildGatewayControlCallerContextAgentAuthorityPayload(options.input), 'utf8')
			.digest('base64url'),
		keyId: options.keyId,
	};
}
