import { chmod, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_GATEWAY_RUNTIME_ROOT = '/run/agent-vm/gateway-runtime';

const managedPluginSocketFilename = 'managed-plugin.sock';

export interface CreateGatewayRuntimePathsOptions {
	readonly runtimeRoot?: string;
}

export interface GatewayRuntimePaths {
	readonly managedPluginSocketPath: string;
	readonly runtimeRoot: string;
}

function assertAbsoluteRuntimeRoot(runtimeRoot: string): void {
	if (runtimeRoot.includes('\0') || !path.isAbsolute(runtimeRoot)) {
		throw new Error('runtimeRoot must be an absolute path without NUL bytes.');
	}
}

function assertGatewayRuntimePathsAreConsistent(paths: GatewayRuntimePaths): void {
	assertAbsoluteRuntimeRoot(paths.runtimeRoot);
	if (
		path.dirname(paths.managedPluginSocketPath) !== paths.runtimeRoot ||
		path.basename(paths.managedPluginSocketPath) !== managedPluginSocketFilename
	) {
		throw new Error('Gateway runtime socket path is outside its validated runtime root.');
	}
}

export function createGatewayRuntimePaths(
	options: CreateGatewayRuntimePathsOptions = {},
): GatewayRuntimePaths {
	const runtimeRoot = options.runtimeRoot ?? DEFAULT_GATEWAY_RUNTIME_ROOT;
	assertAbsoluteRuntimeRoot(runtimeRoot);

	return Object.freeze({
		managedPluginSocketPath: path.join(runtimeRoot, managedPluginSocketFilename),
		runtimeRoot,
	});
}

export async function prepareGatewayRuntimeDirectory(paths: GatewayRuntimePaths): Promise<void> {
	assertGatewayRuntimePathsAreConsistent(paths);
	await mkdir(paths.runtimeRoot, { mode: 0o700, recursive: true });
	const statusBeforeProtection = await lstat(paths.runtimeRoot, { bigint: true });
	if (!statusBeforeProtection.isDirectory() || statusBeforeProtection.isSymbolicLink()) {
		throw new Error('Gateway runtime root must be a regular non-symlink directory.');
	}
	if (process.getuid !== undefined && statusBeforeProtection.uid !== BigInt(process.getuid())) {
		throw new Error('Gateway runtime root must be owned by the service process user.');
	}
	await chmod(paths.runtimeRoot, 0o700);
	const statusAfterProtection = await lstat(paths.runtimeRoot, { bigint: true });
	if (
		!statusAfterProtection.isDirectory() ||
		statusAfterProtection.isSymbolicLink() ||
		statusAfterProtection.dev !== statusBeforeProtection.dev ||
		statusAfterProtection.ino !== statusBeforeProtection.ino
	) {
		throw new Error('Gateway runtime root changed while its protections were applied.');
	}
}
