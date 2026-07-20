import type {
	PortalCallRequest,
	PortalCallResult,
	PortalDescribeRequest,
	PortalDescribeResult,
	PortalListRequest,
	PortalListResult,
	PortalSearchRequest,
	PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimeClient,
	GatewayRuntimeClientOptions,
	GatewayRuntimePortalRequestOptions,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { describe, expect, it, vi } from 'vitest';

import type { OpenClawGatewayRuntimeSandboxRegistration } from './gateway-runtime-sandbox-backend.js';
import type { OpenClawDiagnosticRuntimeLoader } from './openclaw-gateway-runtime-trace-context.js';
import { registerAgentVmPlugin } from './openclaw-plugin-registration.js';
import type { OpenClawPluginService } from './openclaw-sandbox-sdk-contract.js';
import type { OpenClawToolPortalClient } from './tool-portal-native-tools.js';

const toolPortalConfig = {
	agentProjections: {
		'agent-a': {
			agentId: 'agent-a',
			frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
			profileAssignmentRevision: 'profile-revision-a',
			toolPortalProfileId: 'profile-a',
		},
		'agent-b': {
			agentId: 'agent-b',
			frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
			profileAssignmentRevision: 'profile-revision-b',
			toolPortalProfileId: 'profile-b',
		},
	},
	attachment: {
		attachmentGeneration: 7,
		clientKind: 'openclaw-managed-plugin',
		configuredAgentIds: ['agent-a', 'agent-b'],
		frameworkEpoch: 'openclaw-epoch-4',
		gatewayEpoch: 'gateway-epoch-3',
		protocolVersion: 1,
		projectionCohortDigest:
			'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		runtimeEpoch: 'runtime-epoch-5',
		schemaVersion: 1,
	},
} as const;

const loadInactiveOpenClawDiagnosticRuntime: OpenClawDiagnosticRuntimeLoader = async () => ({
	createDiagnosticTraceContextFromActiveScope: () => ({
		spanId: '1111111111111111',
		traceFlags: '01',
		traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
	}),
	formatDiagnosticTraceparent: () => undefined,
});

function createFakeGatewayRuntimeClient(): Pick<GatewayRuntimeClient, 'connect' | 'disconnect'> &
	OpenClawToolPortalClient {
	return {
		connect: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
		portal: {
			call: vi.fn(
				async (
					_request: PortalCallRequest,
					_options: GatewayRuntimePortalRequestOptions,
				): Promise<PortalCallResult> => ({ items: [], ok: true }),
			),
			describe: vi.fn(
				async (
					_request: PortalDescribeRequest,
					_options: GatewayRuntimePortalRequestOptions,
				): Promise<PortalDescribeResult> => ({ items: [], ok: true }),
			),
			list: vi.fn(
				async (
					_request: PortalListRequest,
					_options: GatewayRuntimePortalRequestOptions,
				): Promise<PortalListResult> => ({ items: [], ok: true }),
			),
			search: vi.fn(
				async (
					_request: PortalSearchRequest,
					_options: GatewayRuntimePortalRequestOptions,
				): Promise<PortalSearchResult> => ({ items: [], ok: true }),
			),
		},
	};
}

describe('OpenClaw GatewayRuntimeClient lifecycle', () => {
	it('constructs one UDS client, shares it across configured agents, and owns it through one service', async () => {
		const client = createFakeGatewayRuntimeClient();
		let gatewayRuntimeClientOptions: GatewayRuntimeClientOptions | undefined;
		const createGatewayRuntimeClient = vi.fn((options: GatewayRuntimeClientOptions) => {
			gatewayRuntimeClientOptions = options;
			return client;
		});
		const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
		const activeSpanId = '00f067aa0ba902b7';
		const loadOpenClawDiagnosticRuntime = vi.fn(async () => ({
			createDiagnosticTraceContextFromActiveScope: () => ({
				parentSpanId: activeSpanId,
				spanId: '1111111111111111',
				traceFlags: '01',
				traceId,
			}),
			formatDiagnosticTraceparent: (context: {
				readonly spanId?: string;
				readonly traceFlags?: string;
				readonly traceId: string;
			}) => `00-${context.traceId}-${context.spanId}-${context.traceFlags}`,
		}));
		const registerHttpRoute = vi.fn();
		const registerService = vi.fn();
		const restoreSandboxBackend = vi.fn();
		const registerSandboxBackend = vi.fn(() => restoreSandboxBackend);
		const registerTool = vi.fn();
		const closeSandboxRegistration = vi.fn(async () => {});
		const sandboxRegistration = {
			close: closeSandboxRegistration,
			factory: vi.fn(async () => {
				throw new Error('Factory is not invoked by lifecycle registration proof.');
			}),
			resolveWorkdir: () => '/work',
		} satisfies OpenClawGatewayRuntimeSandboxRegistration;
		const createSandboxRegistration = vi.fn(() => sandboxRegistration);
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

		try {
			registerAgentVmPlugin(
				{
					pluginConfig: {
						toolPortal: toolPortalConfig,
						zoneId: 'zone-a',
					},
					registerHttpRoute,
					registerService,
					registerTool,
					registrationMode: 'full',
				},
				{
					createGatewayRuntimeClient,
					createSandboxRegistration,
					loadOpenClawDiagnosticRuntime,
					loadOpenClawSandboxSdk: vi.fn(async () => ({ registerSandboxBackend })),
				},
			);

			expect(createGatewayRuntimeClient).toHaveBeenCalledOnce();
			if (gatewayRuntimeClientOptions === undefined) {
				throw new Error('Expected Gateway Runtime client construction options.');
			}
			expect(gatewayRuntimeClientOptions).toMatchObject({
				attachment: toolPortalConfig.attachment,
				traceContextProvider: expect.any(Function),
			});
			expect(gatewayRuntimeClientOptions.traceContextProvider?.()).toBeUndefined();
			expect(registerService).toHaveBeenCalledOnce();
			expect(registerTool).toHaveBeenCalledOnce();
			expect(registerHttpRoute).not.toHaveBeenCalled();
			const registeredFactory = registerTool.mock.calls[0]?.[0];
			if (typeof registeredFactory !== 'function') {
				throw new Error('Expected one Tool Portal tool factory.');
			}
			const firstTools = registeredFactory({
				agentId: 'agent-a',
				requesterSenderId: 'sender-a',
				sessionId: 'session-a',
				workspaceDir: '/native/openclaw/workspace-a',
			});
			const secondTools = registeredFactory({
				agentId: 'agent-b',
				requesterSenderId: 'sender-b',
				sessionId: 'session-b',
				workspaceDir: '/native/openclaw/workspace-b',
			});
			expect(firstTools).toHaveLength(4);
			expect(secondTools).toHaveLength(4);

			const service = registerService.mock.calls[0]?.[0] as OpenClawPluginService | undefined;
			if (service === undefined) throw new Error('Expected one OpenClaw plugin service.');
			expect(service.id).toBe('agent-vm-gateway-runtime-client');
			const serviceContext = {
				config: {},
				logger: {
					debug: vi.fn(),
					error: vi.fn(),
					info: vi.fn(),
					warn: vi.fn(),
				},
				stateDir: '/state/openclaw',
			};
			await service.start(serviceContext);
			expect(loadOpenClawDiagnosticRuntime).toHaveBeenCalledOnce();
			expect(gatewayRuntimeClientOptions.traceContextProvider?.()).toEqual({
				traceparent: `00-${traceId}-${activeSpanId}-01`,
			});
			await service.stop?.(serviceContext);
			expect(client.connect).toHaveBeenCalledOnce();
			expect(registerSandboxBackend).toHaveBeenCalledWith('gondolin', {
				factory: sandboxRegistration.factory,
				resolveWorkdir: sandboxRegistration.resolveWorkdir,
			});
			expect(createSandboxRegistration).toHaveBeenCalledWith({
				agentProjections: toolPortalConfig.agentProjections,
				client,
				traceContextProvider: gatewayRuntimeClientOptions.traceContextProvider,
			});
			expect(restoreSandboxBackend).toHaveBeenCalledOnce();
			expect(closeSandboxRegistration).toHaveBeenCalledOnce();
			expect(client.disconnect).toHaveBeenCalledOnce();
			const restoreCallOrder = restoreSandboxBackend.mock.invocationCallOrder[0];
			const closeCallOrder = closeSandboxRegistration.mock.invocationCallOrder[0];
			const disconnectCallOrder = vi.mocked(client.disconnect).mock.invocationCallOrder[0];
			if (
				restoreCallOrder === undefined ||
				closeCallOrder === undefined ||
				disconnectCallOrder === undefined
			) {
				throw new Error('Expected Sandbox unregister, close, and client disconnect calls.');
			}
			expect(restoreCallOrder).toBeLessThan(closeCallOrder);
			expect(closeCallOrder).toBeLessThan(disconnectCallOrder);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('fails closed when full registration lacks immutable Tool Portal attachment config', () => {
		expect(() =>
			registerAgentVmPlugin({
				pluginConfig: { zoneId: 'zone-a' },
				registerService: vi.fn(),
				registerTool: vi.fn(),
				registrationMode: 'full',
			}),
		).toThrow('Gondolin full registration requires toolPortal.');
	});

	it('closes Sandbox reservations and disconnects when backend registration fails', async () => {
		const client = createFakeGatewayRuntimeClient();
		const registerService = vi.fn();
		const closeSandboxRegistration = vi.fn(async () => {});
		const sandboxRegistration = {
			close: closeSandboxRegistration,
			factory: vi.fn(async () => {
				throw new Error('Factory is not invoked by startup failure proof.');
			}),
			resolveWorkdir: () => '/work',
		} satisfies OpenClawGatewayRuntimeSandboxRegistration;
		registerAgentVmPlugin(
			{
				pluginConfig: { toolPortal: toolPortalConfig, zoneId: 'zone-a' },
				registerService,
				registerTool: vi.fn(),
				registrationMode: 'full',
			},
			{
				createGatewayRuntimeClient: () => client,
				createSandboxRegistration: () => sandboxRegistration,
				loadOpenClawDiagnosticRuntime: loadInactiveOpenClawDiagnosticRuntime,
				loadOpenClawSandboxSdk: vi.fn(async () => ({
					registerSandboxBackend: vi.fn(() => {
						throw new Error('backend registration failed');
					}),
				})),
			},
		);
		const service = registerService.mock.calls[0]?.[0] as OpenClawPluginService | undefined;
		if (service === undefined) throw new Error('Expected one OpenClaw plugin service.');

		await expect(
			service.start({
				config: {},
				logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
				stateDir: '/state/openclaw',
			}),
		).rejects.toThrow('backend registration failed');
		expect(closeSandboxRegistration).toHaveBeenCalledOnce();
		expect(client.disconnect).toHaveBeenCalledOnce();
	});

	it('exposes discovery schemas without constructing or connecting a runtime client', () => {
		const createGatewayRuntimeClient = vi.fn(() => createFakeGatewayRuntimeClient());
		const registerService = vi.fn();
		const registerTool = vi.fn();

		registerAgentVmPlugin(
			{
				pluginConfig: {
					toolPortal: toolPortalConfig,
					zoneId: 'zone-a',
				},
				registerService,
				registerTool,
				registrationMode: 'tool-discovery',
			},
			{ createGatewayRuntimeClient },
		);

		expect(registerTool).toHaveBeenCalledOnce();
		expect(createGatewayRuntimeClient).not.toHaveBeenCalled();
		expect(registerService).not.toHaveBeenCalled();
	});

	it('late-binds discovery tools to the connected full-registration client', async () => {
		const client = createFakeGatewayRuntimeClient();
		const discoveryRegisterTool = vi.fn();
		const fullRegisterService = vi.fn();

		registerAgentVmPlugin({
			pluginConfig: {
				toolPortal: toolPortalConfig,
				zoneId: 'zone-a',
			},
			registerTool: discoveryRegisterTool,
			registrationMode: 'tool-discovery',
		});
		registerAgentVmPlugin(
			{
				pluginConfig: {
					toolPortal: toolPortalConfig,
					zoneId: 'zone-a',
				},
				registerService: fullRegisterService,
				registerTool: vi.fn(),
				registrationMode: 'full',
			},
			{
				createGatewayRuntimeClient: () => client,
				createSandboxRegistration: () => ({
					close: vi.fn(async () => {}),
					factory: vi.fn(async () => {
						throw new Error('Factory is not invoked by client binding proof.');
					}),
					resolveWorkdir: () => '/work',
				}),
				loadOpenClawDiagnosticRuntime: loadInactiveOpenClawDiagnosticRuntime,
				loadOpenClawSandboxSdk: vi.fn(async () => ({
					registerSandboxBackend: vi.fn(() => vi.fn()),
				})),
			},
		);

		const discoveryFactory = discoveryRegisterTool.mock.calls[0]?.[0];
		if (typeof discoveryFactory !== 'function') {
			throw new Error('Expected one discovery Tool Portal factory.');
		}
		const discoveryListTool = (
			discoveryFactory({
				agentId: 'agent-a',
				sessionId: 'session-a',
				sessionKey: 'agent:agent-a:e2e:session-a',
			}) as readonly {
				readonly execute: (toolCallId: string, params: unknown) => Promise<unknown>;
				readonly name: string;
			}[]
		).find((tool) => tool.name === 'tool_portal_list');
		if (discoveryListTool === undefined) {
			throw new Error('Expected discovery tool_portal_list.');
		}
		await expect(
			discoveryListTool.execute('before-start', { requests: [{ id: 'before-start' }] }),
		).rejects.toThrow('Gateway runtime client is unavailable');

		const fullService = fullRegisterService.mock.calls[0]?.[0] as OpenClawPluginService | undefined;
		if (fullService === undefined) {
			throw new Error('Expected one full-registration service.');
		}
		const serviceContext = {
			config: {},
			logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
			stateDir: '/state/openclaw',
		};
		await fullService.start(serviceContext);
		await expect(
			discoveryListTool.execute('after-start', { requests: [{ id: 'after-start' }] }),
		).resolves.toMatchObject({ details: { items: [], ok: true } });
		expect(client.portal.list).toHaveBeenCalledOnce();

		await fullService.stop?.(serviceContext);
		await expect(
			discoveryListTool.execute('after-stop', { requests: [{ id: 'after-stop' }] }),
		).rejects.toThrow('Gateway runtime client is unavailable');
	});
});
