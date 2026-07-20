import {
	CapabilityReferenceSchema,
	GatewayRuntimeTrustedInvocationPrincipalSchema,
} from '@agent-vm/agent-portal-sdk';
import {
	GatewayRuntimePortalSurfaceClassSchema,
	GatewayRuntimeTrustedInvocationContextSchema,
	deriveGatewayControlStablePrincipal,
} from '@agent-vm/gateway-control-contracts';
import { z } from 'zod';

export const GatewayRuntimeArtifactStablePrincipalSchema =
	GatewayRuntimeTrustedInvocationPrincipalSchema;

export const GatewayRuntimeArtifactAuthorizationSchema =
	GatewayRuntimeArtifactStablePrincipalSchema.extend({
		capability: CapabilityReferenceSchema,
		executionFingerprint: z.string().min(1),
		operationId: z.string().min(1),
		owningGeneration: z.string().min(1),
		surfaceClass: GatewayRuntimePortalSurfaceClassSchema,
	}).strict();

const GatewayRuntimeArtifactMcpReadCallerSchema = z
	.object({
		principal: GatewayRuntimeArtifactStablePrincipalSchema,
		surfaceClass: z.literal('mcp'),
	})
	.strict();

const GatewayRuntimeArtifactProtectedUdsReadCallerSchema = z
	.object({
		principal: GatewayRuntimeArtifactStablePrincipalSchema,
		surfaceClass: z.literal('protected_uds'),
	})
	.strict();

export const GatewayRuntimeArtifactReadCallerSchema = z.discriminatedUnion('surfaceClass', [
	GatewayRuntimeArtifactMcpReadCallerSchema,
	GatewayRuntimeArtifactProtectedUdsReadCallerSchema,
]);

export const GatewayRuntimeArtifactCurrentAuthorityDecisionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('current') }).strict(),
	z
		.object({
			kind: z.literal('retired'),
			reason: z.enum([
				'capability',
				'execution-fingerprint',
				'operation',
				'owning-generation',
				'unregistered',
			]),
		})
		.strict(),
]);

export const GatewayRuntimeArtifactAuthorityRetirementSchema = z.discriminatedUnion('kind', [
	z
		.object({
			capability: CapabilityReferenceSchema,
			kind: z.literal('capability'),
		})
		.strict(),
	z
		.object({
			executionFingerprint: z.string().min(1),
			kind: z.literal('execution-fingerprint'),
		})
		.strict(),
	z
		.object({
			kind: z.literal('operation'),
			operationId: z.string().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal('owning-generation'),
			owningGeneration: z.string().min(1),
		})
		.strict(),
]);

export const GatewayRuntimeArtifactReadAuthorityDecisionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('authorized') }).strict(),
	z
		.object({
			kind: z.literal('denied'),
			reason: z.enum(['current-authority', 'principal', 'surface']),
		})
		.strict(),
]);

export type GatewayRuntimeArtifactStablePrincipal = z.infer<
	typeof GatewayRuntimeArtifactStablePrincipalSchema
>;
export type GatewayRuntimeArtifactAuthorization = z.infer<
	typeof GatewayRuntimeArtifactAuthorizationSchema
>;
export type GatewayRuntimeArtifactReadCaller = z.infer<
	typeof GatewayRuntimeArtifactReadCallerSchema
>;
export type GatewayRuntimeArtifactMcpReadCaller = z.infer<
	typeof GatewayRuntimeArtifactMcpReadCallerSchema
>;
export type GatewayRuntimeArtifactProtectedUdsReadCaller = z.infer<
	typeof GatewayRuntimeArtifactProtectedUdsReadCallerSchema
>;
export type GatewayRuntimeArtifactCurrentAuthorityDecision = z.infer<
	typeof GatewayRuntimeArtifactCurrentAuthorityDecisionSchema
>;
export type GatewayRuntimeArtifactAuthorityRetirement = z.infer<
	typeof GatewayRuntimeArtifactAuthorityRetirementSchema
>;
export type GatewayRuntimeArtifactReadAuthorityDecision = z.infer<
	typeof GatewayRuntimeArtifactReadAuthorityDecisionSchema
>;

export interface GatewayRuntimeArtifactCurrentAuthority {
	readonly authorizeStoredArtifact: (
		authorization: GatewayRuntimeArtifactAuthorization,
	) => GatewayRuntimeArtifactCurrentAuthorityDecision;
}

export interface GatewayRuntimeArtifactReadAuthorityResolver {
	readonly authorize: (props: {
		readonly caller: GatewayRuntimeArtifactReadCaller;
		readonly storedAuthorization: GatewayRuntimeArtifactAuthorization;
	}) => GatewayRuntimeArtifactReadAuthorityDecision;
}

type GatewayRuntimeArtifactAuthorityRetirementReason = Exclude<
	GatewayRuntimeArtifactCurrentAuthorityDecision,
	{ readonly kind: 'current' }
>['reason'];

export type GatewayRuntimeArtifactAuthorityRegistrationResult =
	| { readonly kind: 'registered' }
	| {
			readonly kind: 'rejected';
			readonly reason: Exclude<GatewayRuntimeArtifactAuthorityRetirementReason, 'unregistered'>;
	  };

export interface GatewayRuntimeArtifactCurrentAuthorityRegistry {
	readonly currentAuthority: GatewayRuntimeArtifactCurrentAuthority;
	readonly register: (
		authorization: GatewayRuntimeArtifactAuthorization,
	) => GatewayRuntimeArtifactAuthorityRegistrationResult;
	readonly retire: (retirement: GatewayRuntimeArtifactAuthorityRetirement) => {
		readonly affectedAuthorizationCount: number;
		readonly kind: 'retired';
	};
}

