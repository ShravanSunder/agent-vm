import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
	GATEWAY_CONTROL_CALLER_CONTEXT_AGENT_AUTHORITY_KEYS_ENV,
	GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV,
} from '@agent-vm/gateway-interface';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import defaultPlugin, {
	OPENCLAW_SSH_SESSION_SCRATCH_ROOT,
	createBackendDeps,
	type SshHelpers,
} from './openclaw-plugin-registration.js';
import type { OpenClawHttpRouteRegistration } from './openclaw-sandbox-sdk-contract.js';
import type {
	OpenClawSandboxBackendHandle,
	OpenClawSandboxFsBridge,
} from './sandbox-backend-factory.js';
import {
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH,
	AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER,
	registerToolVmWriteReadE2eRoute,
	testExports as toolVmWriteReadE2eToolTestExports,
} from './tool-vm-write-read-e2e-tool.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';
const TOOL_PORTAL_NATIVE_TOOL_NAMES = [
	'tool_portal_list',
	'tool_portal_search',
	'tool_portal_describe',
	'tool_portal_call',
] as const;

function createControlSessionPluginConfig(): {
	readonly bootId: string;
	readonly controllerEpoch: string;
	readonly generationId: string;
	readonly peerId: string;
	readonly verifierPublicKeyPem: string;
} {
	const { publicKey } = generateKeyPairSync('ed25519');
	return {
		bootId: 'gateway-boot-a',
		controllerEpoch: 'controller-epoch-a',
		generationId: 'gateway-generation-a',
		peerId: 'gateway-zone-a',
		verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
	};
}

