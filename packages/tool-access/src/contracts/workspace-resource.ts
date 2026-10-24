import { z } from 'zod';

export const workspaceResourceMetadataSchema = z.strictObject({
	kind: z.literal('workspace'),
	organizationId: z.uuid(),
	workspaceId: z.uuid(),
});
export type WorkspaceResourceMetadata = z.infer<typeof workspaceResourceMetadataSchema>;

/** Only trusted deployment configuration supplies the origin of a workspace resource. */
export function normalizeToolPortalOrigin(value: string): string {
	const origin = new URL(z.url().parse(value));
	if (
		!['http:', 'https:'].includes(origin.protocol) ||
		origin.username !== '' ||
		origin.password !== '' ||
		origin.pathname !== '/' ||
		origin.search !== '' ||
		origin.hash !== ''
	)
		throw new Error('Tool Portal origin must contain only an HTTP origin.');
	return origin.origin;
}

export function workspaceResourceIdentifier(props: {
	readonly toolPortalOrigin: string;
	readonly workspaceId: string;
}): string {
	return `${normalizeToolPortalOrigin(props.toolPortalOrigin)}/workspaces/${z.uuid().parse(props.workspaceId)}/mcp`;
}
