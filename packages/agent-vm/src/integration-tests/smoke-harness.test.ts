import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { describe, expect, it } from 'vitest';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { StartGatewayZoneOptions } from '../gateway/gateway-zone-support.js';
import {
	prepareLocalWorkerPackageForGatewayImage,
	scaffoldGatewaySmokeProject,
	shouldRunWorkerGatewaySmoke,
	useLocalOpenClawGatewayImagePackages,
} from './smoke-harness.js';

describe('shouldRunWorkerGatewaySmoke', () => {
	it('requires explicit opt-in even when credentials and commands are available', async () => {
		expect(
			await shouldRunWorkerGatewaySmoke({
				architecture: 'aarch64',
				commandExists: () => true,
				env: { OPEN_AI_TEST_KEY: 'test-token' },
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(false);
	});

	it('requires a model credential when explicitly enabled', async () => {
		expect(
			await shouldRunWorkerGatewaySmoke({
				architecture: 'aarch64',
				commandExists: () => true,
				env: { AGENT_VM_WORKER_SMOKE: '1' },
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(false);
	});

	it('requires QEMU and Docker when explicitly enabled', async () => {
		expect(
			await shouldRunWorkerGatewaySmoke({
				architecture: 'aarch64',
				commandExists: (command) => command !== 'docker',
				env: {
					AGENT_VM_WORKER_SMOKE: '1',
					OPEN_AI_TEST_KEY: 'test-token',
				},
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(false);
	});

	it('requires a compatible Zig version when explicitly enabled', async () => {
		expect(
			await shouldRunWorkerGatewaySmoke({
				architecture: 'aarch64',
				commandExists: () => true,
				env: {
					AGENT_VM_WORKER_SMOKE: '1',
					OPEN_AI_TEST_KEY: 'test-token',
				},
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.15.2',
			}),
		).toBe(false);
	});

	it('allows the worker gateway smoke when opt-in, credentials, commands, and Zig are compatible', async () => {
		expect(
			await shouldRunWorkerGatewaySmoke({
				architecture: 'aarch64',
				commandExists: () => true,
				env: {
					AGENT_VM_WORKER_SMOKE: '1',
					OPEN_AI_TEST_KEY: 'test-token',
				},
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(true);
	});
});

describe('scaffoldGatewaySmokeProject', () => {
	it('dispatches through the typed OpenClaw gateway smoke project scaffold', async () => {
		const project = await scaffoldGatewaySmokeProject({
			agents: ['smoke-agent'],
			architecture: 'aarch64',
			kind: 'openclaw',
			prefix: 'agent-vm-gateway-smoke-project-',
			zoneId: 'smoke-zone',
		});

		expect(project.zone.gateway.type).toBe('openclaw');
		expect(project.systemConfig.zones[0]?.agents).toEqual([{ id: 'smoke-agent' }]);
	});
});

describe('startSmokeControllerRuntime', () => {
	it('passes TCP host and VFS mount overrides into the gateway zone startup dependency', async () => {
		const { startSmokeControllerRuntime } = await import('./smoke-harness.js');
		const capturedGatewayStarts: StartGatewayZoneOptions[] = [];
		const systemConfig = createMinimalOpenClawSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected smoke system config to contain a zone.');
		}

		const harness = await startSmokeControllerRuntime({
			secrets: {
				OPEN_AI_TEST_KEY: 'test-service-account-token',
				OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
			},
			startGatewayZone: async (options) => {
				capturedGatewayStarts.push(options);
				return {
					image: { built: false, fingerprint: 'test', imagePath: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18789 },
					processSpec: {
						bootstrapCommand: '',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/tmp/gateway.log',
						startCommand: '',
					},
					vm: createManagedVmStub(),
					zone,
				};
			},
			startHttpServer: async () => ({
				close: async () => undefined,
			}),
			startOptions: {
				systemConfig,
				zoneIds: ['smoke'],
			},
			tcpHostsOverride: {
				'smoke-upstream.vm.host:48123': '127.0.0.1:48123',
			},
			vfsMountsOverride: {
				'/work/repo': {
					hostPath: process.cwd(),
					kind: 'realfs-readonly',
				},
			},
		});

		try {
			expect(capturedGatewayStarts[0]?.tcpHostsOverride).toEqual({
				'smoke-upstream.vm.host:48123': '127.0.0.1:48123',
			});
			expect(capturedGatewayStarts[0]?.vfsMountsOverride).toEqual({
				'/work/repo': {
					hostPath: process.cwd(),
					kind: 'realfs-readonly',
				},
			});
		} finally {
			await harness.close();
		}
	});

	it('writes a local OpenClaw gateway smoke Dockerfile that installs both portal packages', async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-smoke-harness-'));
		const repoRoot = path.join(temporaryRoot, 'repo');
		const systemConfig = createMinimalOpenClawSystemConfig();
		systemConfig.imageProfiles.gateways.openclaw = {
			type: 'openclaw',
			buildConfig: path.join(temporaryRoot, 'build-config.jsonc'),
			source: { kind: 'managedBase', base: 'openclaw-gateway' },
		};

		await createFakeSecretsPackage(repoRoot);
		await createFakeGondolinAdapterPackage(repoRoot);
		await createFakePackageDist(repoRoot, 'openclaw-agent-vm-plugin', 'gondolin');
		await createFakePackageDist(repoRoot, 'openclaw-mcp-portal-plugin', 'mcp-portal');
		await createFakePortalDist(repoRoot);

		await useLocalOpenClawGatewayImagePackages({
			profileName: 'openclaw',
			projectRoot: temporaryRoot,
			repoRoot,
			systemConfig,
		});

		const dockerfilePath = systemConfig.imageProfiles.gateways.openclaw.dockerfile;
		if (dockerfilePath === undefined) {
			throw new Error('Expected local OpenClaw gateway helper to set dockerfile path.');
		}
		expect(dockerfilePath).toBe(
			path.join(temporaryRoot, 'vm-images', 'gateways', 'openclaw-local-packages', 'Dockerfile'),
		);
		const dockerfile = await fs.readFile(dockerfilePath, 'utf8');
		expect(dockerfile).toContain('COPY config-contracts-local.tgz /tmp/config-contracts-local.tgz');
		expect(dockerfile).toContain('COPY secrets-local.tgz /tmp/secrets-local.tgz');
		expect(dockerfile).toContain('COPY gondolin-adapter-local.tgz /tmp/gondolin-adapter-local.tgz');
		expect(dockerfile).toContain('COPY mcp-portal-local.tgz /tmp/mcp-portal-local.tgz');
		expect(dockerfile).toContain(
			'COPY openclaw-agent-vm-plugin-local.tgz /tmp/openclaw-agent-vm-plugin-local.tgz',
		);
		expect(dockerfile).toContain(
			'COPY openclaw-mcp-portal-plugin-local.tgz /tmp/openclaw-mcp-portal-plugin-local.tgz',
		);
		expect(dockerfile).toContain('npm install --omit=dev --no-audit --no-fund');
		expect(dockerfile).toContain('package_root="/opt/agent-vm/local-packages/node_modules"');
		expect(dockerfile).toContain('/home/openclaw/.openclaw/extensions/gondolin');
		expect(dockerfile).toContain('/home/openclaw/.openclaw/extensions/mcp-portal');
		expect(dockerfile).not.toContain('portal-server.js');
		expect(dockerfile).not.toContain('pnpm add -g');
		expect(dockerfile).not.toContain('/work/repo/packages/mcp-portal');
		expect(dockerfile).not.toMatch(/TOKEN|Authorization|\.npmrc|\.netrc|_authToken|Bearer/u);
		const toolVmDockerfilePath = systemConfig.imageProfiles.toolVms.tool?.dockerfile;
		if (toolVmDockerfilePath === undefined) {
			throw new Error('Expected local OpenClaw gateway helper to set Tool VM dockerfile path.');
		}
		const toolVmDockerfile = await fs.readFile(toolVmDockerfilePath, 'utf8');
		expect(toolVmDockerfile).toContain(
			'COPY config-contracts-local.tgz /tmp/config-contracts-local.tgz',
		);
		expect(toolVmDockerfile).toContain('COPY secrets-local.tgz /tmp/secrets-local.tgz');
		expect(toolVmDockerfile).toContain('COPY mcp-portal-local.tgz /tmp/mcp-portal-local.tgz');
		expect(toolVmDockerfile).toContain('npm install --omit=dev --no-audit --no-fund');
		expect(toolVmDockerfile).toContain('/opt/agent-vm/local-packages');
		expect(toolVmDockerfile).not.toContain('pnpm add -g');
		expect(toolVmDockerfile).not.toMatch(/TOKEN|Authorization|\.npmrc|\.netrc|_authToken|Bearer/u);
	});
});

describe('prepareLocalWorkerPackageForGatewayImage', () => {
	it('packs the local worker package and returns the generated tarball path', async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-worker-pack-'));
		const workerPackageDir = path.join(temporaryRoot, 'packages', 'agent-vm-worker');
		await fs.mkdir(workerPackageDir, { recursive: true });
		await fs.writeFile(
			path.join(workerPackageDir, 'package.json'),
			JSON.stringify(
				{
					name: '@agent-vm/fake-worker-pack-fixture',
					version: '0.0.0',
					files: ['index.js'],
				},
				null,
				2,
			),
		);
		await fs.writeFile(path.join(workerPackageDir, 'index.js'), 'export {};\n');

		const tarballPath = await prepareLocalWorkerPackageForGatewayImage(temporaryRoot);
		const packedFiles = await fs.readdir(path.dirname(tarballPath));

		expect(path.basename(tarballPath)).toBe('agent-vm-fake-worker-pack-fixture-0.0.0.tgz');
		expect(packedFiles).toEqual(['agent-vm-fake-worker-pack-fixture-0.0.0.tgz']);
	});
});

function createManagedVmStub(): ManagedVm {
	const managedVm: ManagedVm = {
		id: 'vm-smoke-test',
		close: async () => undefined,
		enableIngress: async () => ({ host: '127.0.0.1', port: 18789 }),
		enableSsh: async () => ({ host: '127.0.0.1', port: 2222, user: 'root' }),
		exec: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
		getVmInstance: () => managedVm,
		setIngressRoutes: () => undefined,
	};
	return managedVm;
}

function createMinimalOpenClawSystemConfig(): LoadedSystemConfig {
	return {
		cacheDir: '/tmp/cache',
		host: {
			controllerPort: 18800,
			projectNamespace: 'smoke-tests',
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env', envVar: 'OPEN_AI_TEST_KEY' },
			},
		},
		imageProfiles: {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: '/tmp/build-config.jsonc',
				},
			},
			toolVms: {
				tool: {
					type: 'toolVm',
					buildConfig: '/tmp/tool-build-config.jsonc',
				},
			},
		},
		runtimeDir: '/tmp/runtime',
		schemaVersion: 1,
		systemConfigPath: '/tmp/system.json',
		tcpPool: { basePort: 19000, size: 4 },
		toolVmProfiles: {
			standard: {
				cpus: 1,
				imageProfile: 'tool',
				memory: '512M',
			},
		},
		zones: [
			{
				agentSandboxSeeds: {},
				agentToolVmProfiles: {},
				agents: [{ id: 'smoke' }],
				defaultToolVmProfile: 'standard',
				egressHosts: [],
				gateway: {
					type: 'openclaw',
					backupDir: '/tmp/backup',
					config: '/tmp/openclaw.json',
					cpus: 1,
					imageProfile: 'openclaw',
					memory: '1G',
					port: 18789,
					stateDir: '/tmp/state',
					zoneFilesDir: '/tmp/zone',
				},
				id: 'smoke',
				secrets: {
					OPENCLAW_GATEWAY_TOKEN: {
						audience: 'gateway',
						envVar: 'OPENCLAW_GATEWAY_TOKEN',
						injection: 'env',
						source: 'environment',
					},
				},
				websocketBypass: [],
			},
		],
	};
}

async function createFakePackageDist(
	repoRoot: string,
	packageName: 'openclaw-agent-vm-plugin' | 'openclaw-mcp-portal-plugin',
	pluginId: string,
): Promise<void> {
	const packageDir = path.join(repoRoot, 'packages', packageName);
	const distDir = path.join(packageDir, 'dist');
	await fs.mkdir(packageDir, { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				name: `@agent-vm/${packageName}`,
				version: '0.0.0-smoke',
				files: ['dist'],
				type: 'module',
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	await fs.mkdir(distDir, { recursive: true });
	await fs.writeFile(
		path.join(distDir, 'openclaw.plugin.json'),
		`${JSON.stringify({ id: pluginId, name: pluginId })}\n`,
		'utf8',
	);
	await fs.writeFile(path.join(distDir, 'index.js'), 'export default {};\n', 'utf8');
}

async function createFakePortalDist(repoRoot: string): Promise<void> {
	await createFakeConfigContractsPackage(repoRoot);
	const packageDir = path.join(repoRoot, 'packages', 'mcp-portal');
	await fs.mkdir(packageDir, { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				name: '@agent-vm/mcp-portal',
				version: '0.0.0-smoke',
				files: ['dist'],
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	const binDir = path.join(repoRoot, 'packages', 'mcp-portal', 'dist', 'bin');
	await fs.mkdir(binDir, { recursive: true });
	await fs.writeFile(
		path.join(repoRoot, 'packages', 'mcp-portal', 'dist', 'index.js'),
		'export {};\n',
		'utf8',
	);
	await fs.writeFile(path.join(binDir, 'mcp-portal.js'), 'console.log("portal");\n', 'utf8');
}

async function createFakeConfigContractsPackage(repoRoot: string): Promise<void> {
	const packageDir = path.join(repoRoot, 'packages', 'config-contracts');
	await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				name: '@agent-vm/config-contracts',
				version: '0.0.0-smoke',
				files: ['dist'],
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	await fs.writeFile(path.join(packageDir, 'dist', 'index.js'), 'export {};\n', 'utf8');
}

async function createFakeSecretsPackage(repoRoot: string): Promise<void> {
	const packageDir = path.join(repoRoot, 'packages', 'secrets');
	await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				name: '@agent-vm/secrets',
				version: '0.0.0-smoke',
				files: ['dist'],
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	await fs.writeFile(path.join(packageDir, 'dist', 'index.js'), 'export {};\n', 'utf8');
}

async function createFakeGondolinAdapterPackage(repoRoot: string): Promise<void> {
	const packageDir = path.join(repoRoot, 'packages', 'gondolin-adapter');
	await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				dependencies: { '@agent-vm/secrets': '0.0.0-smoke' },
				name: '@agent-vm/gondolin-adapter',
				version: '0.0.0-smoke',
				files: ['dist'],
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	await fs.writeFile(path.join(packageDir, 'dist', 'index.js'), 'export {};\n', 'utf8');
}
