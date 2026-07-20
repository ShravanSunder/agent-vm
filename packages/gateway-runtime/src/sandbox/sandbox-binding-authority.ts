import { JsonObjectSchema } from '@agent-vm/agent-portal-sdk';
import type { GatewayRuntimeTrustedInvocationContext } from '@agent-vm/gateway-control-contracts';
import { z } from 'zod';

const GatewayRuntimeSandboxPublicRequestSchema = z
	.object({
		arguments: JsonObjectSchema,
		kind: z.string().min(1),
	})
	.strict();

export interface GatewayRuntimeSandboxTrustedInvocation {
	readonly backendBindingId: string;
	readonly environmentGeneration: string;
	readonly principal: GatewayRuntimeTrustedInvocationContext['principal'];
}

export interface GatewayRuntimeSandboxBindingDenial {
	readonly kind: 'denied';
	readonly reason: 'public-authority-selector';
}

export interface GatewayRuntimeSandboxBindingAdmission<TAdmission> {
	readonly admission: TAdmission;
	readonly kind: 'admitted';
}

export type GatewayRuntimeSandboxBindingDecision<TAdmission> =
	| GatewayRuntimeSandboxBindingAdmission<TAdmission>
	| GatewayRuntimeSandboxBindingDenial;

export interface GatewayRuntimeSandboxBinding<TAdmission> {
	readonly authorize: (options: {
		readonly publicInput: unknown;
		readonly trustedInvocation: GatewayRuntimeSandboxTrustedInvocation;
	}) => GatewayRuntimeSandboxBindingDecision<TAdmission>;
}

export function createGatewayRuntimeSandboxBinding<TAdmission>(options: {
	readonly admitTrustedBinding: (invocation: GatewayRuntimeSandboxTrustedInvocation) => TAdmission;
}): GatewayRuntimeSandboxBinding<TAdmission> {
	return {
		authorize: (authorizationOptions) => {
			if (
				!GatewayRuntimeSandboxPublicRequestSchema.safeParse(authorizationOptions.publicInput)
					.success
			) {
				return { kind: 'denied', reason: 'public-authority-selector' };
			}
			return {
				admission: options.admitTrustedBinding(authorizationOptions.trustedInvocation),
				kind: 'admitted',
			};
		},
	};
}
