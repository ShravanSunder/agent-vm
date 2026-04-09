import { createLeaseClient, type GondolinLeaseResponse, type LeaseClient } from './lease-client.js';

function isGondolinLeaseResponse(value: unknown): value is GondolinLeaseResponse {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { leaseId?: unknown }).leaseId === 'string' &&
		typeof (value as { tcpSlot?: unknown }).tcpSlot === 'number' &&
		typeof (value as { workdir?: unknown }).workdir === 'string' &&
		typeof (value as { ssh?: unknown }).ssh === 'object' &&
		(value as { ssh?: unknown }).ssh !== null
	);
}

/**
 * Context passed to the FS bridge builder after a lease is acquired.
 * Contains everything needed to construct remote shell-based file operations.
 */
interface FsBridgeLeaseContext {
	readonly remoteAgentWorkspaceDir: string;
	readonly remoteWorkspaceDir: string;
	readonly runRemoteShellScript: (params: {
		readonly allowFailure?: boolean;
		readonly args?: string[];
		readonly script: string;
		readonly signal?: AbortSignal;
		readonly stdin?: Buffer | string;
	}) => Promise<{
		readonly code: number;
		readonly stderr: Buffer;
		readonly stdout: Buffer;
	}>;
}

/**
 * The FS bridge returned by the builder. Matches the shape expected by
 * OpenClaw's SandboxBackendHandle.createFsBridge return type.
 */
interface GondolinFsBridge {
	mkdirp(params: { readonly cwd?: string; readonly filePath: string; readonly signal?: AbortSignal }): Promise<void>;
	readFile(params: { readonly cwd?: string; readonly filePath: string; readonly signal?: AbortSignal }): Promise<Buffer>;
	remove(params: {
		readonly cwd?: string;
		readonly filePath: string;
		readonly force?: boolean;
		readonly recursive?: boolean;
		readonly signal?: AbortSignal;
	}): Promise<void>;
	rename(params: { readonly cwd?: string; readonly from: string; readonly signal?: AbortSignal; readonly to: string }): Promise<void>;
	resolvePath(params: { readonly cwd?: string; readonly filePath: string }): { readonly containerPath: string; readonly relativePath: string };
	stat(params: { readonly cwd?: string; readonly filePath: string; readonly signal?: AbortSignal }): Promise<{
		readonly mtimeMs: number;
		readonly size: number;
		readonly type: 'directory' | 'file' | 'other';
	} | null>;
	writeFile(params: {
		readonly cwd?: string;
		readonly data: Buffer | string;
		readonly encoding?: BufferEncoding;
		readonly filePath: string;
		readonly mkdir?: boolean;
		readonly signal?: AbortSignal;
	}): Promise<void>;
}

interface CreateBackendDependencies {
	readonly buildExecSpec: (params: {
		readonly command: string;
		readonly env: Record<string, string>;
		readonly ssh: GondolinLeaseResponse['ssh'];
		readonly usePty: boolean;
		readonly workdir: string;
	}) => Promise<{
		readonly argv: string[];
		readonly env: Record<string, string>;
		readonly stdinMode: 'pipe-open' | 'pipe-closed';
	}>;
	readonly createFsBridgeBuilder?: (
		leaseContext: FsBridgeLeaseContext,
	) => (params: { readonly sandbox: unknown }) => GondolinFsBridge;
	readonly createLeaseClient?: (options: { readonly controllerUrl: string }) => LeaseClient;
	readonly runRemoteShellScript: (params: {
		readonly script: string;
		readonly ssh: GondolinLeaseResponse['ssh'];
	}) => Promise<{
		readonly code: number;
		readonly stderr: Buffer;
		readonly stdout: Buffer;
	}>;
}

