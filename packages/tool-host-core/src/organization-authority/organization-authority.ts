import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { z } from 'zod';

import type { OrganizationAuthorizationPort } from '#tool-host-core/hosted-mcp-proxy/models/hosted-mcp-proxy-ports';
import {
	agentAdmissionRow,
	isStoredAgentListed,
} from '#tool-host-core/organization-authority/agent-admission-rules';
import {
	createAgentRetirementAuthority,
	type AgentManagementAuthority,
} from '#tool-host-core/organization-authority/agent-retirement';
import { decideApprovalTokenUse } from '#tool-host-core/organization-authority/approval-token-use-rules';
import type { Clock } from '#tool-host-core/organization-authority/models/authority-clock';
import { approvalUsesKey } from '#tool-host-core/organization-authority/models/organization-authority-state';
import type { OrganizationAuthorityStore } from '#tool-host-core/organization-authority/models/organization-authority-store';

export function createOrganizationAuthority(props: {
	readonly store: OrganizationAuthorityStore;
	readonly clock: Pick<Clock, 'nowMs'>;
	readonly cap: number;
}): OrganizationAuthorizationPort & AgentManagementAuthority {
	return {
		...createAgentRetirementAuthority(props.store),
		isAgentListed: async (agentClientId) =>
			isStoredAgentListed(await props.store.read(`agent:${agentClientId}`)),
		setAgentAdmission: async (agentClientId, state) => {
			const row = agentAdmissionRow({ agentClientId, state });
			await props.store.transaction(async (storage) => {
				if (
					state === 'listed' &&
					(await storage.read(`agent-retirement:${agentClientId}`)) !== undefined
				)
					throw new Error('Retired agent cannot be admitted');
				await storage.write(row.key, row.value);
			});
		},
		consumeApprovalToken: async (tokenId, expiresAtMs): Promise<ConsumeApprovalTokenResult> => {
			z.string().min(1).parse(tokenId);
			z.number().finite().parse(expiresAtMs);
			return props.store.transaction(async (storage): Promise<ConsumeApprovalTokenResult> => {
				// Read the clock inside the transaction, before reading the row, exactly as on the host.
				const nowMs = props.clock.nowMs();
				const stored = await storage.read(approvalUsesKey);
				const decision = decideApprovalTokenUse({
					state: stored,
					tokenId,
					expiresAtMs,
					nowMs,
					cap: props.cap,
				});
				if ('next' in decision) await storage.write(approvalUsesKey, decision.next);
				return decision.result;
			});
		},
	};
}
