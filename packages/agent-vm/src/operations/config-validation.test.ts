import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSystemConfig } from '../config/system-config.js';
import { runConfigValidation } from './config-validation.js';

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
					workspaceDir: '/var/agent-vm/workspace',
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

describe('runConfigValidation', () => {
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
});
