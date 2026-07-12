import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import { managedVmImageAssetFileNames } from '../build/gondolin-managed-vm-build-tooling.js';

const repoRoot = process.cwd();
const agentVmCliPath = path.join(
	repoRoot,
	'packages',
	'agent-vm',
	'dist',
	'cli',
	'agent-vm-entrypoint.js',
);

const canarySecretValue = 'agent-vm-canary-secret-token-do-not-store';
const canaryAuthorizationHeader = 'Bearer agent-vm-canary-auth-header';
const canaryPromptText = 'agent-vm-canary-user-prompt';
const canaryToolPayload = 'agent-vm-canary-tool-payload';
const canaryCredentialedUrl = 'https://agent-vm-canary-user:agent-vm-canary-password@example.com';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (temporaryDirectory) => {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}),
	);
});

interface SmokeDeployment {
	readonly configPath: string;
	readonly dockerCallLogPath: string;
	readonly fakeBinDirectory: string;
	readonly runtimeDir: string;
}

interface HealthServer {
	readonly close: () => Promise<void>;
	readonly port: number;
}

interface ObservabilityHealthPorts {
	readonly collectorHealth: number;
	readonly logs: number;
	readonly metrics: number;
	readonly traces: number;
}

interface CreateSmokeDeploymentOptions extends ObservabilityHealthPorts {
	readonly stackMode?: 'external' | 'managed';
	readonly zoneObservability?: boolean;
}

async function createHealthServer(): Promise<HealthServer> {
	const server = http.createServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'text/plain' });
		response.end('ok\n');
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Expected health server to bind to an IPv4 TCP port.');
	}
	return {
		port: address.port,
		close: async () =>
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}),
	};
}

async function createHealthServers(count: number): Promise<readonly HealthServer[]> {
	return await Promise.all(Array.from({ length: count }, async () => await createHealthServer()));
}

async function closeHealthServers(healthServers: readonly HealthServer[]): Promise<void> {
	await Promise.all(healthServers.map(async (healthServer) => await healthServer.close()));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
}

async function seedBuiltImageCache(options: {
	readonly buildConfigPath: string;
	readonly cacheDirectory: string;
}): Promise<void> {
	const fingerprint = await computeFingerprintFromConfigPath(options.buildConfigPath);
	const imageDirectory = path.join(options.cacheDirectory, fingerprint);
	await fs.mkdir(imageDirectory, { recursive: true });
	await Promise.all(
		managedVmImageAssetFileNames.map(async (fileName) => {
			await fs.writeFile(path.join(imageDirectory, fileName), `${fileName}\n`, 'utf8');
		}),
	);
}

async function createFakeDocker(temporaryDirectory: string): Promise<{
	readonly dockerCallLogPath: string;
	readonly fakeBinDirectory: string;
}> {
	const fakeBinDirectory = path.join(temporaryDirectory, 'bin');
	const dockerCallLogPath = path.join(temporaryDirectory, 'docker-calls.log');
	const fakeDockerPath = path.join(fakeBinDirectory, 'docker');
	await fs.mkdir(fakeBinDirectory, { recursive: true });
	await fs.writeFile(
		fakeDockerPath,
		[
			'#!/bin/sh',
			'printf "%s\\n" "$*" >> "$AGENT_VM_DOCKER_CALL_LOG"',
			'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
			'  printf \'{"Architecture":"arm64","Os":"linux","RootFS":{"Layers":["sha256:observability-smoke"]}}\\n\'',
			'fi',
			'exit 0',
			'',
		].join('\n'),
		'utf8',
	);
	await fs.chmod(fakeDockerPath, 0o755);
	return { dockerCallLogPath, fakeBinDirectory };
}

