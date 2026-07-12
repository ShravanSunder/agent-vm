import type { AgentVmHealthEvent, ToolVmSshLease } from '@agent-vm/gateway-interface';

import type { LeaseClient, OpenClawRuntimeStatusReport } from '../lease-client-contract.js';

export interface OpenClawFsBridgeLeaseContext {
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

export interface OpenClawSandboxFsBridge {
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
		readonly ssh: ToolVmSshLease['ssh'];
		readonly usePty: boolean;
		readonly workdir: string;
	}) => Promise<{
		readonly argv: string[];
		readonly env: Record<string, string>;
		readonly finalizeToken?: unknown;
		readonly stdinMode: 'pipe-open' | 'pipe-closed';
	}>;
	readonly createFsBridgeBuilder?: (
		leaseContext: OpenClawFsBridgeLeaseContext,
	) => (params: { readonly sandbox: unknown }) => OpenClawSandboxFsBridge;
	readonly createLeaseClient: (options: { readonly controllerUrl: string }) => LeaseClient;
	readonly publishHealthEvent?: (event: AgentVmHealthEvent) => Promise<void>;
	readonly publishOpenClawRuntimeStatus?: (report: OpenClawRuntimeStatusReport) => Promise<void>;
	readonly runRemoteShellScript: (params: {
		readonly allowFailure?: boolean;
		readonly script: string;
		readonly signal?: AbortSignal;
		readonly ssh: ToolVmSshLease['ssh'];
		readonly stdin?: Buffer | string;
	}) => Promise<{
		readonly code: number;
		readonly stderr: Buffer;
		readonly stdout: Buffer;
	}>;
}

export interface OpenClawSandboxBackendHandle {
	readonly configLabel?: string;
	readonly configLabelKind?: string;
	readonly createFsBridge?: (params: { readonly sandbox: unknown }) => OpenClawSandboxFsBridge;
	readonly env?: Record<string, string>;
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
	readonly finalizeExec?: (params: {
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

export interface CachedAgentLeaseEntry {
	readonly agentWorkspaceDir: string;
	readonly lease: ToolVmSshLease;
	readonly leaseWorkMountDir: string;
	readonly profileId: string;
}
