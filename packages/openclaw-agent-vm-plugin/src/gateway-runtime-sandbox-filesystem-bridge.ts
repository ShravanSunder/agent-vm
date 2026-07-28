import path from 'node:path/posix';

import {
	SANDBOX_MAXIMUM_BINARY_BYTES,
	type GatewayRuntimeTrustedInvocationContext,
	type SandboxEnvironmentHandle,
} from '@agent-vm/agent-portal-sdk/contracts';

import type { OpenClawGatewayRuntimeSandboxClient } from './gateway-runtime-sandbox-backend.js';

const TOOL_VM_DEFAULT_WORKDIR = '/work';
const TOOL_VM_AGENT_WORKSPACE_ROOT = '/workspace';
const FILESYSTEM_READ_CHUNK_BYTES = 1024 * 1024;

export interface OpenClawGatewayRuntimeSandboxFilesystemBridge {
	readonly mkdirp: (params: {
		readonly cwd?: string;
		readonly filePath: string;
		readonly signal?: AbortSignal;
	}) => Promise<void>;
	readonly readFile: (params: {
		readonly cwd?: string;
		readonly filePath: string;
		readonly signal?: AbortSignal;
	}) => Promise<Buffer>;
	readonly remove: (params: {
		readonly cwd?: string;
		readonly filePath: string;
		readonly force?: boolean;
		readonly recursive?: boolean;
		readonly signal?: AbortSignal;
	}) => Promise<void>;
	readonly rename: (params: {
		readonly cwd?: string;
		readonly from: string;
		readonly signal?: AbortSignal;
		readonly to: string;
	}) => Promise<void>;
	readonly resolvePath: (params: { readonly cwd?: string; readonly filePath: string }) => {
		readonly containerPath: string;
		readonly relativePath: string;
	};
	readonly stat: (params: {
		readonly cwd?: string;
		readonly filePath: string;
		readonly signal?: AbortSignal;
	}) => Promise<{
		readonly mtimeMs: number;
		readonly size: number;
		readonly type: 'directory' | 'file' | 'other';
	} | null>;
	readonly writeFile: (params: {
		readonly cwd?: string;
		readonly data: Buffer | string;
		readonly encoding?: BufferEncoding;
		readonly filePath: string;
		readonly mkdir?: boolean;
		readonly signal?: AbortSignal;
	}) => Promise<void>;
}

function requestOptions(
	trustedContext: GatewayRuntimeTrustedInvocationContext,
	signal?: AbortSignal,
): {
	readonly signal?: AbortSignal;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
} {
	return signal === undefined ? { trustedContext } : { signal, trustedContext };
}

function binaryChunk(content: Uint8Array): {
	readonly byteLength: number;
	readonly contentBase64: string;
	readonly encoding: 'base64';
} {
	return {
		byteLength: content.byteLength,
		contentBase64: Buffer.from(content).toString('base64'),
		encoding: 'base64',
	};
}

function resolveGuestPath(params: {
	readonly cwd?: string;
	readonly filePath: string;
	readonly openClawWorkspaceRoot: string;
}): {
	readonly containerPath: string;
	readonly relativePath: string;
} {
	if (params.filePath.includes('\0') || params.filePath.split('/').includes('..')) {
		throw new Error('OpenClaw Sandbox filesystem path contains forbidden traversal.');
	}
	const cwd = params.cwd ?? TOOL_VM_DEFAULT_WORKDIR;
	if (!cwd.startsWith('/') || cwd.includes('\0') || cwd.split('/').includes('..')) {
		throw new Error('OpenClaw Sandbox filesystem cwd must be an absolute guest path.');
	}
	const openClawWorkspaceRoot = path.resolve(params.openClawWorkspaceRoot);
	if (
		!params.openClawWorkspaceRoot.startsWith('/') ||
		params.openClawWorkspaceRoot.includes('\0') ||
		params.openClawWorkspaceRoot.split('/').includes('..') ||
		openClawWorkspaceRoot === '/'
	) {
		throw new Error('OpenClaw Sandbox workspace root must be a contained absolute path.');
	}
	const requestedPath = path.resolve(cwd, params.filePath);
	const workspaceRelativePath = path.relative(openClawWorkspaceRoot, requestedPath);
	const containerPath =
		workspaceRelativePath === '' ||
		(!workspaceRelativePath.startsWith('../') && !path.isAbsolute(workspaceRelativePath))
			? path.resolve(TOOL_VM_AGENT_WORKSPACE_ROOT, workspaceRelativePath)
			: requestedPath;
	const admittedRoot = ['/workspace', '/gitdirs', '/agent-vm', '/work', '/tmp'].find(
		(root) => containerPath === root || containerPath.startsWith(`${root}/`),
	);
	if (admittedRoot === undefined) {
		throw new Error(`OpenClaw Sandbox path '${containerPath}' is outside Tool VM guest roots.`);
	}
	return { containerPath, relativePath: path.relative(admittedRoot, containerPath) };
}

interface SharedFilesystemEnvironmentGroup {
	activeOperationCount: number;
	readonly environment: Promise<SandboxEnvironmentHandle>;
}

