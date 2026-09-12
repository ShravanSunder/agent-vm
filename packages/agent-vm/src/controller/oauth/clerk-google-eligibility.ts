import { z } from 'zod';

const verificationSchema = z.object({ status: z.string() }).nullable();
const clerkGoogleUserSchema = z.object({
	id: z.string().min(1),
	primaryEmailAddressId: z.string().nullable(),
	emailAddresses: z.array(
		z.object({ id: z.string(), emailAddress: z.string(), verification: verificationSchema }),
	),
	externalAccounts: z.array(
		z.object({
			provider: z.string(),
			providerUserId: z.string(),
			emailAddress: z.string(),
			verification: verificationSchema,
		}),
	),
});

/** Eligibility only: durable ownership remains issuer + Clerk user ID. */
export function getVerifiedGoogleEmailAddress(
	value: unknown,
	expectedUserId: string,
): string | undefined {
	const parsed = clerkGoogleUserSchema.safeParse(value);
	if (!parsed.success || parsed.data.id !== expectedUserId) return undefined;
	const primary = parsed.data.emailAddresses.find(
		(address) => address.id === parsed.data.primaryEmailAddressId,
	);
	if (primary?.verification?.status !== 'verified') return undefined;
	const matches = parsed.data.externalAccounts.some(
		(account) =>
			// Backend API preserves oauth_; ClerkJS alone strips that prefix.
			account.provider === 'oauth_google' &&
			account.providerUserId.length > 0 &&
			account.verification?.status === 'verified' &&
			account.emailAddress.toLowerCase() === primary.emailAddress.toLowerCase(),
	);
	return matches ? primary.emailAddress : undefined;
}
