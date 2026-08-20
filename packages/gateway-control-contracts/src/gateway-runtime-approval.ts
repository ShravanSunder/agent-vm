import { createHash } from 'node:crypto';

import { GatewayApprovalDecisionRequestSchema } from '@agent-vm/agent-portal-sdk';
import { GatewayStablePrincipalDigestSchema } from '@agent-vm/agent-portal-sdk/contracts';
import {
	jsonObjectSchema,
	toolPortalBackendKindSchema,
	type ToolPortalBackendKind,
} from '@agent-vm/config-contracts';
import { z } from 'zod/v4';

import {
	GatewayRuntimePortalSurfaceClassSchema,
	GatewayRuntimeTrustedInvocationContextSchema,
} from './gateway-runtime-portal-context.js';

export const GATEWAY_RUNTIME_APPROVAL_AUDIENCE = 'agent-vm-controller-approval';

export const GatewayRuntimeApprovalFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

function canonicalApprovalJson(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new TypeError('Approval fingerprint values must be finite.');
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalApprovalJson(item)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const fields = Object.entries(value)
			.filter(([, fieldValue]) => fieldValue !== undefined)
			.toSorted(([leftName], [rightName]) => leftName.localeCompare(rightName));
		return `{${fields
			.map(
				([fieldName, fieldValue]) =>
					`${JSON.stringify(fieldName)}:${canonicalApprovalJson(fieldValue)}`,
			)
			.join(',')}}`;
	}
	throw new TypeError('Approval fingerprint values must be JSON-compatible.');
}

export const GatewayRuntimeApprovalAuthorityContextSchema = z
	.object({
		controllerEpoch: z.string().min(1),
		frameworkEpoch: z.string().min(1),
		gatewayEpoch: z.string().min(1),
		runtimeEpoch: z.string().min(1),
		zoneId: z.string().min(1),
	})
	.strict();

export const GatewayRuntimeApprovalSemanticRevisionCohortSchema = z
	.object({
		activeRevision: z.string().min(1),
		bindingRevision: z.string().min(1),
		catalogRevision: z.string().min(1),
		profilePolicyRevision: z.string().min(1),
		providerRevision: z.string().min(1),
		schemaRevision: z.string().min(1),
	})
	.strict();

export const GatewayRuntimeApprovalCallSchema = z
	.object({
		arguments: jsonObjectSchema,
		id: z.string().min(1),
		name: z.string().min(1),
		namespace: z.string().min(1),
	})
	.strict();

export const GatewayRuntimeApprovalChallengeIntentSchema = z
	.object({
		backendKind: toolPortalBackendKindSchema,
		call: GatewayRuntimeApprovalCallSchema,
		operationId: z.string().uuid(),
		semanticRevisions: GatewayRuntimeApprovalSemanticRevisionCohortSchema,
		surfaceClass: GatewayRuntimePortalSurfaceClassSchema,
		trustedContext: GatewayRuntimeTrustedInvocationContextSchema,
	})
	.strict();

export const GatewayRuntimeApprovalChallengeSchema = z
	.object({
		approvalId: z.string().uuid(),
		createdAt: z.string().datetime(),
		expiresAt: z.string().datetime(),
		fingerprint: GatewayRuntimeApprovalFingerprintSchema,
		intent: GatewayRuntimeApprovalChallengeIntentSchema,
	})
	.strict();

const approvalDispatchAuthorityShape = {
	approvalId: z.string().uuid(),
	authorityContext: GatewayRuntimeApprovalAuthorityContextSchema,
	expiresAt: z.string().datetime(),
	fingerprint: GatewayRuntimeApprovalFingerprintSchema,
	operationId: z.string().uuid(),
	stablePrincipal: GatewayStablePrincipalDigestSchema,
} as const;

export const GatewayRuntimeMcpProviderDispatchReservationSchema = z
	.object({
		...approvalDispatchAuthorityShape,
		backendKind: z.literal(toolPortalBackendKindSchema.enum.mcp_provider),
		reservationId: z.string().uuid(),
	})
	.strict();

export const GatewayRuntimeControllerExecutionDispatchReservationSchema = z
	.object({
		...approvalDispatchAuthorityShape,
		backendKind: z.literal(toolPortalBackendKindSchema.enum.controller_execution),
		reservationId: z.string().uuid(),
	})
	.strict();

export const GatewayRuntimeToolVmRunnerDispatchReservationSchema = z
	.object({
		...approvalDispatchAuthorityShape,
		backendKind: z.literal(toolPortalBackendKindSchema.enum.tool_vm_runner),
		reservationId: z.string().uuid(),
	})
	.strict();

