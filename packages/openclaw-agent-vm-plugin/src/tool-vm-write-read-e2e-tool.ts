import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
	OpenClawHttpRouteRegistrationApi,
	OpenClawPluginToolContext,
} from './openclaw-sandbox-sdk-contract.js';
import type { createGondolinSandboxBackendFactory } from './sandbox-backend-factory.js';

export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV = 'AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE';
export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV =
	'AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY';
export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH = '/__agent-vm/e2e/tool-vm-write-read';
export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER =
	'x-agent-vm-e2e-tool-vm-write-read-signature';
const maxRouteBodyBytes = 16 * 1024;
const proofFilePathPrefix = '.agent-vm/';

type GondolinSandboxBackendFactory = ReturnType<typeof createGondolinSandboxBackendFactory>;
type GondolinSandboxBackendFactoryProvider = () => Promise<GondolinSandboxBackendFactory>;

interface ToolVmWriteReadE2eProbeDetails {
	readonly agentId: string;
	readonly filePath: string;
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
	readonly sessionKey: string;
	readonly status: 'ok';
	readonly workdir: string;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function requireContextString(value: string | undefined, fieldName: string): string {
	if (value === undefined || value.length === 0) {
		throw new Error(`tool-vm-write-read-e2e: OpenClaw did not provide ${fieldName}.`);
	}
	return value;
}

class ToolVmWriteReadE2eRouteError extends Error {
	readonly statusCode: number;

	constructor(message: string, statusCode: number) {
		super(message);
		this.name = 'ToolVmWriteReadE2eRouteError';
		this.statusCode = statusCode;
	}
}

function signToolVmWriteReadE2eRouteBody(bodyText: string, key: string): string {
	return createHmac('sha256', key).update(bodyText, 'utf8').digest('base64url');
}

function verifyToolVmWriteReadE2eRouteBody(options: {
	readonly bodyText: string;
	readonly key: string;
	readonly signature: string | undefined;
}): void {
	if (options.signature === undefined || options.signature.length === 0) {
		throw new ToolVmWriteReadE2eRouteError('tool-vm-write-read-e2e: missing proof signature.', 401);
	}
	const expectedSignature = signToolVmWriteReadE2eRouteBody(options.bodyText, options.key);
	const expected = Buffer.from(expectedSignature, 'utf8');
	const received = Buffer.from(options.signature, 'utf8');
	if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
		throw new ToolVmWriteReadE2eRouteError('tool-vm-write-read-e2e: invalid proof signature.', 403);
	}
}

function resolveProbeAgentIdFromSessionKey(sessionKey: string): string {
	const match = /^agent:([^:]+):/u.exec(sessionKey);
	if (match?.[1] === undefined || match[1].length === 0) {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: sessionKey must encode an agent id.',
			400,
		);
	}
	return match[1];
}

function normalizeProofFilePath(filePath: string): string {
	if (
		filePath.startsWith('/') ||
		filePath.includes('\0') ||
		filePath.split('/').some((segment) => segment === '..') ||
		!filePath.startsWith(proofFilePathPrefix)
	) {
		throw new ToolVmWriteReadE2eRouteError(
			`tool-vm-write-read-e2e: filePath must stay under ${proofFilePathPrefix}.`,
			400,
		);
	}
	return filePath;
}

function readProbeParams(params: unknown): {
	readonly filePath: string;
	readonly marker: string;
} {
	if (!isObjectRecord(params) || typeof params.marker !== 'string' || params.marker.length === 0) {
		throw new Error('tool-vm-write-read-e2e: marker is required.');
	}
	if (params.filePath !== undefined && typeof params.filePath !== 'string') {
		throw new Error('tool-vm-write-read-e2e: filePath must be a string when provided.');
	}
	return {
		filePath:
			params.filePath === undefined || params.filePath.length === 0
				? `.agent-vm/e2e-tool-vm-write-read-${Date.now().toString(36)}.txt`
				: normalizeProofFilePath(params.filePath),
		marker: params.marker,
	};
}

function readRouteParams(params: unknown): {
	readonly agentId: string;
	readonly filePath: string;
	readonly marker: string;
	readonly sessionKey: string;
} {
	if (!isObjectRecord(params)) {
		throw new Error('tool-vm-write-read-e2e: request body must be an object.');
	}
	if (typeof params.sessionKey !== 'string' || params.sessionKey.length === 0) {
		throw new Error('tool-vm-write-read-e2e: sessionKey is required.');
	}
	const probeParams = readProbeParams(params);
	const agentId = resolveProbeAgentIdFromSessionKey(params.sessionKey);
	if (params.agentId !== undefined && params.agentId !== agentId) {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: body agentId does not match sessionKey agent.',
			403,
		);
	}
	return {
		agentId,
		filePath: probeParams.filePath,
		marker: probeParams.marker,
		sessionKey: params.sessionKey,
	};
}

