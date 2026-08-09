#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

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
import {
	runToolPortalCliParser,
	type ToolPortalCliArguments,
	type ToolPortalCliOperation,
} from './tool-portal-cli-parser.js';

const canonicalResultGraceAfterInterruptMilliseconds = 250;
const ScopedStdioConfigSchema = z
	.object({
		argv: z.array(z.string()).max(128),
		executable: z.string().min(1),
		schemaVersion: z.literal(1),
	})
	.strict();

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

interface ToolPortalCliTransportResult {
	readonly authorization: string | undefined;
	readonly transport: ToolPortalMcpTransport;
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
	if (arguments_.transport.kind === 'http') {
		const environmentName = arguments_.transport.authorizationEnvironmentName;
		const authorization = environmentName === undefined ? undefined : environment[environmentName];
		if (authorization === undefined || authorization.length === 0) {
			throw new Error('The explicit Tool Portal authorization environment variable is unset.');
		}
		return {
			authorization,
			transport: createNodeToolPortalMcpTransport({
				authorization,
				endpoint: parseHttpEndpoint(arguments_.transport.endpoint),
				kind: 'http',
			}),
		};
	}

	const config = ScopedStdioConfigSchema.parse(
		JSON.parse(await readFile(arguments_.transport.scopedStdioConfigPath, 'utf8')) as unknown,
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
	return assertNever(props.operation);
}

function assertNever(value: never): never {
	throw new Error(`Unsupported Tool Portal CLI operation: ${String(value)}.`);
}

function readApprovalToken(
	arguments_: Extract<ToolPortalCliArguments, { readonly operation: 'call' }>,
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
		const parseResult = runToolPortalCliParser(argv, {
			stderr: process.stderr,
			stdout: process.stdout,
		});
		if (parseResult.kind === 'help') return parseResult.exitCode;
		if (parseResult.kind === 'parse-error') return 2;
		const cliArguments = parseResult.value;
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
