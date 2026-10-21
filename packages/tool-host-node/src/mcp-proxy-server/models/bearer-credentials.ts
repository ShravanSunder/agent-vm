import { z } from 'zod';
export const TOOL_PORTAL_MCP_BEARER_AUDIENCE = 'tool-portal:mcp';
export const maximumNodeHostBearerTokenCharacters = 4_096;

const NodeHostBearerCredentialSchema = z
	.object({
		bearerToken: z.string().min(1).max(maximumNodeHostBearerTokenCharacters),
		credentialVersion: z.number().int().positive(),
		principal: z
			.object({
				agentId: z.string().min(1),
				profileAssignmentRevision: z.string().min(1),
				toolPortalProfileId: z.string().min(1),
			})
			.strict(),
	})
	.strict();

export const NodeHostBearerCredentialSetSchema = z
	.object({
		audience: z.literal(TOOL_PORTAL_MCP_BEARER_AUDIENCE),
		credentials: z.array(NodeHostBearerCredentialSchema).min(1),
		serviceGeneration: z.string().min(1),
	})
	.strict();

export type NodeHostBearerCredential = z.infer<typeof NodeHostBearerCredentialSchema>;
export type NodeHostBearerCredentialSet = z.infer<typeof NodeHostBearerCredentialSetSchema>;

export interface CompiledNodeHostCredential {
	readonly authenticatedEnvelope: NodeHostAuthenticatedEnvelope;
	readonly credentialId: string;
	readonly credentialVersion: number;
	readonly principal: NodeHostAuthenticatedPrincipal;
	readonly tokenBytes: Buffer;
}

export const NodeHostAuthenticatedPrincipalSchema = z
	.object({
		agentId: z.string().min(1),
		credentialVersion: z.number().int().positive(),
		profileAssignmentRevision: z.string().min(1),
		toolPortalProfileId: z.string().min(1),
	})
	.strict();

export type NodeHostAuthenticatedPrincipal = z.infer<typeof NodeHostAuthenticatedPrincipalSchema>;

export const NodeHostAuthenticatedEnvelopeSchema = z
	.object({
		audience: z.literal(TOOL_PORTAL_MCP_BEARER_AUDIENCE),
		principal: NodeHostAuthenticatedPrincipalSchema,
		serviceGeneration: z.string().min(1),
	})
	.strict();

export type NodeHostAuthenticatedEnvelope = z.infer<typeof NodeHostAuthenticatedEnvelopeSchema>;

export interface NodeHostCredentialSetState {
	readonly credentials: readonly CompiledNodeHostCredential[];
	readonly drainWaiters: Set<() => void>;
	inFlightRequests: number;
	readonly identity: string;
}

export interface NodeHostFixedCredentialPrincipal {
	readonly agentId: string;
	readonly profileAssignmentRevision: string;
	readonly toolPortalProfileId: string;
}
