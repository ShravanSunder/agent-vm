import path from 'node:path';

import type { ManagedVmFilteredWorkspacePolicy } from '@agent-vm/managed-vm';
import {
	ERRNO,
	VirtualDirent,
	createVirtualDirStats,
	type ShadowPredicate,
	type ShadowProviderOptions,
	type VirtualProvider,
} from '@earendil-works/gondolin';

export interface FilteredWorkspaceProviderDependencies {
	createMemoryProvider(): VirtualProvider;
	createReadonlyProvider(provider: VirtualProvider): VirtualProvider;
	createShadowPathPredicate(paths: readonly string[]): ShadowPredicate;
	createShadowProvider(provider: VirtualProvider, options: ShadowProviderOptions): VirtualProvider;
}

export interface CreateFilteredWorkspaceProviderOptions {
	readonly baseProvider: VirtualProvider;
	readonly dependencies: FilteredWorkspaceProviderDependencies;
	readonly policy: ManagedVmFilteredWorkspacePolicy;
}

type ProviderMethod = (...methodArguments: readonly unknown[]) => unknown;

function toAbsoluteProviderPath(relativePath: string): string {
	return `/${relativePath}`;
}

function normalizeProviderPath(providerPath: string): string {
	const absolutePath = providerPath.startsWith('/') ? providerPath : `/${providerPath}`;
	return path.posix.normalize(absolutePath);
}

function toRelativeProviderPath(providerPath: string): string {
	const normalizedPath = normalizeProviderPath(providerPath);
	return normalizedPath === '/' ? '' : normalizedPath.slice(1);
}

function isEqualOrDescendant(candidatePath: string, ancestorPath: string): boolean {
	return (
		ancestorPath.length === 0 ||
		candidatePath === ancestorPath ||
		candidatePath.startsWith(`${ancestorPath}/`)
	);
}

function pathsOverlap(firstPath: string, secondPath: string): boolean {
	return isEqualOrDescendant(firstPath, secondPath) || isEqualOrDescendant(secondPath, firstPath);
}

function createFilesystemPolicyError(
	code: 'EACCES' | 'ENOENT' | 'EROFS',
	syscall: string,
	providerPath: string,
): Error & { readonly code: 'EACCES' | 'ENOENT' | 'EROFS'; readonly errno: number } {
	return Object.assign(new Error(`${code}: ${syscall} '${providerPath}'`), {
		code,
		errno: ERRNO[code],
		path: providerPath,
		syscall,
	});
}

function invokeProviderMethod(
	provider: VirtualProvider,
	property: string | symbol,
	methodArguments: readonly unknown[],
): unknown {
	const method = Reflect.get(provider, property, provider) as unknown;
	if (typeof method !== 'function') {
		return method;
	}
	return Reflect.apply(method as ProviderMethod, provider, methodArguments);
}

const singlePathMutationMethods = new Set([
	'appendFile',
	'appendFileSync',
	'mkdir',
	'mkdirSync',
	'rmdir',
	'rmdirSync',
	'symlink',
	'symlinkSync',
	'truncate',
	'truncateSync',
	'unlink',
	'unlinkSync',
	'writeFile',
	'writeFileSync',
]);

function mutationPathArgumentIndex(property: string): number {
	return property === 'symlink' || property === 'symlinkSync' ? 1 : 0;
}

function failProviderMutation(property: string, providerPath: string): unknown {
	return failProviderOperation(property, providerPath, 'EROFS');
}

function failProviderOperation(
	property: string,
	providerPath: string,
	code: 'EACCES' | 'ENOENT' | 'EROFS',
): unknown {
	const operationError = createFilesystemPolicyError(code, property, providerPath);
	if (property.endsWith('Sync')) {
		throw operationError;
	}
	return Promise.reject(operationError);
}

