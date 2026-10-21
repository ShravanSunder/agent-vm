import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

const agentAdmissionSchema = z.strictObject({ state: z.enum(['listed', 'removed']) });
const approvalUsesSchema = z.record(z.string(), z.number().finite());
const approvalUsesKey = 'approval-uses-v1';

/** Organization membership and replay authority. No tool calls, streams or credentials live here. */
export class OrganizationAuthorization extends DurableObject {
	async isAgentListed(agentClientId: string): Promise<boolean> {
		const stored = await this.ctx.storage.get(`agent:${agentClientId}`);
		return stored === undefined ? false : agentAdmissionSchema.parse(stored).state === 'listed';
	}

	/** Narrow management seam; no public management route is exposed in S6. */
	async setAgentAdmission(agentClientId: string, state: 'listed' | 'removed'): Promise<void> {
		z.string().min(1).parse(agentClientId);
		await this.ctx.storage.put(`agent:${agentClientId}`, agentAdmissionSchema.parse({ state }));
	}

	async consumeApprovalToken(
		tokenId: string,
		expiresAtMs: number,
	): Promise<ConsumeApprovalTokenResult> {
		z.string().min(1).parse(tokenId);
		z.number().finite().parse(expiresAtMs);
		// One transaction and one put: pruning and first-use admission commit together.
		// The row is private to this authority; no Worker-memory replay list exists.
		return this.ctx.storage.transaction(async (storage): Promise<ConsumeApprovalTokenResult> => {
			const now = Date.now();
			const stored = await storage.get(approvalUsesKey);
			const uses = approvalUsesSchema.parse(stored ?? {});
			if ((uses[tokenId] ?? 0) > now) return { ok: false, reason: 'replayed' };
			const retained = Object.fromEntries(
				Object.entries(uses).filter(([, expiry]) => expiry > now),
			);
			retained[tokenId] = expiresAtMs;
			// Keep the single atomic row well below the platform's 2 MiB record ceiling.
			if (new TextEncoder().encode(JSON.stringify(retained)).byteLength > 512 * 1024)
				return { ok: false, reason: 'replay-cache-full' };
			await storage.put(approvalUsesKey, retained);
			return { ok: true };
		});
	}
}
