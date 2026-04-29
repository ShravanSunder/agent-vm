import fs from 'node:fs';
import path from 'node:path';

import type { VirtualProvider } from '@earendil-works/gondolin';

export interface PinnedRealFsRoot {
	readonly hostPath: string;
	readonly realPath: string;
	readonly fd: number;
	readonly device: number;
	readonly inode: number;
}

export interface CreatePinnedRealFsProviderOptions {
	readonly root: PinnedRealFsRoot;
	readonly createRealFsProvider: (hostPath: string) => VirtualProvider;
}

function formatRootIdentity(root: PinnedRealFsRoot): string {
	return `${root.device}:${root.inode}`;
}

function openDirectoryNoFollow(candidatePath: string): number {
	return fs.openSync(
		candidatePath,
		fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
	);
}

export function pinRealFsRoot(hostPath: string): PinnedRealFsRoot {
	if (!hostPath || !path.isAbsolute(hostPath)) {
		throw new Error(`Pinned RealFS root must be a non-empty absolute path: ${hostPath}`);
	}

	const resolvedHostPath = path.resolve(hostPath);
	const fd = openDirectoryNoFollow(resolvedHostPath);
	try {
		const stats = fs.fstatSync(fd);
		if (!stats.isDirectory()) {
			throw new Error(`Pinned RealFS root is not a directory: ${resolvedHostPath}`);
		}
		const realPath = fs.realpathSync(resolvedHostPath);
		const realPathStats = fs.statSync(realPath);
		if (realPathStats.dev !== stats.dev || realPathStats.ino !== stats.ino) {
			throw new Error(
				`Pinned RealFS root changed while opening: ${resolvedHostPath} opened ${stats.dev}:${stats.ino} but resolved to ${realPathStats.dev}:${realPathStats.ino}`,
			);
		}
		return {
			device: stats.dev,
			fd,
			hostPath: resolvedHostPath,
			inode: stats.ino,
			realPath,
		};
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

export function closePinnedRealFsRoot(root: PinnedRealFsRoot): void {
	fs.closeSync(root.fd);
}

export function assertPinnedRealFsRoot(root: PinnedRealFsRoot): void {
	const pinnedStats = fs.fstatSync(root.fd);
	const currentStats = fs.statSync(root.realPath);
	if (
		pinnedStats.dev !== root.device ||
		pinnedStats.ino !== root.inode ||
		currentStats.dev !== root.device ||
		currentStats.ino !== root.inode
	) {
		throw new Error(
			`Pinned RealFS root changed before mount access: ${root.realPath} expected ${formatRootIdentity(root)} got ${currentStats.dev}:${currentStats.ino}`,
		);
	}
}

type ProviderMethod = (...args: unknown[]) => unknown;

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Reflect.get()
   loses the method signature from Gondolin's VirtualProvider union. The proxy
   keeps the same provider object and only wraps callable properties with the
   pinned-root assertion. */
export function createPinnedRealFsProvider(
	options: CreatePinnedRealFsProviderOptions,
): VirtualProvider {
	assertPinnedRealFsRoot(options.root);
	const provider = options.createRealFsProvider(options.root.realPath);

	return new Proxy(provider, {
		get(target: VirtualProvider, property: string | symbol, receiver: unknown): unknown {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== 'function') {
				return value;
			}

			return (...methodArguments: readonly unknown[]): unknown => {
				assertPinnedRealFsRoot(options.root);
				return Reflect.apply(value as ProviderMethod, target, methodArguments);
			};
		},
	});
}
/* oxlint-enable typescript-eslint/no-unsafe-type-assertion */
