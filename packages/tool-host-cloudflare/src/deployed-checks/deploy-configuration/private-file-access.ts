import { lstat, realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
	privateDeployFileSchema,
	type PrivateDeployFile,
} from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';

/** Resolve existing symlinks before checking every ancestor for a repository marker. */
export async function requireOutsideGitWorkTree(target: string): Promise<string> {
	const absolute = path.resolve(target);
	async function canonicalize(candidate: string): Promise<string> {
		try {
			return await realpath(candidate);
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
			return path.join(await canonicalize(path.dirname(candidate)), path.basename(candidate));
		}
	}
	const canonical = await canonicalize(absolute);
	const ancestors: string[] = [];
	let ancestor = canonical;
	while (true) {
		ancestors.push(ancestor);
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	await Promise.all(
		ancestors.map(async (candidate): Promise<void> => {
			try {
				await lstat(path.join(candidate, '.git'));
			} catch (error) {
				if (
					error instanceof Error &&
					'code' in error &&
					(error.code === 'ENOENT' || error.code === 'ENOTDIR')
				)
					return;
				throw error;
			}
			throw new Error('Private deployment paths must be outside every git work tree.');
		}),
	);
	return canonical;
}
export async function readPrivateDeployFile(
	filePath = process.env.TOOL_PORTAL_PRIVATE_DEPLOY_FILE,
): Promise<PrivateDeployFile> {
	if (!filePath)
		throw new Error(
			'Set TOOL_PORTAL_PRIVATE_DEPLOY_FILE to a private JSON file outside every repository (mode 0600).',
		);
	const canonical = await requireOutsideGitWorkTree(filePath);
	const metadata = await stat(canonical);
	if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
		throw new Error('Private deploy file must be a regular file with mode 0600.');
	try {
		return privateDeployFileSchema.parse(JSON.parse(await readFile(canonical, 'utf8')));
	} catch {
		throw new Error('Private deploy file does not match the deployed-check configuration schema.');
	}
}
