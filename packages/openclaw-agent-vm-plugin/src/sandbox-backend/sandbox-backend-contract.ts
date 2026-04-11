import type { GondolinLeaseResponse, LeaseClient } from '../controller-lease-client.js';

export function isGondolinLeaseResponse(value: unknown): value is GondolinLeaseResponse {
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

export interface FsBridgeLeaseContext {
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

export interface GondolinFsBridge {
	mkdirp(params: {
		readonly cwd?: string;
		readonly filePath: string;
		readonly signal?: AbortSignal;
	}): Promise<void>;
	readFile(params: {
		readonly cwd?: string;
		readonly filePath: string;
		readonly signal?: AbortSignal;
	}): Promise<Buffer>;
	remove(params: {
		readonly cwd?: string;
		readonly filePath: string;
		readonly force?: boolean;
		readonly recursive?: boolean;
		readonly signal?: AbortSignal;
	}): Promise<void>;
	rename(params: {
		readonly cwd?: string;
		readonly from: string;
		readonly signal?: AbortSignal;
		readonly to: string;
	}): Promise<void>;
	resolvePath(params: { readonly cwd?: string; readonly filePath: string }): {
		readonly containerPath: string;
		readonly relativePath: string;
	};
	stat(params: {
		readonly cwd?: string;
		readonly filePath: string;
		readonly signal?: AbortSignal;
	}): Promise<{
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

export interface CreateBackendDependencies {
	readonly buildExecSpec: (params: {
		readonly command: string;
		readonly env: Record<string, string>;
		readonly ssh: GondolinLeaseResponse['ssh'];
		readonly usePty: boolean;
		readonly workdir: string;
	}) => Promise<{
		readonly argv: string[];
		readonly env: Record<string, string>;
		readonly finalizeToken?: unknown;
		readonly stdinMode: 'pipe-open' | 'pipe-closed';
	}>;
	readonly createFsBridgeBuilder?: (
		leaseContext: FsBridgeLeaseContext,
	) => (params: { readonly sandbox: unknown }) => GondolinFsBridge;
	readonly createLeaseClient?: (options: { readonly controllerUrl: string }) => LeaseClient;
	readonly runRemoteShellScript: (params: {
		readonly allowFailure?: boolean;
		readonly script: string;
		readonly signal?: AbortSignal;
		readonly ssh: GondolinLeaseResponse['ssh'];
		readonly stdin?: Buffer | string;
	}) => Promise<{
		readonly code: number;
		readonly stderr: Buffer;
		readonly stdout: Buffer;
	}>;
}

export interface GondolinSandboxBackendHandle {
	readonly configLabel?: string;
	readonly configLabelKind?: string;
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
		readonly finalizeToken?: unknown;
		readonly stdinMode: 'pipe-open' | 'pipe-closed';
	}>;
	finalizeExec?: (params: {
		readonly exitCode: number | null;
		readonly status: 'completed' | 'failed';
		readonly timedOut: boolean;
		readonly token?: unknown;
	}) => Promise<void>;
	runShellCommand(params: { readonly script: string }): Promise<{
		readonly code: number;
		readonly stderr: Buffer;
		readonly stdout: Buffer;
	}>;
}

export interface CachedScopeEntry {
	readonly handle: GondolinSandboxBackendHandle;
	readonly lease: GondolinLeaseResponse;
}