function createRelativeRootProvider(
	provider: VirtualProvider,
	sourceRelativePath: string,
): VirtualProvider {
	const sourceProviderPath = toAbsoluteProviderPath(sourceRelativePath);
	const translatePath = (providerPath: string): string => {
		const suffix = toRelativeProviderPath(providerPath);
		return toAbsoluteProviderPath(
			suffix.length === 0 ? sourceRelativePath : `${sourceRelativePath}/${suffix}`,
		);
	};
	const translateArguments = (
		property: string,
		methodArguments: readonly unknown[],
	): readonly unknown[] => {
		const translatedArguments = [...methodArguments];
		if (
			property === 'rename' ||
			property === 'renameSync' ||
			property === 'link' ||
			property === 'linkSync' ||
			property === 'copyFile' ||
			property === 'copyFileSync'
		) {
			translatedArguments[0] = translatePath(String(methodArguments[0]));
			translatedArguments[1] = translatePath(String(methodArguments[1]));
			return translatedArguments;
		}
		translatedArguments[mutationPathArgumentIndex(property)] = translatePath(
			String(methodArguments[mutationPathArgumentIndex(property)]),
		);
		return translatedArguments;
	};
	const assertResolvedPathWithinSource = (
		resolvedPath: string,
		canonicalSourcePath: string,
		property: string,
		providerPath: string,
	): void => {
		const resolvedRelativePath = toRelativeProviderPath(resolvedPath);
		const canonicalSourceRelativePath = toRelativeProviderPath(canonicalSourcePath);
		if (!isEqualOrDescendant(resolvedRelativePath, canonicalSourceRelativePath)) {
			throw createFilesystemPolicyError('ENOENT', property, providerPath);
		}
	};
	const resolveConfinedPath = async (
		property: string,
		providerPath: string,
		translatedPath: string,
	): Promise<{ readonly canonicalSourcePath: string; readonly resolvedPath: string }> => {
		if (!provider.realpath) {
			throw createFilesystemPolicyError('ENOENT', property, providerPath);
		}
		const [canonicalSourcePath, resolvedPath] = await Promise.all([
			provider.realpath(sourceProviderPath),
			provider.realpath(translatedPath),
		]);
		assertResolvedPathWithinSource(resolvedPath, canonicalSourcePath, property, providerPath);
		return { canonicalSourcePath, resolvedPath };
	};
	const resolveConfinedPathSync = (
		property: string,
		providerPath: string,
		translatedPath: string,
	): { readonly canonicalSourcePath: string; readonly resolvedPath: string } => {
		if (!provider.realpathSync) {
			throw createFilesystemPolicyError('ENOENT', property, providerPath);
		}
		const canonicalSourcePath = provider.realpathSync(sourceProviderPath);
		const resolvedPath = provider.realpathSync(translatedPath);
		assertResolvedPathWithinSource(resolvedPath, canonicalSourcePath, property, providerPath);
		return { canonicalSourcePath, resolvedPath };
	};
	const parentProviderPath = (providerPath: string): string => {
		const normalizedPath = normalizeProviderPath(providerPath);
		return normalizedPath === '/' ? '/' : path.posix.dirname(normalizedPath);
	};
	const remapResolvedPath = (resolvedPath: string, canonicalSourcePath: string): string => {
		const resolvedRelativePath = toRelativeProviderPath(resolvedPath);
		const canonicalSourceRelativePath = toRelativeProviderPath(canonicalSourcePath);
		if (resolvedRelativePath === canonicalSourceRelativePath) {
			return '/';
		}
		return toAbsoluteProviderPath(
			canonicalSourceRelativePath.length === 0
				? resolvedRelativePath
				: resolvedRelativePath.slice(`${canonicalSourceRelativePath}/`.length),
		);
	};
	const asyncFollowMethods = new Set(['access', 'open', 'readdir', 'readFile', 'stat', 'statfs']);
	const syncFollowMethods = new Set([
		'accessSync',
		'openSync',
		'readdirSync',
		'readFileSync',
		'statSync',
		'watch',
		'watchAsync',
		'watchFile',
		'unwatchFile',
	]);

	return new Proxy(provider, {
		get(target: VirtualProvider, property: string | symbol): unknown {
			const value = Reflect.get(target, property, target) as unknown;
			if (typeof property !== 'string' || typeof value !== 'function') {
				return value;
			}
			return (...methodArguments: readonly unknown[]): unknown => {
				const translatedArguments = translateArguments(property, methodArguments);
				if (property === 'realpath') {
					const providerPath = String(methodArguments[0]);
					return resolveConfinedPath(property, providerPath, String(translatedArguments[0])).then(
						({ canonicalSourcePath, resolvedPath }) =>
							remapResolvedPath(resolvedPath, canonicalSourcePath),
					);
				}
				if (property === 'realpathSync') {
					const providerPath = String(methodArguments[0]);
					const { canonicalSourcePath, resolvedPath } = resolveConfinedPathSync(
						property,
						providerPath,
						String(translatedArguments[0]),
					);
					return remapResolvedPath(resolvedPath, canonicalSourcePath);
				}
				if (property === 'lstat' || property === 'readlink') {
					const providerPath = String(methodArguments[0]);
					return resolveConfinedPath(
						property,
						providerPath,
						translatePath(parentProviderPath(providerPath)),
					).then(() => Reflect.apply(value as ProviderMethod, target, translatedArguments));
				}
				if (property === 'lstatSync' || property === 'readlinkSync') {
					const providerPath = String(methodArguments[0]);
					resolveConfinedPathSync(
						property,
						providerPath,
						translatePath(parentProviderPath(providerPath)),
					);
					return Reflect.apply(value as ProviderMethod, target, translatedArguments);
				}
				if (property === 'exists') {
					const providerPath = String(methodArguments[0]);
					return resolveConfinedPath(property, providerPath, String(translatedArguments[0]))
						.then(() => Reflect.apply(value as ProviderMethod, target, translatedArguments))
						.catch(() => false);
				}
				if (property === 'existsSync' || property === 'internalModuleStat') {
					const providerPath = String(methodArguments[0]);
					try {
						resolveConfinedPathSync(property, providerPath, String(translatedArguments[0]));
						return Reflect.apply(value as ProviderMethod, target, translatedArguments);
					} catch {
						return property === 'existsSync' ? false : -2;
					}
				}
				if (asyncFollowMethods.has(property)) {
					const providerPath = String(methodArguments[0]);
					return resolveConfinedPath(property, providerPath, String(translatedArguments[0])).then(
						() => Reflect.apply(value as ProviderMethod, target, translatedArguments),
					);
				}
				if (syncFollowMethods.has(property)) {
					const providerPath = String(methodArguments[0]);
					resolveConfinedPathSync(property, providerPath, String(translatedArguments[0]));
				}
				return Reflect.apply(value as ProviderMethod, target, translatedArguments);
			};
		},
	});
}