async function createSmokeDeployment(
	options: CreateSmokeDeploymentOptions,
): Promise<SmokeDeployment> {
	const temporaryDirectory = await fs.mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-observability-cli-'),
	);
	temporaryDirectories.push(temporaryDirectory);
	const configDirectory = path.join(temporaryDirectory, 'config');
	const vmImagesDirectory = path.join(temporaryDirectory, 'vm-images');
	const cacheDir = path.join(temporaryDirectory, 'cache');
	const runtimeDir = path.join(temporaryDirectory, 'runtime');
	const stateDir = path.join(temporaryDirectory, 'state', 'sunfam');
	const zoneFilesDir = path.join(temporaryDirectory, 'zone-files', 'sunfam');
	const dataDir = path.join(temporaryDirectory, 'observability-data');
	const gatewayConfigPath = path.join(configDirectory, 'gateways', 'sunfam', 'openclaw.json');
	const gatewayBuildConfigPath = path.join(
		vmImagesDirectory,
		'gateways',
		'openclaw',
		'build-config.json',
	);
	const toolBuildConfigPath = path.join(vmImagesDirectory, 'tool-build-config.json');
	const configPath = path.join(configDirectory, 'system.jsonc');
	const fakeDocker = await createFakeDocker(temporaryDirectory);
	const stackMode = options.stackMode ?? 'managed';
	const buildConfig = {
		arch: 'aarch64',
		distro: 'alpine',
		oci: {
			image: 'agent-vm-observability-smoke:latest',
		},
		rootfs: {
			label: 'gondolin-root',
		},
	};
	await writeJson(gatewayConfigPath, {
		diagnostics: {
			otel: {
				authorizationHeader: canaryAuthorizationHeader,
				prompt: canaryPromptText,
				toolPayload: canaryToolPayload,
				url: canaryCredentialedUrl,
			},
		},
	});
	await writeJson(gatewayBuildConfigPath, buildConfig);
	await writeJson(toolBuildConfigPath, buildConfig);
	await writeJson(configPath, {
		schemaVersion: 1,
		cacheDir,
		runtimeDir,
		host: {
			controllerPort: 18_800,
			projectNamespace: 'observability-cli-smoke',
			observability: {
				enabled: true,
				stack:
					stackMode === 'managed'
						? { mode: 'managed' }
						: {
								mode: 'external',
								scrubbing: { responsibility: 'external-collector' },
							},
				mode: 'collector',
				waitOnBuild: true,
				ports: {
					collectorGrpc: 24_317,
					collectorHttp: 24_318,
					collectorHealth: options.collectorHealth,
					metrics: options.metrics,
					logs: options.logs,
					traces: options.traces,
				},
				...(stackMode === 'managed'
					? {
							runner: 'docker-compose',
							dataDir,
							projectName: 'agent-vm-observability-cli-smoke',
							retention: {
								metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
								logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
								traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
							},
						}
					: {}),
			},
		},
		imageProfiles: {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: gatewayBuildConfigPath,
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: toolBuildConfigPath,
				},
			},
		},
		zones: [
			{
				id: 'sunfam',
				agents: [{ id: 'sunfam' }],
				gateway: {
					type: 'openclaw',
					imageProfile: 'openclaw',
					memory: '1G',
					cpus: 1,
					port: 18_791,
					config: gatewayConfigPath,
					stateDir,
					zoneFilesDir,
					controlAuth: {
						mode: 'token',
						secret: 'OPENCLAW_GATEWAY_TOKEN',
					},
				},
				secrets: {
					OPENCLAW_GATEWAY_TOKEN: {
						source: 'environment',
						envVar: canarySecretValue,
						injection: 'env',
						audience: 'gateway',
					},
				},
				egressHosts: [{ host: 'example.com', audience: 'gateway' }],
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
				...(options.zoneObservability === true
					? {
							observability: {
								enabled: true,
								openclaw: {
									serviceName: 'agent-vm-openclaw-sunfam',
									traces: true,
									metrics: true,
									logs: true,
									diagnosticsFlags: ['gateway.lifecycle'],
								},
							},
						}
					: {}),
			},
		],
		toolVmProfiles: {
			standard: {
				memory: '1G',
				cpus: 1,
				imageProfile: 'default',
			},
		},
		tcpPool: { basePort: 19_000, size: 5 },
	});
	await Promise.all([
		seedBuiltImageCache({
			buildConfigPath: gatewayBuildConfigPath,
			cacheDirectory: path.join(cacheDir, 'gateway-images', 'openclaw'),
		}),
		seedBuiltImageCache({
			buildConfigPath: toolBuildConfigPath,
			cacheDirectory: path.join(cacheDir, 'tool-vm-images', 'default'),
		}),
	]);
	return {
		configPath,
		dockerCallLogPath: fakeDocker.dockerCallLogPath,
		fakeBinDirectory: fakeDocker.fakeBinDirectory,
		runtimeDir,
	};
}

