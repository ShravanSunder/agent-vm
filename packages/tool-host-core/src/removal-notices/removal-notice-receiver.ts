import {
	removalNoticeSchema,
	type RemovalNoticeTokenVerifier,
} from '@agent-collaboration/tool-access/contracts';

import type { WorkspaceConfigurationSource } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import type { WorkspaceRemovalAuthority } from '#tool-host-core/workspace-authority/removal-notice-store';

export function createRemovalNoticeReceiver(props: {
	readonly verifier: RemovalNoticeTokenVerifier;
	readonly configurations: WorkspaceConfigurationSource;
	readonly workspaces: {
		readonly forWorkspace: (
			workspaceId: string,
		) => Pick<WorkspaceRemovalAuthority, 'recordRemovalNotice'>;
	};
}): { readonly handle: (request: Request) => Promise<Response> } {
	return {
		handle: async (request) => {
			if (new URL(request.url).pathname !== '/internal/v1/removal-notices')
				return Response.json({ error: 'not-found' }, { status: 404 });
			if (request.method !== 'POST') return new Response(null, { status: 405 });
			const bearer = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/iu)?.[1];
			if (bearer === undefined || !(await props.verifier.verify(bearer)))
				return Response.json({ error: 'unauthenticated' }, { status: 401 });
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json({ error: 'malformed-notice' }, { status: 400 });
			}
			const notice = removalNoticeSchema.safeParse(body);
			if (!notice.success) return Response.json({ error: 'malformed-notice' }, { status: 400 });
			try {
				const configuration = await props.configurations.read(notice.data.workspaceId);
				if (configuration.organizationId !== notice.data.organizationId)
					return Response.json({ error: 'not-permitted' }, { status: 403 });
			} catch {
				return Response.json({ error: 'not-permitted' }, { status: 403 });
			}
			try {
				return Response.json(
					await props.workspaces
						.forWorkspace(notice.data.workspaceId)
						.recordRemovalNotice(notice.data),
				);
			} catch {
				return Response.json({ error: 'notice-unavailable' }, { status: 503 });
			}
		},
	};
}
