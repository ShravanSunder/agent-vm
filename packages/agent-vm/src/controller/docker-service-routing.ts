import fs from 'node:fs';
import path from 'node:path';

import { execa } from 'execa';

export interface DockerServiceRoutingResult {
	readonly composeFilePaths: readonly string[];
	readonly tcpHosts: Record<string, string>;
}

export class DockerServiceRoutingError extends Error {
	public readonly startedComposeFilePaths: readonly string[];

	public constructor(message: string, startedComposeFilePaths: readonly string[], cause?: unknown) {
		super(message, cause ? { cause } : undefined);
		this.name = 'DockerServiceRoutingError';
		this.startedComposeFilePaths = startedComposeFilePaths;
	}
}

interface DockerInspectContainer {
	readonly Config?: {
		readonly ExposedPorts?: Record<string, unknown>;
		readonly Labels?: Record<string, string>;
	};
	readonly NetworkSettings?: {
		readonly Networks?: Record<
			string,
			{
				readonly IPAddress?: string;
			}
		>;
	};
}

function findComposeFiles(
	workspaceDir: string,
	repoHostDirs: readonly string[],
): readonly string[] {
	const candidateDirectories = [workspaceDir, ...repoHostDirs];
	const composeFilePaths: string[] = [];

	for (const directory of candidateDirectories) {
		const composeFilePath = path.join(directory, '.agent-vm', 'docker-compose.yml');
		if (fs.existsSync(composeFilePath)) {
			composeFilePaths.push(composeFilePath);
		}
	}

	return composeFilePaths;
}

function getContainerIp(container: DockerInspectContainer): string | null {
	for (const network of Object.values(container.NetworkSettings?.Networks ?? {})) {
		if (network?.IPAddress) {
			return network.IPAddress;
		}
	}
	return null;
}

function buildTcpHostsFromInspect(
	containers: readonly DockerInspectContainer[],
): Record<string, string> {
	const tcpHosts: Record<string, string> = {};

	for (const container of containers) {
		const serviceName = container.Config?.Labels?.['com.docker.compose.service'];
		const ipAddress = getContainerIp(container);
		const exposedPorts = Object.keys(container.Config?.ExposedPorts ?? {});

		if (!serviceName || !ipAddress) {
			continue;
		}

		for (const portSpec of exposedPorts) {
			const [port] = portSpec.split('/');
			if (!port) {
				continue;
			}
			tcpHosts[`${serviceName}.local:${port}`] = `${ipAddress}:${port}`;
		}
	}

	return tcpHosts;
}

export async function startDockerServicesForTask(
	workspaceDir: string,
	repoHostDirs: readonly string[] = [],
): Promise<DockerServiceRoutingResult> {
	const composeFilePaths = findComposeFiles(workspaceDir, repoHostDirs);
	if (composeFilePaths.length === 0) {
		return {
			composeFilePaths: [],
			tcpHosts: {},
		};
	}

	const tcpHosts: Record<string, string> = {};
	const startedComposeFilePaths: string[] = [];
	for (const composeFilePath of composeFilePaths) {
		const composeWorkingDirectory = path.dirname(path.dirname(composeFilePath));
		try {
			// Compose startup is intentionally sequential because each file mutates host-side task resources.
			// oxlint-disable-next-line eslint/no-await-in-loop
			await execa('docker', ['compose', '-f', composeFilePath, 'up', '-d', '--wait'], {
				cwd: composeWorkingDirectory,
				reject: true,
			});
			startedComposeFilePaths.push(composeFilePath);

			// Container discovery depends on the compose stack just started above.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const psResult = await execa('docker', ['compose', '-f', composeFilePath, 'ps', '-q'], {
				cwd: composeWorkingDirectory,
				reject: true,
			});
			const containerIds = psResult.stdout
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0);

			// Inspecting containers can run in parallel once the compose stack exists.
			const inspectedContainers = await Promise.all(
				containerIds.map(async (containerId) => {
					const inspectResult = await execa('docker', ['inspect', containerId], {
						cwd: composeWorkingDirectory,
						reject: true,
					});
					return JSON.parse(inspectResult.stdout) as DockerInspectContainer[];
				}),
			);
			Object.assign(
				tcpHosts,
				...inspectedContainers.map((containers) => buildTcpHostsFromInspect(containers)),
			);
		} catch (error) {
			throw new DockerServiceRoutingError(
				`Docker service routing failed for ${composeFilePath}`,
				startedComposeFilePaths,
				error,
			);
		}
	}

	return {
		composeFilePaths,
		tcpHosts,
	};
}

export async function stopDockerServicesForTask(
	composeFilePaths: readonly string[],
): Promise<void> {
	if (composeFilePaths.length === 0) {
		return;
	}

	let firstError: unknown = null;
	for (const composeFilePath of composeFilePaths) {
		try {
			// Compose teardown is intentionally sequential because stacks may share docker resources.
			// oxlint-disable-next-line eslint/no-await-in-loop
			await execa('docker', ['compose', '-f', composeFilePath, 'down', '--remove-orphans'], {
				cwd: path.dirname(path.dirname(composeFilePath)),
				reject: true,
			});
		} catch (error) {
			firstError ??= error;
		}
	}

	if (firstError) {
		throw firstError;
	}
}
