import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, loadSystemConfig } from '../config/system-config.js';
import { resolveProjectCheckoutPath, runConfigValidation } from './config-validation.js';

type TestCommandRunner = NonNullable<Parameters<typeof runConfigValidation>[0]['runCommand']>;

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
}

function minimalWorkerConfig(): unknown {
	return {
		phases: {
			plan: {
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: { path: './prompts/plan-agent.md' },
				reviewerInstructions: null,
			},
			work: {
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: null,
				reviewerInstructions: null,
			},
			wrapup: { instructions: null },
		},
	};
}

async function writeContainerProjectFixture(rootPath: string): Promise<string> {
	await writeJson(path.join(rootPath, 'config', 'system.json'), {
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm',
			githubToken: { source: 'environment', envVar: 'GITHUB_TOKEN' },
		},
		cacheDir: '/var/agent-vm/cache',
		imageProfiles: {
			gateways: {
				worker: {
					type: 'worker',
					buildConfig: '/etc/agent-vm/vm-images/gateways/worker/build-config.json',
					dockerfile: '/etc/agent-vm/vm-images/gateways/worker/Dockerfile',
				},
			},
		},
		zones: [
			{
				id: 'coding-agent',
				gateway: {
					type: 'worker',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: '/etc/agent-vm/gateways/coding-agent/worker.json',
					imageProfile: 'worker',
					stateDir: '/var/agent-vm/state',
				},
				secrets: {},
				allowedHosts: ['api.openai.com'],
			},
		],
		tcpPool: { basePort: 19000, size: 5 },
	});
	await writeJson(path.join(rootPath, 'config', 'systemCacheIdentifier.json'), {
		schemaVersion: 1,
		hostSystemType: 'container',
	});
	await writeJson(
		path.join(rootPath, 'config', 'gateways', 'coding-agent', 'worker.json'),
		minimalWorkerConfig(),
	);
	await fs.mkdir(path.join(rootPath, 'config', 'gateways', 'coding-agent', 'prompts'), {
		recursive: true,
	});
	await fs.writeFile(
		path.join(rootPath, 'config', 'gateways', 'coding-agent', 'prompts', 'plan-agent.md'),
		'Plan carefully.\n',
		'utf8',
	);
	await writeJson(path.join(rootPath, 'vm-images', 'gateways', 'worker', 'build-config.json'), {
		arch: 'x86_64',
		distro: 'alpine',
	});
	await fs.writeFile(
		path.join(rootPath, 'vm-images', 'gateways', 'worker', 'Dockerfile'),
		'FROM node:24-slim\n',
		'utf8',
	);
	await fs.mkdir(path.join(rootPath, 'vm-host-system'), { recursive: true });
	await Promise.all(
		['Dockerfile', 'start.sh', 'agent-vm-controller.service'].map(async (fileName) => {
			await fs.writeFile(path.join(rootPath, 'vm-host-system', fileName), '', 'utf8');
		}),
	);
	return path.join(rootPath, 'config', 'system.json');
}

async function writeOpenClawProjectFixture(rootPath: string): Promise<string> {
	await writeJson(path.join(rootPath, 'config', 'system.json'), {
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm',
			githubToken: { source: 'environment', envVar: 'GITHUB_TOKEN' },
		},
		cacheDir: path.join(rootPath, 'cache'),
		imageProfiles: {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: '../vm-images/gateways/openclaw/build-config.json',
					dockerfile: '../vm-images/gateways/openclaw/Dockerfile',
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: '../vm-images/tool-vms/default/build-config.json',
					dockerfile: '../vm-images/tool-vms/default/Dockerfile',
				},
			},
		},
		zones: [
			{
				id: 'shravan',
				gateway: {
					type: 'openclaw',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './gateways/shravan/openclaw.json',
					imageProfile: 'openclaw',
					stateDir: path.join(rootPath, 'state', 'shravan'),
					zoneFilesDir: path.join(rootPath, 'zone-files', 'shravan'),
				},
				secrets: {},
				allowedHosts: ['api.openai.com'],
				toolProfile: 'default',
			},
		],
		toolProfiles: {
			default: {
				memory: '1G',
				cpus: 1,
				workspaceRoot: path.join(rootPath, 'workspaces', 'tools'),
				imageProfile: 'default',
			},
		},
		tcpPool: { basePort: 19000, size: 5 },
	});
	await writeJson(path.join(rootPath, 'config', 'systemCacheIdentifier.json'), {
		schemaVersion: 1,
		hostSystemType: 'bare-metal',
	});
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'openclaw.json'), {
		gateway: {
			auth: { mode: 'token' },
			bind: 'loopback',
			controlUi: {
				allowedOrigins: ['http://127.0.0.1:18791', 'http://localhost:18791'],
			},
			mode: 'local',
			port: 18789,
		},
		channels: {},
	});
	await writeJson(path.join(rootPath, 'vm-images', 'gateways', 'openclaw', 'build-config.json'), {
		arch: 'aarch64',
		distro: 'alpine',
	});
	await fs.writeFile(
		path.join(rootPath, 'vm-images', 'gateways', 'openclaw', 'Dockerfile'),
		'FROM node:24-slim\n',
		'utf8',
	);
	await writeJson(path.join(rootPath, 'vm-images', 'tool-vms', 'default', 'build-config.json'), {
		arch: 'aarch64',
		distro: 'alpine',
	});
	await fs.writeFile(
		path.join(rootPath, 'vm-images', 'tool-vms', 'default', 'Dockerfile'),
		'FROM node:24-slim\n',
		'utf8',
	);
	return path.join(rootPath, 'config', 'system.json');
}

