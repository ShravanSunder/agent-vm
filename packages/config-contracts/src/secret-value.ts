import { z } from 'zod';

export const secretFormatSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('bearer'),
		})
		.strict(),
	z
		.object({
			kind: z.literal('prefix'),
			prefix: z
				.string()
				.min(1, 'secret format prefix must not be empty.')
				.max(64, 'secret format prefix must be 64 characters or fewer.')
				.refine(
					(value) => !/\s/u.test(value),
					'secret format prefix must not contain whitespace; agent-vm inserts one space.',
				),
		})
		.strict(),
]);

const environmentSecretValueSchema = z
	.object({
		source: z.literal('environment'),
		name: z.string().min(1),
	})
	.strict();

const onePasswordSecretValueSchema = z
	.object({
		source: z.literal('1password'),
		ref: z.string().regex(/^op:\/\//u, '1Password refs must start with op://'),
	})
	.strict();

export const secretValueSchema = z.discriminatedUnion('source', [
	environmentSecretValueSchema,
	onePasswordSecretValueSchema,
]);

export const formattedSecretValueSchema = z.discriminatedUnion('source', [
	environmentSecretValueSchema.extend({
		format: secretFormatSchema.optional(),
	}),
	onePasswordSecretValueSchema.extend({
		format: secretFormatSchema.optional(),
	}),
]);

export type SecretFormat = z.infer<typeof secretFormatSchema>;
export type SecretValue = z.infer<typeof secretValueSchema>;
export type FormattedSecretValue = z.infer<typeof formattedSecretValueSchema>;

export function formatSecretValue(secret: FormattedSecretValue, rawValue: string): string {
	if (secret.format === undefined) {
		return rawValue;
	}
	switch (secret.format.kind) {
		case 'bearer':
			return `Bearer ${rawValue}`;
		case 'prefix':
			return `${secret.format.prefix} ${rawValue}`;
		default: {
			const exhaustiveFormat: never = secret.format;
			return exhaustiveFormat;
		}
	}
}
