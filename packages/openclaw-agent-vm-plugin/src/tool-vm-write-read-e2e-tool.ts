import type {
	OpenClawHttpRouteRegistrationApi,
	OpenClawPluginToolContext,
} from './openclaw-sandbox-sdk-contract.js';
import type { createGondolinSandboxBackendFactory } from './sandbox-backend-factory.js';

export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV = 'AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE';
export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH = '/__agent-vm/e2e/tool-vm-write-read';

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
				: params.filePath,
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
	if (typeof params.agentId !== 'string' || params.agentId.length === 0) {
		throw new Error('tool-vm-write-read-e2e: agentId is required.');
	}
	if (typeof params.sessionKey !== 'string' || params.sessionKey.length === 0) {
		throw new Error('tool-vm-write-read-e2e: sessionKey is required.');
	}
	const probeParams = readProbeParams(params);
	return {
		agentId: params.agentId,
		filePath: probeParams.filePath,
		marker: probeParams.marker,
		sessionKey: params.sessionKey,
	};
}

async function readRequestBody(request: AsyncIterable<Buffer | string>): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
	}
	const bodyText = Buffer.concat(chunks).toString('utf8');
	return bodyText.length === 0 ? {} : JSON.parse(bodyText);
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
	const registerHttpRoute = options.api.registerHttpRoute;
	if (typeof registerHttpRoute !== 'function') {
		throw new Error('tool-vm-write-read-e2e: OpenClaw did not provide registerHttpRoute.');
	}
	registerHttpRoute({
		auth: 'plugin',
		handler: async (request, response) => {
			try {
				const routeParams = readRouteParams(await readRequestBody(request));
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
				response.statusCode = 500;
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