function createPositiveWorkspaceProjectionProvider(
	provider: VirtualProvider,
	policy: Extract<
		ManagedVmFilteredWorkspacePolicy['visibility'],
		{ readonly kind: 'positive-paths' }
	>,
	dependencies: FilteredWorkspaceProviderDependencies,
): VirtualProvider {
	const isVisible = (providerPath: string): boolean => {
		const relativePath = toRelativeProviderPath(providerPath);
		return (
			relativePath.length === 0 ||
			policy.visiblePaths.some((visiblePath) => pathsOverlap(relativePath, visiblePath))
		);
	};
	const isWritable = (providerPath: string): boolean => {
		const relativePath = toRelativeProviderPath(providerPath);
		return policy.writablePaths.some((writablePath) =>
			isEqualOrDescendant(relativePath, writablePath),
		);
	};
	const projectedProvider = dependencies.createShadowProvider(provider, {
		shouldShadow: ({ path: providerPath }) => !isVisible(providerPath),
		writeMode: 'deny',
	});
	const readonlyProvider = dependencies.createReadonlyProvider(projectedProvider);

	return new Proxy(projectedProvider, {
		get(target: VirtualProvider, property: string | symbol): unknown {
			const value = Reflect.get(target, property, target) as unknown;
			if (typeof property !== 'string' || typeof value !== 'function') {
				return value;
			}
			if (property === 'open' || property === 'openSync') {
				return (...methodArguments: readonly unknown[]): unknown => {
					const providerPath = String(methodArguments[0]);
					const selectedProvider =
						isVisible(providerPath) && !isWritable(providerPath) ? readonlyProvider : target;
					return invokeProviderMethod(selectedProvider, property, methodArguments);
				};
			}
			if (singlePathMutationMethods.has(property)) {
				return (...methodArguments: readonly unknown[]): unknown => {
					const pathIndex = mutationPathArgumentIndex(property);
					const providerPath = String(methodArguments[pathIndex]);
					const selectedProvider =
						isVisible(providerPath) && !isWritable(providerPath) ? readonlyProvider : target;
					return invokeProviderMethod(selectedProvider, property, methodArguments);
				};
			}
			if (property === 'rename' || property === 'renameSync') {
				return (...methodArguments: readonly unknown[]): unknown => {
					const affectedPaths = [String(methodArguments[0]), String(methodArguments[1])];
					const selectedProvider =
						affectedPaths.every(isVisible) &&
						affectedPaths.some((affectedPath) => !isWritable(affectedPath))
							? readonlyProvider
							: target;
					return invokeProviderMethod(selectedProvider, property, methodArguments);
				};
			}
			if (property === 'copyFile' || property === 'copyFileSync') {
				return (...methodArguments: readonly unknown[]): unknown => {
					const sourcePath = String(methodArguments[0]);
					const destinationPath = String(methodArguments[1]);
					const selectedProvider =
						isVisible(sourcePath) && isVisible(destinationPath) && !isWritable(destinationPath)
							? readonlyProvider
							: target;
					return invokeProviderMethod(selectedProvider, property, methodArguments);
				};
			}
			return (...methodArguments: readonly unknown[]): unknown =>
				Reflect.apply(value as ProviderMethod, target, methodArguments);
		},
	});
}

