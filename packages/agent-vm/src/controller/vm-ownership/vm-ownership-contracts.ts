import { z } from 'zod';

export const VM_OWNERSHIP_MEMBERSHIP_SCHEMA_VERSION = 1 as const;

const boundedIdentitySchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const boundedTextSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine((value) => !value.includes('\0'));
const absoluteOwnedPathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => value.startsWith('/') && !value.includes('\0'));

export const gatewayEpochIdentitySchema = z.strictObject({
	bootId: boundedTextSchema,
	controllerEpoch: boundedTextSchema,
	gatewayEpochId: boundedIdentitySchema,
	gatewayVmId: boundedIdentitySchema,
	generationId: boundedTextSchema,
	zoneId: boundedTextSchema,
});

export type GatewayEpochIdentity = z.infer<typeof gatewayEpochIdentitySchema>;

export const gatewayZonePrincipalSchema = z.strictObject({
	kind: z.literal('gateway-zone'),
	zoneId: boundedTextSchema,
});

export const stableAgentPrincipalSchema = z.strictObject({
	agentId: boundedTextSchema,
	kind: z.literal('stable-agent'),
	zoneId: boundedTextSchema,
});

export const workerTaskPrincipalSchema = z.strictObject({
	kind: z.literal('worker-task'),
	taskId: boundedTextSchema,
	zoneId: boundedTextSchema,
});

export const vmOwnershipPrincipalSchema = z.discriminatedUnion('kind', [
	gatewayZonePrincipalSchema,
	stableAgentPrincipalSchema,
	workerTaskPrincipalSchema,
]);

export type VmOwnershipPrincipal = z.infer<typeof vmOwnershipPrincipalSchema>;

export const parentGatewayIdentitySchema = gatewayEpochIdentitySchema.pick({
	gatewayEpochId: true,
	gatewayVmId: true,
});

const baseReservationReferenceShape = {
	controllerEpoch: boundedTextSchema,
	expectedRevision: z.number().int().positive(),
	reservationId: boundedIdentitySchema,
	reservationPath: absoluteOwnedPathSchema,
	vmId: boundedIdentitySchema,
};

export const gatewayOwnershipReservationReferenceSchema = z.strictObject({
	...baseReservationReferenceShape,
	parentGateway: z.null(),
	principal: gatewayZonePrincipalSchema,
	role: z.literal('gateway'),
});

export type GatewayOwnershipReservationReference = z.infer<
	typeof gatewayOwnershipReservationReferenceSchema
>;

export const toolVmOwnershipReservationReferenceSchema = z.strictObject({
	...baseReservationReferenceShape,
	parentGateway: parentGatewayIdentitySchema,
	principal: stableAgentPrincipalSchema,
	role: z.literal('tool'),
});

export type ToolVmOwnershipReservationReference = z.infer<
	typeof toolVmOwnershipReservationReferenceSchema
>;

export const standaloneVmOwnershipReservationReferenceSchema = z.strictObject({
	...baseReservationReferenceShape,
	parentGateway: z.null(),
	principal: workerTaskPrincipalSchema,
	role: z.literal('standalone'),
});

export type StandaloneVmOwnershipReservationReference = z.infer<
	typeof standaloneVmOwnershipReservationReferenceSchema
>;

export const vmOwnershipReservationReferenceSchema = z.discriminatedUnion('role', [
	gatewayOwnershipReservationReferenceSchema,
	toolVmOwnershipReservationReferenceSchema,
	standaloneVmOwnershipReservationReferenceSchema,
]);

export type VmOwnershipReservationReference = z.infer<typeof vmOwnershipReservationReferenceSchema>;

export const gatewayMembershipStateSchema = z.enum([
	'admitting',
	'sealed',
	'destroying',
	'destroyed',
	'owner-unsafe',
]);

export type GatewayMembershipState = z.infer<typeof gatewayMembershipStateSchema>;

export const childMembershipStateSchema = z.enum([
	'provisional',
	'current',
	'destroying',
	'destroyed',
	'owner-unsafe',
]);

export type ChildMembershipState = z.infer<typeof childMembershipStateSchema>;

export const ownershipDispositionReasonSchema = z.enum([
	'exact-destroy-incomplete',
	'exact-destroy-unavailable',
	'reservation-revision-mismatch',
	'ownership-link-mismatch',
]);

export type OwnershipDispositionReason = z.infer<typeof ownershipDispositionReasonSchema>;

export const toolVmChildMembershipSchema = toolVmOwnershipReservationReferenceSchema.extend({
	dispositionReason: ownershipDispositionReasonSchema.optional(),
	observedReservationRevision: z.number().int().positive(),
	state: childMembershipStateSchema,
});

export type ToolVmChildMembership = z.infer<typeof toolVmChildMembershipSchema>;

export const gatewayMembershipRecordSchema = z.strictObject({
	children: z.array(toolVmChildMembershipSchema),
	controllerEpoch: boundedTextSchema,
	createdAtMs: z.number().int().nonnegative(),
	gateway: gatewayEpochIdentitySchema,
	gatewayReservation: gatewayOwnershipReservationReferenceSchema,
	revision: z.number().int().positive(),
	schemaVersion: z.literal(VM_OWNERSHIP_MEMBERSHIP_SCHEMA_VERSION),
	state: gatewayMembershipStateSchema,
	updatedAtMs: z.number().int().nonnegative(),
});

export type GatewayMembershipRecord = z.infer<typeof gatewayMembershipRecordSchema>;

export function stablePrincipalKey(principal: z.infer<typeof stableAgentPrincipalSchema>): string {
	return `${principal.zoneId}\0${principal.agentId}`;
}

export function gatewayIdentitiesEqual(
	left: GatewayEpochIdentity,
	right: GatewayEpochIdentity,
): boolean {
	return (
		left.bootId === right.bootId &&
		left.controllerEpoch === right.controllerEpoch &&
		left.gatewayEpochId === right.gatewayEpochId &&
		left.gatewayVmId === right.gatewayVmId &&
		left.generationId === right.generationId &&
		left.zoneId === right.zoneId
	);
}
