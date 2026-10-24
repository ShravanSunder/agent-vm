import { workspaceResourceMetadataSchema } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

/** Fresh issuer-owned E6 readback; the shared metadata keeps workspace identity at its contract owner. */
export const workspaceResourceSchema = z.object({
	identifier: z.url(),
	metadata: workspaceResourceMetadataSchema,
	allowedScopes: z.array(z.string()).nullable(),
	customClaims: z.record(z.string(), z.unknown()).nullable(),
	disabled: z.boolean(),
});
export type WorkspaceResource = z.infer<typeof workspaceResourceSchema>;

export function workspaceResourceHasIssuancePolicy(resource: WorkspaceResource): boolean {
	return (
		!resource.disabled &&
		resource.allowedScopes?.length === 1 &&
		resource.allowedScopes[0] === 'tool-portal:agent'
	);
}
