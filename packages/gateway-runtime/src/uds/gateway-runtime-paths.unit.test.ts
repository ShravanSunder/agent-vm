import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	DEFAULT_GATEWAY_RUNTIME_ROOT,
	createGatewayRuntimePaths,
	prepareGatewayRuntimeDirectory,
} from './gateway-runtime-paths.js';

const temporarySandboxRoots: string[] = [];

async function createUnpreparedRuntimeRoot(): Promise<string> {
	const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-gateway-runtime-paths-'));
	temporarySandboxRoots.push(sandboxRoot);
	return path.join(sandboxRoot, 'gateway-runtime');
}

function isPathAtOrBelowRoot(candidatePath: string, rootPath: string): boolean {
	const relativePath = path.relative(rootPath, candidatePath);
	return (
		relativePath === '' ||
		(relativePath !== '..' &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath))
	);
}

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporarySandboxRoots
			.splice(0)
			.map((sandboxRoot) => rm(sandboxRoot, { force: true, recursive: true })),
	);
});

describe('Gateway runtime VM-local paths', () => {
	it('constructs the fixed default managed-plugin socket path', () => {
		// Arrange
		const expectedRuntimeRoot = '/run/agent-vm/gateway-runtime';

		// Act
		const paths = createGatewayRuntimePaths({});

		// Assert
		expect(DEFAULT_GATEWAY_RUNTIME_ROOT).toBe(expectedRuntimeRoot);
		expect(paths).toEqual({
			runtimeRoot: expectedRuntimeRoot,
			managedPluginSocketPath: `${expectedRuntimeRoot}/managed-plugin.sock`,
		});
	});

	it('keeps lifecycle epoch values out of the VM-local path identity', () => {
		// Arrange
		const lifecycleEpochs = [
			{ gatewayEpoch: 'gateway-epoch-17', runtimeEpoch: 'runtime-epoch-23' },
			{ gatewayEpoch: 'gateway-epoch-18', runtimeEpoch: 'runtime-epoch-24' },
		] as const;

		// Act
		const pathsForEachLifecycleEpoch = lifecycleEpochs.map(() => createGatewayRuntimePaths({}));

		// Assert
		expect(pathsForEachLifecycleEpoch).toHaveLength(2);
		expect(pathsForEachLifecycleEpoch[0]).toEqual(pathsForEachLifecycleEpoch[1]);
		expect(Object.keys(pathsForEachLifecycleEpoch[0] ?? {}).toSorted()).toEqual([
			'managedPluginSocketPath',
			'runtimeRoot',
		]);
	});

	it('places the managed-plugin socket directly beneath a custom absolute runtime root', async (): Promise<void> => {
		// Arrange
		const runtimeRoot = await createUnpreparedRuntimeRoot();

		// Act
		const paths = createGatewayRuntimePaths({ runtimeRoot });

		// Assert
		expect(paths).toEqual({
			runtimeRoot,
			managedPluginSocketPath: path.join(runtimeRoot, 'managed-plugin.sock'),
		});
		expect(path.dirname(paths.managedPluginSocketPath)).toBe(runtimeRoot);
		expect(path.relative(runtimeRoot, paths.managedPluginSocketPath)).toBe('managed-plugin.sock');
	});

	it.each([
		{ label: 'a relative path', runtimeRoot: 'run/agent-vm/gateway-runtime' },
		{ label: 'a path containing NUL', runtimeRoot: '/run/agent-vm/gateway\0runtime' },
	])('rejects $label as a custom runtime root', ({ runtimeRoot }): void => {
		// Arrange
		const constructPaths = (): ReturnType<typeof createGatewayRuntimePaths> =>
			createGatewayRuntimePaths({ runtimeRoot });

		// Act / Assert
		expect(constructPaths).toThrow('runtimeRoot must be an absolute path without NUL bytes.');
	});

	it('creates the single runtime root with effective mode 0700', async (): Promise<void> => {
		// Arrange
		const runtimeRoot = await createUnpreparedRuntimeRoot();
		const paths = createGatewayRuntimePaths({ runtimeRoot });

		// Act
		await prepareGatewayRuntimeDirectory(paths);
		const directoryStatus = await stat(runtimeRoot);

		// Assert
		expect(directoryStatus.isDirectory()).toBe(true);
		expect(directoryStatus.mode & 0o777).toBe(0o700);
	});

	it('tightens an existing permissive runtime root to mode 0700', async (): Promise<void> => {
		// Arrange
		const runtimeRoot = await createUnpreparedRuntimeRoot();
		const paths = createGatewayRuntimePaths({ runtimeRoot });
		await mkdir(runtimeRoot, { recursive: true });
		await chmod(runtimeRoot, 0o777);
		expect((await stat(runtimeRoot)).mode & 0o777).toBe(0o777);

		// Act
		await prepareGatewayRuntimeDirectory(paths);

		// Assert
		expect((await stat(runtimeRoot)).mode & 0o777).toBe(0o700);
	});

	it('keeps default paths outside work, persistent state, mount, and ingress namespaces', () => {
		// Arrange
		const forbiddenProjectionRoots = [
			'/work',
			'/workspace',
			'/zone',
			'/state',
			'/config',
			'/mnt',
			'/agent-vm/tool-portal/mcp',
			'/agent-vm/controller-execution',
		] as const;
		const paths = createGatewayRuntimePaths({});

		// Act
		const projectedPathPairs = [paths.runtimeRoot, paths.managedPluginSocketPath].flatMap(
			(candidatePath) =>
				forbiddenProjectionRoots
					.filter((forbiddenRoot) => isPathAtOrBelowRoot(candidatePath, forbiddenRoot))
					.map((forbiddenRoot) => ({ candidatePath, forbiddenRoot })),
		);

		// Assert
		expect(projectedPathPairs).toEqual([]);
	});

	it('rejects a runtime root redirected through a final-component symlink', async (): Promise<void> => {
		// Arrange
		const runtimeRoot = await createUnpreparedRuntimeRoot();
		const redirectedRoot = `${runtimeRoot}-redirected`;
		await mkdir(redirectedRoot, { mode: 0o700 });
		await symlink(redirectedRoot, runtimeRoot);
		const paths = createGatewayRuntimePaths({ runtimeRoot });

		// Act / Assert
		await expect(prepareGatewayRuntimeDirectory(paths)).rejects.toThrow(
			'regular non-symlink directory',
		);
	});

	it('returns a frozen path object that cannot be redirected after validation', () => {
		// Arrange
		const paths = createGatewayRuntimePaths({});
		const originalRuntimeRoot = paths.runtimeRoot;

		// Act
		const mutationSucceeded = Reflect.set(paths, 'runtimeRoot', '/work/redirected');

		// Assert
		expect(Object.isFrozen(paths)).toBe(true);
		expect(mutationSucceeded).toBe(false);
		expect(paths.runtimeRoot).toBe(originalRuntimeRoot);
	});
});
