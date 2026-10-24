import { z } from 'zod';

import type { SignInHttpConfiguration } from '#auth/better-auth-provider/sign-in-http-handler';
import { createD1SignInDatabase } from '#auth/cloudflare-host/d1-sign-in-database';
import { signInConfigurationSchema } from '#auth/sign-in-core/models/deployment-configuration';

/** Deployment facts come only from the generated Env's protected bindings. */
export function signInWorkerConfiguration(bindings: AuthWorkerEnv): SignInHttpConfiguration {
	return {
		database: createD1SignInDatabase(bindings.DB),
		configuration: signInConfigurationSchema.parse(JSON.parse(bindings.SIGN_IN_CONFIGURATION)),
		secret: z.string().min(32).parse(bindings.AUTH_SECRET),
		google: {
			clientId: z.string().min(1).parse(bindings.GOOGLE_CLIENT_ID),
			clientSecret: z.string().min(1).parse(bindings.GOOGLE_CLIENT_SECRET),
		},
		github: {
			clientId: z.string().min(1).parse(bindings.GITHUB_CLIENT_ID),
			clientSecret: z.string().min(1).parse(bindings.GITHUB_CLIENT_SECRET),
		},
		now: Date.now,
	};
}