async function runBuiltAgentVmBuild(
	deployment: SmokeDeployment,
	extraArgs: readonly string[] = [],
): Promise<string> {
	const result = await execa(
		'node',
		[agentVmCliPath, 'build', '--config', deployment.configPath, ...extraArgs],
		{
			all: true,
			env: {
				AGENT_VM_DOCKER_CALL_LOG: deployment.dockerCallLogPath,
				PATH: `${deployment.fakeBinDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
			},
			reject: true,
			timeout: 60_000,
		},
	);
	return result.all ?? '';
}

async function readOptionalText(filePath: string): Promise<string> {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return '';
		}
		throw error;
	}
}

describe('smoke: agent-vm build observability CLI', () => {
	it('skips managed host observability when no zone telemetry path is accepted without leaking canaries', async () => {
		const healthServers = await createHealthServers(4);
		const [collectorHealth, metrics, logs, traces] = healthServers;
		if (!collectorHealth || !metrics || !logs || !traces) {
			throw new Error('Expected four observability health servers.');
		}
		try {
			const deployment = await createSmokeDeployment({
				collectorHealth: collectorHealth.port,
				logs: logs.port,
				metrics: metrics.port,
				traces: traces.port,
			});

			const output = await runBuiltAgentVmBuild(deployment);

			expect(output).toContain('no OpenClaw zone opted in');
			const dockerCalls = await readOptionalText(deployment.dockerCallLogPath);
			expect(dockerCalls).not.toContain('compose --project-name agent-vm-observability-cli-smoke');
			expect(dockerCalls).not.toContain('up -d --wait');
			const observabilityRuntimeDir = path.join(
				deployment.runtimeDir,
				'observability',
				'observability-cli-smoke',
			);
			const composeYaml = await readOptionalText(
				path.join(observabilityRuntimeDir, 'docker-compose.observability.yml'),
			);
			const collectorYaml = await readOptionalText(
				path.join(observabilityRuntimeDir, 'otel-collector-config.yaml'),
			);
			const renderedArtifacts = `${output}\n${dockerCalls}\n${composeYaml}\n${collectorYaml}`;
			for (const canary of [
				canarySecretValue,
				canaryAuthorizationHeader,
				canaryPromptText,
				canaryToolPayload,
				canaryCredentialedUrl,
			]) {
				expect(renderedArtifacts).not.toContain(canary);
			}
		} finally {
			await closeHealthServers(healthServers);
		}
	});

	it('prepares host observability when an OpenClaw zone opts in', async () => {
		const healthServers = await createHealthServers(4);
		const [collectorHealth, metrics, logs, traces] = healthServers;
		if (!collectorHealth || !metrics || !logs || !traces) {
			throw new Error('Expected four observability health servers.');
		}
		try {
			const deployment = await createSmokeDeployment({
				collectorHealth: collectorHealth.port,
				logs: logs.port,
				metrics: metrics.port,
				traces: traces.port,
				zoneObservability: true,
			});

			const output = await runBuiltAgentVmBuild(deployment);

			expect(output).toContain('Observability stack');
			expect(output).toContain('Host observability stack ready');
			const dockerCalls = await readOptionalText(deployment.dockerCallLogPath);
			expect(dockerCalls).toContain('compose --project-name agent-vm-observability-cli-smoke');
			expect(dockerCalls).toContain('up -d --wait');
			const observabilityRuntimeDir = path.join(
				deployment.runtimeDir,
				'observability',
				'observability-cli-smoke',
			);
			const composeYaml = await readOptionalText(
				path.join(observabilityRuntimeDir, 'docker-compose.observability.yml'),
			);
			const collectorYaml = await readOptionalText(
				path.join(observabilityRuntimeDir, 'otel-collector-config.yaml'),
			);
			const renderedArtifacts = `${output}\n${dockerCalls}\n${composeYaml}\n${collectorYaml}`;
			for (const canary of [
				canarySecretValue,
				canaryAuthorizationHeader,
				canaryPromptText,
				canaryToolPayload,
				canaryCredentialedUrl,
			]) {
				expect(renderedArtifacts).not.toContain(canary);
			}
		} finally {
			await closeHealthServers(healthServers);
		}
	});

	it('reports --no-observability as skipped and does not call Docker Compose', async () => {
		const healthServers = await createHealthServers(4);
		const [collectorHealth, metrics, logs, traces] = healthServers;
		if (!collectorHealth || !metrics || !logs || !traces) {
			throw new Error('Expected four observability health servers.');
		}
		try {
			const deployment = await createSmokeDeployment({
				collectorHealth: collectorHealth.port,
				logs: logs.port,
				metrics: metrics.port,
				traces: traces.port,
			});

			const output = await runBuiltAgentVmBuild(deployment, ['--no-observability']);

			expect(output).toContain('observability preparation skipped');
			expect(output).toContain('--no-observability');
			expect(await readOptionalText(deployment.dockerCallLogPath)).toBe('');
		} finally {
			await closeHealthServers(healthServers);
		}
	});

	it('reports external observability without rendering or starting Compose', async () => {
		const healthServers = await createHealthServers(4);
		const [collectorHealth, metrics, logs, traces] = healthServers;
		if (!collectorHealth || !metrics || !logs || !traces) {
			throw new Error('Expected four observability health servers.');
		}
		try {
			const deployment = await createSmokeDeployment({
				collectorHealth: collectorHealth.port,
				logs: logs.port,
				metrics: metrics.port,
				traces: traces.port,
				stackMode: 'external',
			});

			const output = await runBuiltAgentVmBuild(deployment);

			expect(output).toContain('external observability stack');
			expect(output).toContain('Docker Compose is not managed by this deployment');
			expect(await readOptionalText(deployment.dockerCallLogPath)).toBe('');
			const observabilityRuntimeDir = path.join(
				deployment.runtimeDir,
				'observability',
				'observability-cli-smoke',
			);
			expect(
				await readOptionalText(
					path.join(observabilityRuntimeDir, 'docker-compose.observability.yml'),
				),
			).toBe('');
			expect(
				await readOptionalText(path.join(observabilityRuntimeDir, 'otel-collector-config.yaml')),
			).toBe('');
		} finally {
			await closeHealthServers(healthServers);
		}
	});
});
