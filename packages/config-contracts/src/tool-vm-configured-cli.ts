import { z } from 'zod';

import {
	configuredCliInvocationMatcherSchema,
	configuredCliOutputPolicySchema,
	configuredCliTimeoutPolicySchema,
} from './controller-configured-cli.js';

export const MAXIMUM_TOOL_VM_CLI_ARGV_ITEMS = 100;
export const MAXIMUM_TOOL_VM_CLI_ARGV_TOKEN_CHARACTERS = 4_096;
export const MAXIMUM_TOOL_VM_CLI_STDIN_BYTES = 65_536;
export const MAXIMUM_TOOL_VM_CLI_MODEL_VISIBLE_STDOUT_BYTES = 65_536;
export const MAXIMUM_TOOL_VM_CLI_TRANSPORT_BYTES_PER_STREAM = 1_048_576;

const nulFreeTextSchema = (maximumCharacters: number): z.ZodString =>
	z
		.string()
		.min(1)
		.max(maximumCharacters)
		.refine((value) => !value.includes('\0'), { message: 'Value must contain no NUL bytes.' });

export const toolVmCliArgvTokenSchema = nulFreeTextSchema(
	MAXIMUM_TOOL_VM_CLI_ARGV_TOKEN_CHARACTERS,
);

const toolVmCliCommonInputShape = {
	argv: z.array(toolVmCliArgvTokenSchema).max(MAXIMUM_TOOL_VM_CLI_ARGV_ITEMS),
	reason: z.string().min(1).max(2_000),
	stdin: z
		.string()
		.max(MAXIMUM_TOOL_VM_CLI_STDIN_BYTES)
		.refine(
			(value) => new TextEncoder().encode(value).byteLength <= MAXIMUM_TOOL_VM_CLI_STDIN_BYTES,
			{ message: 'Tool VM CLI stdin exceeds the UTF-8 byte limit.' },
		)
		.optional(),
} as const;

export const quickToolVmCliInputSchema = z.object(toolVmCliCommonInputShape).strict();

export const openToolVmCliInputSchema = z
	.object({
		...toolVmCliCommonInputShape,
		timeoutMs: z.number().int().positive().max(28_800_000).optional(),
	})
	.strict();

export const toolVmCliInputSchema = z.union([quickToolVmCliInputSchema, openToolVmCliInputSchema]);

export const toolVmCliMetadataSchema = z
	.object({
		categories: z.array(nulFreeTextSchema(64)).max(16).optional(),
		displayName: nulFreeTextSchema(200).optional(),
		source: nulFreeTextSchema(200).optional(),
		version: nulFreeTextSchema(100).optional(),
	})
	.strict();

export const toolVmCliAdvisoryHintsSchema = z
	.object({
		hintDeny: z.array(configuredCliInvocationMatcherSchema).default([]),
		hintRequiresApproval: z.array(configuredCliInvocationMatcherSchema).default([]),
	})
	.strict();

export const toolVmCliOutputPolicySchema = configuredCliOutputPolicySchema
	.extend({
		stderrMaxBytes: z.number().int().positive().max(MAXIMUM_TOOL_VM_CLI_TRANSPORT_BYTES_PER_STREAM),
		stdoutMaxBytes: z.number().int().positive().max(MAXIMUM_TOOL_VM_CLI_MODEL_VISIBLE_STDOUT_BYTES),
	})
	.strict();

const toolVmCliExecutableSchema = z
	.string()
	.min(1)
	.refine((value) => value.startsWith('/') && !value.includes('\0'), {
		message: 'Tool VM CLI executables must be absolute and contain no NUL bytes.',
	});

const toolVmCliWorkingDirectorySchema = z
	.string()
	.min(1)
	.refine(
		(value) => !value.includes('\0') && !value.startsWith('/') && !value.split('/').includes('..'),
		{
			message: 'Tool VM CLI working directories must stay relative to the Tool VM work root.',
		},
	);

export const toolVmConfiguredCliOperationSchema = z
	.object({
		advisoryHints: toolVmCliAdvisoryHintsSchema.optional(),
		executable: toolVmCliExecutableSchema,
		kind: z.literal('command.cli'),
		metadata: toolVmCliMetadataSchema.optional(),
		output: toolVmCliOutputPolicySchema,
		safeHelp: z.string().min(1).max(4_000),
		timeout: configuredCliTimeoutPolicySchema,
		workingDirectory: toolVmCliWorkingDirectorySchema,
	})
	.strict();

