import { z } from 'zod';

export const signInConfigurationSchema = z.strictObject({
	issuer: z.url(),
	mode: z.literal('private'),
	ownerEmail: z.email().transform((email) => email.toLowerCase()),
	agentAudience: z.url(),
	managementAudience: z.url(),
	organizationIds: z.array(z.uuid()).min(1),
	ownerCliClientId: z.string().min(1),
	ownerCliRedirectUri: z.url().refine((value) => {
		const redirect = new URL(value);
		return (
			redirect.protocol === 'http:' &&
			['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) &&
			redirect.username === '' &&
			redirect.password === '' &&
			redirect.hash === ''
		);
	}, 'Owner CLI redirects must use an HTTP loopback address'),
	accessTokenSeconds: z.number().int().positive().max(300).default(300),
	managementHumanCheck: z
		.enum(['remembered-login', 'fresh-verified-uv', 'exact-operation-binding'])
		.default('remembered-login'),
});
export type SignInConfiguration = z.infer<typeof signInConfigurationSchema>;
