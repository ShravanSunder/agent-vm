import {
	removalNoticeSchema,
	removalSubjectSchema,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import { WorkspaceAuthority } from '#worker-host/durable-workspace-authority/workspace-authority';
export { WorkspaceAuthority };
type ObjectProofBindings = Readonly<Pick<ToolPortalWorkerEnv, 'WORKSPACES'>>;
const controlSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('consume'),
		organizationId: z.string(),
		tokenId: z.string(),
		expiresAtMs: z.number(),
	}),
	z.strictObject({ kind: z.literal('notice'), notice: removalNoticeSchema }),
	z.strictObject({
		kind: z.literal('mark'),
		workspaceId: z.string(),
		subject: removalSubjectSchema,
	}),
]);
// Test-only DO controls, separate from the production fetch entry.
export default {
	async fetch(request: Request, bindings: ObjectProofBindings): Promise<Response> {
		const input = controlSchema.parse(await request.json());
		switch (input.kind) {
			case 'consume':
				return Response.json(
					await bindings.WORKSPACES.get(
						bindings.WORKSPACES.idFromName(input.organizationId),
					).consumeApprovalToken(input.tokenId, input.expiresAtMs),
				);
			case 'notice':
				return Response.json(
					await bindings.WORKSPACES.get(
						bindings.WORKSPACES.idFromName(input.notice.workspaceId),
					).recordRemovalNotice(input.notice),
				);
			case 'mark':
				return Response.json(
					await bindings.WORKSPACES.get(
						bindings.WORKSPACES.idFromName(input.workspaceId),
					).readRemovalMark(input.subject),
				);
		}
	},
};
