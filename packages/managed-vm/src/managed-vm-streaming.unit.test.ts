import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
	ManagedVm,
	ManagedVmExecOptions,
	ManagedVmExecStreamingOptions,
	ManagedVmExecStreamMode,
} from './managed-vm-contracts.js';

type AssertAssignable<TTarget, TValue extends TTarget> = TValue;

export type PipedStdoutWithDiscardedStderr = AssertAssignable<
	ManagedVmExecStreamingOptions,
	{
		readonly stderr: { readonly kind: 'discard' };
		readonly stdout: { readonly kind: 'pipe' };
		readonly windowBytes: 262_144;
	}
>;

export type MissingStderrMode = AssertAssignable<
	ManagedVmExecStreamingOptions,
	// @ts-expect-error Streaming output requires an explicit stderr mode.
	{
		readonly stdout: { readonly kind: 'pipe' };
		readonly windowBytes: 262_144;
	}
>;

export type MissingOutputWindow = AssertAssignable<
	ManagedVmExecStreamingOptions,
	// @ts-expect-error Streaming output requires one bounded global output window.
	{
		readonly stderr: { readonly kind: 'discard' };
		readonly stdout: { readonly kind: 'pipe' };
	}
>;

// @ts-expect-error Native Gondolin output strings are not neutral structural modes.
export type NativePipeStringMode = AssertAssignable<ManagedVmExecStreamMode, 'pipe'>;

export type NativeIgnoreMode = AssertAssignable<
	ManagedVmExecStreamMode,
	// @ts-expect-error Native Gondolin ignore mode is represented by neutral discard.
	{ readonly kind: 'ignore' }
>;

describe('ManagedVm streaming exec contract', () => {
	it('groups required structural stream modes with one bounded output window', () => {
		const streamingOutput = {
			stderr: { kind: 'discard' },
			stdout: { kind: 'pipe' },
			windowBytes: 256 * 1024,
		} as const satisfies ManagedVmExecStreamingOptions;
		const execOptions = {
			output: streamingOutput,
			stdin: 'fixed input',
		} satisfies ManagedVmExecOptions;

		expect(execOptions.output).toEqual({
			stderr: { kind: 'discard' },
			stdout: { kind: 'pipe' },
			windowBytes: 256 * 1024,
		});
		expectTypeOf<ManagedVmExecStreamMode>().toEqualTypeOf<
			{ readonly kind: 'pipe' } | { readonly kind: 'discard' }
		>();
	});

	it('preserves buffered execution by omitting the grouped streaming field', () => {
		const bufferedExecOptions = {
			stdin: Uint8Array.from([1, 2, 3]),
		} satisfies ManagedVmExecOptions;

		expect(bufferedExecOptions).not.toHaveProperty('output');
		expectTypeOf<ManagedVmExecOptions['output']>().toEqualTypeOf<
			ManagedVmExecStreamingOptions | undefined
		>();
	});

	it('does not add a general filesystem capability to the neutral VM handle', () => {
		expectTypeOf<ManagedVm>().not.toHaveProperty('fs');
		expectTypeOf<ManagedVm>().not.toHaveProperty('getVmInstance');
		expect(true).toBe(true);
	});
});
