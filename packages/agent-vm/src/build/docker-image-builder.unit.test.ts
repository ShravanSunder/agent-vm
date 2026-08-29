import { describe, expect, it } from 'vitest';

import {
	buildDockerImage,
	resolveDockerRootfsIdentity,
	type DockerImageBuilderDependencies,
	type DockerRootfsIdentity,
} from './docker-image-builder.js';

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
				dockerfilePath: '/project/vm-images/gateways/hermes/Dockerfile',
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
					'/project/vm-images/gateways/hermes/Dockerfile',
					'-t',
					'agent-vm-gateway:latest',
					'/project/vm-images/gateways/hermes',
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
				dockerfilePath: '/project/vm-images/gateways/hermes/Dockerfile',
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
					dockerfilePath: '/project/vm-images/gateways/hermes/Dockerfile',
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

	it('resolves rootfs identity from Docker image inspect output', async () => {
		const identity = await resolveDockerRootfsIdentity('agent-vm-gateway:latest', {
			inspectImage: async () => ({
				Architecture: 'arm64',
				Os: 'linux',
				RootFS: {
					Layers: ['sha256:layer-a', 'sha256:layer-b'],
				},
				Variant: 'v8',
			}),
		});

		expect(identity).toEqual({
			architecture: 'arm64',
			layers: ['sha256:layer-a', 'sha256:layer-b'],
			os: 'linux',
			variant: 'v8',
		} satisfies DockerRootfsIdentity);
	});

	it('treats missing Docker images as absent rootfs identity', async () => {
		const identity = await resolveDockerRootfsIdentity('agent-vm-gateway:latest', {
			inspectImage: async () => undefined,
		});

		expect(identity).toBeUndefined();
	});

	it('rejects Docker images without ordered rootfs layers', async () => {
		await expect(
			resolveDockerRootfsIdentity('agent-vm-gateway:latest', {
				inspectImage: async () => ({
					Architecture: 'arm64',
					Os: 'linux',
					RootFS: {},
				}),
			}),
		).rejects.toThrow(/missing ordered rootfs layers/u);
	});
});
