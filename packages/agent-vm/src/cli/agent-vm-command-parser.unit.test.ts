import { describe, expect, it } from 'vitest';

import { createAgentVmParser, type AgentVmCommand } from './commands/create-app.js';
import { runOptiqueCliParser } from './optique-cli-support.js';

const silentIo = {
	stderr: { write: (): boolean => true },
	stdout: { write: (): boolean => true },
};

function parseAgentVmCommand(argv: readonly string[]): AgentVmCommand {
	const result = runOptiqueCliParser({
		argv,
		io: silentIo,
		parser: createAgentVmParser(),
		programName: 'agent-vm',
	});
	if (result.kind !== 'parsed') {
		throw new Error(`Expected parsed command, received ${result.kind}.`);
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

describe('agent-vm Optique command contract', () => {
	it('preserves the exact option contract for every command leaf', () => {
		for (const { argv, expected } of commandContractFixtures) {
			expect(parseAgentVmCommand(argv), argv.join(' ')).toStrictEqual(expected);
		}
	});

	it('parses every command leaf into a discriminated command value', () => {
		const leaves: readonly [readonly string[], string][] = [
			[
				['init', 'zone', '--type', 'worker', '--secrets', 'environment', '--arch', 'x86_64'],
				'init',
			],
			[['build'], 'build'],
			[['validate'], 'validate'],
			[['doctor'], 'doctor'],
			[['cache', 'list'], 'cache.list'],
			[['cache', 'clean'], 'cache.clean'],
			[['config', 'reset-instructions'], 'config.reset-instructions'],
			[['manual', 'update'], 'manual.update'],
			[['migrate', 'images'], 'migrate.images'],
			[['paths', 'show'], 'paths.show'],
			[['resources', 'init'], 'resources.init'],
			[['resources', 'validate'], 'resources.validate'],
			[['resources', 'update'], 'resources.update'],
			[['backup', 'create', '--zone', 'zone'], 'backup.create'],
			[['backup', 'list', '--zone', 'zone'], 'backup.list'],
			[['backup', 'restore', 'backup.age', '--zone', 'zone'], 'backup.restore'],
			[['auth', '1password'], 'auth.1password'],
			[['auth', 'codex-harness', '--zone', 'zone'], 'auth.codex-harness'],
			[['auth', 'openclaw', 'login', 'openai', '--zone', 'zone'], 'auth.openclaw.login'],
			[['controller', 'start', '--zone', 'zone'], 'controller.start'],
			[['controller', 'stop'], 'controller.stop'],
			[['controller', 'cleanup', '--zone', 'zone'], 'controller.cleanup'],
			[['controller', 'status'], 'controller.status'],
			[['controller', 'health', '--zone', 'zone'], 'controller.health'],
			[['controller', 'health-snapshot', '--zone', 'zone'], 'controller.health-snapshot'],
			[['controller', 'service-health', '--zone', 'zone'], 'controller.service-health'],
			[['controller', 'ssh', '--zone', 'zone'], 'controller.ssh'],
			[['controller', 'destroy', '--zone', 'zone'], 'controller.destroy'],
			[['controller', 'upgrade', '--zone', 'zone'], 'controller.upgrade'],
			[['controller', 'logs', '--zone', 'zone'], 'controller.logs'],
			[['controller', 'credentials', 'check', '--zone', 'zone'], 'controller.credentials.check'],
			[
				['controller', 'credentials', 'refresh', '--zone', 'zone'],
				'controller.credentials.refresh',
			],
		];

		for (const [argv, command] of leaves) {
			const result = runOptiqueCliParser({
				argv,
				io: silentIo,
				parser: createAgentVmParser(),
				programName: 'agent-vm',
				version: '1.2.3',
			});
			expect(result).toMatchObject({ kind: 'parsed', value: { command } });
		}
	});

	it('preserves exact controller operation option shapes', () => {
		expect(parseAgentVmCommand(['controller', 'stop'])).toStrictEqual({
			command: 'controller.stop',
			options: { config: 'config/system.json' },
		});
		expect(parseAgentVmCommand(['controller', 'status'])).toStrictEqual({
			command: 'controller.status',
			options: { config: 'config/system.json' },
		});
		expect(parseAgentVmCommand(['controller', 'health', '--zone', 'zone'])).toStrictEqual({
			command: 'controller.health',
			options: { config: 'config/system.json', zone: 'zone' },
		});
		expect(parseAgentVmCommand(['controller', 'destroy', '--zone', 'zone'])).toStrictEqual({
			command: 'controller.destroy',
			options: { config: 'config/system.json', purge: false, zone: 'zone' },
		});
	});

	it('preserves defaults, optional values, and Zod-owned domains', () => {
		const result = runOptiqueCliParser({
			argv: ['init', 'zone', '--type', 'worker', '--secrets', 'environment', '--arch', 'x86_64'],
			io: silentIo,
			parser: createAgentVmParser(),
			programName: 'agent-vm',
		});
		expect(result).toMatchObject({
			kind: 'parsed',
			value: {
				command: 'init',
				options: {
					zoneId: 'zone',
					paths: undefined,
					preset: undefined,
					secrets: 'environment',
					arch: 'x86_64',
				},
			},
		});

		const hermes = runOptiqueCliParser({
			argv: ['init', 'zone', '--type', 'hermes', '--secrets', 'environment', '--arch', 'x86_64'],
			io: silentIo,
			parser: createAgentVmParser(),
			programName: 'agent-vm',
		});
		expect(hermes).toMatchObject({ kind: 'parse-error' });
	});

	it('rejects invalid and reserved exact-domain values during parsing', () => {
		const invalidArgv: readonly (readonly string[])[] = [
			['auth', 'openclaw', 'login', 'openai', '--agent', 'Hello World', '--zone', 'zone'],
			['config', 'reset-instructions', '--zone', 'cache'],
			['init', 'cache', '--type', 'worker', '--secrets', 'environment', '--arch', 'x86_64'],
			[
				'init',
				'zone',
				'--type',
				'worker',
				'--secrets',
				'environment',
				'--arch',
				'x86_64',
				'--namespace',
				'Project_Name',
			],
			[
				'init',
				'zone',
				'--type',
				'openclaw',
				'--secrets',
				'environment',
				'--arch',
				'x86_64',
				'--openclaw-agents',
				'main,Hello World',
			],
			['manual', 'update', '--default-zone', 'controller-state'],
		];

		for (const argv of invalidArgv) {
			const result = runOptiqueCliParser({
				argv,
				io: silentIo,
				parser: createAgentVmParser(),
				programName: 'agent-vm',
			});
			expect(result, argv.join(' ')).toMatchObject({ kind: 'parse-error', exitCode: 1 });
		}
	});

	it('transforms openclaw agent CSV values into validated deduplicated ids', () => {
		const result = runOptiqueCliParser({
			argv: [
				'init',
				'zone',
				'--type',
				'openclaw',
				'--secrets',
				'environment',
				'--arch',
				'x86_64',
				'--openclaw-agents',
				' sun,main, sun ',
			],
			io: silentIo,
			parser: createAgentVmParser(),
			programName: 'agent-vm',
		});

		expect(result).toMatchObject({
			kind: 'parsed',
			value: {
				command: 'init',
				options: { agents: ['sun', 'main'] },
			},
		});
	});

	it('supports help and version outcomes without dispatching an operation', () => {
		expect(
			runOptiqueCliParser({
				argv: ['controller', '--help'],
				io: silentIo,
				parser: createAgentVmParser(),
				programName: 'agent-vm',
				version: '1.2.3',
			}),
		).toMatchObject({ kind: 'help', exitCode: 0 });
		expect(
			runOptiqueCliParser({
				argv: ['--version'],
				io: silentIo,
				parser: createAgentVmParser(),
				programName: 'agent-vm',
				version: '1.2.3',
			}),
		).toMatchObject({ kind: 'version', exitCode: 0 });
	});
});
