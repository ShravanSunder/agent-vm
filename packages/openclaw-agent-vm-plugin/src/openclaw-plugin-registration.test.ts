import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import defaultPlugin, {
	createBackendDeps,
	type SshHelpers,
} from './openclaw-plugin-registration.js';
import type { OpenClawSandboxFsBridge } from './sandbox-backend-factory.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';

function createMockSshHelpers(overrides?: Partial<SshHelpers>): SshHelpers {
	const mockSession = { command: 'ssh', configPath: '/tmp/ssh', host: 'tool-0.vm.host' };
	return {
		buildExecRemoteCommand: vi.fn(() => `cd ${OPENCLAW_TOOL_VM_WORKSPACE_MOUNT} && ls -la`),
		buildRemoteCommand: vi.fn(() => '/bin/sh -c pwd'),
		buildSshSandboxArgv: vi.fn(() => ['ssh', '-i', '/tmp/key', 'tool-0.vm.host', 'ls']),
		createRemoteShellSandboxFsBridge: vi.fn(() => ({
			mkdirp: vi.fn(async () => {}),
			readFile: vi.fn(async () => Buffer.from('content')),
			remove: vi.fn(async () => {}),
			rename: vi.fn(async () => {}),
			resolvePath: vi.fn(() => ({
				containerPath: `${OPENCLAW_TOOL_VM_WORKSPACE_MOUNT}/f.txt`,
				relativePath: 'f.txt',
			})),
			stat: vi.fn(async () => ({ mtimeMs: 0, size: 0, type: 'file' as const })),
			writeFile: vi.fn(async () => {}),
		})),
		createSshSandboxSessionFromSettings: vi.fn(async () => mockSession),
		runSshSandboxCommand: vi.fn(async () => ({
			code: 0,
			stderr: Buffer.from(''),
			stdout: Buffer.from('ok'),
		})),
		sanitizeEnvVars: vi.fn(() => ({ allowed: { PATH: '/usr/bin' } })),
		...overrides,
	};
}

