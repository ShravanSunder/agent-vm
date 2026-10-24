import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { z } from 'zod';

import type { WorkspaceAuthorizationPort } from '#tool-host-core/hosted-mcp-proxy/models/hosted-mcp-proxy-ports';
import { decideApprovalTokenUse } from '#tool-host-core/workspace-authority/approval-token-use-rules';
import type { Clock } from '#tool-host-core/workspace-authority/models/authority-clock';
import { approvalUsesKey } from '#tool-host-core/workspace-authority/models/workspace-authority-state';
import type { WorkspaceAuthorityStore } from '#tool-host-core/workspace-authority/models/workspace-authority-store';
import {
	createWorkspaceRemovalAuthority,
	type WorkspaceRemovalAuthority,
} from '#tool-host-core/workspace-authority/removal-notice-store';

export function createWorkspaceAuthority(props: {
	readonly store: WorkspaceAuthorityStore;
	readonly clock: Pick<Clock, 'nowMs'>;
	readonly cap: number;
}): WorkspaceAuthorizationPort & WorkspaceRemovalAuthority {
	return {
		...createWorkspaceRemovalAuthority(props),
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
