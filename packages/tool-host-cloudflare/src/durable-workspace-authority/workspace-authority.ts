import type {
	RemovalNotice,
	RemovalNoticeAck,
	RemovalSubject,
} from '@agent-collaboration/tool-access/contracts';
import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { createWorkspaceAuthority } from '@agent-collaboration/tool-host-core';
import { DurableObject } from 'cloudflare:workers';

import { workerApprovalUsesBytes } from '#worker-host/worker-limits';

/** Workspace removal marks and replay authority. No tool calls, streams or credentials live here. */
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

	async readRemovalMark(subject: RemovalSubject): Promise<number | null> {
		return this.#authority().readRemovalMark(subject);
	}
	async recordRemovalNotice(notice: RemovalNotice): Promise<RemovalNoticeAck> {
		return this.#authority().recordRemovalNotice(notice);
	}
	async pruneRemovalNotices(): Promise<void> {
		await this.#authority().pruneRemovalNotices();
	}

	async consumeApprovalToken(
		tokenId: string,
		expiresAtMs: number,
	): Promise<ConsumeApprovalTokenResult> {
		return this.#authority().consumeApprovalToken(tokenId, expiresAtMs);
	}
}
