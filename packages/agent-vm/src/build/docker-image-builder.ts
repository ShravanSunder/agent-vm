import path from 'node:path';

import { execa } from 'execa';

export interface DockerImageBuilderDependencies {
	readonly executeCommand?: (
		command: string,
		args: readonly string[],
	) => Promise<{
		readonly exitCode?: number;
	} | void>;
}

export interface BuildDockerImageOptions {
	readonly dockerfilePath: string;
	readonly imageTag: string;
}

async function executeDockerCommand(command: string, args: readonly string[]): Promise<void> {
	await execa(command, args, { stdio: 'inherit' });
}

export async function buildDockerImage(
	options: BuildDockerImageOptions,
	dependencies: DockerImageBuilderDependencies = {},
): Promise<void> {
	const executeCommand = dependencies.executeCommand ?? executeDockerCommand;
	const resolvedDockerfilePath = path.resolve(options.dockerfilePath);
	const dockerBuildContextDirectory = path.dirname(resolvedDockerfilePath);

	try {
		await executeCommand('docker', [
			'build',
			'-f',
			resolvedDockerfilePath,
			'-t',
			options.imageTag,
			dockerBuildContextDirectory,
		]);
	} catch (error) {
		throw new Error(
			`Docker build failed for ${options.imageTag}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}
