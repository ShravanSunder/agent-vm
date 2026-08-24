import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { configure, dispose, getConfig, reset, type LogRecord, type Sink } from '@logtape/logtape';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV,
	AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH,
} from './gateway-runtime-sandbox-write-read-e2e-route.js';
import e2ePlugin from './openclaw-plugin-registration.e2e.js';
import defaultPlugin from './openclaw-plugin-registration.js';
import type {
	OpenClawHttpRouteRegistration,
	OpenClawPluginLogger,
} from './openclaw-sandbox-sdk-contract.js';
import type { RegisterToolPortalNativeToolsProps } from './tool-portal-native-tools.js';

const TOOL_PORTAL_NATIVE_TOOL_NAMES = [
	'tool_portal_list',
	'tool_portal_search',
	'tool_portal_describe',
	'tool_portal_call',
] as const;

interface JsonSchemaNode {
	readonly additionalProperties?: boolean | JsonSchemaNode;
	readonly items?: JsonSchemaNode;
	readonly minLength?: number;
	readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
	readonly required?: readonly string[];
	readonly type?: string;
	readonly uniqueItems?: boolean;
}

function createToolPortalPluginConfig(): {
	readonly agentProjections: Readonly<
		Record<
			string,
			{
				readonly agentId: string;
				readonly frameworkIdentity: {
					readonly agentId: string;
					readonly kind: 'openclaw';
				};
				readonly profileAssignmentRevision: string;
				readonly toolPortalNamespaces: readonly {
					readonly namespace: string;
					readonly summary?: string;
				}[];
				readonly toolPortalProfileId: string;
			}
		>
	>;
	readonly attachment: {
		readonly attachmentGeneration: number;
		readonly clientKind: 'openclaw-managed-plugin';
		readonly configuredAgentIds: readonly string[];
		readonly frameworkEpoch: string;
		readonly gatewayEpoch: string;
		readonly protocolVersion: number;
		readonly projectionCohortDigest: string;
		readonly runtimeEpoch: string;
		readonly schemaVersion: number;
	};
} {
	return {
		agentProjections: {
			shravan: {
				agentId: 'shravan',
				frameworkIdentity: { agentId: 'shravan', kind: 'openclaw' },
				profileAssignmentRevision: 'profile-revision-a',
				toolPortalNamespaces: [],
				toolPortalProfileId: 'profile-a',
			},
		},
		attachment: {
			attachmentGeneration: 7,
			clientKind: 'openclaw-managed-plugin',
			configuredAgentIds: ['shravan'],
			frameworkEpoch: 'openclaw-epoch-a',
			gatewayEpoch: 'gateway-epoch-a',
			protocolVersion: 1,
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			runtimeEpoch: 'runtime-epoch-a',
			schemaVersion: 1,
		},
	};
}

afterEach(async () => {
	await dispose().catch(() => undefined);
	await reset();
	vi.doUnmock('./tool-portal-native-tools.js');
	vi.resetModules();
	vi.unstubAllEnvs();
});

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

