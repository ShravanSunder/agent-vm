import { describe, expect, it } from 'vitest';

import { buildDockerImage, type DockerImageBuilderDependencies } from './docker-image-builder.js';

describe('buildDockerImage', () => {
	it('runs docker build with the dockerfile directory as build context', async () => {
		const executedCommands: {
			command: string;
			args: readonly string[];
			options: unknown;
		}[] = [];
		const dependencies: DockerImageBuilderDependencies = {
			executeCommand: async (command, args, options) => {
				executedCommands.push({ command, args, options });
			},
		};

		await buildDockerImage(
			{
				dockerfilePath: '/project/vm-images/gateways/openclaw/Dockerfile',
				imageTag: 'agent-vm-gateway:latest',
			},
			dependencies,
		);

		expect(executedCommands).toEqual([
			{
				command: 'docker',
				args: [
					'build',
					'--progress=plain',
					'-f',
					'/project/vm-images/gateways/openclaw/Dockerfile',
					'-t',
					'agent-vm-gateway:latest',
					'/project/vm-images/gateways/openclaw',
				],
				options: {},
			},
		]);
	});

	it('passes Tasuku stream preview to the Docker executor when provided', async () => {
		const streamPreview = { write: () => true };
		const executedOptions: unknown[] = [];
		const dependencies: DockerImageBuilderDependencies = {
			executeCommand: async (_command, _args, options) => {
				executedOptions.push(options);
			},
		};

		await buildDockerImage(
			{
				dockerfilePath: '/project/vm-images/gateways/openclaw/Dockerfile',
				imageTag: 'agent-vm-gateway:latest',
				streamPreview,
			},
			dependencies,
		);

		expect(executedOptions).toEqual([{ streamPreview }]);
	});

	it('wraps docker build failures with image context', async () => {
		await expect(
			buildDockerImage(
				{
					dockerfilePath: '/project/vm-images/gateways/openclaw/Dockerfile',
					imageTag: 'agent-vm-gateway:latest',
				},
				{
					executeCommand: async () => {
						throw new Error('exit code 1');
					},
				},
			),
		).rejects.toThrow('Docker build failed for agent-vm-gateway:latest: exit code 1');
	});
});
