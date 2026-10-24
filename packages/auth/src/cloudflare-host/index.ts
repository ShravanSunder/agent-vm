/// <reference types="../../worker-configuration.gen.d.ts" preserve="true" />

import { WorkerEntrypoint } from 'cloudflare:workers';

import { createSignInHttpHandler } from '#auth/better-auth-provider/sign-in-http-handler';
import { createSignInManagementBinding } from '#auth/better-auth-provider/sign-in-management-binding';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';
import type { AgentClientChangeResult } from '#auth/sign-in-core/agent-clients/agent-registration';

/** Only the named service binding can reach agent management; the public fetch handler exposes no RPC route. */
export class AgentClientManagement extends WorkerEntrypoint<AuthWorkerEnv> {
	async humanCheckStatus(): ReturnType<
		ReturnType<typeof createSignInManagementBinding>['humanCheckStatus']
	> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).humanCheckStatus();
	}
	async isLiveOwner(props: {
		readonly token: string;
		readonly organizationId: string;
	}): Promise<boolean> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).isLiveOwner(props);
	}

	async ownsAgentClient(props: {
		readonly token: string;
		readonly organizationId: string;
		readonly clientId: string;
	}): Promise<boolean> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).ownsAgentClient(
			props,
		);
	}

	async changeClient(props: {
		readonly token: string;
		readonly operation: unknown;
	}): Promise<AgentClientChangeResult> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).changeClient(props);
	}
}

export default {
	async fetch(request: Request, bindings: AuthWorkerEnv): Promise<Response> {
		try {
			return await createSignInHttpHandler(signInWorkerConfiguration(bindings))(request);
		} catch {
			return Response.json({ error: 'sign-in-unavailable' }, { status: 503 });
		}
	},
};
