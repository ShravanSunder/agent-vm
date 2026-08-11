import { object, or } from '@optique/core/constructs';
import { runParser, type RunOptions } from '@optique/core/facade';
import { formatMessage, message } from '@optique/core/message';
import { map, multiple, optional, withDefault } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { parseSync } from '@optique/core/parser';
import { argument, command, option } from '@optique/core/primitives';
import type { NonEmptyString } from '@optique/core/valueparser';
import { zod } from '@optique/zod';
import { z } from 'zod';

import type { PortalCoreToolName } from '../core/portal-core.js';
import type { PortalServerCliArgs } from './serve-command.js';

const nonEmptyStringSchema = z.string().min(1);
const portSchema = z.coerce.number().int().min(0).max(65_535);
const agentOverrideSchema = z.string().regex(/^[^=]+=[^=]+$/u);
const credentialProxyUrlSchema = z
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
	}, 'Expected an HTTP(S) URL without credentials or a fragment.')
	.transform((value) => new URL(value).toString());
const portalToolNameSchema = z.enum([
	'mcp_portal_list',
	'mcp_portal_search',
	'mcp_portal_describe',
	'mcp_portal_call',
]);

function stringValueParser(
	metavar: NonEmptyString,
	placeholder: string,
): ReturnType<typeof zod<string>> {
	return zod(nonEmptyStringSchema, { metavar, placeholder });
}

function portValueParser(): ReturnType<typeof zod<number>> {
	return zod(portSchema, { metavar: 'PORT', placeholder: 18_791 });
}

function agentOverrideValueParser(): ReturnType<typeof zod<string>> {
	return zod(agentOverrideSchema, {
		metavar: 'AGENT=PROFILE',
		placeholder: 'agent=profile',
	});
}

function credentialProxyUrlValueParser(): ReturnType<typeof zod<string>> {
	return zod(credentialProxyUrlSchema, {
		metavar: 'URL',
		placeholder: 'http://localhost',
	});
}

export interface ValidateCommand {
	readonly command: 'validate';
	readonly options: {
		readonly catalogPath: string;
	};
}

export interface GenerateHelperCommand {
	readonly command: 'generate-helper';
	readonly options: {
		readonly catalogPath: string;
		readonly outputDirectory: string;
	};
}

export interface CallCommand {
	readonly command: 'call';
	readonly options: {
		readonly agentId: string;
		readonly configDir: string;
		readonly inputPath: string;
		readonly toolName: PortalCoreToolName;
	};
}

export interface PrintClientConfigCommand {
	readonly command: 'mcp-proxy.print-client-config';
	readonly options: {
		readonly agentId: string;
		readonly configDir: string;
		readonly expectedFingerprint: string;
		readonly proxyUrl?: string;
	};
}

export interface WriteCredentialCommand {
	readonly command: 'mcp-proxy.write-credential';
	readonly options: {
		readonly agentId?: string;
		readonly configDir?: string;
		readonly expectedFingerprint?: string;
		readonly outputPath?: string;
	};
}

export interface ServeCommand {
	readonly command: 'mcp-proxy.serve';
	readonly options: PortalServerCliArgs;
}

export type McpPortalCommand =
	| CallCommand
	| GenerateHelperCommand
	| PrintClientConfigCommand
	| ServeCommand
	| ValidateCommand
	| WriteCredentialCommand;

export type McpPortalCliParseResult =
	| { readonly kind: 'parsed'; readonly value: McpPortalCommand }
	| { readonly kind: 'help'; readonly exitCode: 0 }
	| { readonly kind: 'parse-error'; readonly exitCode: number };

