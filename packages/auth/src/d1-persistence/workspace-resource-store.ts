import { z } from 'zod';

import {
	workspaceResourceSchema,
	type WorkspaceResource,
} from '#auth/sign-in-core/agent-clients/workspace-resource';

function parseJsonColumn(value: unknown): unknown {
	return typeof value === 'string' ? JSON.parse(value) : value;
}
const workspaceResourceRowSchema = workspaceResourceSchema.extend({
	metadata: z.preprocess(parseJsonColumn, workspaceResourceSchema.shape.metadata),
	allowedScopes: z.preprocess(parseJsonColumn, workspaceResourceSchema.shape.allowedScopes),
	customClaims: z.preprocess(parseJsonColumn, workspaceResourceSchema.shape.customClaims),
	disabled: z.union([z.boolean(), z.literal(0), z.literal(1), z.null()]).transform(Boolean),
});

/** Better Auth owns resource writes; issuance and management read the primary resource row afresh. */
export function createWorkspaceResourceStore(database: AuthWorkerEnv['DB']): {
	readonly read: (identifier: string) => Promise<WorkspaceResource | null>;
	readonly exists: (identifier: string) => Promise<boolean>;
} {
	return {
		async exists(identifier: string): Promise<boolean> {
			return (
				(await database
					.withSession('first-primary')
					.prepare('SELECT identifier FROM oauthResource WHERE identifier = ?')
					.bind(identifier)
					.first()) !== null
			);
		},
		async read(identifier: string): Promise<WorkspaceResource | null> {
			const row = await database
				.withSession('first-primary')
				.prepare(
					'SELECT identifier, metadata, allowedScopes, customClaims, disabled FROM oauthResource WHERE identifier = ?',
				)
				.bind(identifier)
				.first();
			if (row === null) return null;
			const resource = workspaceResourceRowSchema.safeParse(row);
			return resource.success ? resource.data : null;
		},
	};
}
