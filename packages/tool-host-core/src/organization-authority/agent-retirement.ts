import { z } from 'zod';

import type { OrganizationAuthorityStore } from '#tool-host-core/organization-authority/models/organization-authority-store';

const agentRetirementSchema = z.strictObject({
	kind: z.enum(['pending', 'complete']),
	requestId: z.uuid(),
});
export type AgentRetirement = z.infer<typeof agentRetirementSchema>;

export interface AgentManagementAuthority {
	readonly isAgentListed: (clientId: string) => Promise<boolean>;
	readonly setAgentAdmission: (clientId: string, state: 'listed' | 'removed') => Promise<void>;
	readonly readAgentRetirement: (clientId: string) => Promise<AgentRetirement | null>;
	readonly beginAgentRetirement: (clientId: string, requestId: string) => Promise<AgentRetirement>;
	readonly completeAgentRetirement: (clientId: string) => Promise<void>;
}

export function createAgentRetirementAuthority(
	store: OrganizationAuthorityStore,
): Pick<
	AgentManagementAuthority,
	'readAgentRetirement' | 'beginAgentRetirement' | 'completeAgentRetirement'
> {
	return {
		async readAgentRetirement(clientId): Promise<AgentRetirement | null> {
			const stored = await store.read(`agent-retirement:${clientId}`);
			return stored === undefined ? null : agentRetirementSchema.parse(stored);
		},
		async beginAgentRetirement(clientId, requestId): Promise<AgentRetirement> {
			z.string().min(1).parse(clientId);
			const pending = agentRetirementSchema.parse({ kind: 'pending', requestId });
			return store.transaction(async (storage) => {
				const stored = await storage.read(`agent-retirement:${clientId}`);
				const retirement = stored === undefined ? pending : agentRetirementSchema.parse(stored);
				// Pending status and removal commit together; a failed commit leaves both unchanged.
				await storage.write(`agent:${clientId}`, { state: 'removed' });
				await storage.write(`agent-retirement:${clientId}`, retirement);
				return retirement;
			});
		},
		async completeAgentRetirement(clientId): Promise<void> {
			await store.transaction(async (storage) => {
				const retirement = agentRetirementSchema.parse(
					await storage.read(`agent-retirement:${clientId}`),
				);
				const admission = z
					.strictObject({ state: z.literal('removed') })
					.parse(await storage.read(`agent:${clientId}`));
				await storage.write(`agent:${clientId}`, admission);
				await storage.write(`agent-retirement:${clientId}`, { ...retirement, kind: 'complete' });
			});
		},
	};
}