export const configuredCliResultSchema = z
	.object({
		exitCode: z.number().int(),
		stderrSummary: z.string().optional(),
		stderrTruncated: z.boolean(),
		stdout: z.string(),
		stdoutTruncated: z.boolean(),
	})
	.strict();

export type ConfiguredCliResult = z.infer<typeof configuredCliResultSchema>;
export type ToolVmCliAdvisoryHints = z.infer<typeof toolVmCliAdvisoryHintsSchema>;
export type ToolVmCliInput = z.infer<typeof toolVmCliInputSchema>;
export type ToolVmCliMetadata = z.infer<typeof toolVmCliMetadataSchema>;
export type ToolVmConfiguredCliOperation = z.infer<typeof toolVmConfiguredCliOperationSchema>;

export function resolveToolVmCliTimeout(props: {
	readonly input: ToolVmCliInput;
	readonly kind: ToolVmConfiguredCliOperation['timeout']['kind'];
}): number {
	if (props.kind === 'quick') {
		quickToolVmCliInputSchema.parse(props.input);
		return 5_000;
	}
	const input = openToolVmCliInputSchema.parse(props.input);
	return input.timeoutMs ?? 120_000;
}

export class ConfiguredCliOutputOverflowError extends Error {
	constructor() {
		super('Configured CLI output exceeded its configured bound.');
		this.name = 'ConfiguredCliOutputOverflowError';
	}
}

function truncateUtf8(value: Uint8Array, maximumBytes: number): string {
	const bounded = value.subarray(0, maximumBytes);
	const decoder = new TextDecoder('utf-8', { fatal: true });
	for (let removedBytes = 0; removedBytes <= 3; removedBytes += 1) {
		try {
			return decoder.decode(bounded.subarray(0, bounded.byteLength - removedBytes));
		} catch {
			// A valid UTF-8 scalar spans at most four bytes, so only the final scalar can be partial.
		}
	}
	return '';
}

export function fixedSafeConfiguredCliStderrSummary(stderr: Uint8Array): string {
	try {
		const sanitized = new TextDecoder()
			.decode(stderr)
			.replaceAll(
				/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/gu,
				'[REDACTED]',
			)
			.replaceAll(
				/\b(?:api[-_ ]?key|authorization|cookie|password|private[-_ ]?key|refresh[-_ ]?token|secret|set-cookie|token)\s*[:=]\s*\S+/giu,
				'[REDACTED]',
			)
			.replaceAll(/\b(?:Bearer|Basic)\s+\S+/giu, '[REDACTED]');
		return truncateUtf8(new TextEncoder().encode(sanitized), 4_096);
	} catch {
		return 'Command stderr summary unavailable.';
	}
}

export function projectConfiguredCliBufferedOutput(props: {
	readonly exitCode: number;
	readonly output: z.infer<typeof configuredCliOutputPolicySchema>;
	readonly stderr: Uint8Array;
	readonly stderrTruncated?: boolean;
	readonly stdout: Uint8Array;
	readonly stdoutTruncated?: boolean;
}): ConfiguredCliResult {
	const stderrOverflow =
		props.stderrTruncated === true || props.stderr.byteLength > props.output.stderrMaxBytes;
	const stdoutOverflow =
		props.stdoutTruncated === true || props.stdout.byteLength > props.output.stdoutMaxBytes;
	if (props.output.overflow === 'fail' && (stderrOverflow || stdoutOverflow)) {
		throw new ConfiguredCliOutputOverflowError();
	}
	const boundedStderr = props.stderr.subarray(0, props.output.stderrMaxBytes);
	const boundedStdout = props.stdout.subarray(0, props.output.stdoutMaxBytes);
	return configuredCliResultSchema.parse({
		exitCode: props.exitCode,
		...(props.output.modelVisibleStderr === 'fixed_safe_summary' && boundedStderr.byteLength > 0
			? { stderrSummary: fixedSafeConfiguredCliStderrSummary(boundedStderr) }
			: {}),
		stderrTruncated: stderrOverflow,
		stdout: new TextDecoder().decode(boundedStdout),
		stdoutTruncated: stdoutOverflow,
	});
}