describe('createAgentVmPlugin', () => {
	it('marks the plugin for gateway startup activation', async () => {
		const manifestPath = path.resolve(import.meta.dirname, '..', 'openclaw.plugin.json');
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
			readonly activation?: { readonly onStartup?: boolean };
			readonly cliBackends?: readonly string[];
			readonly configSchema?: JsonSchemaNode;
			readonly contracts?: { readonly tools?: readonly string[] };
			readonly toolMetadata?: Record<string, { readonly optional?: boolean }>;
		};

		expect(manifest.activation?.onStartup).toBe(true);
		expect(manifest.cliBackends).toBeUndefined();
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
		expect(manifest.configSchema?.properties).not.toHaveProperty('profileId');
		expect(manifest.configSchema?.properties?.toolPortal).toMatchObject({
			additionalProperties: false,
			required: ['agentProjections', 'attachment'],
			type: 'object',
		});
		const toolPortalSchema = manifest.configSchema?.properties?.toolPortal;
		const agentProjectionsSchema = toolPortalSchema?.properties?.agentProjections;
		const projectionSchema =
			typeof agentProjectionsSchema?.additionalProperties === 'object'
				? agentProjectionsSchema.additionalProperties
				: undefined;
		expect(projectionSchema?.properties?.toolPortalNamespaces).toMatchObject({
			items: {
				additionalProperties: false,
				properties: {
					namespace: { minLength: 1, type: 'string' },
					summary: { maxLength: 500, minLength: 1, type: 'string' },
				},
				required: ['namespace'],
				type: 'object',
			},
			type: 'array',
			uniqueItems: true,
		});
		expect(projectionSchema?.required).toContain('toolPortalNamespaces');
		expect(manifest.configSchema?.properties).not.toHaveProperty('controlSession');
	});

	it('exports a default plugin descriptor with the agent-vm id', () => {
		expect(defaultPlugin.id).toBe('gondolin');
		expect(defaultPlugin.name).toBe('Gondolin VM Sandbox');
		expect(typeof defaultPlugin.register).toBe('function');
	});

	it('keeps full registration free of plugin-owned control, lease, and direct SSH construction', async () => {
		const registrationSource = await readFile(
			path.resolve(import.meta.dirname, 'openclaw-plugin-registration.ts'),
			'utf8',
		);

		for (const forbiddenAuthorityConstructor of [
			'createGatewayControlCallerContextStore',
			'createGatewayControlEventPublisher',
			'createGatewayControlLeaseClient',
			'createAgentVmSandboxBackendFactory',
			'createAgentVmSandboxBackendManager',
			'ensureGatewayControlSessionHeartbeat',
			'getOrCreateGatewayControlServiceRuntime',
			'registerToolVmWriteReadE2eRoute',
			'createBackendDeps',
			'OPENCLAW_SSH_SESSION_SCRATCH_ROOT',
		] as const) {
			expect(registrationSource).not.toContain(forbiddenAuthorityConstructor);
		}
	});

	async function importPluginRegistrationWithWarningProbe(
		warningMessages: string[],
		warningMessage = `native-tool-registration-${warningMessages.length + 1}`,
	): Promise<typeof import('./openclaw-plugin-registration.js')> {
		vi.doMock('./tool-portal-native-tools.js', async (importOriginal) => {
			const actual = await importOriginal<typeof import('./tool-portal-native-tools.js')>();
			return {
				...actual,
				registerToolPortalNativeTools: (props: RegisterToolPortalNativeToolsProps): void => {
					props.logger?.warn?.(warningMessage);
					warningMessages.push('emitted');
				},
			};
		});
		return import('./openclaw-plugin-registration.js');
	}

	function expectCapturedPluginWarning(
		records: readonly LogRecord[],
		warningMessage: string,
	): void {
		expect(records).toContainEqual(
			expect.objectContaining({
				category: ['agent-vm', 'openclaw-plugin'],
				level: 'warning',
				rawMessage: 'OpenClaw plugin warning: {warning}',
				properties: { warning: warningMessage },
			}),
		);
	}

	it('routes tool-discovery warnings through the OpenClaw host logger without LogTape setup', async () => {
		const warningMessages: string[] = [];
		const hostWarning = vi.fn<(message: string) => void>();
		const hostLogger = {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: hostWarning,
		} satisfies OpenClawPluginLogger;
		vi.resetModules();
		const { registerAgentVmPlugin } =
			await importPluginRegistrationWithWarningProbe(warningMessages);

		registerAgentVmPlugin({
			pluginConfig: {
				toolPortal: createToolPortalPluginConfig(),
				zoneId: 'shravan',
			},
			logger: hostLogger,
			registerTool: vi.fn(),
			registrationMode: 'tool-discovery',
		});

		expect(warningMessages).toEqual(['emitted']);
		expect(hostWarning).toHaveBeenCalledWith('native-tool-registration-1');
		expect(getConfig()).toBeNull();
	});

	it('routes full-registration warnings through the OpenClaw host logger without LogTape setup', async () => {
		const warningMessages: string[] = [];
		const hostWarning = vi.fn<(message: string) => void>();
		const hostLogger = {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: hostWarning,
		} satisfies OpenClawPluginLogger;
		vi.resetModules();
		const { registerAgentVmPlugin } =
			await importPluginRegistrationWithWarningProbe(warningMessages);

		registerAgentVmPlugin({
			pluginConfig: {
				toolPortal: createToolPortalPluginConfig(),
				zoneId: 'shravan',
			},
			logger: hostLogger,
			registerService: vi.fn(),
			registerTool: vi.fn(),
			registrationMode: 'full',
		});

		expect(warningMessages).toEqual(['emitted']);
		expect(hostWarning).toHaveBeenCalledWith('native-tool-registration-1');
		expect(getConfig()).toBeNull();
	});

	it('uses a categorized LogTape fallback with bounded warning properties', async () => {
		const records: LogRecord[] = [];
		const sink: Sink = (record): void => {
			records.push(record);
		};
		await configure({
			loggers: [
				{
					category: ['agent-vm', 'openclaw-plugin'],
					lowestLevel: 'trace',
					sinks: ['capture'],
				},
			],
			reset: false,
			sinks: { capture: sink },
		});
		const warningMessages: string[] = [];
		const warningMessage = `native-tool-registration-{literal}-${'x'.repeat(300)}`;
		vi.resetModules();
		const { registerAgentVmPlugin } = await importPluginRegistrationWithWarningProbe(
			warningMessages,
			warningMessage,
		);

		registerAgentVmPlugin({
			pluginConfig: {
				toolPortal: createToolPortalPluginConfig(),
				zoneId: 'shravan',
			},
			registerTool: vi.fn(),
			registrationMode: 'tool-discovery',
		});

		expect(warningMessages).toEqual(['emitted']);
		expectCapturedPluginWarning(records, warningMessage.slice(0, 256));
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
					toolPortal: createToolPortalPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerService: vi.fn(),
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
					toolPortal: createToolPortalPluginConfig(),
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

	it('does not register plugin-owned control readiness or upgrade routes', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerHttpRoute = vi.fn();

		try {
			defaultPlugin.register({
				pluginConfig: {
					toolPortal: createToolPortalPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute,
				registerService: vi.fn(),
				registerTool: vi.fn(),
				registrationMode: 'full',
			});

			expect(registerHttpRoute).not.toHaveBeenCalled();
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('registers only the thin UDS client service across repeated full registration', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const firstRegisterHttpRoute = vi.fn();
		const secondRegisterHttpRoute = vi.fn();
		const firstRegisterService = vi.fn();
		const secondRegisterService = vi.fn();
		const pluginConfig = {
			toolPortal: createToolPortalPluginConfig(),
			zoneId: 'shravan',
		};

		try {
			defaultPlugin.register({
				pluginConfig,
				registerHttpRoute: firstRegisterHttpRoute,
				registerService: firstRegisterService,
				registerTool: vi.fn(),
				registrationMode: 'full',
			});
			defaultPlugin.register({
				pluginConfig,
				registerHttpRoute: secondRegisterHttpRoute,
				registerService: secondRegisterService,
				registerTool: vi.fn(),
				registrationMode: 'full',
			});

			expect(firstRegisterHttpRoute).not.toHaveBeenCalled();
			expect(secondRegisterHttpRoute).not.toHaveBeenCalled();
			expect(firstRegisterService).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'agent-vm-gateway-runtime-client' }),
			);
			expect(secondRegisterService).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'agent-vm-gateway-runtime-client' }),
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
					toolPortal: createToolPortalPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerService: vi.fn(),
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

	it('keeps the production entrypoint route-free when E2E route opt-ins are set', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerHttpRoute = vi.fn();
		const registerTool = vi.fn();
		vi.stubEnv(AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV, '1');
		vi.stubEnv(AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV, 'test-uds-proof-key');
		vi.stubEnv(
			AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV,
			JSON.stringify([{ agentId: 'shravan', sessionKey: 'agent:shravan:e2e:test-session' }]),
		);

		try {
			defaultPlugin.register({
				pluginConfig: {
					toolPortal: createToolPortalPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute,
				registerService: vi.fn(),
				registerTool,
				registrationMode: 'full',
			});

			expect(registerHttpRoute).not.toHaveBeenCalled();
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('does not register the private e2e Tool VM write/read route without env opt-in', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerHttpRoute = vi.fn();
		const registerTool = vi.fn();

		try {
			defaultPlugin.register({
				pluginConfig: {
					toolPortal: createToolPortalPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute,
				registerService: vi.fn(),
				registerTool,
				registrationMode: 'full',
			});

			expect(
				registeredRoute(registerHttpRoute, AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH),
			).toBeUndefined();
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('opts the E2E entrypoint into the private UDS sandbox route outside the control prefix', () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const registerHttpRoute = vi.fn();
		const registerTool = vi.fn();
		vi.stubEnv(AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV, '1');
		vi.stubEnv(AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV, 'test-uds-proof-key');
		vi.stubEnv(
			AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV,
			JSON.stringify([{ agentId: 'shravan', sessionKey: 'agent:shravan:e2e:test-session' }]),
		);

		try {
			e2ePlugin.register({
				pluginConfig: {
					toolPortal: createToolPortalPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute,
				registerService: vi.fn(),
				registerTool,
				registrationMode: 'full',
			});

			const route = expectRegisteredRoute(
				registerHttpRoute,
				AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH,
			);
			expect(route.path).not.toMatch(/^\/__agent-vm/u);
			expect(route.auth).toBe('plugin');
		} finally {
			stderrWrite.mockRestore();
		}
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
					toolPortal: createToolPortalPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerService: vi.fn(),
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
					toolPortal: createToolPortalPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerService: vi.fn(),
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
					toolPortal: createToolPortalPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute: vi.fn(),
				registerService: vi.fn(),
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
					zoneId: 'shravan',
				},
				registrationMode: 'full',
			}),
		).toThrow('Gondolin full registration requires OpenClaw registerTool.');
	});

	it('fails full registration without immutable Tool Portal attachment config', () => {
		expect(() =>
			defaultPlugin.register({
				pluginConfig: {
					zoneId: 'shravan',
				},
				registerTool: vi.fn(),
				registrationMode: 'full',
			}),
		).toThrow('Gondolin full registration requires toolPortal.');
	});

	it('does not require private plugin-owned controller authority environment', () => {
		vi.unstubAllEnvs();
		const registerHttpRoute = vi.fn();

		expect(() =>
			defaultPlugin.register({
				pluginConfig: {
					toolPortal: createToolPortalPluginConfig(),
					zoneId: 'shravan',
				},
				registerHttpRoute,
				registerService: vi.fn(),
				registerTool: vi.fn(),
				registrationMode: 'full',
			}),
		).not.toThrow();
		expect(registerHttpRoute).not.toHaveBeenCalled();
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