function createWorkspaceHardlinkProvider(
	provider: VirtualProvider,
	baseProvider: VirtualProvider,
	policy: ManagedVmFilteredWorkspacePolicy,
): VirtualProvider {
	const hidden = (providerPath: string): boolean => {
		const relativePath = toRelativeProviderPath(providerPath);
		return policy.hiddenPaths.some((hiddenPath) => isEqualOrDescendant(relativePath, hiddenPath));
	};
	const temporary = (providerPath: string): boolean => {
		const relativePath = toRelativeProviderPath(providerPath);
		return policy.temporaryPaths.some((temporaryPath) =>
			isEqualOrDescendant(relativePath, temporaryPath),
		);
	};
	const visible = (providerPath: string): boolean => {
		if (policy.visibility.kind === 'whole-root-writable') {
			return true;
		}
		const relativePath = toRelativeProviderPath(providerPath);
		return (
			relativePath.length === 0 ||
			policy.visibility.visiblePaths.some((visiblePath) => pathsOverlap(relativePath, visiblePath))
		);
	};
	const writable = (providerPath: string): boolean => {
		if (temporary(providerPath)) {
			return false;
		}
		if (policy.visibility.kind === 'whole-root-writable') {
			return true;
		}
		const relativePath = toRelativeProviderPath(providerPath);
		return policy.visibility.writablePaths.some((writablePath) =>
			isEqualOrDescendant(relativePath, writablePath),
		);
	};

	return new Proxy(provider, {
		get(target: VirtualProvider, property: string | symbol): unknown {
			const value = Reflect.get(target, property, target) as unknown;
			if (property !== 'link' && property !== 'linkSync') {
				return typeof value === 'function'
					? (...methodArguments: readonly unknown[]): unknown =>
							Reflect.apply(value as ProviderMethod, target, methodArguments)
					: value;
			}
			const underlyingLinkMethod = Reflect.get(baseProvider, property, baseProvider) as unknown;
			if (typeof underlyingLinkMethod !== 'function') {
				return undefined;
			}
			return (...methodArguments: readonly unknown[]): unknown => {
				const sourcePath = String(methodArguments[0]);
				const destinationPath = String(methodArguments[1]);
				if (hidden(sourcePath) || !visible(sourcePath)) {
					return failProviderOperation(property, sourcePath, 'ENOENT');
				}
				if (hidden(destinationPath) || !visible(destinationPath)) {
					return failProviderOperation(property, destinationPath, 'EACCES');
				}
				if (!writable(sourcePath)) {
					return failProviderOperation(property, sourcePath, 'EROFS');
				}
				if (!writable(destinationPath)) {
					return failProviderOperation(property, destinationPath, 'EROFS');
				}
				if (property === 'link') {
					if (!provider.realpath) {
						return failProviderOperation(property, sourcePath, 'ENOENT');
					}
					return provider
						.realpath(sourcePath)
						.then(() =>
							Reflect.apply(underlyingLinkMethod as ProviderMethod, baseProvider, methodArguments),
						);
				}
				if (!provider.realpathSync) {
					return failProviderOperation(property, sourcePath, 'ENOENT');
				}
				provider.realpathSync(sourcePath);
				return Reflect.apply(underlyingLinkMethod as ProviderMethod, baseProvider, methodArguments);
			};
		},
	});
}

interface ReadonlyInputProvider {
	readonly destinationRelativePath: string;
	readonly provider: VirtualProvider;
}

