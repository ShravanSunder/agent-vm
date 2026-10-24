/// <reference types="../../worker-configuration.gen.d.ts" preserve="true" />

import { createSignInHttpHandler } from '#auth/better-auth-provider/sign-in-http-handler';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';

export default {
	async fetch(request: Request, bindings: AuthWorkerEnv): Promise<Response> {
		try {
			return await createSignInHttpHandler(signInWorkerConfiguration(bindings))(request);
		} catch {
			return Response.json({ error: 'sign-in-unavailable' }, { status: 503 });
		}
	},
};
