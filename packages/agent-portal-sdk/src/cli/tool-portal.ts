#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
	PortalArtifactReadRequestSchema,
	type PortalArtifactReadResult,
} from '../artifact-surface/index.js';
import { encodeCanonicalJson } from '../portable-contracts/index.js';
import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
	type PortalCallResult,
	type PortalDescribeResult,
	type PortalListResult,
	type PortalSearchResult,
} from '../portal-call-surface/index.js';
import {
	ToolPortalMcpClient,
	type ToolPortalMcpTransport,
} from '../tool-portal-mcp-client/index.js';
import { createNodeToolPortalMcpTransport } from '../tool-portal-mcp-client/node-tool-portal-mcp-transport.js';

const OperationSchema = z.enum(['artifact-read', 'call', 'describe', 'list', 'search']);
const TransportKindSchema = z.enum(['http', 'scoped-stdio']);
const EnvironmentVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const canonicalResultGraceAfterInterruptMilliseconds = 250;
const ScopedStdioConfigSchema = z
	.object({
		argv: z.array(z.string()).max(128),
		executable: z.string().min(1),
		schemaVersion: z.literal(1),
	})
	.strict();

type ToolPortalCliOperation = z.infer<typeof OperationSchema>;
type ToolPortalCliInvocationResult =
	| { readonly kind: 'artifact-read'; readonly result: PortalArtifactReadResult }
	| {
			readonly kind: 'portal';
			readonly result:
				| PortalCallResult
				| PortalDescribeResult
				| PortalListResult
				| PortalSearchResult;
	  };

interface ToolPortalCliArguments {
	readonly approvalTokenEnvironmentName?: string;
	readonly authorizationEnvironmentName?: string;
	readonly endpoint?: string;
	readonly inputJson: string;
	readonly operation: ToolPortalCliOperation;
	readonly scopedStdioConfigPath?: string;
	readonly transportKind: z.infer<typeof TransportKindSchema>;
}

interface ToolPortalCliTransportResult {
	readonly authorization: string | undefined;
	readonly transport: ToolPortalMcpTransport;
}

function parseNamedOptions(argv: readonly string[]): ReadonlyMap<string, string> {
	const namedOptions = new Map<string, string>();
	for (let index = 1; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (name === undefined || value === undefined || !name.startsWith('--')) {
			throw new Error('Every Tool Portal CLI option requires one explicit value.');
		}
		if (namedOptions.has(name)) {
			throw new Error(`Duplicate Tool Portal CLI option: ${name}.`);
		}
		namedOptions.set(name, value);
	}
	return namedOptions;
}

function requireNamedOption(namedOptions: ReadonlyMap<string, string>, name: string): string {
	const value = namedOptions.get(name);
	if (value === undefined || value.length === 0) {
		throw new Error(`Missing required Tool Portal CLI option: ${name}.`);
	}
	return value;
}

function assertExactOptionNames(
	namedOptions: ReadonlyMap<string, string>,
	allowedNames: ReadonlySet<string>,
): void {
	for (const name of namedOptions.keys()) {
		if (!allowedNames.has(name)) {
			throw new Error(`Unknown Tool Portal CLI option: ${name}.`);
		}
	}
}

function parseCliArguments(argv: readonly string[]): ToolPortalCliArguments {
	const operation = OperationSchema.parse(argv[0]);
	const namedOptions = parseNamedOptions(argv);
	const inputJson = requireNamedOption(namedOptions, '--input-json');
	const transportKind = TransportKindSchema.parse(requireNamedOption(namedOptions, '--transport'));
	if (operation !== 'call' && namedOptions.has('--approval-token-env')) {
		throw new Error('Tool Portal approval tokens are accepted only for the call operation.');
	}

	if (transportKind === 'http') {
		assertExactOptionNames(
			namedOptions,
			new Set([
				'--approval-token-env',
				'--authorization-env',
				'--endpoint',
				'--input-json',
				'--transport',
			]),
		);
		return {
			...(namedOptions.has('--approval-token-env')
				? {
						approvalTokenEnvironmentName: EnvironmentVariableNameSchema.parse(
							requireNamedOption(namedOptions, '--approval-token-env'),
						),
					}
				: {}),
			authorizationEnvironmentName: EnvironmentVariableNameSchema.parse(
				requireNamedOption(namedOptions, '--authorization-env'),
			),
			endpoint: requireNamedOption(namedOptions, '--endpoint'),
			inputJson,
			operation,
			transportKind,
		};
	}

	assertExactOptionNames(
		namedOptions,
		new Set(['--approval-token-env', '--input-json', '--stdio-config', '--transport']),
	);
	const scopedStdioConfigPath = requireNamedOption(namedOptions, '--stdio-config');
	if (!path.isAbsolute(scopedStdioConfigPath)) {
		throw new Error('Scoped stdio configuration path must be absolute.');
	}
	return {
		...(namedOptions.has('--approval-token-env')
			? {
					approvalTokenEnvironmentName: EnvironmentVariableNameSchema.parse(
						requireNamedOption(namedOptions, '--approval-token-env'),
					),
				}
			: {}),
		inputJson,
		operation,
		scopedStdioConfigPath,
		transportKind,
	};
}

function parseHttpEndpoint(endpoint: string): URL {
	const parsedEndpoint = new URL(endpoint);
	if (
		!['http:', 'https:'].includes(parsedEndpoint.protocol) ||
		parsedEndpoint.username.length > 0 ||
		parsedEndpoint.password.length > 0 ||
		parsedEndpoint.hash.length > 0
	) {
		throw new Error(
			'Tool Portal HTTP endpoint must be an HTTP(S) URL without credentials or a fragment.',
		);
	}
	return parsedEndpoint;
}

