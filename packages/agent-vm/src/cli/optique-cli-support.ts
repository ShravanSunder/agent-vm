import { runParser, type RunOptions } from '@optique/core/facade';
import type { InferValue, Parser } from '@optique/core/parser';
import type { ValueParser } from '@optique/core/valueparser';
import { zod } from '@optique/zod';
import { z } from 'zod';

import { zoneIdSchema } from '../config/system-config.js';
import type { CliIo } from './agent-vm-cli-support.js';

export type OptiqueCliParseResult<TValue> =
	| {
			readonly kind: 'parsed';
			readonly value: TValue;
	  }
	| {
			readonly kind: 'help';
			readonly exitCode: 0;
	  }
	| {
			readonly kind: 'version';
			readonly exitCode: 0;
	  }
	| {
			readonly kind: 'parse-error';
			readonly exitCode: number;
	  };

export interface RunOptiqueCliParserOptions<TParser extends Parser> {
	readonly argv: readonly string[];
	readonly io: CliIo;
	readonly parser: TParser;
	readonly programName: string;
	readonly version?: string;
}

type OptiqueCliRunnerSignal = Exclude<OptiqueCliParseResult<never>, { readonly kind: 'parsed' }>;

class OptiqueCliRunnerSignalError extends Error {
	readonly signal: OptiqueCliRunnerSignal;

	constructor(signal: OptiqueCliRunnerSignal) {
		super(`Optique CLI runner signal: ${signal.kind}`);
		this.name = 'OptiqueCliRunnerSignalError';
		this.signal = signal;
	}
}

function writeOptiqueOutput(ioWrite: CliIo['stdout'], text: string): void {
	ioWrite.write(text.endsWith('\n') ? text : `${text}\n`);
}

function createRunOptions(io: CliIo, version: string | undefined): RunOptions<never, never> {
	return {
		help: {
			command: true,
			option: { names: ['-h', '--help'] as const },
			onShow: (): never => {
				throw new OptiqueCliRunnerSignalError({
					exitCode: 0,
					kind: 'help',
				});
			},
		},
		onError: (exitCode: number): never => {
			throw new OptiqueCliRunnerSignalError({
				exitCode,
				kind: 'parse-error',
			});
		},
		stderr: (text: string): void => {
			writeOptiqueOutput(io.stderr, text);
		},
		stdout: (text: string): void => {
			writeOptiqueOutput(io.stdout, text);
		},
		...(version === undefined
			? {}
			: {
					version: {
						value: version,
						option: { names: ['-v', '--version'] as const },
						onShow: (): never => {
							throw new OptiqueCliRunnerSignalError({
								exitCode: 0,
								kind: 'version',
							});
						},
					},
				}),
	};
}

export function runOptiqueCliParser<TParser extends Parser>(
	options: RunOptiqueCliParserOptions<TParser>,
): OptiqueCliParseResult<InferValue<TParser>> {
	try {
		const value = runParser(
			options.parser,
			options.programName,
			options.argv,
			createRunOptions(options.io, options.version),
		);
		return { kind: 'parsed', value };
	} catch (error: unknown) {
		if (error instanceof OptiqueCliRunnerSignalError) {
			return error.signal;
		}
		throw error;
	}
}

const configPathSchema = z.string().min(1);

export function createConfigPathValueParser(): ValueParser<'sync', string> {
	return zod(configPathSchema, {
		metavar: 'PATH',
		placeholder: 'config/system.json',
	});
}

export function createZoneIdValueParser(): ValueParser<'sync', string> {
	return zod(zoneIdSchema, {
		metavar: 'ZONE_ID',
		placeholder: 'zone-id',
	});
}