interface GondolinSandboxBackendHandle {
	createFsBridge?: (params: { readonly sandbox: unknown }) => GondolinFsBridge;
	env?: Record<string, string>;
	readonly id: string;
	readonly runtimeId: string;
	readonly runtimeLabel: string;
	readonly workdir: string;
	buildExecSpec(params: {
		readonly command: string;
		readonly env: Record<string, string>;
		readonly usePty: boolean;
		readonly workdir?: string;
	}): Promise<{
		readonly argv: string[];
		readonly env: Record<string, string>;
		readonly stdinMode: 'pipe-open' | 'pipe-closed';
	}>;
	runShellCommand(params: { readonly script: string }): Promise<{
		readonly code: number;
		readonly stderr: Buffer;
		readonly stdout: Buffer;
	}>;
}

export function createGondolinSandboxBackendFactory(
	options: {
		readonly controllerUrl: string;
		readonly zoneId: string;
	},
	dependencies: CreateBackendDependencies,
): (params: {
	readonly agentWorkspaceDir: string;
	readonly cfg: {
		readonly docker?: {
			readonly env?: Record<string, string>;
		};
	};
	readonly scopeKey: string;
	readonly sessionKey: string;
	readonly workspaceDir: string;
}) => Promise<GondolinSandboxBackendHandle> {
	return async (params) => {
		const leaseClient =
			dependencies.createLeaseClient?.({
				controllerUrl: options.controllerUrl,
			}) ?? createLeaseClient({ controllerUrl: options.controllerUrl });
		const leaseResponse = await leaseClient.requestLease({
			agentWorkspaceDir: params.agentWorkspaceDir,
			profileId: 'standard',
			scopeKey: params.scopeKey,
			workspaceDir: params.workspaceDir,
			zoneId: options.zoneId,
		});
		if (!isGondolinLeaseResponse(leaseResponse)) {
			throw new TypeError('Controller lease API returned an unexpected response.');
		}
		const lease = leaseResponse;

		const boundRunRemoteShellScript: FsBridgeLeaseContext['runRemoteShellScript'] = async (
			shellParams,
		) => {
			const session = await dependencies.runRemoteShellScript({
				script: buildShellScriptWithArgs(shellParams.script, shellParams.args),
				ssh: lease.ssh,
			});
			return session;
		};

		const fsBridgeCreateFn = dependencies.createFsBridgeBuilder
			? dependencies.createFsBridgeBuilder({
					remoteAgentWorkspaceDir: lease.workdir,
					remoteWorkspaceDir: lease.workdir,
					runRemoteShellScript: boundRunRemoteShellScript,
				})
			: undefined;

		return {
			...(fsBridgeCreateFn
				? {
						createFsBridge: fsBridgeCreateFn,
					}
				: {}),
			...(params.cfg.docker?.env
				? {
						env: params.cfg.docker.env,
					}
				: {}),
			id: 'gondolin',
			runtimeId: lease.leaseId,
			runtimeLabel: lease.leaseId,
			workdir: lease.workdir,
			buildExecSpec: async (execParams) =>
				await dependencies.buildExecSpec({
					command: execParams.command,
					env: execParams.env,
					ssh: lease.ssh,
					usePty: execParams.usePty,
					workdir: execParams.workdir ?? lease.workdir,
				}),
			runShellCommand: async (commandParams) =>
				await dependencies.runRemoteShellScript({
					script: commandParams.script,
					ssh: lease.ssh,
				}),
		} satisfies GondolinSandboxBackendHandle;
	};
}

/**
 * Wraps a shell script with positional args by appending shell-escaped
 * arguments. The upstream runRemoteShellScript only accepts a flat script
 * string, so we inline args as `set -- <escaped args>; <script>`.
 */
function buildShellScriptWithArgs(script: string, args?: readonly string[]): string {
	if (!args || args.length === 0) {
		return script;
	}
	const escaped = args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
	return `set -- ${escaped}; ${script}`;
}

export type { CreateBackendDependencies, FsBridgeLeaseContext, GondolinFsBridge, GondolinSandboxBackendHandle };