async function createCliTransport(
	arguments_: ToolPortalCliArguments,
	environment: NodeJS.ProcessEnv,
): Promise<ToolPortalCliTransportResult> {
	if (arguments_.transportKind === 'http') {
		const environmentName = arguments_.authorizationEnvironmentName;
		const authorization = environmentName === undefined ? undefined : environment[environmentName];
		if (authorization === undefined || authorization.length === 0) {
			throw new Error('The explicit Tool Portal authorization environment variable is unset.');
		}
		if (arguments_.endpoint === undefined) {
			throw new Error('Tool Portal HTTP endpoint is required.');
		}
		return {
			authorization,
			transport: createNodeToolPortalMcpTransport({
				authorization,
				endpoint: parseHttpEndpoint(arguments_.endpoint),
				kind: 'http',
			}),
		};
	}

	if (arguments_.scopedStdioConfigPath === undefined) {
		throw new Error('Scoped stdio configuration path is required.');
	}
	const config = ScopedStdioConfigSchema.parse(
		JSON.parse(await readFile(arguments_.scopedStdioConfigPath, 'utf8')) as unknown,
	);
	return {
		authorization: undefined,
		transport: createNodeToolPortalMcpTransport({
			argv: config.argv,
			executable: config.executable,
			kind: 'scoped-stdio',
		}),
	};
}

async function invokePortalOperation(props: {
	readonly approvalToken?: string;
	readonly client: ToolPortalMcpClient;
	readonly operation: ToolPortalCliOperation;
	readonly publicRequest: unknown;
	readonly signal: AbortSignal;
}): Promise<ToolPortalCliInvocationResult> {
	const options = {
		resultGraceAfterAbortMs: canonicalResultGraceAfterInterruptMilliseconds,
		signal: props.signal,
	};
	switch (props.operation) {
		case 'artifact-read':
			return {
				kind: 'artifact-read',
				result: await props.client.artifacts.read(
					PortalArtifactReadRequestSchema.parse(props.publicRequest),
					options,
				),
			};
		case 'call':
			return {
				kind: 'portal',
				result: await props.client.call(PortalCallRequestSchema.parse(props.publicRequest), {
					...options,
					...(props.approvalToken === undefined ? {} : { approvalToken: props.approvalToken }),
				}),
			};
		case 'describe':
			return {
				kind: 'portal',
				result: await props.client.describe(
					PortalDescribeRequestSchema.parse(props.publicRequest),
					options,
				),
			};
		case 'list':
			return {
				kind: 'portal',
				result: await props.client.list(
					PortalListRequestSchema.parse(props.publicRequest),
					options,
				),
			};
		case 'search':
			return {
				kind: 'portal',
				result: await props.client.search(
					PortalSearchRequestSchema.parse(props.publicRequest),
					options,
				),
			};
	}
	throw new Error(`Unsupported Tool Portal CLI operation: ${String(props.operation)}.`);
}

function readApprovalToken(
	arguments_: ToolPortalCliArguments,
	environment: NodeJS.ProcessEnv,
): string | undefined {
	const environmentName = arguments_.approvalTokenEnvironmentName;
	if (environmentName === undefined) return undefined;
	const approvalToken = environment[environmentName];
	if (approvalToken === undefined || approvalToken.length === 0) {
		throw new Error('The explicit Tool Portal approval-token environment variable is unset.');
	}
	return z.string().min(1).max(16_384).parse(approvalToken);
}

function safeDiagnostic(error: unknown, secrets: readonly string[]): string {
	let message = error instanceof Error ? error.message : String(error);
	for (const secret of secrets) {
		if (secret.length > 0) message = message.replaceAll(secret, '[redacted]');
	}
	return message;
}

async function waitForCancellationNotificationFlush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function runToolPortalCli(
	argv: readonly string[],
	environment: NodeJS.ProcessEnv,
): Promise<number> {
	let authorization: string | undefined;
	let approvalToken: string | undefined;
	let client: ToolPortalMcpClient | undefined;
	const cancellation = new AbortController();
	const interrupt = (): void => cancellation.abort(new Error('Tool Portal CLI interrupted.'));
	process.once('SIGINT', interrupt);
	try {
		const cliArguments = parseCliArguments(argv);
		const transportResult = await createCliTransport(cliArguments, environment);
		authorization = transportResult.authorization;
		client = new ToolPortalMcpClient({ transport: transportResult.transport });
		await client.connect();
		const publicRequest = JSON.parse(cliArguments.inputJson) as unknown;
		approvalToken =
			cliArguments.operation === 'call' ? readApprovalToken(cliArguments, environment) : undefined;
		const invocation = await invokePortalOperation({
			...(approvalToken === undefined ? {} : { approvalToken }),
			client,
			operation: cliArguments.operation,
			publicRequest,
			signal: cancellation.signal,
		});
		process.stdout.write(`${encodeCanonicalJson(invocation.result)}\n`);
		const exitCode = invocation.kind === 'artifact-read' || invocation.result.ok ? 0 : 1;
		try {
			await client.close();
		} catch {
			// A canonical result already returned and remains authoritative after interrupt/close races.
		}
		client = undefined;
		return exitCode;
	} catch (error: unknown) {
		if (cancellation.signal.aborted) {
			await waitForCancellationNotificationFlush();
		}
		process.stderr.write(
			`tool-portal: ${safeDiagnostic(error, [
				...(authorization === undefined ? [] : [authorization]),
				...(approvalToken === undefined ? [] : [approvalToken]),
			])}\n`,
		);
		return 2;
	} finally {
		process.removeListener('SIGINT', interrupt);
		if (client !== undefined) {
			try {
				await client.close();
			} catch {
				// The primary diagnostic and exit class remain authoritative.
			}
		}
	}
}

process.exitCode = await runToolPortalCli(process.argv.slice(2), process.env);