export const GatewayRuntimeApprovalDispatchReservationSchema = z.discriminatedUnion('backendKind', [
	GatewayRuntimeMcpProviderDispatchReservationSchema,
	GatewayRuntimeControllerExecutionDispatchReservationSchema,
	GatewayRuntimeToolVmRunnerDispatchReservationSchema,
]);

export const GatewayRuntimeGatewayDispatchReservationSchema = z.discriminatedUnion('backendKind', [
	GatewayRuntimeMcpProviderDispatchReservationSchema,
	GatewayRuntimeToolVmRunnerDispatchReservationSchema,
]);

export const GatewayRuntimeMcpProviderDispatchGrantSchema = z
	.object({
		...approvalDispatchAuthorityShape,
		backendKind: z.literal(toolPortalBackendKindSchema.enum.mcp_provider),
		grantId: z.string().uuid(),
	})
	.strict();

export const GatewayRuntimeToolVmRunnerDispatchGrantSchema = z
	.object({
		...approvalDispatchAuthorityShape,
		backendKind: z.literal(toolPortalBackendKindSchema.enum.tool_vm_runner),
		grantId: z.string().uuid(),
	})
	.strict();

export const GatewayRuntimeApprovalDispatchGrantSchema = z.discriminatedUnion('backendKind', [
	GatewayRuntimeMcpProviderDispatchGrantSchema,
	GatewayRuntimeToolVmRunnerDispatchGrantSchema,
]);

const directDispatchAuthorityShape = {
	fingerprint: GatewayRuntimeApprovalFingerprintSchema,
	kind: z.literal('without-approval'),
	operationId: z.string().uuid(),
} as const;

export const GatewayRuntimeMcpProviderDirectDispatchAuthoritySchema = z
	.object({
		...directDispatchAuthorityShape,
		backendKind: z.literal(toolPortalBackendKindSchema.enum.mcp_provider),
	})
	.strict();

export const GatewayRuntimeToolVmRunnerDirectDispatchAuthoritySchema = z
	.object({
		...directDispatchAuthorityShape,
		backendKind: z.literal(toolPortalBackendKindSchema.enum.tool_vm_runner),
	})
	.strict();

export const GatewayRuntimeControllerExecutionDirectDispatchAuthoritySchema = z
	.object({
		...directDispatchAuthorityShape,
		backendKind: z.literal(toolPortalBackendKindSchema.enum.controller_execution),
	})
	.strict();

export const GatewayRuntimeMcpProviderApprovalGrantDispatchAuthoritySchema = z
	.object({
		backendKind: z.literal(toolPortalBackendKindSchema.enum.mcp_provider),
		grant: GatewayRuntimeMcpProviderDispatchGrantSchema,
		kind: z.literal('approval-grant'),
	})
	.strict();

export const GatewayRuntimeToolVmRunnerApprovalGrantDispatchAuthoritySchema = z
	.object({
		backendKind: z.literal(toolPortalBackendKindSchema.enum.tool_vm_runner),
		grant: GatewayRuntimeToolVmRunnerDispatchGrantSchema,
		kind: z.literal('approval-grant'),
	})
	.strict();

export const GatewayRuntimeControllerExecutionApprovalReservationDispatchAuthoritySchema = z
	.object({
		backendKind: z.literal(toolPortalBackendKindSchema.enum.controller_execution),
		kind: z.literal('controller-approval-reservation'),
		reservation: GatewayRuntimeControllerExecutionDispatchReservationSchema,
	})
	.strict();

export const GatewayRuntimeToolPortalDispatchAuthoritySchema = z.union([
	GatewayRuntimeMcpProviderDirectDispatchAuthoritySchema,
	GatewayRuntimeToolVmRunnerDirectDispatchAuthoritySchema,
	GatewayRuntimeControllerExecutionDirectDispatchAuthoritySchema,
	GatewayRuntimeMcpProviderApprovalGrantDispatchAuthoritySchema,
	GatewayRuntimeToolVmRunnerApprovalGrantDispatchAuthoritySchema,
	GatewayRuntimeControllerExecutionApprovalReservationDispatchAuthoritySchema,
]);

export const GatewayRuntimeApprovalNotDispatchedReasonSchema = z.enum([
	'consumed-without-dispatch',
	'denied',
	'expired',
	'revoked',
	'stale-authority',
	'stale-fingerprint',
]);

export const GatewayRuntimeApprovalAmbiguousReasonSchema = z.literal('dispatch-armed');

export const GatewayRuntimeApprovalAdmissionResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			challenge: GatewayRuntimeApprovalChallengeSchema,
			kind: z.literal('approval-required'),
		})
		.strict(),
	z
		.object({
			kind: z.literal('dispatch-reserved'),
			reservation: GatewayRuntimeApprovalDispatchReservationSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('not-dispatched'),
			operationId: z.string().uuid(),
			reason: GatewayRuntimeApprovalNotDispatchedReasonSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('ambiguous'),
			operationId: z.string().uuid(),
			reason: GatewayRuntimeApprovalAmbiguousReasonSchema,
		})
		.strict(),
]);

export const GatewayRuntimeApprovalArmDispatchCommandSchema = z
	.object({
		reservation: GatewayRuntimeGatewayDispatchReservationSchema,
	})
	.strict();

export const GatewayRuntimeApprovalArmDispatchResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			grant: GatewayRuntimeApprovalDispatchGrantSchema,
			kind: z.literal('dispatch-armed'),
		})
		.strict(),
	z
		.object({
			kind: z.literal('not-dispatched'),
			operationId: z.string().uuid(),
			reason: GatewayRuntimeApprovalNotDispatchedReasonSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('ambiguous'),
			operationId: z.string().uuid(),
			reason: GatewayRuntimeApprovalAmbiguousReasonSchema,
		})
		.strict(),
]);

export const GatewayRuntimeApprovalDecisionCommandSchema = GatewayApprovalDecisionRequestSchema;

export const GatewayRuntimeApprovalRevokeCommandSchema = z
	.object({
		approvalId: z.string().uuid(),
	})
	.strict();

export type GatewayRuntimeApprovalAuthorityContext = z.infer<
	typeof GatewayRuntimeApprovalAuthorityContextSchema
>;
export type GatewayRuntimeApprovalChallengeIntent = z.infer<
	typeof GatewayRuntimeApprovalChallengeIntentSchema
>;
export type GatewayRuntimeApprovalChallenge = z.infer<typeof GatewayRuntimeApprovalChallengeSchema>;
export type GatewayRuntimeApprovalDispatchReservation = z.infer<
	typeof GatewayRuntimeApprovalDispatchReservationSchema
>;
export type GatewayRuntimeGatewayDispatchReservation = z.infer<
	typeof GatewayRuntimeGatewayDispatchReservationSchema
>;
export type GatewayRuntimeControllerExecutionDispatchReservation = z.infer<
	typeof GatewayRuntimeControllerExecutionDispatchReservationSchema
>;
export type GatewayRuntimeApprovalDispatchGrant = z.infer<
	typeof GatewayRuntimeApprovalDispatchGrantSchema
>;
export type GatewayRuntimeToolPortalDispatchAuthority = z.infer<
	typeof GatewayRuntimeToolPortalDispatchAuthoritySchema
>;
export type GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<
	TBackendKind extends ToolPortalBackendKind,
> = Extract<GatewayRuntimeToolPortalDispatchAuthority, { readonly backendKind: TBackendKind }>;
export type GatewayRuntimeApprovalAdmissionResult = z.infer<
	typeof GatewayRuntimeApprovalAdmissionResultSchema
>;
export type GatewayRuntimeApprovalArmDispatchResult = z.infer<
	typeof GatewayRuntimeApprovalArmDispatchResultSchema
>;
export type GatewayRuntimeApprovalArmDispatchCommand = z.infer<
	typeof GatewayRuntimeApprovalArmDispatchCommandSchema
>;
export type GatewayRuntimeApprovalDecisionCommand = z.infer<
	typeof GatewayRuntimeApprovalDecisionCommandSchema
>;
export type GatewayRuntimeApprovalRevokeCommand = z.infer<
	typeof GatewayRuntimeApprovalRevokeCommandSchema
>;

export function deriveGatewayRuntimeApprovalFingerprint(props: {
	readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
	readonly intent: GatewayRuntimeApprovalChallengeIntent;
}): `sha256:${string}` {
	return `sha256:${createHash('sha256').update(canonicalApprovalJson(props), 'utf8').digest('hex')}`;
}

export function deriveGatewayRuntimeApprovalId(fingerprint: `sha256:${string}`): string {
	const hexadecimal = fingerprint.slice('sha256:'.length, 'sha256:'.length + 32).split('');
	hexadecimal[12] = '5';
	const variantNibble = Number.parseInt(hexadecimal[16] ?? '0', 16);
	hexadecimal[16] = ((variantNibble & 0x3) | 0x8).toString(16);
	const value = hexadecimal.join('');
	return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