export interface McpPortalCliParserIo {
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

function createValidateCommand(): Parser<'sync', ValidateCommand> {
	return command(
		'validate',
		map(
			object({
				catalogPath: argument(stringValueParser('CATALOG', 'catalog.json'), {
					description: message`Catalog JSON file to validate`,
				}),
			}),
			(options): ValidateCommand => ({ command: 'validate', options }),
		),
		{ description: message`Validate a portal catalog JSON file` },
	);
}

function createGenerateHelperCommand(): Parser<'sync', GenerateHelperCommand> {
	return command(
		'generate-helper',
		map(
			object({
				catalogPath: argument(stringValueParser('CATALOG', 'catalog.json'), {
					description: message`Catalog JSON file to generate helpers from`,
				}),
				outputDirectory: option('--out', stringValueParser('DIRECTORY', 'generated'), {
					description: message`Directory for generated catalog files`,
				}),
			}),
			(options): GenerateHelperCommand => ({ command: 'generate-helper', options }),
		),
		{ description: message`Generate catalog JSON and TypeScript helpers` },
	);
}

function createCallCommand(): Parser<'sync', CallCommand> {
	return command(
		'call',
		map(
			object({
				agentId: option('--agent', stringValueParser('AGENT_ID', 'agent')),
				configDir: option('--config-dir', stringValueParser('DIRECTORY', 'config')),
				inputPath: option('--input', stringValueParser('JSON', 'request.json')),
				toolName: withDefault(
					option(
						'--tool',
						zod<PortalCoreToolName>(portalToolNameSchema, {
							metavar: 'PORTAL_TOOL',
							placeholder: 'mcp_portal_call',
						}),
					),
					'mcp_portal_call',
				),
			}),
			(options): CallCommand => ({ command: 'call', options }),
		),
		{ description: message`Call a portal tool through the configured upstreams` },
	);
}

function createPrintClientConfigCommand(): Parser<'sync', PrintClientConfigCommand> {
	return command(
		'print-client-config',
		map(
			object({
				agentId: option('--agent', stringValueParser('AGENT_ID', 'agent')),
				configDir: option('--config-dir', stringValueParser('DIRECTORY', 'config')),
				expectedFingerprint: option(
					'--master-key-fingerprint',
					stringValueParser('FINGERPRINT', 'sha256:...'),
				),
				proxyUrl: optional(option('--proxy-url', credentialProxyUrlValueParser())),
			}),
			({ agentId, configDir, expectedFingerprint, proxyUrl }): PrintClientConfigCommand => ({
				command: 'mcp-proxy.print-client-config',
				options: {
					agentId,
					configDir,
					expectedFingerprint,
					...(proxyUrl === undefined ? {} : { proxyUrl }),
				},
			}),
		),
		{ description: message`Print an MCP Portal client configuration` },
	);
}

function createWriteCredentialCommand(): Parser<'sync', WriteCredentialCommand> {
	return command(
		'write-credential',
		map(
			object({
				agentId: optional(option('--agent', stringValueParser('AGENT_ID', 'agent'))),
				configDir: optional(option('--config-dir', stringValueParser('DIRECTORY', 'config'))),
				expectedFingerprint: optional(
					option('--master-key-fingerprint', stringValueParser('FINGERPRINT', 'sha256:...')),
				),
				outputPath: optional(option('--out', stringValueParser('PATH', 'credential.json'))),
			}),
			({ agentId, configDir, expectedFingerprint, outputPath }): WriteCredentialCommand => ({
				command: 'mcp-proxy.write-credential',
				options: {
					...(agentId === undefined ? {} : { agentId }),
					...(configDir === undefined ? {} : { configDir }),
					...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
					...(outputPath === undefined ? {} : { outputPath }),
				},
			}),
		),
		{ description: message`Persist an MCP Portal credential (disabled)` },
	);
}

function createPortalServerOptionsParser(): Parser<'sync', PortalServerCliArgs> {
	return map(
		object({
			agentOverrides: multiple(
				option('--agent', agentOverrideValueParser(), {
					description: message`Override an agent's configured profile at startup`,
				}),
			),
			configDir: option('--config-dir', stringValueParser('DIRECTORY', 'config')),
			port: optional(option('-p', '--port', portValueParser())),
		}),
		({ agentOverrides, configDir, port }): PortalServerCliArgs => ({
			agentOverrides,
			configDir,
			...(port === undefined ? {} : { port }),
		}),
	);
}

function createServeCommand(): Parser<'sync', ServeCommand> {
	return command(
		'serve',
		map(
			createPortalServerOptionsParser(),
			(options): ServeCommand => ({
				command: 'mcp-proxy.serve',
				options,
			}),
		),
		{ description: message`Start the external MCP Portal proxy server` },
	);
}

function createMcpProxyCommand(): Parser<'sync', McpPortalCommand> {
	return command(
		'mcp-proxy',
		or(createPrintClientConfigCommand(), createServeCommand(), createWriteCredentialCommand()),
	);
}

export const mcpPortalCliParser: Parser<'sync', McpPortalCommand> = or(
	createCallCommand(),
	createGenerateHelperCommand(),
	createMcpProxyCommand(),
	createValidateCommand(),
);

export const portalServerCliParser: Parser<'sync', PortalServerCliArgs> =
	createPortalServerOptionsParser();

type McpPortalCliRunnerSignal = Exclude<McpPortalCliParseResult, { readonly kind: 'parsed' }>;

class McpPortalCliRunnerSignalError extends Error {
	readonly signal: McpPortalCliRunnerSignal;

	constructor(signal: McpPortalCliRunnerSignal) {
		super(`MCP Portal CLI runner signal: ${signal.kind}`);
		this.name = 'McpPortalCliRunnerSignalError';
		this.signal = signal;
	}
}

function writeParserOutput(write: McpPortalCliParserIo['stdout'], text: string): void {
	write.write(text.endsWith('\n') ? text : `${text}\n`);
}

function createRunOptions(io: McpPortalCliParserIo): RunOptions<never, never> {
	return {
		help: {
			command: true,
			option: { names: ['-h', '--help'] as const },
			onShow: (): never => {
				throw new McpPortalCliRunnerSignalError({ exitCode: 0, kind: 'help' });
			},
		},
		onError: (exitCode: number): never => {
			throw new McpPortalCliRunnerSignalError({ exitCode, kind: 'parse-error' });
		},
		stderr: (text: string): void => writeParserOutput(io.stderr, text),
		stdout: (text: string): void => writeParserOutput(io.stdout, text),
	};
}

export function runMcpPortalCliParser(
	argv: readonly string[],
	io: McpPortalCliParserIo,
): McpPortalCliParseResult {
	try {
		return {
			kind: 'parsed',
			value: runParser(mcpPortalCliParser, 'mcp-portal', argv, createRunOptions(io)),
		};
	} catch (error: unknown) {
		if (error instanceof McpPortalCliRunnerSignalError) {
			return error.signal;
		}
		throw error;
	}
}

export function parsePortalServerCliArgs(argv: readonly string[]): PortalServerCliArgs {
	if (argv.length === 0) {
		throw new Error('--config-dir <path> is required.');
	}
	const result = parseSync(portalServerCliParser, argv);
	if (!result.success) {
		throw new Error(formatMessage(result.error));
	}
	return result.value;
}
