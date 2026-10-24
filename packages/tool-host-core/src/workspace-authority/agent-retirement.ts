import { z } from 'zod';

import { agentAdmissionSchema } from '#tool-host-core/workspace-authority/models/workspace-authority-state';
import type { WorkspaceAuthorityStore } from '#tool-host-core/workspace-authority/models/workspace-authority-store';

export const agentRemovalSchema = z.strictObject({
	kind: z.enum(['pending', 'complete']),
	operation: z.enum(['unlink', 'disable']),
	requestId: z.uuid(),
});
export type AgentRemoval = z.infer<typeof agentRemovalSchema>;
interface AgentRemovalIntent {
	readonly operation: AgentRemoval['operation'];
	readonly replacesPendingRequestId?: string;
}
export interface AgentManagementAuthority {
	readonly readMembership: (clientId: string) => Promise<{ readonly persona: string } | null>;
	readonly setMembership: (clientId: string, persona: string) => Promise<void>;
	readonly readAgentRemoval: (clientId: string) => Promise<AgentRemoval | null>;
	readonly beginAgentRemoval: (
		clientId: string,
		requestId: string,
		intent: AgentRemovalIntent,
	) => Promise<AgentRemoval>;
	readonly completeAgentRemoval: (
		clientId: string,
		requestId: string,
		operation: AgentRemoval['operation'],
	) => Promise<void>;
}

/** Membership denial and pending second write commit atomically in the selected workspace. */
export function createAgentRemovalAuthority(
	store: WorkspaceAuthorityStore,
): Pick<
	AgentManagementAuthority,
	'readAgentRemoval' | 'beginAgentRemoval' | 'completeAgentRemoval'
> {
	return {
		async readAgentRemoval(clientId): Promise<AgentRemoval | null> {
			const stored = await store.read(`member-removal:${clientId}`);
			return stored === undefined ? null : agentRemovalSchema.parse(stored);
		},
		async beginAgentRemoval(clientId, requestId, intent): Promise<AgentRemoval> {
			z.string().min(1).parse(clientId);
			const { operation, replacesPendingRequestId } = intent;
			if (replacesPendingRequestId !== undefined) z.uuid().parse(replacesPendingRequestId);
			const pending = agentRemovalSchema.parse({ kind: 'pending', requestId, operation });
			return store.transaction(async (storage) => {
				const stored = await storage.read(`member-removal:${clientId}`);
				const previous = stored === undefined ? undefined : agentRemovalSchema.parse(stored);
				const replacement = replacesPendingRequestId !== undefined;
				if (
					replacement &&
					(previous?.kind !== 'pending' ||
						previous.operation !== operation ||
						previous.requestId !== replacesPendingRequestId ||
						previous.requestId === requestId)
				)
					throw new Error('Pending membership replacement conflicts');
				if (
					!replacement &&
					previous?.kind === 'pending' &&
					!(
						previous.operation === 'unlink' &&
						operation === 'disable' &&
						previous.requestId !== requestId
					) &&
					(previous.requestId !== requestId || previous.operation !== operation)
				)
					throw new Error('Pending membership operation conflicts');
				if (!replacement && previous?.requestId === requestId && previous.operation !== operation)
					throw new Error('Membership operation intent conflicts');
				if (!replacement && previous?.operation === 'disable' && previous.requestId !== requestId)
					throw new Error('Retired client cannot be changed');
				const row = await storage.read(`member:${clientId}`);
				// An absent member stays absent: removal never fabricates a persona.
				if (row !== undefined)
					await storage.write(`member:${clientId}`, {
						...agentAdmissionSchema.parse(row),
						state: 'removed',
					});
				const removal = previous?.requestId === requestId ? previous : pending;
				await storage.write(`member-removal:${clientId}`, removal);
				return removal;
			});
		},
		async completeAgentRemoval(clientId, requestId, operation): Promise<void> {
			await store.transaction(async (storage) => {
				const removal = agentRemovalSchema.parse(await storage.read(`member-removal:${clientId}`));
				if (removal.requestId !== requestId || removal.operation !== operation)
					throw new Error('Membership operation conflicts');
				const row = await storage.read(`member:${clientId}`);
				if (row !== undefined && agentAdmissionSchema.parse(row).state !== 'removed')
					throw new Error('Membership still active');
				await storage.write(`member-removal:${clientId}`, { ...removal, kind: 'complete' });
			});
		},
	};
}