function directReadonlyDestinationChildren(
	providerPath: string,
	readonlyInputs: readonly ReadonlyInputProvider[],
): readonly string[] {
	const relativePath = toRelativeProviderPath(providerPath);
	const prefix = relativePath.length === 0 ? '' : `${relativePath}/`;
	const children = new Set<string>();
	for (const readonlyInput of readonlyInputs) {
		if (!readonlyInput.destinationRelativePath.startsWith(prefix)) {
			continue;
		}
		const remainingPath = readonlyInput.destinationRelativePath.slice(prefix.length);
		const childName = remainingPath.split('/')[0];
		if (childName) {
			children.add(childName);
		}
	}
	return [...children].toSorted();
}

function entryName(entry: string | { readonly name: string }): string {
	return typeof entry === 'string' ? entry : entry.name;
}

function mergeDirectoryEntries(
	entries: readonly (string | { readonly name: string })[],
	virtualChildren: readonly string[],
	withFileTypes: boolean,
): readonly (string | { readonly name: string })[] {
	const presentNames = new Set(entries.map(entryName));
	const missingChildren = virtualChildren.filter((childName) => !presentNames.has(childName));
	return [
		...entries,
		...missingChildren.map((childName) =>
			withFileTypes ? new VirtualDirent(childName) : childName,
		),
	];
}

function isNoEntryError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(('code' in error && (error.code === 'ENOENT' || error.code === 'ERRNO_2')) ||
			('errno' in error && (error.errno === ERRNO.ENOENT || error.errno === -ERRNO.ENOENT)))
	);
}

