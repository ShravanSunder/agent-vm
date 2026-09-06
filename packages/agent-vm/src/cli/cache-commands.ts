import fs from 'node:fs/promises';
import path from 'node:path';

import {
	configuredImageSelectionRecordPath,
	readPreparedManagedVmImage,
} from '../build/prepared-gondolin-image-cache.js';
import {
	deploymentCacheDirForSystemConfig,
	deploymentGeneratedDirForStorageRoot,
	sharedImageCacheDirForSystemConfig,
	type LoadedSystemConfig,
} from '../config/system-config.js';
import {
	acquireControllerOwnershipLock as acquireControllerOwnershipLockDefault,
	type ControllerOwnershipLock,
} from '../controller/vm-ownership/controller-ownership-lock.js';
import { removeDeploymentCacheDirectory } from './cache-directory-removal.js';

interface CacheCommandIo {
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

interface ImageSelectionStatus {
	readonly fingerprint: string | null;
	readonly recordPath: string;
	readonly status: 'invalid-or-missing' | 'ready';
}

export interface CacheCommandDependencies {
	readonly acquireControllerOwnershipLock?: typeof acquireControllerOwnershipLockDefault;
	readonly removeDirectory?: (directoryPath: string) => Promise<void>;
}

async function listSharedImageFingerprints(
	sharedImageCacheDir: string,
): Promise<readonly string[]> {
	try {
		return (await fs.readdir(sharedImageCacheDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && /^[a-f0-9]{16}$/u.test(entry.name))
			.map((entry) => entry.name)
			.toSorted();
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

async function resolveImageSelectionStatuses(systemConfig: LoadedSystemConfig): Promise<{
	readonly gateways: Readonly<Record<string, ImageSelectionStatus>>;
	readonly toolVms: Readonly<Record<string, ImageSelectionStatus>>;
}> {
	const deploymentGeneratedDir = deploymentGeneratedDirForStorageRoot(systemConfig.storageRootDir);
	const sharedImageCacheDir = sharedImageCacheDirForSystemConfig(systemConfig);
	const resolveFamily = async (
		family: 'gateway' | 'toolVm',
		profiles: Readonly<Record<string, { readonly buildConfig: string; readonly type: string }>>,
	): Promise<Readonly<Record<string, ImageSelectionStatus>>> =>
		Object.fromEntries(
			await Promise.all(
				Object.entries(profiles).map(async ([profileName, profile]) => {
					const selectionRecordPath = configuredImageSelectionRecordPath({
						deploymentGeneratedDir,
						family,
						profileName,
					});
					const preparedImage = await readPreparedManagedVmImage({
						buildConfigPath: profile.buildConfig,
						...(profile.type === 'hermes'
							? {
									expectedManagedGatewayBoot: {
										kind: 'managed-gateway-exact-two-role',
										frameworkBootEntry: 'hermes-framework-service',
									} as const,
								}
							: {}),
						selectionRecordPath,
						sharedImageCacheDir,
					});
					return [
						profileName,
						preparedImage === undefined
							? ({
									fingerprint: null,
									recordPath: selectionRecordPath,
									status: 'invalid-or-missing',
								} satisfies ImageSelectionStatus)
							: ({
									fingerprint: preparedImage.fingerprint,
									recordPath: selectionRecordPath,
									status: 'ready',
								} satisfies ImageSelectionStatus),
					] as const;
				}),
			),
		);

	return {
		gateways: await resolveFamily('gateway', systemConfig.imageProfiles.gateways),
		toolVms: await resolveFamily('toolVm', systemConfig.imageProfiles.toolVms),
	};
}

async function assertCleanupTargetIdentity(cacheDir: string, target: string): Promise<void> {
	let canonicalTarget: string;
	try {
		canonicalTarget = await fs.realpath(target);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
			return;
		throw error;
	}
	const canonicalCacheDir = await fs.realpath(cacheDir);
	const expectedTarget = path.join(canonicalCacheDir, path.relative(cacheDir, target));
	if (canonicalTarget !== expectedTarget) {
		throw new Error(
			`Unsafe cache cleanup target '${target}': symbolic links change its storage identity.`,
		);
	}
}

async function resolveDeploymentCleanupTargets(
	cacheDir: string,
	deploymentCacheDir: string,
): Promise<readonly string[]> {
	const zonesDirectory = path.join(deploymentCacheDir, 'zones');
	await assertCleanupTargetIdentity(cacheDir, zonesDirectory);
	const targets = [path.join(deploymentCacheDir, 'docker-contexts')];
	try {
		const zoneEntries = await fs.readdir(zonesDirectory, { withFileTypes: true });
		for (const entry of zoneEntries) {
			if (entry.isDirectory())
				targets.push(path.join(zonesDirectory, entry.name, 'framework-cache'));
		}
	} catch (error) {
		if (
			typeof error !== 'object' ||
			error === null ||
			!('code' in error) ||
			error.code !== 'ENOENT'
		)
			throw error;
	}
	return targets;
}

async function releaseOwnershipLockAfterOperation(options: {
	readonly lock: ControllerOwnershipLock;
	readonly operation: () => Promise<void>;
}): Promise<void> {
	let operationError: unknown;
	try {
		await options.operation();
	} catch (error) {
		operationError = error;
	}
	let releaseError: unknown;
	try {
		await options.lock.release();
	} catch (error) {
		releaseError = error;
	}
	if (operationError !== undefined && releaseError !== undefined) {
		throw new AggregateError(
			[operationError, releaseError],
			'Cache cleanup and controller ownership lock release both failed',
			{ cause: operationError },
		);
	}
	if (operationError !== undefined) throw operationError;
	if (releaseError !== undefined) throw releaseError;
}

export async function runCacheCommand(
	options: {
		readonly confirm?: boolean;
		readonly subcommand: string;
		readonly systemConfig: LoadedSystemConfig;
	},
	io: CacheCommandIo,
	dependencies: CacheCommandDependencies = {},
): Promise<void> {
	const deploymentCacheDir = deploymentCacheDirForSystemConfig(options.systemConfig);
	const sharedImageCacheDir = sharedImageCacheDirForSystemConfig(options.systemConfig);
	const deploymentGeneratedDir = deploymentGeneratedDirForStorageRoot(
		options.systemConfig.storageRootDir,
	);

	if (options.subcommand === 'list') {
		io.stdout.write(
			`${JSON.stringify(
				{
					cacheDir: options.systemConfig.cacheDir,
					deploymentCacheDir,
					deploymentGeneratedDir,
					imageSelections: await resolveImageSelectionStatuses(options.systemConfig),
					sharedImageCacheDir,
					sharedImageFingerprints: await listSharedImageFingerprints(sharedImageCacheDir),
				},
				null,
				2,
			)}\n`,
		);
		return;
	}

	if (options.subcommand === 'clean') {
		if (!options.confirm) {
			const cleanupTargets = await resolveDeploymentCleanupTargets(
				options.systemConfig.cacheDir,
				deploymentCacheDir,
			);
			io.stderr.write(
				`[cache] Deployment cache cleanup targets:\n${cleanupTargets.map((target) => `  ${target}`).join('\n')}\n[cache] Shared VM images and deployment-generated metadata are preserved. Run with --confirm while the controller is stopped.\n`,
			);
			return;
		}

		const acquireControllerOwnershipLock =
			dependencies.acquireControllerOwnershipLock ?? acquireControllerOwnershipLockDefault;
		const removeDirectory =
			dependencies.removeDirectory ??
			(async (directoryPath: string): Promise<void> =>
				await removeDeploymentCacheDirectory(options.systemConfig.cacheDir, directoryPath));
		const ownershipLock = await acquireControllerOwnershipLock({
			runtimeDirectory: options.systemConfig.controllerRuntimeDir,
		});
		await releaseOwnershipLockAfterOperation({
			lock: ownershipLock,
			operation: async () => {
				const cleanupTargets = await resolveDeploymentCleanupTargets(
					options.systemConfig.cacheDir,
					deploymentCacheDir,
				);
				await Promise.all(
					cleanupTargets.map(
						async (target) =>
							await assertCleanupTargetIdentity(options.systemConfig.cacheDir, target),
					),
				);
				await Promise.all(cleanupTargets.map(async (target) => await removeDirectory(target)));
			},
		});
		io.stderr.write("[cache] Deleted this deployment's Docker contexts and framework caches.\n");
		return;
	}

	throw new Error(`Unknown cache subcommand '${options.subcommand}'.`);
}