describe('createGondolinPlugin', () => {
	it('marks the plugin for gateway startup activation', async () => {
		const manifestPath = path.resolve(import.meta.dirname, '..', 'openclaw.plugin.json');
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
			readonly activation?: { readonly onStartup?: boolean };
			readonly cliBackends?: readonly string[];
			readonly contracts?: { readonly tools?: readonly string[] };
		};

		expect(manifest.activation?.onStartup).toBe(true);
		expect(manifest.cliBackends).toContain('gondolin');
		expect(manifest.contracts?.tools).toContain('zone_git_push');
	});

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

	it('registers the zone_git_push tool from plugin config when available', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerTool = vi.fn();

		try {
			defaultPlugin.register({
				pluginConfig: {
					controllerUrl: 'http://controller.vm.host:18800',
					zoneId: 'shravan',
				},
				registerTool,
				registrationMode: 'full',
			});

			expect(registerTool).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'zone_git_push',
					parameters: expect.objectContaining({ type: 'object' }),
				}),
				{ name: 'zone_git_push', optional: true },
			);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('registers zone_git_push during OpenClaw tool discovery without loading the sandbox SDK', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerTool = vi.fn();

		try {
			defaultPlugin.register({
				pluginConfig: {
					controllerUrl: 'http://controller.vm.host:18800',
					zoneId: 'shravan',
				},
				registerTool,
				registrationMode: 'tool-discovery',
			});

			expect(registerTool).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'zone_git_push',
					parameters: expect.objectContaining({ type: 'object' }),
				}),
				{ name: 'zone_git_push', optional: true },
			);
			expect(stderrWrite).not.toHaveBeenCalled();
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('publishes Tool VM runtime status from OpenClaw runtime config during full registration', async () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

		try {
			defaultPlugin.register({
				config: {
					agents: {
						defaults: {
							sandbox: {
								backend: 'gondolin',
								mode: 'all',
								scope: 'agent',
								workspaceAccess: 'rw',
							},
							workspace: '/zone/agents/default',
						},
					},
				},
				pluginConfig: {
					controllerUrl: 'http://controller.vm.host:18800',
					zoneId: 'shravan',
				},
				registerTool: vi.fn(),
				registrationMode: 'full',
			});

			await vi.waitFor(() => {
				expect(fetchSpy).toHaveBeenCalledWith(
					'http://controller.vm.host:18800/zones/shravan/openclaw-runtime-status',
					expect.objectContaining({
						method: 'POST',
					}),
				);
			});
			const requestInit = fetchSpy.mock.calls[0]?.[1];
			if (typeof requestInit?.body !== 'string') {
				throw new TypeError('Expected runtime status request body to be a string.');
			}
			const body = JSON.parse(requestInit.body) as {
				readonly findings: readonly { readonly ok: boolean }[];
				readonly pluginId: string;
				readonly zoneId: string;
			};
			expect(body.pluginId).toBe('gondolin');
			expect(body.zoneId).toBe('shravan');
			expect(body.findings.every((finding) => finding.ok)).toBe(true);
		} finally {
			fetchSpy.mockRestore();
			stderrWrite.mockRestore();
		}
	});

	it('fails full registration when OpenClaw does not expose registerTool', () => {
		expect(() =>
			defaultPlugin.register({
				pluginConfig: {
					controllerUrl: 'http://controller.vm.host:18800',
					zoneId: 'shravan',
				},
				registrationMode: 'full',
			}),
		).toThrow('Gondolin full registration requires OpenClaw registerTool.');
	});

	it('resolves zone_git_push token from the configured environment variable', async () => {
		const previousToken = process.env.AGENT_VM_ZONE_GIT_TOKEN;
		process.env.AGENT_VM_ZONE_GIT_TOKEN = 'runtime-push-token';
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		let registeredTool:
			| Parameters<NonNullable<Parameters<typeof defaultPlugin.register>[0]['registerTool']>>[0]
			| undefined;

		try {
			defaultPlugin.register({
				pluginConfig: {
					controllerUrl: 'http://controller.vm.host:18800',
					zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN',
					zoneId: 'shravan',
				},
				registerTool: (tool) => {
					registeredTool = tool;
				},
				registrationMode: 'tool-discovery',
			});

			if (!registeredTool) {
				throw new Error('Expected zone_git_push tool to be registered.');
			}
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValue(new Response(JSON.stringify({ success: true })));
			try {
				await registeredTool.execute('tool-call-1', { expectedHead: 'abc123' });
				expect(fetchSpy).toHaveBeenCalledWith(
					'http://controller.vm.host:18800/zones/shravan/zone-git/push',
					expect.objectContaining({
						headers: {
							'content-type': 'application/json',
							'x-agent-vm-zone-git-token': 'runtime-push-token',
						},
					}),
				);
			} finally {
				fetchSpy.mockRestore();
			}
		} finally {
			stderrWrite.mockRestore();
			if (previousToken === undefined) {
				delete process.env.AGENT_VM_ZONE_GIT_TOKEN;
			} else {
				process.env.AGENT_VM_ZONE_GIT_TOKEN = previousToken;
			}
		}
	});
});

