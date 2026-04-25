import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';

import {
	finalizeRepoResourceSetupInputSchema,
	repoResourcesFinalSchema,
	repoResourcesDescriptionSchema,
	type FinalizeRepoResourceSetupInput,
	type ResolvedRepoResourcesDescription,
	type ResolvedRepoResourcesFinal,
} from '../config/resource-contracts/index.js';

const REPO_RESOURCES_PATH = path.join('.agent-vm', 'repo-resources.ts');
const REPO_CONTRACT_TIMEOUT_MS = 30_000;

function writeRepoContractLoaderLog(message: string): void {
	process.stderr.write(`[repo-resource-contract-loader] ${message}\n`);
}

function getErrorStderr(error: unknown): string | null {
	if (
		typeof error === 'object' &&
		error !== null &&
		'stderr' in error &&
		typeof error.stderr === 'string'
	) {
		const stderr = error.stderr.trim();
		return stderr.length > 0 ? stderr : null;
	}
	return null;
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

export async function hasRepoResourceDescriptionContract(repoDir: string): Promise<boolean> {
	return await fileExists(path.join(repoDir, REPO_RESOURCES_PATH));
}

async function runRepoResourcesFunction(options: {
	readonly argument?: unknown;
	readonly functionName: 'describeRepoResources' | 'finalizeRepoResourceSetup';
	readonly repoDir: string;
	readonly repoId: string;
	readonly repoUrl: string;
}): Promise<unknown> {
	const contractPath = path.join(options.repoDir, REPO_RESOURCES_PATH);
	const contractUrl = pathToFileURL(contractPath).href;
	const source = `
const module = await import(${JSON.stringify(contractUrl)});
const fn = module[${JSON.stringify(options.functionName)}];
if (typeof fn !== 'function') {
\tthrow new Error('repo-resources.ts must export ${options.functionName}()');
}
const argument = ${JSON.stringify(options.argument ?? null)};
const result = ${options.argument === undefined ? 'await fn()' : 'await fn(argument)'};
process.stdout.write(JSON.stringify(result));
`;
	try {
		const result = await execa(
			'node',
			['--experimental-strip-types', '--input-type=module', '--eval', source],
			{
				cwd: options.repoDir,
				// Repo contracts are untrusted task input. Keep only PATH so Node and
				// repo-local shell lookups work without inheriting controller secrets.
				env: { PATH: process.env.PATH ?? '' },
				extendEnv: false,
				reject: true,
				timeout: REPO_CONTRACT_TIMEOUT_MS,
			},
		);
		const stdout = result.stdout.trim();
		if (stdout.length === 0) {
			throw new Error(
				`repo-resources.ts ${options.functionName}() produced no stdout for repo '${options.repoId}'.`,
			);
		}
		return JSON.parse(stdout) as unknown;
	} catch (error) {
		const stderr = getErrorStderr(error);
		const message = `${error instanceof Error ? error.message : String(error)}${
			stderr ? `\nstderr:\n${stderr}` : ''
		}`;
		throw new Error(
			`Failed to run repo-resources.ts ${options.functionName}() for repo '${options.repoId}' (${options.repoUrl}): ${message}`,
			{ cause: error },
		);
	}
}

export async function loadRepoResourceDescriptionContract(options: {
	readonly repoDir: string;
	readonly repoId: string;
	readonly repoUrl: string;
}): Promise<ResolvedRepoResourcesDescription> {
	const contractPath = path.join(options.repoDir, REPO_RESOURCES_PATH);
	if (!(await fileExists(contractPath))) {
		writeRepoContractLoaderLog(
			`${options.repoId}: no ${REPO_RESOURCES_PATH}; treating repo resources as empty.`,
		);
		return {
			setupCommand: '.agent-vm/run-setup.sh',
			requires: {},
			provides: {},
		};
	}

	const result = await runRepoResourcesFunction({
		functionName: 'describeRepoResources',
		repoDir: options.repoDir,
		repoId: options.repoId,
		repoUrl: options.repoUrl,
	});
	return repoResourcesDescriptionSchema.parse(result);
}

export async function finalizeRepoResourceSetupInSubprocess(options: {
	readonly input: FinalizeRepoResourceSetupInput;
	readonly repoDir: string;
}): Promise<ResolvedRepoResourcesFinal> {
	const parsedInput = finalizeRepoResourceSetupInputSchema.parse(options.input);
	const result = await runRepoResourcesFunction({
		argument: parsedInput,
		functionName: 'finalizeRepoResourceSetup',
		repoDir: options.repoDir,
		repoId: parsedInput.repoId,
		repoUrl: parsedInput.repoUrl,
	});
	return repoResourcesFinalSchema.parse(result);
}
