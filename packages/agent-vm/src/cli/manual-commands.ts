import fs from 'node:fs/promises';
import path from 'node:path';

import {
	buildAgentVmAgentsTemplate,
	buildManualTemplateFiles,
	type ManualTemplateOptions,
} from './manual-templates.js';

export interface UpdateAgentVmManualOptions extends ManualTemplateOptions {
	readonly targetDir: string;
	readonly updateAgentIndex: boolean;
}

export interface UpdateAgentVmManualResult {
	readonly updated: readonly string[];
}

async function writeGeneratedFile(
	targetDir: string,
	relativePath: string,
	content: string,
): Promise<void> {
	const absolutePath = path.join(targetDir, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content, 'utf8');
}

async function replaceRelativeSymlink(linkPath: string, target: string): Promise<void> {
	await fs.rm(linkPath, { force: true });
	await fs.symlink(target, linkPath);
}

export async function updateAgentVmManual(
	options: UpdateAgentVmManualOptions,
): Promise<UpdateAgentVmManualResult> {
	const updated: string[] = [];
	const manualFiles = buildManualTemplateFiles(options);
	await Promise.all(
		manualFiles.map(
			async (file) => await writeGeneratedFile(options.targetDir, file.relativePath, file.content),
		),
	);
	updated.push(...manualFiles.map((file) => file.relativePath));

	if (options.updateAgentIndex) {
		await writeGeneratedFile(options.targetDir, 'AGENTS.md', buildAgentVmAgentsTemplate(options));
		await replaceRelativeSymlink(path.join(options.targetDir, 'CLAUDE.md'), 'AGENTS.md');
		updated.push('AGENTS.md', 'CLAUDE.md');
	}

	return { updated };
}
