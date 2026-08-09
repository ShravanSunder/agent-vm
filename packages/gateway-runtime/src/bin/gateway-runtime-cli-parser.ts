import path from 'node:path';

import { object } from '@optique/core/constructs';
import { runParser, type RunOptions } from '@optique/core/facade';
import { message } from '@optique/core/message';
import { map } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { z } from 'zod';

export interface GatewayRuntimeCliIo {
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

export interface GatewayRuntimeStartCommand {
	readonly command: 'start';
	readonly options: {
		readonly config: string;
	};
}

export type GatewayRuntimeCliCommand = GatewayRuntimeStartCommand;

export type GatewayRuntimeCliParseResult =
	| {
			readonly kind: 'parsed';
			readonly value: GatewayRuntimeCliCommand;
	  }
	| {
			readonly kind: 'help';
			readonly exitCode: 0;
	  }
	| {
			readonly kind: 'parse-error';
			readonly exitCode: number;
	  };

const absoluteConfigPathSchema = z
	.string()
	.refine((value) => path.isAbsolute(value), {
		message: 'Gateway runtime config path must be absolute.',
	})
	.refine((value) => !value.includes('\0'), {
		message: 'Gateway runtime config path must contain no NUL bytes.',
	});

const gatewayRuntimeCliParser: Parser<'sync', GatewayRuntimeCliCommand> = map(
	object({
		config: option(
			'--config',
			zod(absoluteConfigPathSchema, {
				metavar: 'ABSOLUTE_CONFIG_PATH',
				placeholder: '/tmp/gateway-runtime.json',
			}),
			{
				description: message`Path to the Gateway Runtime service configuration JSON`,
			},
		),
	}),
	(options): GatewayRuntimeStartCommand => ({ command: 'start', options }),
);

type GatewayRuntimeCliRunnerSignal = Exclude<
	GatewayRuntimeCliParseResult,
	{ readonly kind: 'parsed' }
>;

class GatewayRuntimeCliRunnerSignalError extends Error {
	readonly signal: GatewayRuntimeCliRunnerSignal;

	constructor(signal: GatewayRuntimeCliRunnerSignal) {
		super(`Gateway Runtime CLI runner signal: ${signal.kind}`);
		this.name = 'GatewayRuntimeCliRunnerSignalError';
		this.signal = signal;
	}
}

function writeParserOutput(write: GatewayRuntimeCliIo['stdout'], text: string): void {
	write.write(text.endsWith('\n') ? text : `${text}\n`);
}

function createRunOptions(io: GatewayRuntimeCliIo): RunOptions<never, never> {
	return {
		help: {
			command: true,
			option: { names: ['-h', '--help'] as const },
			onShow: (): never => {
				throw new GatewayRuntimeCliRunnerSignalError({ exitCode: 0, kind: 'help' });
			},
		},
		onError: (exitCode: number): never => {
			throw new GatewayRuntimeCliRunnerSignalError({ kind: 'parse-error', exitCode });
		},
		stderr: (text: string): void => writeParserOutput(io.stderr, text),
		stdout: (text: string): void => writeParserOutput(io.stdout, text),
	};
}

export function runGatewayRuntimeCliParser(
	argv: readonly string[],
	io: GatewayRuntimeCliIo,
): GatewayRuntimeCliParseResult {
	try {
		return {
			kind: 'parsed',
			value: runParser(
				gatewayRuntimeCliParser,
				'agent-vm-gateway-runtime',
				argv,
				createRunOptions(io),
			),
		};
	} catch (error: unknown) {
		if (error instanceof GatewayRuntimeCliRunnerSignalError) return error.signal;
		throw error;
	}
}
