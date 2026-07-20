import { z } from 'zod';

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

export const gatewayEpochSeedSchema = z.strictObject({
	bootId: boundedTextSchema,
	controllerEpoch: boundedTextSchema,
	gatewayEpochId: boundedIdentitySchema,
	generationId: boundedTextSchema,
	zoneId: boundedTextSchema,
});

export type GatewayEpochSeed = z.infer<typeof gatewayEpochSeedSchema>;

export const gatewayEpochIdentitySchema = gatewayEpochSeedSchema.extend({
	gatewayVmId: boundedIdentitySchema,
});

export type GatewayEpochIdentity = z.infer<typeof gatewayEpochIdentitySchema>;

export const stableAgentIdentitySchema = z.strictObject({
	agentId: boundedTextSchema,
	zoneId: boundedTextSchema,
});

export type StableAgentIdentity = z.infer<typeof stableAgentIdentitySchema>;

export const vmOwnershipDeploymentIdentitySchema = z.strictObject({
	configPath: absoluteOwnedPathSchema,
	controllerPort: z.number().int().min(1).max(65_535),
	projectNamespace: boundedTextSchema,
});

export type VmOwnershipDeploymentIdentity = z.infer<typeof vmOwnershipDeploymentIdentitySchema>;

export type GatewayMembershipState = 'seeded' | 'admitting' | 'sealed' | 'retired' | 'owner-unsafe';

export type ToolVmMembershipState =
	| 'provisional'
	| 'current'
	| 'destroying'
	| 'retiring'
	| 'destroyed'
	| 'owner-unsafe';

export interface ToolVmMembershipSnapshot {
	readonly agentId: string;
	readonly leafId: string;
	readonly state: ToolVmMembershipState;
	readonly toolVmId?: string;
}

export interface GatewayMembershipSnapshot {
	readonly children: readonly ToolVmMembershipSnapshot[];
	readonly identity?: GatewayEpochIdentity;
	readonly seed: GatewayEpochSeed;
	readonly state: GatewayMembershipState;
}

export function gatewaySeedsEqual(left: GatewayEpochSeed, right: GatewayEpochSeed): boolean {
	return (
		left.bootId === right.bootId &&
		left.controllerEpoch === right.controllerEpoch &&
		left.gatewayEpochId === right.gatewayEpochId &&
		left.generationId === right.generationId &&
		left.zoneId === right.zoneId
	);
}

export function gatewayIdentitiesEqual(
	left: GatewayEpochIdentity,
	right: GatewayEpochIdentity,
): boolean {
	return gatewaySeedsEqual(left, right) && left.gatewayVmId === right.gatewayVmId;
}