function createNestedReadonlyWorkspaceProvider(
	provider: VirtualProvider,
	sourceProvider: VirtualProvider,
	policy: ManagedVmFilteredWorkspacePolicy,
	dependencies: FilteredWorkspaceProviderDependencies,
): VirtualProvider {
	const readonlyInputs: ReadonlyInputProvider[] = [];
	for (const readonlyInput of policy.readonlyInputs) {
		if (
			policy.hiddenPaths.some((hiddenPath) =>
				isEqualOrDescendant(readonlyInput.destinationRelativePath, hiddenPath),
			)
		) {
			continue;
		}
		let inputProvider = createRelativeRootProvider(
			sourceProvider,
			readonlyInput.sourceRelativePath,
		);
		const nestedHiddenPaths = policy.hiddenPaths.flatMap((hiddenPath) => {
			const destinationPrefix = `${readonlyInput.destinationRelativePath}/`;
			return hiddenPath.startsWith(destinationPrefix)
				? [toAbsoluteProviderPath(hiddenPath.slice(destinationPrefix.length))]
				: [];
		});
		if (nestedHiddenPaths.length > 0) {
			inputProvider = dependencies.createShadowProvider(inputProvider, {
				shouldShadow: dependencies.createShadowPathPredicate(nestedHiddenPaths),
				writeMode: 'deny',
			});
		}
		readonlyInputs.push({
			destinationRelativePath: readonlyInput.destinationRelativePath,
			provider: dependencies.createReadonlyProvider(inputProvider),
		});
	}

	if (readonlyInputs.length === 0) {
		return provider;
	}

	const findInput = (providerPath: string): ReadonlyInputProvider | undefined => {
		const relativePath = toRelativeProviderPath(providerPath);
		return readonlyInputs.find((readonlyInput) =>
			isEqualOrDescendant(relativePath, readonlyInput.destinationRelativePath),
		);
	};
	const mapInputPath = (providerPath: string, readonlyInput: ReadonlyInputProvider): string => {
		const relativePath = toRelativeProviderPath(providerPath);
		const suffix = relativePath.slice(readonlyInput.destinationRelativePath.length);
		return suffix.length === 0 ? '/' : suffix;
	};
	const conflictsWithReadonlyInput = (providerPath: string): boolean => {
		const relativePath = toRelativeProviderPath(providerPath);
		return readonlyInputs.some((readonlyInput) =>
			pathsOverlap(relativePath, readonlyInput.destinationRelativePath),
		);
	};
	const isHidden = (providerPath: string): boolean => {
		const relativePath = toRelativeProviderPath(providerPath);
		return policy.hiddenPaths.some((hiddenPath) => isEqualOrDescendant(relativePath, hiddenPath));
	};

	return new Proxy(provider, {
		get(target: VirtualProvider, property: string | symbol): unknown {
			const value = Reflect.get(target, property, target) as unknown;
			if (typeof property !== 'string' || typeof value !== 'function') {
				return value;
			}
			if (property === 'readdir' || property === 'readdirSync') {
				return (...methodArguments: readonly unknown[]): unknown => {
					const providerPath = String(methodArguments[0]);
					const readdirOptions = methodArguments[1];
					const withFileTypes =
						typeof readdirOptions === 'object' &&
						readdirOptions !== null &&
						'withFileTypes' in readdirOptions &&
						readdirOptions.withFileTypes === true;
					const readonlyInput = findInput(providerPath);
					if (readonlyInput && !isHidden(providerPath)) {
						return invokeProviderMethod(readonlyInput.provider, property, [
							mapInputPath(providerPath, readonlyInput),
							...methodArguments.slice(1),
						]);
					}
					const virtualChildren = directReadonlyDestinationChildren(providerPath, readonlyInputs);
					if (virtualChildren.length === 0) {
						return Reflect.apply(value as ProviderMethod, target, methodArguments);
					}
					if (property === 'readdir') {
						return Promise.resolve(Reflect.apply(value as ProviderMethod, target, methodArguments))
							.catch((error: unknown) => {
								if (isNoEntryError(error)) {
									return [];
								}
								throw error;
							})
							.then((entries) =>
								mergeDirectoryEntries(
									entries as readonly (string | { readonly name: string })[],
									virtualChildren,
									withFileTypes,
								),
							);
					}
					try {
						return mergeDirectoryEntries(
							Reflect.apply(value as ProviderMethod, target, methodArguments) as readonly (
								| string
								| { readonly name: string }
							)[],
							virtualChildren,
							withFileTypes,
						);
					} catch (error) {
						if (isNoEntryError(error)) {
							return virtualChildren;
						}
						throw error;
					}
				};
			}
			if (
				property === 'stat' ||
				property === 'statSync' ||
				property === 'lstat' ||
				property === 'lstatSync'
			) {
				return (...methodArguments: readonly unknown[]): unknown => {
					const providerPath = String(methodArguments[0]);
					const readonlyInput = findInput(providerPath);
					if (readonlyInput && !isHidden(providerPath)) {
						return invokeProviderMethod(readonlyInput.provider, property, [
							mapInputPath(providerPath, readonlyInput),
							...methodArguments.slice(1),
						]);
					}
					const virtualChildren = directReadonlyDestinationChildren(providerPath, readonlyInputs);
					if (virtualChildren.length === 0) {
						return Reflect.apply(value as ProviderMethod, target, methodArguments);
					}
					if (property === 'stat' || property === 'lstat') {
						return Promise.resolve(
							Reflect.apply(value as ProviderMethod, target, methodArguments),
						).catch((error: unknown) => {
							if (isNoEntryError(error)) {
								return createVirtualDirStats();
							}
							throw error;
						});
					}
					try {
						return Reflect.apply(value as ProviderMethod, target, methodArguments);
					} catch (error) {
						if (isNoEntryError(error)) {
							return createVirtualDirStats();
						}
						throw error;
					}
				};
			}
			if (property === 'open' || property === 'openSync') {
				return (...methodArguments: readonly unknown[]): unknown => {
					const providerPath = String(methodArguments[0]);
					const readonlyInput = findInput(providerPath);
					return readonlyInput && !isHidden(providerPath)
						? invokeProviderMethod(readonlyInput.provider, property, [
								mapInputPath(providerPath, readonlyInput),
								...methodArguments.slice(1),
							])
						: Reflect.apply(value as ProviderMethod, target, methodArguments);
				};
			}
			if (singlePathMutationMethods.has(property)) {
				return (...methodArguments: readonly unknown[]): unknown => {
					const providerPath = String(methodArguments[mutationPathArgumentIndex(property)]);
					if (!isHidden(providerPath) && conflictsWithReadonlyInput(providerPath)) {
						return failProviderMutation(property, providerPath);
					}
					return Reflect.apply(value as ProviderMethod, target, methodArguments);
				};
			}
			if (
				property === 'rename' ||
				property === 'renameSync' ||
				property === 'link' ||
				property === 'linkSync'
			) {
				return (...methodArguments: readonly unknown[]): unknown => {
					const affectedPaths = [String(methodArguments[0]), String(methodArguments[1])];
					const conflictingPath = affectedPaths.find(
						(affectedPath) => !isHidden(affectedPath) && conflictsWithReadonlyInput(affectedPath),
					);
					if (conflictingPath) {
						return failProviderMutation(property, conflictingPath);
					}
					return Reflect.apply(value as ProviderMethod, target, methodArguments);
				};
			}
			if (property === 'copyFile' || property === 'copyFileSync') {
				return (...methodArguments: readonly unknown[]): unknown => {
					const sourcePath = String(methodArguments[0]);
					const destinationPath = String(methodArguments[1]);
					if (!isHidden(destinationPath) && conflictsWithReadonlyInput(destinationPath)) {
						return failProviderMutation(property, destinationPath);
					}
					const sourceInput = findInput(sourcePath);
					if (!sourceInput || isHidden(sourcePath)) {
						return Reflect.apply(value as ProviderMethod, target, methodArguments);
					}
					const mappedSourcePath = mapInputPath(sourcePath, sourceInput);
					if (property === 'copyFile') {
						return Promise.resolve(
							invokeProviderMethod(sourceInput.provider, 'readFile', [mappedSourcePath]),
						).then((contents) =>
							invokeProviderMethod(target, 'writeFile', [destinationPath, contents]),
						);
					}
					const contents = invokeProviderMethod(sourceInput.provider, 'readFileSync', [
						mappedSourcePath,
					]);
					return invokeProviderMethod(target, 'writeFileSync', [destinationPath, contents]);
				};
			}
			return (...methodArguments: readonly unknown[]): unknown => {
				const providerPath = String(methodArguments[0]);
				const readonlyInput = findInput(providerPath);
				const result =
					readonlyInput && !isHidden(providerPath)
						? invokeProviderMethod(readonlyInput.provider, property, [
								mapInputPath(providerPath, readonlyInput),
								...methodArguments.slice(1),
							])
						: Reflect.apply(value as ProviderMethod, target, methodArguments);
				if (!readonlyInput || isHidden(providerPath)) {
					return result;
				}
				if (property === 'realpath') {
					return Promise.resolve(result).then((resolvedPath) => {
						const resolvedRelativePath = toRelativeProviderPath(String(resolvedPath));
						return toAbsoluteProviderPath(
							resolvedRelativePath.length === 0
								? readonlyInput.destinationRelativePath
								: `${readonlyInput.destinationRelativePath}/${resolvedRelativePath}`,
						);
					});
				}
				if (property === 'realpathSync') {
					const resolvedRelativePath = toRelativeProviderPath(String(result));
					return toAbsoluteProviderPath(
						resolvedRelativePath.length === 0
							? readonlyInput.destinationRelativePath
							: `${readonlyInput.destinationRelativePath}/${resolvedRelativePath}`,
					);
				}
				return result;
			};
		},
	});
}

