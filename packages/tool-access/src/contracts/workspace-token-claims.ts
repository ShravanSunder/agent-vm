import { z } from 'zod';

export const sessionRefSchema = z.strictObject({
	installation: z.uuid(),
	harness_endpoint: z.string().min(1),
	conversation_id: z.string().min(1),
});
export const machineEnvironmentSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('physical') }),
	z.strictObject({ kind: z.literal('cloudVm'), provider: z.string(), instance: z.string() }),
]);
export const isolationSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('host'), instance_id: z.string().min(1) }),
	z.strictObject({
		kind: z.literal('processSandbox'),
		mechanism: z.enum(['seatbelt', 'bubblewrap', 'landlock']),
		instance_id: z.string().min(1),
	}),
	z.strictObject({
		kind: z.literal('container'),
		runtime: z.string(),
		container_id: z.string(),
		instance_id: z.string().min(1),
	}),
	z.strictObject({
		kind: z.literal('vm'),
		launcher: z.literal('agent-vm'),
		vm_id: z.string(),
		instance_id: z.string().min(1),
	}),
]);
export const botPrincipalSchema = z.strictObject({ kind: z.literal('bot'), bot_id: z.uuid() });
export const principalSchema = z.discriminatedUnion('kind', [
	botPrincipalSchema,
	z.strictObject({
		kind: z.literal('fleetHarnessSession'),
		session_ref: sessionRefSchema,
		machine_environment: machineEnvironmentSchema,
		project_id: z.string().min(1),
		isolation: isolationSchema,
	}),
]);
export const personaRefSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('sessionDefault') }),
	z.strictObject({ kind: z.literal('named'), name: z.string().min(1) }),
]);
export const markSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const issuerOwnedClaimsSchema = z.looseObject({
	iss: z.url(),
	aud: z.string().min(1),
	sub: z.string().min(1),
	client_id: z.string().min(1),
	jti: z.string().min(1),
	iat: z.number().int(),
	exp: z.number().int(),
	scope: z.string(),
});
export const workspaceTokenClaimsSchema = issuerOwnedClaimsSchema
	.extend({
		principal: principalSchema,
		organization_id: z.uuid(),
		workspace_id: z.uuid(),
		persona: personaRefSchema,
		grant_revision: markSchema,
		grant_expires_at: z.number().int(),
	})
	.refine(
		(claims) => claims.principal.kind === 'fleetHarnessSession' || claims.persona.kind === 'named',
	);
export const collaborationTokenClaimsSchema = issuerOwnedClaimsSchema.extend({
	principal: botPrincipalSchema,
	organization_id: z.uuid(),
	grant_revision: markSchema,
	grant_expires_at: z.number().int(),
	workspace_id: z.never().optional(),
	persona: z.never().optional(),
});
export type Principal = z.infer<typeof principalSchema>;
export type PersonaRef = z.infer<typeof personaRefSchema>;
export type WorkspaceTokenClaims = z.infer<typeof workspaceTokenClaimsSchema>;
export type CollaborationTokenClaims = z.infer<typeof collaborationTokenClaimsSchema>;
export type Mark = z.infer<typeof markSchema>;
