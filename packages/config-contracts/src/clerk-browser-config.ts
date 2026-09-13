import { z } from 'zod';

const fixedHttpsUrlSchema = z
	.url()
	.max(2048)
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
	}, 'Clerk URLs must use HTTPS without credentials, query or fragment.');
const exactHttpsOriginSchema = fixedHttpsUrlSchema.refine(
	(value) => new URL(value).origin === value,
	'Clerk origins must not include a path or trailing slash.',
);

export const clerkBrowserIdentityConfigSchema = z
	.object({
		kind: z.literal('clerk'),
		issuer: exactHttpsOriginSchema,
		fixedLoginReturnOrigin: exactHttpsOriginSchema,
		hostedSignInUrl: fixedHttpsUrlSchema,
		publishableKey: z
			.string()
			.max(2048)
			.regex(/^pk_(test|live)_[A-Za-z0-9+/=_-]+$/u),
		secretKey: z
			.object({
				source: z.literal('1password'),
				ref: z
					.string()
					.max(4096)
					.regex(/^op:\/\//u),
			})
			.strict(),
	})
	.strict()
	.refine((configuration) => {
		const encodedDomain = configuration.publishableKey.slice(
			configuration.publishableKey.indexOf('_', 3) + 1,
		);
		const decodedDomain = Buffer.from(encodedDomain, 'base64').toString('utf8');
		return decodedDomain === `${new URL(configuration.issuer).hostname}$`;
	}, 'Clerk publishable key must identify the configured issuer host.');
export type ClerkBrowserIdentityConfig = z.infer<typeof clerkBrowserIdentityConfigSchema>;