describe('createBackendDeps', () => {
	it('delegates buildExecSpec to SSH helpers', async () => {
		const ssh = createMockSshHelpers();
		const deps = createBackendDeps(ssh);

		const execSpec = await deps.buildExecSpec({
			command: 'ls -la',
			env: { TEST: '1' },
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
			usePty: false,
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
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
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			env: { TEST: '1' },
		});
		expect(execSpec.stdinMode).toBe('pipe-open');
		expect(execSpec.argv).toEqual(['ssh', '-i', '/tmp/key', 'tool-0.vm.host', 'ls']);

		// Verify finalizeToken contains session and dispose function
		expect(execSpec.finalizeToken).toBeDefined();
		const token = execSpec.finalizeToken as { session: unknown; dispose: () => Promise<void> };
		expect(token.session).toEqual({
			command: 'ssh',
			configPath: '/tmp/ssh',
			host: 'tool-0.vm.host',
		});
		expect(typeof token.dispose).toBe('function');
	});

	it('buildExecSpec finalizeToken dispose calls disposeSshSandboxSession when available', async () => {
		const disposeSshSandboxSession = vi.fn(async () => {});
		const ssh = createMockSshHelpers({ disposeSshSandboxSession });
		const deps = createBackendDeps(ssh);

		const execSpec = await deps.buildExecSpec({
			command: 'echo test',
			env: {},
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
			usePty: false,
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		});

		const token = execSpec.finalizeToken as { dispose: () => Promise<void> };
		await token.dispose();

		expect(disposeSshSandboxSession).toHaveBeenCalledTimes(1);
	});

	it('buildExecSpec finalizeToken dispose is safe when disposeSshSandboxSession is absent', async () => {
		const ssh = createMockSshHelpers();
		// disposeSshSandboxSession is undefined by default in createMockSshHelpers
		const deps = createBackendDeps(ssh);

		const execSpec = await deps.buildExecSpec({
			command: 'echo test',
			env: {},
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
			usePty: false,
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		});

		const token = execSpec.finalizeToken as { dispose: () => Promise<void> };
		// Should not throw
		await token.dispose();
	});

	it('delegates runRemoteShellScript to SSH helpers', async () => {
		const mockSession = { command: 'ssh', configPath: '/tmp/ssh', host: 'tool-0.vm.host' };
		const ssh = createMockSshHelpers({
			buildRemoteCommand: vi.fn(() => '/bin/sh -c pwd gondolin-sandbox-fs'),
			createSshSandboxSessionFromSettings: vi.fn(async () => mockSession),
			runSshSandboxCommand: vi.fn(async () => ({
				code: 0,
				stderr: Buffer.from(''),
				stdout: Buffer.from('/work\n'),
			})),
		});

		const deps = createBackendDeps(ssh);
		const result = await deps.runRemoteShellScript({
			script: 'pwd',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout.toString()).toBe('/work\n');
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

	it('createFsBridgeBuilder delegates to SDK createRemoteShellSandboxFsBridge', () => {
		const mockBridge: OpenClawSandboxFsBridge = {
			mkdirp: vi.fn(async () => {}),
			readFile: vi.fn(async () => Buffer.from('remote-content')),
			remove: vi.fn(async () => {}),
			rename: vi.fn(async () => {}),
			resolvePath: vi.fn(() => ({
				containerPath: `${OPENCLAW_TOOL_VM_WORKSPACE_MOUNT}/readme.md`,
				relativePath: 'readme.md',
			})),
			stat: vi.fn(async () => ({ mtimeMs: 2000, size: 100, type: 'file' as const })),
			writeFile: vi.fn(async () => {}),
		};
		const createRemoteShellSandboxFsBridge = vi.fn(() => mockBridge);
		const ssh = createMockSshHelpers({ createRemoteShellSandboxFsBridge });

		const deps = createBackendDeps(ssh);

		const mockRunShellScript = vi.fn(async () => ({
			code: 0,
			stderr: Buffer.from(''),
			stdout: Buffer.from(''),
		}));
		const createFsBridge = deps.createFsBridgeBuilder({
			remoteWorkspaceDir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			remoteAgentWorkspaceDir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			runRemoteShellScript: mockRunShellScript,
		});

		const fakeSandbox = { workspaceDir: '/home/user', agentWorkspaceDir: '/home/user' };
		const bridge = createFsBridge({ sandbox: fakeSandbox });

		expect(bridge).toBe(mockBridge);
		expect(createRemoteShellSandboxFsBridge).toHaveBeenCalledWith({
			sandbox: fakeSandbox,
			runtime: {
				remoteWorkspaceDir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				remoteAgentWorkspaceDir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				runRemoteShellScript: mockRunShellScript,
			},
		});
	});
});