beforeEach(() => {
	vi.stubEnv(
		GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV,
		'test-caller-context-proof-key-with-enough-length',
	);
	vi.stubEnv(
		GATEWAY_CONTROL_CALLER_CONTEXT_AGENT_AUTHORITY_KEYS_ENV,
		JSON.stringify({
			main: 'test-main-agent-authority-key-with-enough-length',
			second: 'test-second-agent-authority-key-with-enough-length',
		}),
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

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

function registeredRoute(
	registerHttpRoute: ReturnType<typeof vi.fn>,
	pathname: string,
): OpenClawHttpRouteRegistration | undefined {
	return registerHttpRoute.mock.calls
		.map((call) => call[0] as OpenClawHttpRouteRegistration)
		.find((candidate) => candidate.path === pathname);
}

function expectRegisteredRoute(
	registerHttpRoute: ReturnType<typeof vi.fn>,
	pathname: string,
): OpenClawHttpRouteRegistration {
	const route = registeredRoute(registerHttpRoute, pathname);
	if (route === undefined) {
		throw new Error(`Expected route ${pathname} to be registered.`);
	}
	return route;
}

interface CapturedHttpResponse {
	readonly bodyText: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly statusCode: number;
}

async function invokeRegisteredRoute(options: {
	readonly bodyText: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly route: OpenClawHttpRouteRegistration;
}): Promise<CapturedHttpResponse> {
	const responseHeaders: Record<string, string> = {};
	let statusCode = 200;
	let bodyText = '';
	const request = Readable.from([Buffer.from(options.bodyText, 'utf8')]) as Readable & {
		headers: Readonly<Record<string, string>>;
	};
	request.headers = options.headers ?? {};
	const response = {
		get statusCode(): number {
			return statusCode;
		},
		set statusCode(value: number) {
			statusCode = value;
		},
		end: (chunk?: string | Buffer): void => {
			bodyText = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : (chunk ?? '');
		},
		setHeader: (name: string, value: number | string | readonly string[]): void => {
			responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
		},
	};
	await options.route.handler(
		request as unknown as Parameters<OpenClawHttpRouteRegistration['handler']>[0],
		response as Parameters<OpenClawHttpRouteRegistration['handler']>[1],
	);
	return {
		bodyText,
		headers: responseHeaders,
		statusCode,
	};
}

function createToolVmWriteReadProbeBody(options?: {
	readonly agentId?: string;
	readonly filePath?: string;
	readonly marker?: string;
	readonly sessionKey?: string;
}): string {
	return JSON.stringify({
		agentId: options?.agentId ?? 'beta',
		filePath: options?.filePath ?? '.agent-vm/proof.txt',
		marker: options?.marker ?? 'probe-marker',
		sessionKey: options?.sessionKey ?? 'agent:beta:tool-vm-write-read:test-session',
	});
}

function createToolVmWriteReadProbeHeaders(bodyText: string): Readonly<Record<string, string>> {
	return {
		[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER]:
			toolVmWriteReadE2eToolTestExports.signToolVmWriteReadE2eRouteBody(
				bodyText,
				'test-tool-vm-write-read-proof-key',
			),
	};
}

function createMockToolVmWriteReadBackend(options?: {
	readonly runShellCommand?: OpenClawSandboxBackendHandle['runShellCommand'];
}): OpenClawSandboxBackendHandle {
	return {
		buildExecSpec: vi.fn(async () => ({
			argv: ['sh', '-lc', 'true'],
			env: {},
			stdinMode: 'pipe-closed' as const,
		})),
		id: 'mock-tool-vm-backend',
		runShellCommand:
			options?.runShellCommand ??
			vi.fn(async () => ({
				code: 0,
				stderr: Buffer.from(''),
				stdout: Buffer.from('probe-marker'),
			})),
		runtimeId: 'mock-runtime',
		runtimeLabel: 'mock-runtime',
		workdir: '/workspace',
	};
}

describe('createGondolinPlugin', () => {
	it('marks the plugin for gateway startup activation', async () => {
		const manifestPath = path.resolve(import.meta.dirname, '..', 'openclaw.plugin.json');
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
			readonly activation?: { readonly onStartup?: boolean };
			readonly cliBackends?: readonly string[];
			readonly configSchema?: {
				readonly properties?: Record<
					string,
					{
						readonly additionalProperties?: boolean;
						readonly required?: readonly string[];
						readonly type?: string;
					}
				>;
				readonly required?: readonly string[];
			};
			readonly contracts?: { readonly tools?: readonly string[] };
			readonly toolMetadata?: Record<string, { readonly optional?: boolean }>;
		};

		expect(manifest.activation?.onStartup).toBe(true);
		expect(manifest.cliBackends).toContain('gondolin');
		expect(manifest.contracts?.tools ?? []).not.toContain('zone_git_push');
		expect(manifest.contracts?.tools).toEqual(TOOL_PORTAL_NATIVE_TOOL_NAMES);
		expect(manifest.toolMetadata).toEqual(
			Object.fromEntries(
				TOOL_PORTAL_NATIVE_TOOL_NAMES.map((toolName) => [toolName, { optional: true }]),
			),
		);
		expect(manifest.configSchema?.required).toEqual(['zoneId']);
		expect(manifest.configSchema?.properties).not.toHaveProperty('controllerUrl');
		expect(manifest.configSchema?.properties).not.toHaveProperty('gatewayControlLinkMonitor');
		expect(manifest.configSchema?.properties).not.toHaveProperty('gatewayControlSessionMonitor');
		expect(manifest.configSchema?.properties?.toolPortal).toMatchObject({
			additionalProperties: false,
			required: ['configDir'],
			type: 'object',
		});
		expect(manifest.configSchema?.properties?.controlSession).toMatchObject({
			additionalProperties: false,
			required: ['bootId', 'controllerEpoch', 'generationId', 'peerId', 'verifierPublicKeyPem'],
			type: 'object',
		});
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

	it('does not register the old direct zone_git_push model tool', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerTool = vi.fn();

		try {
			defaultPlugin.register({
				pluginConfig: {
					controlSession: createControlSessionPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerTool,
				registrationMode: 'full',
			});

			expect(registerTool).not.toHaveBeenCalledWith(
				expect.objectContaining({ name: 'zone_git_push' }),
				expect.anything(),
			);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('does not expose zone_git_push during OpenClaw tool discovery', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerTool = vi.fn();

		try {
			defaultPlugin.register({
				pluginConfig: {
					zoneId: 'shravan',
				},
				registerTool,
				registrationMode: 'tool-discovery',
			});

			expect(registerTool).not.toHaveBeenCalledWith(
				expect.objectContaining({ name: 'zone_git_push' }),
				expect.anything(),
			);
			expect(stderrWrite).not.toHaveBeenCalled();
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('registers Tool Portal native tools during OpenClaw tool discovery', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerTool = vi.fn();

		try {
			defaultPlugin.register({
				pluginConfig: {
					toolPortal: {
						configDir: '/home/openclaw/.openclaw/cache/tool-portal-effective',
					},
					zoneId: 'shravan',
				},
				registerTool,
				registrationMode: 'tool-discovery',
			});

			expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
				names: TOOL_PORTAL_NATIVE_TOOL_NAMES,
				optional: true,
			});
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('registers private gateway control readiness and upgrade routes when control session config is present', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerHttpRoute = vi.fn();

		try {
			defaultPlugin.register({
				pluginConfig: {
					controlSession: createControlSessionPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute,
				registerTool: vi.fn(),
				registrationMode: 'full',
			});

			expect(registerHttpRoute).toHaveBeenCalledWith(
				expect.objectContaining({
					auth: 'plugin',
					match: 'exact',
					path: '/__agent-vm/ready',
				}),
			);
			expect(registerHttpRoute).toHaveBeenCalledWith(
				expect.objectContaining({
					auth: 'plugin',
					handleUpgrade: expect.any(Function),
					match: 'exact',
					path: '/__agent-vm/gateway-control',
				}),
			);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('reuses the gateway control service across repeated full registration for the same identity', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const controlSession = createControlSessionPluginConfig();
		const firstRegisterHttpRoute = vi.fn();
		const secondRegisterHttpRoute = vi.fn();
		const pluginConfig = {
			controlSession,
			zoneId: 'shravan',
		};

		try {
			defaultPlugin.register({
				pluginConfig,
				registerHttpRoute: firstRegisterHttpRoute,
				registerTool: vi.fn(),
				registrationMode: 'full',
			});
			defaultPlugin.register({
				pluginConfig,
				registerHttpRoute: secondRegisterHttpRoute,
				registerTool: vi.fn(),
				registrationMode: 'full',
			});

			expect(expectRegisteredRoute(firstRegisterHttpRoute, '/__agent-vm/ready').handler).toBe(
				expectRegisteredRoute(secondRegisterHttpRoute, '/__agent-vm/ready').handler,
			);
			expect(
				expectRegisteredRoute(firstRegisterHttpRoute, '/__agent-vm/gateway-control').handleUpgrade,
			).toBe(
				expectRegisteredRoute(secondRegisterHttpRoute, '/__agent-vm/gateway-control').handleUpgrade,
			);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('registers Tool Portal native model tools instead of MCP Portal model tools', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerTool = vi.fn();

		try {
			defaultPlugin.register({
				pluginConfig: {
					controlSession: createControlSessionPluginConfig(),
					toolPortal: {
						configDir: '/home/openclaw/.openclaw/cache/tool-portal-effective',
					},
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerTool,
				registrationMode: 'full',
			});

			expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
				names: TOOL_PORTAL_NATIVE_TOOL_NAMES,
				optional: true,
			});
			const toolFactory = registerTool.mock.calls.find(
				(call) => typeof call[0] === 'function',
			)?.[0];
			if (typeof toolFactory !== 'function') {
				throw new Error('Expected a Tool Portal native tool factory registration.');
			}
			const factory = toolFactory as (context: {
				readonly agentId: string;
			}) => readonly { readonly name: string }[];
			const tools = factory({ agentId: 'shravan' });
			expect(tools.map((tool) => tool.name)).toEqual([
				'tool_portal_list',
				'tool_portal_search',
				'tool_portal_describe',
				'tool_portal_call',
			]);
			expect(JSON.stringify(tools)).not.toContain('mcp_portal_');
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('does not register the private e2e Tool VM write/read route during full plugin registration', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerHttpRoute = vi.fn();
		const registerTool = vi.fn();
		vi.stubEnv(AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV, '1');
		vi.stubEnv(AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV, 'test-tool-vm-write-read-proof-key');

		try {
			defaultPlugin.register({
				pluginConfig: {
					controlSession: createControlSessionPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute,
				registerTool,
				registrationMode: 'full',
			});

			expect(registerTool).not.toHaveBeenCalledWith(expect.any(Function), expect.any(Object));
			expect(
				registeredRoute(registerHttpRoute, AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH),
			).toBeUndefined();
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('rejects the private e2e Tool VM write/read route without a proof signature', async () => {
		const registerHttpRoute = vi.fn();
		const backendFactory = vi.fn(async () => createMockToolVmWriteReadBackend());
		vi.stubEnv(AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV, '1');
		vi.stubEnv(AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV, 'test-tool-vm-write-read-proof-key');

		registerToolVmWriteReadE2eRoute({
			api: { registerHttpRoute },
			factoryProvider: async () => backendFactory,
		});
		const response = await invokeRegisteredRoute({
			bodyText: createToolVmWriteReadProbeBody(),
			route: expectRegisteredRoute(registerHttpRoute, AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH),
		});

		expect(response.statusCode).toBe(401);
		expect(JSON.parse(response.bodyText)).toMatchObject({
			error: { message: 'tool-vm-write-read-e2e: missing proof signature.' },
			ok: false,
		});
		expect(backendFactory).not.toHaveBeenCalled();
	});

	it('rejects the private e2e Tool VM write/read route when body agent does not match the session key', async () => {
		const registerHttpRoute = vi.fn();
		const backendFactory = vi.fn(async () => createMockToolVmWriteReadBackend());
		vi.stubEnv(AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV, '1');
		vi.stubEnv(AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV, 'test-tool-vm-write-read-proof-key');

		registerToolVmWriteReadE2eRoute({
			api: { registerHttpRoute },
			factoryProvider: async () => backendFactory,
		});
		const bodyText = createToolVmWriteReadProbeBody({
			agentId: 'main',
			sessionKey: 'agent:beta:tool-vm-write-read:test-session',
		});
		const response = await invokeRegisteredRoute({
			bodyText,
			headers: createToolVmWriteReadProbeHeaders(bodyText),
			route: expectRegisteredRoute(registerHttpRoute, AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH),
		});

		expect(response.statusCode).toBe(403);
		expect(JSON.parse(response.bodyText)).toMatchObject({
			error: { message: 'tool-vm-write-read-e2e: body agentId does not match sessionKey agent.' },
			ok: false,
		});
		expect(backendFactory).not.toHaveBeenCalled();
	});

	it('rejects the private e2e Tool VM write/read route for unsafe proof paths', async () => {
		const registerHttpRoute = vi.fn();
		const backendFactory = vi.fn(async () => createMockToolVmWriteReadBackend());
		vi.stubEnv(AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV, '1');
		vi.stubEnv(AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV, 'test-tool-vm-write-read-proof-key');

		registerToolVmWriteReadE2eRoute({
			api: { registerHttpRoute },
			factoryProvider: async () => backendFactory,
		});
		const bodyText = createToolVmWriteReadProbeBody({
			filePath: '../outside.txt',
		});
		const response = await invokeRegisteredRoute({
			bodyText,
			headers: createToolVmWriteReadProbeHeaders(bodyText),
			route: expectRegisteredRoute(registerHttpRoute, AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH),
		});

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.bodyText)).toMatchObject({
			error: { message: 'tool-vm-write-read-e2e: filePath must stay under .agent-vm/.' },
			ok: false,
		});
		expect(backendFactory).not.toHaveBeenCalled();
	});

	it('runs the private e2e Tool VM write/read route with a signed same-agent proof', async () => {
		const registerHttpRoute = vi.fn();
		const runShellCommand = vi.fn(async () => ({
			code: 0,
			stderr: Buffer.from(''),
			stdout: Buffer.from('probe-marker'),
		}));
		const backend = createMockToolVmWriteReadBackend({ runShellCommand });
		const backendFactory = vi.fn(async () => backend);
		vi.stubEnv(AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV, '1');
		vi.stubEnv(AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV, 'test-tool-vm-write-read-proof-key');

		registerToolVmWriteReadE2eRoute({
			api: { registerHttpRoute },
			factoryProvider: async () => backendFactory,
		});
		const bodyText = createToolVmWriteReadProbeBody();
		const response = await invokeRegisteredRoute({
			bodyText,
			headers: createToolVmWriteReadProbeHeaders(bodyText),
			route: expectRegisteredRoute(registerHttpRoute, AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH),
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.bodyText)).toMatchObject({
			details: {
				agentId: 'beta',
				filePath: '.agent-vm/proof.txt',
				marker: 'probe-marker',
				readBack: 'probe-marker',
				sessionKey: 'agent:beta:tool-vm-write-read:test-session',
			},
			ok: true,
		});
		expect(backendFactory).toHaveBeenCalledWith(
			expect.objectContaining({
				agentWorkspaceDir: '/zone/agents/beta',
				scopeKey: 'agent:beta:tool-vm-write-read:test-session',
				sessionKey: 'agent:beta:tool-vm-write-read:test-session',
			}),
		);
		expect(runShellCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				script: expect.stringContaining("proof_file='.agent-vm/proof.txt'"),
			}),
		);
	});

	it('does not publish Tool VM runtime status through controller HTTP during full registration', async () => {
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
					controlSession: createControlSessionPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerTool: vi.fn(),
				registrationMode: 'full',
			});

			await Promise.resolve();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			stderrWrite.mockRestore();
		}
	});

	it('does not retry Tool VM runtime status through controller HTTP while the controller becomes ready', async () => {
		vi.useFakeTimers();
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'controller-not-ready' }), { status: 503 }),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

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
					controlSession: createControlSessionPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerTool: vi.fn(),
				registrationMode: 'full',
			});

			await vi.advanceTimersByTimeAsync(1_000);
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(stderrWrite).not.toHaveBeenCalledWith(
				expect.stringContaining('failed to publish OpenClaw runtime status'),
			);
		} finally {
			fetchSpy.mockRestore();
			stderrWrite.mockRestore();
			vi.useRealTimers();
		}
	});

	it('does not keep a controller HTTP runtime-status retry loop alive', async () => {
		vi.useFakeTimers();
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ error: 'controller-not-ready' }), { status: 503 }),
			);

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
					controlSession: createControlSessionPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerTool: vi.fn(),
				registrationMode: 'full',
			});

			await vi.advanceTimersByTimeAsync(29_000);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			stderrWrite.mockRestore();
			vi.useRealTimers();
		}
	});

	it('fails full registration when OpenClaw does not expose registerTool', () => {
		expect(() =>
			defaultPlugin.register({
				pluginConfig: {
					controlSession: createControlSessionPluginConfig(),
					zoneId: 'shravan',
				},
				registrationMode: 'full',
			}),
		).toThrow('Gondolin full registration requires OpenClaw registerTool.');
	});

	it('fails full registration without control session config instead of falling back to raw lease HTTP', () => {
		expect(() =>
			defaultPlugin.register({
				pluginConfig: {
					zoneId: 'shravan',
				},
				registerTool: vi.fn(),
				registrationMode: 'full',
			}),
		).toThrow('Gondolin full registration requires controlSession.');
	});

	it('fails full registration when the private caller-context proof key env is absent', () => {
		vi.unstubAllEnvs();

		expect(() =>
			defaultPlugin.register({
				pluginConfig: {
					controlSession: createControlSessionPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerTool: vi.fn(),
				registrationMode: 'full',
			}),
		).toThrow(
			`Gondolin full registration requires ${GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV}.`,
		);
	});

	it('rejects legacy zone_git_push token config during tool discovery', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerTool = vi.fn();

		try {
			expect(() =>
				defaultPlugin.register({
					pluginConfig: {
						zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN',
						zoneId: 'shravan',
					},
					registerTool,
					registrationMode: 'tool-discovery',
				}),
			).toThrow('Gondolin plugin config no longer accepts zone git token fields.');
			expect(registerTool).not.toHaveBeenCalled();
		} finally {
			stderrWrite.mockRestore();
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
				workspaceRoot: OPENCLAW_SSH_SESSION_SCRATCH_ROOT,
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
