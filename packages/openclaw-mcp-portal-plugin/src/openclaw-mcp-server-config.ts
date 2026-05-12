import type { NormalizedUpstreamMcpServer, UpstreamMcpTransportKind } from '@agent-vm/mcp-portal';

import { redactPortalSecrets } from './redaction.js';

export interface OpenClawMcpNormalizationDiagnostic {
	readonly message: string;
	readonly namespace: string;
}

export interface OpenClawMcpNormalizationResult {
	readonly diagnostics: readonly OpenClawMcpNormalizationDiagnostic[];
	readonly servers: readonly NormalizedUpstreamMcpServer[];
}

type OpenClawMcpServerInput = Readonly<Record<string, unknown>>;

const unsafeEnvKeys = new Set(['DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'NODE_OPTIONS']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	return value.filter((entry): entry is string => typeof entry === 'string');
}

function stringRecord(
	value: unknown,
	options: { readonly dropUnsafeEnv: boolean },
): Readonly<Record<string, string>> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !options.dropUnsafeEnv || !unsafeEnvKeys.has(key))
			.map(([key, recordValue]) => [key, String(recordValue)]),
	);
}

function resolveTransport(record: OpenClawMcpServerInput): UpstreamMcpTransportKind | null {
	const rawTransport = record.transport ?? record.type;
	if (rawTransport === undefined && typeof record.url === 'string') {
		return 'auto-http';
	}
	if (rawTransport === undefined && typeof record.command === 'string') {
		return 'stdio';
	}
	if (rawTransport === 'http' || rawTransport === 'streamable-http') {
		return 'streamable-http';
	}
	if (rawTransport === 'sse') {
		return 'sse';
	}
	if (rawTransport === 'stdio') {
		return 'stdio';
	}
	return null;
}

function normalizeServer(
	namespace: string,
	record: OpenClawMcpServerInput,
): NormalizedUpstreamMcpServer {
	const transport = resolveTransport(record);
	if (!transport) {
		throw new Error(`Unsupported MCP transport for namespace "${namespace}".`);
	}

	const connectionTimeoutMs =
		typeof record.connectionTimeoutMs === 'number' ? record.connectionTimeoutMs : undefined;
	if (transport === 'stdio') {
		if (typeof record.command !== 'string' || record.command.length === 0) {
			throw new Error(`MCP namespace "${namespace}" is missing command.`);
		}
		const args = stringArray(record.args);
		const env = stringRecord(record.env, { dropUnsafeEnv: true });
		const cwd = record.cwd ?? record.workingDirectory;

		return {
			...(args !== undefined ? { args } : {}),
			command: record.command,
			...(connectionTimeoutMs !== undefined ? { connectionTimeoutMs } : {}),
			...(typeof cwd === 'string' ? { cwd } : {}),
			...(env !== undefined ? { env } : {}),
			namespace,
			transport,
		};
	}

	if (typeof record.url !== 'string' || record.url.length === 0) {
		throw new Error(`MCP namespace "${namespace}" is missing url.`);
	}

	const headers = stringRecord(record.headers, { dropUnsafeEnv: false });
	return {
		...(connectionTimeoutMs !== undefined ? { connectionTimeoutMs } : {}),
		...(headers !== undefined ? { headers } : {}),
		namespace,
		transport,
		url: record.url,
	};
}

export function normalizeOpenClawMcpServers(value: unknown): OpenClawMcpNormalizationResult {
	if (!isRecord(value)) {
		return {
			diagnostics: [{ message: 'OpenClaw mcp.servers must be an object.', namespace: '<root>' }],
			servers: [],
		};
	}

	const diagnostics: OpenClawMcpNormalizationDiagnostic[] = [];
	const servers: NormalizedUpstreamMcpServer[] = [];
	for (const [namespace, record] of Object.entries(value).toSorted(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (!isRecord(record)) {
			diagnostics.push({ message: `MCP namespace "${namespace}" must be an object.`, namespace });
			continue;
		}

		try {
			servers.push(normalizeServer(namespace, record));
		} catch (error) {
			diagnostics.push({
				message: redactPortalSecrets(error instanceof Error ? error.message : String(error)),
				namespace,
			});
		}
	}

	return { diagnostics, servers };
}
