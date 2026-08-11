import { parseSync } from '@optique/core';
import { describe, expect, it } from 'vitest';

import { agentVmRootParser, type AgentVmCommand } from './agent-vm-command-parser.js';

function parseAgentVmCommand(argv: readonly string[]): AgentVmCommand {
	const result = parseSync(agentVmRootParser, argv);
	if (!result.success) {
		throw new Error(`Expected command to parse: ${argv.join(' ')}`);
	}
	return result.value;
}

const commandContractFixtures = [
	{
		argv: [
			'init',
			'project-zone',
			'--type',
			'openclaw',
			'--preset',
			'container-arm64',
			'--secrets',
			'1password',
			'--arch',
			'x86_64',
			'--paths',
			'user-dir',
			'--namespace',
			'my-project',
			'--overwrite',
			'--openclaw-agents',
			' sun,main,sun ',
			'--onepassword-keychain-account-name',
			'team',
		],
		expected: {
			command: 'init',
			options: {
				zoneId: 'project-zone',
				type: 'openclaw',
				preset: {
					architecture: 'aarch64',
					hostSystemType: 'container',
					paths: 'pod',
					secretsProvider: 'environment',
					writeLocalEnvironmentFile: false,
				},
				secrets: '1password',
				arch: 'x86_64',
				paths: 'user-dir',
				namespace: 'my-project',
				overwrite: true,
				agents: ['sun', 'main'],
				onePasswordKeychainAccountName: 'team',
			},
		},
	},
	{
		argv: ['build', '-c', 'config/build.jsonc', '--force', '--no-observability'],
		expected: {
			command: 'build',
			options: { config: 'config/build.jsonc', force: true, noObservability: true },
		},
	},
	{
		argv: ['validate', '--mcp-live'],
		expected: {
			command: 'validate',
			options: { config: 'config/system.json', mcpLive: true },
		},
	},
	{
		argv: ['doctor', '--json'],
		expected: {
			command: 'doctor',
			options: { config: 'config/system.json', json: true, showPassed: false },
		},
	},
	{
		argv: ['cache', 'list', '-c', 'config/cache.json'],
		expected: { command: 'cache.list', options: { config: 'config/cache.json' } },
	},
	{
		argv: ['cache', 'clean', '--confirm'],
		expected: { command: 'cache.clean', options: { config: 'config/system.json', confirm: true } },
	},
	{
		argv: [
			'config',
			'reset-instructions',
			'-c',
			'config/worker.json',
			'--zone',
			'worker',
			'--phase',
			'work',
		],
		expected: {
			command: 'config.reset-instructions',
			options: { config: 'config/worker.json', zone: 'worker', phase: 'work' },
		},
	},
	{
		argv: [
			'manual',
			'update',
			'--agents',
			'--config',
			'config/system.jsonc',
			'--default-zone',
			'worker',
			'--json',
			'--target-dir',
			'deployment',
		],
		expected: {
			command: 'manual.update',
			options: {
				agents: true,
				config: 'config/system.jsonc',
				defaultZone: 'worker',
				json: true,
				targetDir: 'deployment',
			},
		},
	},
	{
		argv: ['migrate', 'images', '-c', 'config/migrate.json'],
		expected: { command: 'migrate.images', options: { config: 'config/migrate.json' } },
	},
	{
		argv: ['paths', 'show', '--sizes', '-c', 'config/paths.json'],
		expected: { command: 'paths.show', options: { config: 'config/paths.json', sizes: true } },
	},
	{
		argv: ['resources', 'init'],
		expected: { command: 'resources.init', options: { json: false } },
	},
	{
		argv: ['resources', 'validate', '--json'],
		expected: { command: 'resources.validate', options: { json: true } },
	},
	{
		argv: ['resources', 'update'],
		expected: { command: 'resources.update', options: { json: false } },
	},
	{
		argv: ['backup', 'create', '-c', 'config/backup.json', '-z', 'prod'],
		expected: {
			command: 'backup.create',
			options: { config: 'config/backup.json', zone: 'prod' },
		},
	},
	{
		argv: ['backup', 'list'],
		expected: {
			command: 'backup.list',
			options: { config: 'config/system.json', zone: undefined },
		},
	},
	{
		argv: ['backup', 'restore', 'backup-prod.age', '-c', 'config/backup.json', '-z', 'prod'],
		expected: {
			command: 'backup.restore',
			options: { backupPath: 'backup-prod.age', config: 'config/backup.json', zone: 'prod' },
		},
	},
	{
		argv: ['auth', '1password', '-c', 'config/auth.json'],
		expected: {
			command: 'auth.1password',
			options: { config: 'config/auth.json', tokenReference: undefined },
		},
	},
	{
		argv: [
			'auth',
			'codex-harness',
			'--agent',
			'main',
			'--all-agents',
			'-c',
			'config/auth.json',
			'-z',
			'prod',
		],
		expected: {
			command: 'auth.codex-harness',
			options: {
				agent: 'main',
				allAgents: true,
				config: 'config/auth.json',
				zone: 'prod',
			},
		},
	},
	{
		argv: [
			'auth',
			'openclaw',
			'login',
			'openai',
			'--agent',
			'main',
			'--all-configured-profiles',
			'-c',
			'config/auth.json',
			'--device-code',
			'--dry-run',
			'--profile-id',
			'openai-codex:one',
			'--profile-id',
			'openai-codex:two',
			'-z',
			'prod',
		],
		expected: {
			command: 'auth.openclaw.login',
			options: {
				agent: 'main',
				allConfiguredProfiles: true,
				config: 'config/auth.json',
				deviceCode: true,
				dryRun: true,
				profileIds: ['openai-codex:one', 'openai-codex:two'],
				provider: 'openai',
				zone: 'prod',
			},
		},
	},
	{
		argv: ['controller', 'start', '-c', 'config/controller.json', '-z', 'prod'],
		expected: {
			command: 'controller.start',
			options: { config: 'config/controller.json', zone: 'prod' },
		},
	},
	{
		argv: ['controller', 'stop'],
		expected: { command: 'controller.stop', options: { config: 'config/system.json' } },
	},
	{
		argv: ['controller', 'cleanup', '--force', '-z', 'prod'],
		expected: {
			command: 'controller.cleanup',
			options: { config: 'config/system.json', force: true, zone: 'prod' },
		},
	},
	{
		argv: ['controller', 'status', '-c', 'config/controller.json'],
		expected: { command: 'controller.status', options: { config: 'config/controller.json' } },
	},
	{
		argv: ['controller', 'health', '-z', 'prod'],
		expected: {
			command: 'controller.health',
			options: { config: 'config/system.json', zone: 'prod' },
		},
	},
	{
		argv: ['controller', 'health-snapshot', '-c', 'config/controller.json'],
		expected: {
			command: 'controller.health-snapshot',
			options: { config: 'config/controller.json', zone: undefined },
		},
	},
	{
		argv: ['controller', 'service-health', '-c', 'config/controller.json', '-z', 'prod'],
		expected: {
			command: 'controller.service-health',
			options: { config: 'config/controller.json', zone: 'prod' },
		},
	},
	{
		argv: ['controller', 'ssh', '--all-secrets', '-c', 'config/controller.json', '-z', 'prod'],
		expected: {
			command: 'controller.ssh',
			options: { allSecrets: true, config: 'config/controller.json', zone: 'prod' },
		},
	},
	{
		argv: ['controller', 'destroy', '--purge', '-z', 'prod'],
		expected: {
			command: 'controller.destroy',
			options: { config: 'config/system.json', purge: true, zone: 'prod' },
		},
	},
	{
		argv: ['controller', 'upgrade', '-c', 'config/controller.json', '-z', 'prod'],
		expected: {
			command: 'controller.upgrade',
			options: { config: 'config/controller.json', zone: 'prod' },
		},
	},
	{
		argv: ['controller', 'logs'],
		expected: {
			command: 'controller.logs',
			options: { config: 'config/system.json', zone: undefined },
		},
	},
	{
		argv: ['controller', 'credentials', 'check', '-z', 'prod'],
		expected: {
			command: 'controller.credentials.check',
			options: { config: 'config/system.json', zone: 'prod' },
		},
	},
	{
		argv: ['controller', 'credentials', 'refresh', '-c', 'config/controller.json', '-z', 'prod'],
		expected: {
			command: 'controller.credentials.refresh',
			options: { config: 'config/controller.json', zone: 'prod' },
		},
	},
] satisfies ReadonlyArray<{
	readonly argv: readonly string[];
	readonly expected: AgentVmCommand;
}>;

