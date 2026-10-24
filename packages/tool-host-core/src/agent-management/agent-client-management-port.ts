import { z } from 'zod';

export const personOperationContextSchema = z.strictObject({
	token: z.string().min(1),
	requestId: z.uuid(),
	organizationId: z.uuid(),
});
export const workspaceOperationContextSchema = personOperationContextSchema.extend({
	workspaceId: z.uuid(),
});
export const workspaceClientOperationSchema = workspaceOperationContextSchema.extend({
	clientId: z.string().min(1),
});
export const clientRetirementOperationSchema = personOperationContextSchema.extend({
	clientId: z.string().min(1),
});
export type PersonOperationContext = z.infer<typeof personOperationContextSchema>;
export type WorkspaceOperationContext = z.infer<typeof workspaceOperationContextSchema>;
export type WorkspaceClientOperation = z.infer<typeof workspaceClientOperationSchema>;
export type ClientRetirementOperation = z.infer<typeof clientRetirementOperationSchema>;

export const managementFailureSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('incomplete'), clientId: z.string().min(1) }),
	z.strictObject({
		kind: z.literal('refused'),
		reason: z.enum([
			'not-owner',
			'foreign-organization',
			'invalid-client',
			'resource-conflict',
			'operation-conflict',
			'human-check-not-implemented',
		]),
	}),
]);
export type ManagementFailure = z.infer<typeof managementFailureSchema>;
const workspaceClientResultSchema = z.strictObject({
	clientId: z.string().min(1),
	workspaceId: z.uuid(),
	resource: z.url(),
});
export const registerAndLinkResultSchema = z.union([
	workspaceClientResultSchema.extend({
		kind: z.literal('registered'),
		clientSecret: z.string().min(1),
	}),
	managementFailureSchema,
]);
export const linkResultSchema = z.union([
	workspaceClientResultSchema.extend({ kind: z.literal('linked') }),
	managementFailureSchema,
]);
export const unlinkResultSchema = z.union([
	workspaceClientResultSchema.extend({ kind: z.literal('unlinked') }),
	managementFailureSchema,
]);
export const disableResultSchema = z.union([
	z.strictObject({ kind: z.literal('disabled'), clientId: z.string().min(1) }),
	managementFailureSchema,
]);
export type RegisterAndLinkResult = z.infer<typeof registerAndLinkResultSchema>;
export type LinkResult = z.infer<typeof linkResultSchema>;
export type UnlinkResult = z.infer<typeof unlinkResultSchema>;
export type DisableResult = z.infer<typeof disableResultSchema>;

/** Each mutation verifies the original Person token and a fresh live owner session in sign-in. */
export interface AgentClientManagementPort {
	readonly humanCheckStatus: () => Promise<
		| { readonly kind: 'ready'; readonly level: 'remembered-login' }
		| {
				readonly kind: 'not-implemented';
				readonly level: 'fresh-verified-uv' | 'exact-operation-binding';
		  }
	>;
	readonly isLiveOwner: (props: {
		readonly token: string;
		readonly organizationId: string;
	}) => Promise<boolean>;
	readonly ownsAgentClient: (props: {
		readonly token: string;
		readonly organizationId: string;
		readonly clientId: string;
	}) => Promise<boolean>;
	readonly registerAndLink: (props: WorkspaceOperationContext) => Promise<RegisterAndLinkResult>;
	readonly link: (props: WorkspaceClientOperation) => Promise<LinkResult>;
	readonly unlink: (props: WorkspaceClientOperation) => Promise<UnlinkResult>;
	readonly disable: (props: ClientRetirementOperation) => Promise<DisableResult>;
}