export function createOpenClawGatewayRuntimeSandboxFilesystemBridge(options: {
	readonly client: OpenClawGatewayRuntimeSandboxClient;
	readonly openClawWorkspaceRoot: string;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}): OpenClawGatewayRuntimeSandboxFilesystemBridge {
	let currentEnvironmentGroup: SharedFilesystemEnvironmentGroup | undefined;
	const withFilesystemEnvironment = async <TResult>(operation: {
		readonly run: (environment: SandboxEnvironmentHandle) => Promise<TResult>;
	}): Promise<TResult> => {
		let environmentGroup = currentEnvironmentGroup;
		if (environmentGroup === undefined) {
			environmentGroup = {
				activeOperationCount: 0,
				environment: options.client.sandbox.environment
					.open({}, requestOptions(options.trustedContext))
					.then((opened) => opened.environment),
			};
			currentEnvironmentGroup = environmentGroup;
		}
		environmentGroup.activeOperationCount += 1;
		try {
			return await operation.run(await environmentGroup.environment);
		} finally {
			environmentGroup.activeOperationCount -= 1;
			if (
				environmentGroup.activeOperationCount === 0 &&
				currentEnvironmentGroup === environmentGroup
			) {
				currentEnvironmentGroup = undefined;
				const environment = await environmentGroup.environment.catch(() => undefined);
				if (environment !== undefined) {
					await options.client.sandbox.environment.close(
						{ environment },
						requestOptions(options.trustedContext),
					);
				}
			}
		}
	};
	const resolvePath = (params: {
		readonly cwd?: string;
		readonly filePath: string;
	}): { readonly containerPath: string; readonly relativePath: string } =>
		resolveGuestPath({ ...params, openClawWorkspaceRoot: options.openClawWorkspaceRoot });
	return {
		resolvePath,
		readFile: async (params) =>
			await withFilesystemEnvironment({
				run: async (environment) => {
					const { containerPath } = resolvePath(params);
					const chunks: Buffer[] = [];
					let offsetBytes = 0;
					for (;;) {
						if (offsetBytes >= SANDBOX_MAXIMUM_BINARY_BYTES) {
							throw new Error(
								'Gateway Runtime filesystem read exceeded the canonical byte ceiling.',
							);
						}
						// oxlint-disable-next-line no-await-in-loop -- File offsets are read in order.
						const result = await options.client.sandbox.filesystem.read(
							{
								environment,
								maxBytes: Math.min(
									FILESYSTEM_READ_CHUNK_BYTES,
									SANDBOX_MAXIMUM_BINARY_BYTES - offsetBytes,
								),
								offsetBytes,
								path: containerPath,
							},
							requestOptions(options.trustedContext, params.signal),
						);
						const chunk = Buffer.from(result.chunk.contentBase64, 'base64');
						chunks.push(chunk);
						if (result.nextOffsetBytes > SANDBOX_MAXIMUM_BINARY_BYTES) {
							throw new Error(
								'Gateway Runtime filesystem read exceeded the canonical byte ceiling.',
							);
						}
						if (result.eof) return Buffer.concat(chunks);
						if (result.nextOffsetBytes <= offsetBytes) {
							throw new Error('Gateway Runtime filesystem read returned a non-advancing offset.');
						}
						offsetBytes = result.nextOffsetBytes;
					}
				},
			}),
		writeFile: async (params) => {
			await withFilesystemEnvironment({
				run: async (environment) => {
					const { containerPath } = resolvePath(params);
					if (params.mkdir !== false) {
						await options.client.sandbox.filesystem.mkdir(
							{ environment, path: path.dirname(containerPath), recursive: true },
							requestOptions(options.trustedContext, params.signal),
						);
					}
					const content = Buffer.isBuffer(params.data)
						? params.data
						: Buffer.from(params.data, params.encoding ?? 'utf8');
					await options.client.sandbox.filesystem.write(
						{ atomic: true, content: binaryChunk(content), environment, path: containerPath },
						requestOptions(options.trustedContext, params.signal),
					);
				},
			});
		},
		mkdirp: async (params) => {
			await withFilesystemEnvironment({
				run: async (environment) => {
					await options.client.sandbox.filesystem.mkdir(
						{
							environment,
							path: resolvePath(params).containerPath,
							recursive: true,
						},
						requestOptions(options.trustedContext, params.signal),
					);
				},
			});
		},
		remove: async (params) => {
			await withFilesystemEnvironment({
				run: async (environment) => {
					const resolvedPath = resolvePath(params).containerPath;
					if (params.force !== false) {
						const status = await options.client.sandbox.filesystem.stat(
							{ environment, path: resolvedPath },
							requestOptions(options.trustedContext, params.signal),
						);
						if (status.kind === 'not-found') return;
					}
					await options.client.sandbox.filesystem.remove(
						{ environment, path: resolvedPath, recursive: params.recursive === true },
						requestOptions(options.trustedContext, params.signal),
					);
				},
			});
		},
		rename: async (params) => {
			await withFilesystemEnvironment({
				run: async (environment) => {
					const pathOptions = params.cwd === undefined ? {} : { cwd: params.cwd };
					await options.client.sandbox.filesystem.rename(
						{
							destinationPath: resolvePath({ ...pathOptions, filePath: params.to }).containerPath,
							environment,
							replace: true,
							sourcePath: resolvePath({ ...pathOptions, filePath: params.from }).containerPath,
						},
						requestOptions(options.trustedContext, params.signal),
					);
				},
			});
		},
		stat: async (params) =>
			await withFilesystemEnvironment({
				run: async (environment) => {
					const result = await options.client.sandbox.filesystem.stat(
						{ environment, path: resolvePath(params).containerPath },
						requestOptions(options.trustedContext, params.signal),
					);
					if (result.kind === 'not-found') return null;
					return {
						mtimeMs: 0,
						size: result.entry.byteLength ?? 0,
						type:
							result.entry.kind === 'file' || result.entry.kind === 'directory'
								? result.entry.kind
								: ('other' as const),
					};
				},
			}),
	};
}
