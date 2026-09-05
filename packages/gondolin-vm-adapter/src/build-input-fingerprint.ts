import { createHash } from 'node:crypto';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { BuildConfig } from '@earendil-works/gondolin';

async function digestInputPath(
	inputPath: string,
	ancestors: ReadonlySet<string> = new Set(),
): Promise<string> {
	const identity = await realpath(inputPath);
	if (ancestors.has(identity)) throw new Error(`Cyclic image build input '${inputPath}'.`);
	const metadata = await lstat(inputPath);
	const hash = createHash('sha256');
	if (metadata.isSymbolicLink()) {
		const target = await readlink(inputPath);
		hash.update(JSON.stringify(['symlink', target, await digestInputPath(identity, ancestors)]));
	} else if (metadata.isDirectory()) {
		hash.update(JSON.stringify(['directory', metadata.mode & 0o7777]));
		const nextAncestors = new Set([...ancestors, identity]);
		const entries = (await readdir(inputPath)).toSorted();
		const digests = await entries.reduce<Promise<(readonly [string, string])[]>>(
			async (pending, entry) => {
				const collected = await pending;
				collected.push([entry, await digestInputPath(path.join(inputPath, entry), nextAncestors)]);
				return collected;
			},
			Promise.resolve([]),
		);
		hash.update(JSON.stringify(digests));
	} else if (metadata.isFile()) {
		hash.update(JSON.stringify(['file', metadata.mode & 0o7777, metadata.size]));
		const fileHandle = await open(inputPath, 'r');
		try {
			for await (const chunk of fileHandle.createReadStream({ autoClose: false })) {
				if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary build input.');
				hash.update(chunk);
			}
		} finally {
			await fileHandle.close();
		}
	} else throw new Error(`Unsupported image build input '${inputPath}'.`);
	return hash.digest('hex');
}

export async function fingerprintBuildInputContent(
	buildConfig: BuildConfig,
	configDir: string,
): Promise<BuildConfig> {
	const normalized = structuredClone(buildConfig);
	const digestPath = async (inputPath: string): Promise<string> =>
		`sha256:${await digestInputPath(path.resolve(configDir, inputPath))}`;
	if (normalized.init !== undefined) {
		const init = normalized.init;
		await Promise.all(
			(['rootfsInit', 'initramfsInit', 'rootfsInitExtra'] as const).map(async (field) => {
				const inputPath = init[field];
				if (inputPath !== undefined) init[field] = await digestPath(inputPath);
			}),
		);
	}
	if (normalized.postBuild?.copy !== undefined) {
		normalized.postBuild.copy = await Promise.all(
			normalized.postBuild.copy.map(async (entry) => ({
				...entry,
				src: await digestPath(entry.src),
			})),
		);
	}
	const helperFields = [
		'sandboxdPath',
		'sandboxfsPath',
		'sandboxsshPath',
		'sandboxingressPath',
	] as const;
	const explicitHelpers = helperFields.every((field) => buildConfig[field] !== undefined);
	const helperDirectory = process.env.GONDOLIN_SANDBOX_HELPERS_DIR?.trim();
	if (
		!explicitHelpers &&
		/^(1|true|yes|on)$/iu.test(process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE ?? '')
	) {
		throw new Error(
			'Cached image builds require explicit sandbox helper paths instead of source-build environment overrides.',
		);
	}
	await Promise.all(
		helperFields.map(async (field) => {
			const inputPath =
				buildConfig[field] ??
				(!explicitHelpers && helperDirectory
					? path.join(helperDirectory, 'bin', field.replace(/Path$/u, ''))
					: undefined);
			if (inputPath !== undefined) normalized[field] = await digestPath(inputPath);
		}),
	);
	if (normalized.nixos?.systemExpression !== undefined)
		normalized.nixos.systemExpression = await digestPath(normalized.nixos.systemExpression);
	return normalized;
}
