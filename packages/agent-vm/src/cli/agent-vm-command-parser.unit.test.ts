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

describe('agent-vm Optique command contract', () => {
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
		expect(parseAgentVmCommand(['controller', 'stop'])).toEqual({
			command: 'controller.stop',
			options: { config: 'config/system.json' },
		});
		expect(parseAgentVmCommand(['controller', 'status'])).toEqual({
			command: 'controller.status',
			options: { config: 'config/system.json' },
		});
		expect(parseAgentVmCommand(['controller', 'health', '--zone', 'zone'])).toEqual({
			command: 'controller.health',
			options: { config: 'config/system.json', zone: 'zone' },
		});
		expect(parseAgentVmCommand(['controller', 'destroy', '--zone', 'zone'])).toEqual({
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
