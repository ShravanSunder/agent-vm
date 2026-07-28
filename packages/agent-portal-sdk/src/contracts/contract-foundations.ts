import { z } from 'zod';

import { withPortableSuperRefinement } from '../portable-contracts/portable-refinement-authoring.js';

export const PORTABLE_MAXIMUM_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const SANDBOX_MAXIMUM_ENVIRONMENT_VARIABLES = 100;
export const SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS = 256;
export const SANDBOX_MAXIMUM_PATH_CHARACTERS = 1_024;
export const SANDBOX_MAXIMUM_TEXT_CHARACTERS = 64 * 1_024;
export const SANDBOX_MAXIMUM_BINARY_BYTES = 16 * 1_024 * 1_024;
export const SANDBOX_MAXIMUM_LIST_ITEMS = 1_000;
export const SANDBOX_MAXIMUM_OPERATION_MILLISECONDS = 60 * 60 * 1_000;

export const BoundedOpaqueIdentifierSchema = z
	.string()
	.min(1)
	.max(SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS);
export const PositiveSafeIntegerSchema = z
	.number()
	.int()
	.positive()
	.max(PORTABLE_MAXIMUM_SAFE_INTEGER);
export const NonnegativeSafeIntegerSchema = z
	.number()
	.int()
	.nonnegative()
	.max(PORTABLE_MAXIMUM_SAFE_INTEGER);
export const BoundedOperationMillisecondsSchema = PositiveSafeIntegerSchema.max(
	SANDBOX_MAXIMUM_OPERATION_MILLISECONDS,
);
export const BoundedByteCountSchema = PositiveSafeIntegerSchema.max(SANDBOX_MAXIMUM_BINARY_BYTES);
export const BoundedTextSchema = z.string().max(SANDBOX_MAXIMUM_TEXT_CHARACTERS);
export const SandboxShellCommandSchema = z
	.string()
	.min(1)
	.max(SANDBOX_MAXIMUM_TEXT_CHARACTERS)
	// oxlint-disable-next-line no-control-regex -- The wire contract must reject embedded NUL bytes.
	.regex(/^[^\0]+$/u);
export const SandboxGuestAbsolutePathSchema = z
	.string()
	.min(1)
	.max(SANDBOX_MAXIMUM_PATH_CHARACTERS)
	.startsWith('/')
	// oxlint-disable-next-line no-control-regex -- Guest paths cannot contain embedded NUL bytes.
	.regex(/^[^\0]+$/u);
export const SandboxGuestPathSchema = z
	.string()
	.min(1)
	.max(SANDBOX_MAXIMUM_PATH_CHARACTERS)
	// oxlint-disable-next-line no-control-regex -- Guest paths cannot contain embedded NUL bytes.
	.regex(/^[^\0]+$/u);
