import { describe, expect, it, vi } from 'vitest';

import defaultPlugin, { createBackendDeps, type SshHelpers } from './plugin.js';

describe('createGondolinPlugin', () => {
	it('exports a default plugin descriptor with the gondolin id', () => {
		expect(defaultPlugin.id).toBe('gondolin');
		expect(defaultPlugin.name).toBe('Gondolin VM Sandbox');
		expect(typeof defaultPlugin.register).toBe('function');
	});

	it('register does not throw when called in non-full mode', () => {
		expect(() => {
			defaultPlugin.register({
				pluginConfig: {},
				registrationMode: 'minimal',
			});
		}).not.toThrow();
	});

	it.skip('register in full mode attempts SDK import and logs error for missing SDK path', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		defaultPlugin.register({
			pluginConfig: {
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			registrationMode: 'full',
		});

		// The SDK import will fail outside a gateway VM — poll until the error is logged
		for (let attempt = 0; attempt < 20; attempt++) {
			if (consoleSpy.mock.calls.length > 0) break;
			// oxlint-disable-next-line eslint/no-await-in-loop -- polling for async rejection
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('[gondolin] failed to load OpenClaw SDK'),
		);
		consoleSpy.mockRestore();
	});
});

describe('createBackendDeps', () => {
	it('delegates buildExecSpec to SSH helpers', async () => {
		const mockSession = { command: 'ssh', configPath: '/tmp/ssh', host: 'tool-0.vm.host' };
		const ssh: SshHelpers = {
			buildExecRemoteCommand: vi.fn(() => 'cd /workspace && ls -la'),
			buildRemoteCommand: vi.fn(() => '/bin/sh -c pwd'),
			buildSshSandboxArgv: vi.fn(() => ['ssh', '-i', '/tmp/key', 'tool-0.vm.host', 'ls']),
			createSshSandboxSessionFromSettings: vi.fn(async () => mockSession),
			runSshSandboxCommand: vi.fn(async () => ({
				code: 0,
				stderr: Buffer.from(''),
				stdout: Buffer.from('ok'),
			})),
			sanitizeEnvVars: vi.fn(() => ({ allowed: { PATH: '/usr/bin' } })),
		};

		const deps = createBackendDeps(ssh);

		const execSpec = await deps.buildExecSpec({
			command: 'ls -la',
			env: { TEST: '1' },
			ssh: { host: 'tool-0.vm.host', identityPem: 'pem', port: 22, user: 'sandbox' },
			usePty: false,
			workdir: '/workspace',
		});

		expect(ssh.createSshSandboxSessionFromSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				target: 'sandbox@tool-0.vm.host:22',
				identityData: 'pem',
				strictHostKeyChecking: false,
			}),
		);
		expect(ssh.buildExecRemoteCommand).toHaveBeenCalledWith({
			command: 'ls -la',
			workdir: '/workspace',
			env: { TEST: '1' },
		});
		expect(execSpec.stdinMode).toBe('pipe-open');
		expect(execSpec.argv).toEqual(['ssh', '-i', '/tmp/key', 'tool-0.vm.host', 'ls']);
	});

	it('delegates runRemoteShellScript to SSH helpers', async () => {
		const mockSession = { command: 'ssh', configPath: '/tmp/ssh', host: 'tool-0.vm.host' };
		const ssh: SshHelpers = {
			buildExecRemoteCommand: vi.fn(),
			buildRemoteCommand: vi.fn(() => '/bin/sh -c pwd gondolin-sandbox-fs'),
			buildSshSandboxArgv: vi.fn(),
			createSshSandboxSessionFromSettings: vi.fn(async () => mockSession),
			runSshSandboxCommand: vi.fn(async () => ({
				code: 0,
				stderr: Buffer.from(''),
				stdout: Buffer.from('/workspace\n'),
			})),
			sanitizeEnvVars: vi.fn(),
		};

		const deps = createBackendDeps(ssh);
		const result = await deps.runRemoteShellScript({
			script: 'pwd',
			ssh: { host: 'tool-0.vm.host', identityPem: 'pem', port: 22, user: 'sandbox' },
		});

		expect(result.code).toBe(0);
		expect(result.stdout.toString()).toBe('/workspace\n');
		expect(ssh.buildRemoteCommand).toHaveBeenCalledWith([
			'/bin/sh',
			'-c',
			'pwd',
			'gondolin-sandbox-fs',
		]);
		expect(ssh.runSshSandboxCommand).toHaveBeenCalledWith({
			session: mockSession,
			remoteCommand: '/bin/sh -c pwd gondolin-sandbox-fs',
		});
	});
});
