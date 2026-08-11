import path from 'node:path';

import { conditional, object, or } from '@optique/core/constructs';
import { runParser, type RunOptions } from '@optique/core/facade';
import { formatMessage } from '@optique/core/message';
import { map, optional } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { parseSync } from '@optique/core/parser';
import { command, option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { z } from 'zod';

const operationSchema = z.enum(['artifact-read', 'call', 'describe', 'list', 'search']);
const transportKindSchema = z.enum(['http', 'scoped-stdio']);
const environmentVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const toolPortalHttpEndpointSchema = z
	.string()
	.url()
	.refine((value) => {
		if (!URL.canParse(value)) return false;
		const url = new URL(value);
		return (
			(url.protocol === 'http:' || url.protocol === 'https:') &&
			url.username.length === 0 &&
			url.password.length === 0 &&
			url.hash.length === 0
		);
	}, 'Expected an HTTP(S) URL without credentials or a fragment.');
const absolutePathSchema = z.string().min(1).refine(path.isAbsolute, {
	message: 'Scoped stdio configuration path must be absolute.',
});

export type ToolPortalCliOperation = z.infer<typeof operationSchema>;

export interface ToolPortalHttpTransportArguments {
	readonly authorizationEnvironmentName: string;
	readonly endpoint: string;
	readonly kind: 'http';
}

export interface ToolPortalScopedStdioTransportArguments {
	readonly kind: 'scoped-stdio';
	readonly scopedStdioConfigPath: string;
}

export type ToolPortalCliTransport =
	| ToolPortalHttpTransportArguments
	| ToolPortalScopedStdioTransportArguments;

type ToolPortalNonCallOperation = Exclude<ToolPortalCliOperation, 'call'>;

export type ToolPortalCliArguments =
	| {
			readonly approvalTokenEnvironmentName?: string;
			readonly inputJson: string;
			readonly operation: 'call';
			readonly transport: ToolPortalCliTransport;
	  }
	| {
			readonly inputJson: string;
			readonly operation: ToolPortalNonCallOperation;
			readonly transport: ToolPortalCliTransport;
	  };

export type ToolPortalCliParseResult =
	| { readonly kind: 'parsed'; readonly value: ToolPortalCliArguments }
	| { readonly kind: 'help'; readonly exitCode: 0 }
	| { readonly kind: 'parse-error'; readonly exitCode: number };

export interface ToolPortalCliParserIo {
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

function createEnvironmentVariableNameParser(): ReturnType<typeof zod<string>> {
	return zod(environmentVariableNameSchema, {
		metavar: 'ENV_NAME',
		placeholder: 'TOOL_PORTAL_AUTH',
	});
}

function createInputJsonParser(): ReturnType<typeof zod<string>> {
	return zod(z.string().min(1), {
		metavar: 'JSON',
		placeholder: '{}',
	});
}

function createHttpTransportParser(): Parser<'sync', ToolPortalHttpTransportArguments> {
	const httpTransportOptionsParser = object({
		authorizationEnvironmentName: option(
			'--authorization-env',
			createEnvironmentVariableNameParser(),
		),
		endpoint: option(
			'--endpoint',
			zod(toolPortalHttpEndpointSchema, {
				metavar: 'URL',
				placeholder: 'https://example.test/mcp',
			}),
		),
	});
	return map(
		httpTransportOptionsParser,
		(options): ToolPortalHttpTransportArguments => ({
			...options,
			kind: 'http',
		}),
	);
}

function createScopedStdioTransportParser(): Parser<
	'sync',
	ToolPortalScopedStdioTransportArguments
> {
	const scopedStdioTransportOptionsParser = object({
		scopedStdioConfigPath: option(
			'--stdio-config',
			zod(absolutePathSchema, {
				metavar: 'PATH',
				placeholder: '/tmp/tool-portal.json',
			}),
		),
	});
	return map(
		scopedStdioTransportOptionsParser,
		(options): ToolPortalScopedStdioTransportArguments => ({
			...options,
			kind: 'scoped-stdio',
		}),
	);
}

function createTransportParser(): Parser<'sync', ToolPortalCliTransport> {
	const transportSelectionParser = conditional(
		option(
			'--transport',
			zod(transportKindSchema, {
				metavar: 'TRANSPORT',
				placeholder: 'http',
			}),
		),
		{
			http: createHttpTransportParser(),
			'scoped-stdio': createScopedStdioTransportParser(),
		},
	);
	return map(transportSelectionParser, ([, transport]): ToolPortalCliTransport => transport);
}

function createInputJsonOption(): Parser<'sync', string> {
	return option('--input-json', createInputJsonParser());
}

function createCallCommand(): Parser<'sync', ToolPortalCliArguments> {
	return command(
		'call',
		map(
			object({
				approvalTokenEnvironmentName: optional(
					option('--approval-token-env', createEnvironmentVariableNameParser()),
				),
				inputJson: createInputJsonOption(),
				transport: createTransportParser(),
			}),
			({ approvalTokenEnvironmentName, inputJson, transport }): ToolPortalCliArguments => ({
				...(approvalTokenEnvironmentName === undefined ? {} : { approvalTokenEnvironmentName }),
				inputJson,
				operation: 'call',
				transport,
			}),
		),
	);
}

function createNonCallCommand(
	operation: ToolPortalNonCallOperation,
): Parser<'sync', ToolPortalCliArguments> {
	return command(
		operation,
		map(
			object({
				inputJson: createInputJsonOption(),
				transport: createTransportParser(),
			}),
			({ inputJson, transport }): ToolPortalCliArguments => ({
				inputJson,
				operation,
				transport,
			}),
		),
	);
}

export const toolPortalCliParser: Parser<'sync', ToolPortalCliArguments> = or(
	createNonCallCommand('artifact-read'),
	createCallCommand(),
	createNonCallCommand('describe'),
	createNonCallCommand('list'),
	createNonCallCommand('search'),
);

type ToolPortalCliRunnerSignal = Exclude<ToolPortalCliParseResult, { readonly kind: 'parsed' }>;

class ToolPortalCliRunnerSignalError extends Error {
	readonly signal: ToolPortalCliRunnerSignal;

	constructor(signal: ToolPortalCliRunnerSignal) {
		super(`Tool Portal CLI runner signal: ${signal.kind}`);
		this.signal = signal;
	}
}

function writeOutput(write: ToolPortalCliParserIo['stdout'], text: string): void {
	write.write(text.endsWith('\n') ? text : `${text}\n`);
}

function createRunOptions(io: ToolPortalCliParserIo): RunOptions<never, never> {
	return {
		help: {
			command: true,
			option: { names: ['-h', '--help'] as const },
			onShow: (): never => {
				throw new ToolPortalCliRunnerSignalError({ exitCode: 0, kind: 'help' });
			},
		},
		onError: (exitCode: number): never => {
			throw new ToolPortalCliRunnerSignalError({ exitCode, kind: 'parse-error' });
		},
		stderr: (text: string): void => writeOutput(io.stderr, text),
		stdout: (text: string): void => writeOutput(io.stdout, text),
	};
}

export function runToolPortalCliParser(
	argv: readonly string[],
	io: ToolPortalCliParserIo,
): ToolPortalCliParseResult {
	try {
		return {
			kind: 'parsed',
			value: runParser(toolPortalCliParser, 'tool-portal', argv, createRunOptions(io)),
		};
	} catch (error: unknown) {
		if (error instanceof ToolPortalCliRunnerSignalError) return error.signal;
		throw error;
	}
}

export function parseToolPortalCliArguments(argv: readonly string[]): ToolPortalCliArguments {
	const result = parseSync(toolPortalCliParser, argv);
	if (!result.success) {
		throw new Error(formatMessage(result.error));
	}
	return result.value;
}
