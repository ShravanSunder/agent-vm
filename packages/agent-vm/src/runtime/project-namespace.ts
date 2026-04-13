import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function slugifyProjectName(projectName: string): string {
	const normalizedProjectName = projectName
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+/u, '')
		.replace(/-+$/u, '');

	return normalizedProjectName.length > 0 ? normalizedProjectName : 'agent-vm';
}

export async function buildDefaultProjectNamespace(targetDirectory: string): Promise<string> {
	const resolvedTargetDirectory = await fs
		.realpath(targetDirectory)
		.catch(() => path.resolve(targetDirectory));
	const projectName = slugifyProjectName(path.basename(resolvedTargetDirectory));
	const projectHash = crypto
		.createHash('sha1')
		.update(resolvedTargetDirectory)
		.digest('hex')
		.slice(0, 8);

	return `${projectName}-${projectHash}`;
}
