import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';

import { repoResourcesDescriptionSchema } from '../config/resource-contracts/index.js';
import {
	buildDockerComposeTemplate,
	buildRepoResourcesAgentsTemplate,
	buildRepoResourcesDeclarationTemplate,
	buildRepoResourcesReadmeTemplate,
	buildRepoResourcesTemplate,
	buildRunSetupShellTemplate,
} from './resource-contract-templates.js';

const AGENT_VM_DIR = '.agent-vm';
const REPO_RESOURCES_VALIDATE_TIMEOUT_MS = 30_000;
const USER_OWNED_FILES = new Set([
	'.agent-vm/repo-resources.ts',
	'.agent-vm/run-setup.sh',
	'.agent-vm/docker-compose.yml',
]);
const STALE_FILES = [
	'.agent-vm/resources-post-hook.ts',
	'.agent-vm/resources-post-hook.d.ts',
	'.agent-vm/setup-repo-resources.sh',
] as const;

export interface RepoResourcesCommandOptions {
	readonly targetDir: string;
}

export interface InitRepoResourcesResult {
	readonly created: readonly string[];
	readonly skipped: readonly string[];
	readonly updated: readonly string[];
}

export interface UpdateRepoResourcesResult {
	readonly updated: readonly string[];
}

export interface ValidateRepoResourcesResult {
	readonly valid: true;
}

interface ResourceTemplateFile {
	readonly content: string;
	readonly generated: boolean;
	readonly mode?: number;
	readonly relativePath: string;
}

function buildResourceTemplateFiles(): readonly ResourceTemplateFile[] {
	return [
		{
			relativePath: '.agent-vm/repo-resources.ts',
			content: buildRepoResourcesTemplate(),
			generated: false,
		},
		{
			relativePath: '.agent-vm/repo-resources.d.ts',
			content: buildRepoResourcesDeclarationTemplate(),
			generated: true,
		},
		{
			relativePath: '.agent-vm/run-setup.sh',
			content: buildRunSetupShellTemplate(),
			generated: false,
			mode: 0o755,
		},
		{
			relativePath: '.agent-vm/docker-compose.yml',
			content: buildDockerComposeTemplate(),
			generated: false,
		},
		{
			relativePath: '.agent-vm/AGENTS.md',
			content: buildRepoResourcesAgentsTemplate(),
			generated: true,
		},
		{
			relativePath: '.agent-vm/README.md',
			content: buildRepoResourcesReadmeTemplate(),
			generated: true,
		},
	];
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

async function writeTemplateFile(
	targetDir: string,
	file: ResourceTemplateFile,
	options: { readonly overwriteGenerated: boolean },
): Promise<'created' | 'skipped' | 'updated'> {
	const absolutePath = path.join(targetDir, file.relativePath);
	const exists = await fileExists(absolutePath);
	if (exists && USER_OWNED_FILES.has(file.relativePath)) {
		return 'skipped';
	}
	if (exists && !file.generated && !options.overwriteGenerated) {
		return 'skipped';
	}
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, file.content, {
		encoding: 'utf8',
		...(file.mode ? { mode: file.mode } : {}),
	});
	return exists ? 'updated' : 'created';
}

export async function initRepoResources(
	options: RepoResourcesCommandOptions,
): Promise<InitRepoResourcesResult> {
	await fs.mkdir(path.join(options.targetDir, AGENT_VM_DIR), { recursive: true });
	const created: string[] = [];
	const skipped: string[] = [];
	const updated: string[] = [];

	const results = await Promise.all(
		buildResourceTemplateFiles().map(async (file) => ({
			file,
			result: await writeTemplateFile(options.targetDir, file, {
				overwriteGenerated: true,
			}),
		})),
	);
	for (const { file, result } of results) {
		if (result === 'created') {
			created.push(file.relativePath);
		} else if (result === 'skipped') {
			skipped.push(file.relativePath);
		} else {
			updated.push(file.relativePath);
		}
	}

	return { created, skipped, updated };
}

export async function updateRepoResources(
	options: RepoResourcesCommandOptions,
): Promise<UpdateRepoResourcesResult> {
	await fs.mkdir(path.join(options.targetDir, AGENT_VM_DIR), { recursive: true });
	const updated = await Promise.all(
		buildResourceTemplateFiles()
			.filter((templateFile) => templateFile.generated)
			.map(async (file) => {
				const absolutePath = path.join(options.targetDir, file.relativePath);
				await fs.writeFile(absolutePath, file.content, { encoding: 'utf8' });
				return file.relativePath;
			}),
	);

	return { updated };
}

async function assertNoStaleResourceFiles(targetDir: string): Promise<void> {
	const staleFileChecks = await Promise.all(
		STALE_FILES.map(async (staleFile) => ({
			exists: await fileExists(path.join(targetDir, staleFile)),
			staleFile,
		})),
	);
	for (const { exists, staleFile } of staleFileChecks) {
		if (exists) {
			throw new Error(`Stale resource file '${staleFile}' is not supported.`);
		}
	}
}

export async function loadRepoResourcesDescription(targetDir: string): Promise<unknown> {
	const contractPath = path.join(targetDir, AGENT_VM_DIR, 'repo-resources.ts');
	const contractUrl = pathToFileURL(contractPath).href;
	const source = `
const module = await import(${JSON.stringify(contractUrl)});
if (typeof module.describeRepoResources !== 'function') {
	throw new Error('repo-resources.ts must export describeRepoResources()');
}
const result = await module.describeRepoResources();
process.stdout.write(JSON.stringify(result));
`;
	const result = await execa(
		'node',
		['--experimental-strip-types', '--input-type=module', '--eval', source],
		{
			cwd: targetDir,
			env: { PATH: process.env.PATH ?? '' },
			extendEnv: false,
			reject: true,
			timeout: REPO_RESOURCES_VALIDATE_TIMEOUT_MS,
		},
	);
	const stdout = result.stdout.trim();
	if (stdout.length === 0) {
		throw new Error('repo-resources.ts describeRepoResources() produced no stdout.');
	}
	return JSON.parse(stdout) as unknown;
}

export async function validateRepoResources(
	options: RepoResourcesCommandOptions,
): Promise<ValidateRepoResourcesResult> {
	await assertNoStaleResourceFiles(options.targetDir);
	const description = await loadRepoResourcesDescription(options.targetDir);
	repoResourcesDescriptionSchema.parse(description);
	return { valid: true };
}