async function readRequestBodyText(request: AsyncIterable<Buffer | string>): Promise<string> {
	const chunks: Buffer[] = [];
	let byteLength = 0;
	for await (const chunk of request) {
		const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
		byteLength += chunkBuffer.byteLength;
		if (byteLength > maxRouteBodyBytes) {
			throw new ToolVmWriteReadE2eRouteError(
				'tool-vm-write-read-e2e: request body too large.',
				413,
			);
		}
		chunks.push(chunkBuffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function readHeaderValue(
	headers: Readonly<Record<string, string | readonly string[] | undefined>>,
	headerName: string,
): string | undefined {
	const value = headers[headerName];
	if (typeof value === 'string') {
		return value;
	}
	if (!isReadonlyStringArray(value)) {
		return undefined;
	}
	const firstValue: string | undefined = value[0];
	return typeof firstValue === 'string' ? firstValue : undefined;
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

async function runToolVmWriteReadE2eProbe(options: {
	readonly context: OpenClawPluginToolContext;
	readonly factoryProvider: GondolinSandboxBackendFactoryProvider;
	readonly params: {
		readonly filePath: string;
		readonly marker: string;
	};
}): Promise<ToolVmWriteReadE2eProbeDetails> {
	const agentId = requireContextString(options.context.agentId, 'agentId');
	const sessionKey =
		options.context.sessionKey === undefined || options.context.sessionKey.length === 0
			? `agent:${agentId}:tool-vm-write-read:${Date.now().toString(36)}`
			: options.context.sessionKey;
	const agentWorkspaceDir =
		options.context.agentDir ?? options.context.workspaceDir ?? `/zone/agents/${agentId}`;
	const workspaceDir = options.context.workspaceDir ?? agentWorkspaceDir;
	const factory = await options.factoryProvider();
	const backend = await factory({
		agentWorkspaceDir,
		cfg: {
			backend: 'gondolin',
			mode: 'all',
			scope: 'agent',
			workspaceAccess: 'rw',
		},
		scopeKey: sessionKey,
		sessionKey,
		workspaceDir,
	});
	const commandResult = await backend.runShellCommand({
		script: [
			'set -eu',
			`proof_file=${shellSingleQuote(options.params.filePath)}`,
			`proof_marker=${shellSingleQuote(options.params.marker)}`,
			'mkdir -p "$(dirname "$proof_file")"',
			'printf "%s" "$proof_marker" >"$proof_file"',
			'cat "$proof_file"',
		].join('\n'),
	});
	const readBack = commandResult.stdout.toString('utf8');
	if (commandResult.code !== 0) {
		throw new Error(
			`tool-vm-write-read-e2e: command failed with ${String(commandResult.code)}: ${commandResult.stderr.toString('utf8')}`,
		);
	}
	return {
		agentId,
		filePath: options.params.filePath,
		marker: options.params.marker,
		readBack,
		runtimeId: backend.runtimeId,
		sessionKey,
		status: 'ok',
		workdir: backend.workdir,
	};
}

export function registerToolVmWriteReadE2eRoute(options: {
	readonly api: {
		readonly registerHttpRoute: OpenClawHttpRouteRegistrationApi['registerHttpRoute'];
	};
	readonly factoryProvider: GondolinSandboxBackendFactoryProvider;
}): void {
	if (process.env[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV] !== '1') {
		return;
	}
	const proofKey = process.env[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV];
	if (proofKey === undefined || proofKey.length === 0) {
		throw new Error(
			`tool-vm-write-read-e2e: ${AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV} is required.`,
		);
	}
	const registerHttpRoute = options.api.registerHttpRoute;
	if (typeof registerHttpRoute !== 'function') {
		throw new Error('tool-vm-write-read-e2e: OpenClaw did not provide registerHttpRoute.');
	}
	registerHttpRoute({
		auth: 'plugin',
		handler: async (request, response) => {
			try {
				const bodyText = await readRequestBodyText(request);
				verifyToolVmWriteReadE2eRouteBody({
					bodyText,
					key: proofKey,
					signature: readHeaderValue(
						request.headers,
						AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER,
					),
				});
				const routeParams = readRouteParams(bodyText.length === 0 ? {} : JSON.parse(bodyText));
				const details = await runToolVmWriteReadE2eProbe({
					context: {
						agentDir: `/zone/agents/${routeParams.agentId}`,
						agentId: routeParams.agentId,
						sessionKey: routeParams.sessionKey,
						workspaceDir: `/zone/agents/${routeParams.agentId}`,
					},
					factoryProvider: options.factoryProvider,
					params: routeParams,
				});
				response.statusCode = 200;
				response.setHeader('cache-control', 'no-store');
				response.setHeader('content-type', 'application/json; charset=utf-8');
				response.end(JSON.stringify({ details, ok: true }));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				response.statusCode =
					error instanceof ToolVmWriteReadE2eRouteError ? error.statusCode : 500;
				response.setHeader('cache-control', 'no-store');
				response.setHeader('content-type', 'application/json; charset=utf-8');
				response.end(JSON.stringify({ error: { message }, ok: false }));
			}
			return true;
		},
		match: 'exact',
		path: AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH,
	});
}

export const testExports = {
	signToolVmWriteReadE2eRouteBody,
};
