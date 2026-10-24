import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { createWorkspaceAuthority, type AgentRemoval } from '@agent-collaboration/tool-host-core';
import { DurableObject } from 'cloudflare:workers';

import { workerApprovalUsesBytes } from '#worker-host/worker-limits';

/** Workspace membership and replay authority. No tool calls, streams or credentials live here. */
export class WorkspaceAuthority extends DurableObject {
	#authority(): ReturnType<typeof createWorkspaceAuthority> {
		return createWorkspaceAuthority({
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

	async readMembership(clientId: string): Promise<{ readonly persona: string } | null> {
		return this.#authority().readMembership(clientId);
	}
	async setMembership(clientId: string, persona: string): Promise<void> {
		await this.#authority().setMembership(clientId, persona);
	}
	async readAgentRemoval(clientId: string): Promise<AgentRemoval | null> {
		return this.#authority().readAgentRemoval(clientId);
	}
	async beginAgentRemoval(
		clientId: string,
		requestId: string,
		operation: AgentRemoval['operation'],
	): Promise<AgentRemoval> {
		return this.#authority().beginAgentRemoval(clientId, requestId, operation);
	}
	async completeAgentRemoval(
		clientId: string,
		requestId: string,
		operation: AgentRemoval['operation'],
	): Promise<void> {
		await this.#authority().completeAgentRemoval(clientId, requestId, operation);
	}

	async consumeApprovalToken(
		tokenId: string,
		expiresAtMs: number,
	): Promise<ConsumeApprovalTokenResult> {
		return this.#authority().consumeApprovalToken(tokenId, expiresAtMs);
	}
}
