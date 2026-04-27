import path from 'node:path';

import { execa } from 'execa';

import type { TaskOutput } from '../shared/run-task.js';

export interface DockerCommandOptions {
	readonly streamPreview?: TaskOutput;
}

export interface DockerImageBuilderDependencies {
	readonly executeCommand?: (
		command: string,
		args: readonly string[],
		options: DockerCommandOptions,
	) => Promise<{
		readonly exitCode?: number;
	} | void>;
}

export interface BuildDockerImageOptions {
	readonly dockerfilePath: string;
	readonly imageTag: string;
	readonly streamPreview?: TaskOutput;
}

async function executeDockerCommand(
	command: string,
	args: readonly string[],
	options: DockerCommandOptions,
): Promise<void> {
	if (!options.streamPreview) {
		await execa(command, args, { stdio: 'inherit' });
		return;
	}

	const child = execa(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
	child.stdout?.on('data', (chunk) => {
		options.streamPreview?.write(chunk);
	});
	child.stderr?.on('data', (chunk) => {
		options.streamPreview?.write(chunk);
	});
	await child;
}

export async function buildDockerImage(
	options: BuildDockerImageOptions,
	dependencies: DockerImageBuilderDependencies = {},
): Promise<void> {
	const executeCommand = dependencies.executeCommand ?? executeDockerCommand;
	const resolvedDockerfilePath = path.resolve(options.dockerfilePath);
	const dockerBuildContextDirectory = path.dirname(resolvedDockerfilePath);

	try {
		await executeCommand(
			'docker',
			[
				'build',
				'--progress=plain',
				'-f',
				resolvedDockerfilePath,
				'-t',
				options.imageTag,
				dockerBuildContextDirectory,
			],
			options.streamPreview ? { streamPreview: options.streamPreview } : {},
		);
	} catch (error) {
		throw new Error(
			`Docker build failed for ${options.imageTag}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}
