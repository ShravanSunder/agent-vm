import { createHmac } from 'node:crypto';

import {
	buildGatewayControlCallerContextProofPayload,
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