describe('runConfigValidation', () => {
	it('leaves runtime container paths unchanged inside /etc/agent-vm', () => {
		const systemConfig = createLoadedSystemConfig(
			{
				host: { controllerPort: 18800, projectNamespace: 'agent-vm' },
				imageProfiles: {
					gateways: {
						worker: {
							type: 'worker',
							buildConfig: '/etc/agent-vm/vm-images/gateways/worker/build-config.json',
						},
					},
				},
				zones: [
					{
						id: 'coding-agent',
						gateway: {
							type: 'worker',
							memory: '2G',
							cpus: 2,
							port: 18791,
							config: '/etc/agent-vm/gateways/coding-agent/worker.json',
							imageProfile: 'worker',
							stateDir: '/var/agent-vm/state',
						},
						secrets: {},
						allowedHosts: ['api.openai.com'],
					},
				],
				tcpPool: { basePort: 19000, size: 5 },
			},
			{ systemConfigPath: '/etc/agent-vm/system.json' },
		);

		const resolvedPath = resolveProjectCheckoutPath(
			systemConfig,
			'/etc/agent-vm/gateways/coding-agent/worker.json',
		);

		expect(resolvedPath).toBe('/etc/agent-vm/gateways/coding-agent/worker.json');
	});

	it('validates a container project from its checkout paths', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeContainerProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({ systemConfig });

		expect(result.ok).toBe(true);
		expect(result.checks.every((check) => check.ok)).toBe(true);
		expect(result.checks.find((check) => check.name === 'worker-config-coding-agent')?.hint).toBe(
			path.join(temporaryDirectoryPath, 'config', 'gateways', 'coding-agent', 'worker.json'),
		);
		expect(result.checks.find((check) => check.name === 'gateway-worker-build-config')?.ok).toBe(
			true,
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports missing project-local worker prompt files', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeContainerProjectFixture(temporaryDirectoryPath);
		await fs.rm(
			path.join(
				temporaryDirectoryPath,
				'config',
				'gateways',
				'coding-agent',
				'prompts',
				'plan-agent.md',
			),
		);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({ systemConfig });

		expect(result.ok).toBe(false);
		const workerConfigCheck = result.checks.find(
			(check) => check.name === 'worker-config-coding-agent',
		);
		expect(workerConfigCheck?.ok).toBe(false);
		expect(workerConfigCheck?.hint).toMatch(/plan-agent\.md/u);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('validates OpenClaw gateway configs with the OpenClaw CLI', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const runCommandCalls: {
			readonly command: string;
			readonly arguments_: readonly string[];
			readonly cwd: string | undefined;
			readonly env: Readonly<Record<string, string>> | undefined;
		}[] = [];
		const runCommand: TestCommandRunner = async (command, arguments_, options) => {
			runCommandCalls.push({ command, arguments_, cwd: options?.cwd, env: options?.env });
			return { exitCode: 0, stderr: '', stdout: '{"ok":true}\\n' };
		};

		const result = await runConfigValidation({ runCommand, systemConfig });

		expect(result.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'openclaw-config-shravan')).toMatchObject({
			ok: true,
			hint: path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'openclaw.json'),
		});
		expect(runCommandCalls).toEqual([
			{
				command: 'openclaw',
				arguments_: ['config', 'validate', '--json'],
				cwd: temporaryDirectoryPath,
				env: {
					OPENCLAW_CONFIG_PATH: path.join(
						temporaryDirectoryPath,
						'config',
						'gateways',
						'shravan',
						'openclaw.json',
					),
				},
			},
		]);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('accepts OpenClaw configs when host-only plugin path validation is the only issue', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const validationOutput =
			'{"valid":false,"issues":[{"path":"plugins.load.paths","message":"plugin: plugin path not found: /home/openclaw/.openclaw/extensions"}]}';
		const runCommand: TestCommandRunner = async () => ({
			exitCode: 1,
			stderr: '',
			stdout: validationOutput,
		});

		const result = await runConfigValidation({ runCommand, systemConfig });

		expect(result.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'openclaw-config-shravan')).toMatchObject({
			ok: true,
		});

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports OpenClaw schema validation failures before gateway boot', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const validationOutput =
			'{"ok":false,"errors":[{"path":["agents","defaults","thinkingDefault"],"message":"Unrecognized key"}]}';
		const runCommand: TestCommandRunner = async () => ({
			exitCode: 1,
			stderr: '',
			stdout: validationOutput,
		});

		const result = await runConfigValidation({ runCommand, systemConfig });

		expect(result.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'openclaw-config-shravan')).toMatchObject({
			ok: false,
			hint: expect.stringContaining('agents.defaults.thinkingDefault: Unrecognized key'),
		});

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});
});