function capabilityKey(capability: GatewayRuntimeArtifactAuthorization['capability']): string {
	return JSON.stringify([capability.namespace, capability.name] satisfies readonly string[]);
}

function authorizationKey(authorization: GatewayRuntimeArtifactAuthorization): string {
	return JSON.stringify([
		deriveGatewayControlStablePrincipal({ principal: authorization }),
		authorization.capability.namespace,
		authorization.capability.name,
		authorization.executionFingerprint,
		authorization.operationId,
		authorization.owningGeneration,
		authorization.surfaceClass,
	] satisfies readonly string[]);
}

/** Track the exact live authority scopes that may still authorize stored artifact bytes. */
export function createGatewayRuntimeArtifactCurrentAuthorityRegistry(): GatewayRuntimeArtifactCurrentAuthorityRegistry {
	const activeAuthorizations = new Map<string, GatewayRuntimeArtifactAuthorization>();
	const retiredCapabilities = new Set<string>();
	const retiredExecutionFingerprints = new Set<string>();
	const retiredOperations = new Set<string>();
	const retiredOwningGenerations = new Set<string>();

	function retirementReason(
		authorization: GatewayRuntimeArtifactAuthorization,
	): Exclude<GatewayRuntimeArtifactAuthorityRetirementReason, 'unregistered'> | null {
		if (retiredCapabilities.has(capabilityKey(authorization.capability))) return 'capability';
		if (retiredExecutionFingerprints.has(authorization.executionFingerprint)) {
			return 'execution-fingerprint';
		}
		if (retiredOperations.has(authorization.operationId)) return 'operation';
		if (retiredOwningGenerations.has(authorization.owningGeneration)) {
			return 'owning-generation';
		}
		return null;
	}

	function register(
		unparsedAuthorization: GatewayRuntimeArtifactAuthorization,
	): GatewayRuntimeArtifactAuthorityRegistrationResult {
		const authorization = GatewayRuntimeArtifactAuthorizationSchema.parse(unparsedAuthorization);
		const reason = retirementReason(authorization);
		if (reason !== null) return { kind: 'rejected', reason };
		activeAuthorizations.set(authorizationKey(authorization), authorization);
		return { kind: 'registered' };
	}

	function retire(unparsedRetirement: GatewayRuntimeArtifactAuthorityRetirement): {
		readonly affectedAuthorizationCount: number;
		readonly kind: 'retired';
	} {
		const retirement = GatewayRuntimeArtifactAuthorityRetirementSchema.parse(unparsedRetirement);
		switch (retirement.kind) {
			case 'capability':
				retiredCapabilities.add(capabilityKey(retirement.capability));
				break;
			case 'execution-fingerprint':
				retiredExecutionFingerprints.add(retirement.executionFingerprint);
				break;
			case 'operation':
				retiredOperations.add(retirement.operationId);
				break;
			case 'owning-generation':
				retiredOwningGenerations.add(retirement.owningGeneration);
				break;
		}
		let affectedAuthorizationCount = 0;
		for (const [key, authorization] of activeAuthorizations) {
			if (retirementReason(authorization) === null) continue;
			activeAuthorizations.delete(key);
			affectedAuthorizationCount += 1;
		}
		return { affectedAuthorizationCount, kind: 'retired' };
	}

	return {
		currentAuthority: {
			authorizeStoredArtifact: (unparsedAuthorization) => {
				const authorization =
					GatewayRuntimeArtifactAuthorizationSchema.parse(unparsedAuthorization);
				const reason = retirementReason(authorization);
				if (reason !== null) return { kind: 'retired', reason };
				return activeAuthorizations.has(authorizationKey(authorization))
					? { kind: 'current' }
					: { kind: 'retired', reason: 'unregistered' };
			},
		},
		register,
		retire,
	};
}

export function gatewayRuntimeArtifactStablePrincipalFromTrustedContext(
	trustedContext: z.input<typeof GatewayRuntimeTrustedInvocationContextSchema>,
): GatewayRuntimeArtifactStablePrincipal {
	const parsedContext = GatewayRuntimeTrustedInvocationContextSchema.parse(trustedContext);
	return GatewayRuntimeArtifactStablePrincipalSchema.parse(parsedContext.principal);
}

function stablePrincipalsMatch(
	left: GatewayRuntimeArtifactStablePrincipal,
	right: GatewayRuntimeArtifactStablePrincipal,
): boolean {
	return (
		deriveGatewayControlStablePrincipal({ principal: left }) ===
		deriveGatewayControlStablePrincipal({ principal: right })
	);
}

/** Combine immutable artifact provenance with required live authority before byte access. */
export function createGatewayRuntimeArtifactReadAuthorityResolver(props: {
	readonly currentAuthority: GatewayRuntimeArtifactCurrentAuthority;
}): GatewayRuntimeArtifactReadAuthorityResolver {
	return {
		authorize: (authorizationProps) => {
			const caller = GatewayRuntimeArtifactReadCallerSchema.parse(authorizationProps.caller);
			const storedAuthorization = GatewayRuntimeArtifactAuthorizationSchema.parse(
				authorizationProps.storedAuthorization,
			);
			if (caller.surfaceClass !== storedAuthorization.surfaceClass) {
				return { kind: 'denied', reason: 'surface' };
			}
			if (!stablePrincipalsMatch(caller.principal, storedAuthorization)) {
				return { kind: 'denied', reason: 'principal' };
			}
			const currentDecision = GatewayRuntimeArtifactCurrentAuthorityDecisionSchema.parse(
				props.currentAuthority.authorizeStoredArtifact(storedAuthorization),
			);
			return currentDecision.kind === 'current'
				? { kind: 'authorized' }
				: { kind: 'denied', reason: 'current-authority' };
		},
	};
}
