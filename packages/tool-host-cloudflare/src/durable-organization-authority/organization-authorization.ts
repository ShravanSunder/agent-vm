import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { createOrganizationAuthority } from '@agent-collaboration/tool-host-core';
import { DurableObject } from 'cloudflare:workers';

import { workerApprovalUsesBytes } from '#worker-host/worker-limits';

/** Organization membership and replay authority. No tool calls, streams or credentials live here. */
export class OrganizationAuthorization extends DurableObject {
	#authority(): ReturnType<typeof createOrganizationAuthority> {
		return createOrganizationAuthority({
			clock: { nowMs: () => Date.now() },
			cap: workerApprovalUsesBytes,
			store: {
				read: (key) => this.ctx.storage.get(key),
				write: (key, value) => this.ctx.storage.put(key, value),
				// One transaction and one put: pruning and first-use admission commit together.
				transaction: (decide) =>
					this.ctx.storage.transaction((storage) =>
						decide({
							read: (key) => storage.get(key),
							write: (key, value) => storage.put(key, value),
						}),
					),
			},
		});
	}

	async isAgentListed(agentClientId: string): Promise<boolean> {
		return this.#authority().isAgentListed(agentClientId);
	}

	/** Narrow management seam; no public management route is exposed in S6. */
	async setAgentAdmission(agentClientId: string, state: 'listed' | 'removed'): Promise<void> {
		await this.#authority().setAgentAdmission(agentClientId, state);
	}

	async consumeApprovalToken(
		tokenId: string,
		expiresAtMs: number,
	): Promise<ConsumeApprovalTokenResult> {
		return this.#authority().consumeApprovalToken(tokenId, expiresAtMs);
	}
}
