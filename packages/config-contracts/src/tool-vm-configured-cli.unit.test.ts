import { describe, expect, it } from 'vitest';

import {
	MAXIMUM_TOOL_VM_CLI_MODEL_VISIBLE_STDOUT_BYTES,
	MAXIMUM_TOOL_VM_CLI_STDIN_BYTES,
	MAXIMUM_TOOL_VM_CLI_TRANSPORT_BYTES_PER_STREAM,
	openToolVmCliInputSchema,
	quickToolVmCliInputSchema,
	toolVmCliOutputPolicySchema,
} from './tool-vm-configured-cli.js';

describe('Tool VM configured CLI contracts', () => {
	it('accepts empty argv and preserves transport-representable token content', () => {
		expect(
			quickToolVmCliInputSchema.parse({ argv: [], reason: 'Run the configured executable.' }),
		).toEqual({ argv: [], reason: 'Run the configured executable.' });
		expect(
			openToolVmCliInputSchema.parse({
				argv: ['crawl', 'line one\nline two', 'column\tvalue', ';', '$TOKEN'],
				reason: 'Run with caller-selected arguments.',
				stdin: 'arbitrary\ninput',
				timeoutMs: 45_000,
			}),
		).toMatchObject({ argv: ['crawl', 'line one\nline two', 'column\tvalue', ';', '$TOKEN'] });
	});

	it('rejects only malformed or out-of-bounds Tool VM CLI protocol values', () => {
		for (const invalidInput of [
			{ argv: [''], reason: 'Empty token.' },
			{ argv: ['contains\0nul'], reason: 'NUL token.' },
			{ argv: [], reason: '', timeoutMs: 1 },
			{ argv: [], reason: 'Quick calls cannot choose a timeout.', timeoutMs: 1 },
		] as const) {
			expect(quickToolVmCliInputSchema.safeParse(invalidInput).success).toBe(false);
		}
		expect(
			openToolVmCliInputSchema.safeParse({
				argv: [],
				reason: 'Oversized UTF-8 stdin.',
				stdin: '🙂'.repeat(MAXIMUM_TOOL_VM_CLI_STDIN_BYTES / 2),
			}).success,
		).toBe(false);
		expect(
			openToolVmCliInputSchema.safeParse({
				argv: [],
				reason: 'Maximum open timeout.',
				timeoutMs: 28_800_000,
			}).success,
		).toBe(true);
		expect(
			openToolVmCliInputSchema.safeParse({
				argv: [],
				reason: 'Over maximum open timeout.',
				timeoutMs: 28_800_001,
			}).success,
		).toBe(false);
	});

	it('keeps configured capture bounds beneath immutable strict SSH ceilings', () => {
		const basePolicy = {
			modelVisibleStderr: 'fixed_safe_summary',
			overflow: 'truncate',
			stderrMaxBytes: MAXIMUM_TOOL_VM_CLI_TRANSPORT_BYTES_PER_STREAM,
			stdoutMaxBytes: MAXIMUM_TOOL_VM_CLI_MODEL_VISIBLE_STDOUT_BYTES,
		} as const;

		expect(toolVmCliOutputPolicySchema.safeParse(basePolicy).success).toBe(true);
		expect(
			toolVmCliOutputPolicySchema.safeParse({
				...basePolicy,
				stdoutMaxBytes: MAXIMUM_TOOL_VM_CLI_MODEL_VISIBLE_STDOUT_BYTES + 1,
			}).success,
		).toBe(false);
		expect(
			toolVmCliOutputPolicySchema.safeParse({
				...basePolicy,
				stderrMaxBytes: MAXIMUM_TOOL_VM_CLI_TRANSPORT_BYTES_PER_STREAM + 1,
			}).success,
		).toBe(false);
	});
});