export const SandboxEnvironmentVariableNameSchema = z
	.string()
	.min(1)
	.max(SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
export const SandboxEnvironmentVariableValueSchema = z
	.string()
	.max(SANDBOX_MAXIMUM_TEXT_CHARACTERS)
	// oxlint-disable-next-line no-control-regex -- Environment values cannot contain embedded NUL bytes.
	.regex(/^[^\0]*$/u);

const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const CanonicalBase64Schema = z
	.string()
	.max(Math.ceil(SANDBOX_MAXIMUM_BINARY_BYTES / 3) * 4)
	.regex(canonicalBase64Pattern);
export const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const SandboxWorkRelativePathSchema = withPortableSuperRefinement({
	refinement: (requestedPath, context) => {
		if (
			requestedPath.length === 0 ||
			requestedPath.includes('\0') ||
			requestedPath.startsWith('/') ||
			requestedPath.endsWith('/') ||
			requestedPath
				.split('/')
				.some((segment) => segment === '' || segment === '.' || segment === '..')
		) {
			context.addIssue({
				code: 'custom',
				message: 'Sandbox path must remain relative to the server-selected work root.',
			});
		}
	},
	refinementIdentity: 'sandbox.path.work-relative',
	schema: z.string().max(SANDBOX_MAXIMUM_PATH_CHARACTERS),
});

export const SandboxHandleKindSchema = z.enum(['environment', 'process', 'stream', 'terminal']);
export const SandboxStreamChannelSchema = z.enum(['stdin', 'stdout', 'stderr', 'pty']);

export const SandboxBoundHandleSchema = z
	.object({
		handleId: BoundedOpaqueIdentifierSchema,
		kind: SandboxHandleKindSchema,
		owningGeneration: BoundedOpaqueIdentifierSchema,
	})
	.strict();

// oxlint-disable-next-line explicit-function-return-type -- Preserve the literal handle kind in the returned Zod object schema.
export function createSandboxBoundHandleSchema<
	THandleKind extends z.infer<typeof SandboxHandleKindSchema>,
>(kind: THandleKind) {
	return SandboxBoundHandleSchema.extend({ kind: z.literal(kind) }).strict();
}

export const SandboxEnvironmentHandleSchema = createSandboxBoundHandleSchema('environment');
export const SandboxProcessHandleSchema = createSandboxBoundHandleSchema('process');
export const SandboxStreamHandleSchema = createSandboxBoundHandleSchema('stream')
	.extend({ channel: SandboxStreamChannelSchema })
	.strict();
export const SandboxTerminalHandleSchema = createSandboxBoundHandleSchema('terminal');

export const SandboxEnvironmentVariableSchema = z
	.object({
		name: SandboxEnvironmentVariableNameSchema,
		value: SandboxEnvironmentVariableValueSchema,
	})
	.strict()
	.readonly();

export const SandboxDirectShellStartRequestSchema = withPortableSuperRefinement({
	refinement: (request, context) => {
		const environmentVariableNames =
			request.environmentVariables?.map((environmentVariable) => environmentVariable.name) ?? [];
		if (new Set(environmentVariableNames).size !== environmentVariableNames.length) {
			context.addIssue({
				code: 'custom',
				message: 'Direct Sandbox environment contains a duplicate variable name.',
			});
		}
	},
	refinementIdentity: 'sandbox.environment-variable.unique-names',
	schema: z
		.object({
			command: SandboxShellCommandSchema,
			cwd: SandboxGuestAbsolutePathSchema.optional(),
			environment: SandboxEnvironmentHandleSchema,
			environmentVariables: z
				.array(SandboxEnvironmentVariableSchema)
				.max(SANDBOX_MAXIMUM_ENVIRONMENT_VARIABLES)
				.readonly()
				.optional(),
		})
		.strict(),
});

function decodedCanonicalBase64ByteLength(contentBase64: string): number {
	if (contentBase64.length === 0) return 0;
	const paddingCharacters = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0;
	return (contentBase64.length / 4) * 3 - paddingCharacters;
}

export const SandboxBinaryChunkSchema = withPortableSuperRefinement({
	refinement: (chunk, context) => {
		if (chunk.byteLength !== decodedCanonicalBase64ByteLength(chunk.contentBase64)) {
			context.addIssue({
				code: 'custom',
				message: 'Binary chunk byte length does not match decoded canonical base64 content.',
				path: ['byteLength'],
			});
		}
	},
	refinementIdentity: 'sandbox.binary-chunk.byte-length',
	schema: z
		.object({
			byteLength: NonnegativeSafeIntegerSchema.max(SANDBOX_MAXIMUM_BINARY_BYTES),
			contentBase64: CanonicalBase64Schema,
			encoding: z.literal('base64'),
		})
		.strict(),
});

export type SandboxBoundHandle = z.infer<typeof SandboxBoundHandleSchema>;
export type SandboxDirectShellStartRequest = z.infer<typeof SandboxDirectShellStartRequestSchema>;
export type SandboxEnvironmentVariable = z.infer<typeof SandboxEnvironmentVariableSchema>;
export type SandboxEnvironmentHandle = z.infer<typeof SandboxEnvironmentHandleSchema>;
export type SandboxProcessHandle = z.infer<typeof SandboxProcessHandleSchema>;
export type SandboxStreamHandle = z.infer<typeof SandboxStreamHandleSchema>;
export type SandboxTerminalHandle = z.infer<typeof SandboxTerminalHandleSchema>;