describe('agent-vm Optique command parser', () => {
	it('preserves the exact option contract for every current command leaf', () => {
		for (const { argv, expected } of commandContractFixtures) {
			expect(parseAgentVmCommand(argv), argv.join(' ')).toStrictEqual(expected);
		}
	});

	it('keeps the init gateway type narrower than the runtime gateway domain', () => {
		const result = parseSync(agentVmRootParser, [
			'init',
			'zone',
			'--type',
			'hermes',
			'--secrets',
			'environment',
			'--arch',
			'x86_64',
		]);
		expect(result.success).toBe(false);
	});

	it('rejects invalid values before dispatch', () => {
		const invalidArguments = [
			['auth', 'openclaw', 'login', 'openai', '--agent', 'Hello World', '--zone', 'zone'],
			['config', 'reset-instructions', '--phase', 'cache'],
			['init', 'zone', '--type', 'worker', '--namespace', 'Project_Name'],
			['controller', 'ssh', '--print', '--zone', 'zone'],
			['controller', 'ssh', '--zone', 'zone', '--', 'openclaw', 'auth', 'login'],
		] as const;
		for (const invalidArgumentList of invalidArguments) {
			expect(
				parseSync(agentVmRootParser, invalidArgumentList).success,
				invalidArgumentList.join(' '),
			).toBe(false);
		}
	});
});
