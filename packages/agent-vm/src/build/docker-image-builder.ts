import path from 'node:path';
import { createInterface as createReadlineInterface } from 'node:readline';

import { execa } from 'execa';

import type { TaskOutput } from '../shared/run-task.js';

export interface DockerCommandOptions {
	readonly quiet?: boolean;
	readonly streamPreview?: TaskOutput;
}

export interface DockerRootfsIdentity {
	readonly architecture: string;
	readonly layers: readonly string[];
	readonly os: string;
	readonly variant?: string;
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

export interface DockerImageInspectDependencies {
	readonly inspectImage?: (imageTag: string) => Promise<unknown | undefined>;
}

export interface BuildDockerImageOptions {
	readonly dockerfilePath: string;
	readonly imageTag: string;
	readonly quiet?: boolean;
	readonly streamPreview?: TaskOutput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function pipeStreamAsLines(
	stream: NodeJS.ReadableStream | null | undefined,
	sink: TaskOutput,
): void {
	if (!stream) {
		return;
	}
	const lineReader = createReadlineInterface({ input: stream });
	lineReader.on('line', (line: string) => {
		sink.write(`${line}\n`);
	});
}

async function executeDockerCommand(
	command: string,
	args: readonly string[],
	options: DockerCommandOptions,
): Promise<void> {
	if (!options.streamPreview) {
		await execa(command, args, { stdio: options.quiet ? 'pipe' : 'inherit' });
		return;
	}

	const child = execa(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
	pipeStreamAsLines(child.stdout, options.streamPreview);
	pipeStreamAsLines(child.stderr, options.streamPreview);
	await child;
}

async function inspectDockerImage(imageTag: string): Promise<unknown | undefined> {
	try {
		const result = await execa('docker', [
			'image',
			'inspect',
			'--format',
			'{{json .}}',
			imageTag,
		]);
		return JSON.parse(result.stdout) as unknown;
	} catch {
		return undefined;
	}
}

export async function resolveDockerRootfsIdentity(
	imageTag: string,
	dependencies: DockerImageInspectDependencies = {},
): Promise<DockerRootfsIdentity | undefined> {
	const inspectedImage = await (dependencies.inspectImage ?? inspectDockerImage)(imageTag);
	if (inspectedImage === undefined) {
		return undefined;
	}
	if (!isRecord(inspectedImage)) {
		throw new Error(`Docker image '${imageTag}' inspect result must be an object.`);
	}
	const architecture = inspectedImage.Architecture;
	const os = inspectedImage.Os;
	const variant = inspectedImage.Variant;
	const rootfs = inspectedImage.RootFS;
	if (typeof architecture !== 'string' || architecture.length === 0) {
		throw new Error(`Docker image '${imageTag}' is missing architecture.`);
	}
	if (typeof os !== 'string' || os.length === 0) {
		throw new Error(`Docker image '${imageTag}' is missing operating system.`);
	}
	if (!isRecord(rootfs)) {
		throw new Error(`Docker image '${imageTag}' is missing rootfs metadata.`);
	}
	const layers = rootfs.Layers;
	if (
		!Array.isArray(layers) ||
		layers.length === 0 ||
		!layers.every((layer): layer is string => typeof layer === 'string' && layer.length > 0)
	) {
		throw new Error(`Docker image '${imageTag}' is missing ordered rootfs layers.`);
	}

	return {
		architecture,
		layers,
		os,
		...(typeof variant === 'string' && variant.length > 0 ? { variant } : {}),
	};
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
			{
				...(options.quiet ? { quiet: true } : {}),
				...(options.streamPreview ? { streamPreview: options.streamPreview } : {}),
			},
		);
	} catch (error) {
		throw new Error(
			`Docker build failed for ${options.imageTag}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}