export function createFilteredWorkspaceProvider(
	options: CreateFilteredWorkspaceProviderOptions,
): VirtualProvider {
	let workspaceProvider = options.baseProvider;
	if (options.policy.visibility.kind === 'positive-paths') {
		workspaceProvider = createPositiveWorkspaceProjectionProvider(
			workspaceProvider,
			options.policy.visibility,
			options.dependencies,
		);
	}

	if (options.policy.hiddenPaths.length > 0) {
		workspaceProvider = options.dependencies.createShadowProvider(workspaceProvider, {
			shouldShadow: options.dependencies.createShadowPathPredicate(
				options.policy.hiddenPaths.map(toAbsoluteProviderPath),
			),
			writeMode: 'deny',
		});
	}

	if (options.policy.temporaryPaths.length > 0) {
		const hiddenPredicate = options.dependencies.createShadowPathPredicate(
			options.policy.hiddenPaths.map(toAbsoluteProviderPath),
		);
		const temporaryPredicate = options.dependencies.createShadowPathPredicate(
			options.policy.temporaryPaths.map(toAbsoluteProviderPath),
		);
		workspaceProvider = options.dependencies.createShadowProvider(workspaceProvider, {
			shouldShadow: (context) => !hiddenPredicate(context) && temporaryPredicate(context),
			tmpfs: options.dependencies.createMemoryProvider(),
			writeMode: 'tmpfs',
		});
	}
	workspaceProvider = createWorkspaceHardlinkProvider(
		workspaceProvider,
		options.baseProvider,
		options.policy,
	);

	return createNestedReadonlyWorkspaceProvider(
		workspaceProvider,
		options.baseProvider,
		options.policy,
		options.dependencies,
	);
}
