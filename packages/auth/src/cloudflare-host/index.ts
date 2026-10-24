/// <reference types="../../worker-configuration.gen.d.ts" preserve="true" />

import { WorkerEntrypoint } from 'cloudflare:workers';

import { createSignInHttpHandler } from '#auth/better-auth-provider/sign-in-http-handler';
import { createSignInManagementBinding } from '#auth/better-auth-provider/sign-in-management-binding';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';

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

	async registerAndLink(
		props: Parameters<ReturnType<typeof createSignInManagementBinding>['registerAndLink']>[0],
	): ReturnType<ReturnType<typeof createSignInManagementBinding>['registerAndLink']> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).registerAndLink(
			props,
		);
	}
	async link(
		props: Parameters<ReturnType<typeof createSignInManagementBinding>['link']>[0],
	): ReturnType<ReturnType<typeof createSignInManagementBinding>['link']> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).link(props);
	}
	async unlink(
		props: Parameters<ReturnType<typeof createSignInManagementBinding>['unlink']>[0],
	): ReturnType<ReturnType<typeof createSignInManagementBinding>['unlink']> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).unlink(props);
	}
	async disable(
		props: Parameters<ReturnType<typeof createSignInManagementBinding>['disable']>[0],
	): ReturnType<ReturnType<typeof createSignInManagementBinding>['disable']> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).disable(props);
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
