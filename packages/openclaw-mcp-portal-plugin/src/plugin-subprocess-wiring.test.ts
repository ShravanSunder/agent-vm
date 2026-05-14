import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashCallArguments, portalHmacKeyEnvName, verifyApprovalToken } from '@agent-vm/mcp-portal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
	OpenClawBeforeToolCallEvent,
	OpenClawBeforeToolCallResult,
	OpenClawPluginHookContext,
	OpenClawPortalPluginApi,
	OpenClawPluginService,
} from './openclaw-plugin-api.js';

type BeforeToolCallHandler = (
	event: OpenClawBeforeToolCallEvent,
	context: OpenClawPluginHookContext,
) => OpenClawBeforeToolCallResult | Promise<OpenClawBeforeToolCallResult | void> | void;

interface CapturedSupervisorOptions {
	readonly binPath: string;
	readonly configDir: string;
	readonly host: string;
	readonly hmacEnv: Readonly<Record<string, string>>;
	readonly port: number;
}

const supervisorMocks = vi.hoisted(() => ({
	capturedOptions: [] as CapturedSupervisorOptions[],
	start: vi.fn(async () => {}),
	stop: vi.fn(async () => {}),
}));

vi.mock('./portal-subprocess-supervisor.js', () => ({
	createPortalSubprocessSupervisor: (options: CapturedSupervisorOptions) => {
		supervisorMocks.capturedOptions.push(options);
		return {
			isAlive: () => true,
			start: supervisorMocks.start,
			stop: supervisorMocks.stop,
		};
	},
}));

const createdDirectories: string[] = [];

afterEach(async () => {
	supervisorMocks.capturedOptions.splice(0);
	supervisorMocks.start.mockClear();
	supervisorMocks.stop.mockClear();
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
	);
});

async function createConfigDir(): Promise<string> {
	const configDir = await mkdtemp(join(tmpdir(), 'agent-vm-mcp-portal-plugin-'));
	createdDirectories.push(configDir);
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, 'mcp.config.jsonc'),
		`${JSON.stringify({ schemaVersion: 1, providers: {} }, null, '\t')}\n`,
		'utf8',
	);
	await writeFile(
		join(configDir, 'mcp-portal.config.jsonc'),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				server: {
					host: '127.0.0.1',
					port: 18_791,
					accessHeader: {
						name: 'x-agent-vm-mcp-portal-secret',
						secret: { source: 'environment', name: 'MCP_PORTAL_SERVER_SECRET' },
					},
				},
				agents: {
					shravan: { profile: 'builder' },
				},
				profiles: {
					builder: {
						enabledNamespaces: ['linear'],
						enabledToolsByNamespace: { linear: ['create_issue'] },
						hiddenToolsByNamespace: {},
						approval: {
							allowWithoutApprovalTools: [],
							alwaysAskTools: [{ namespace: 'linear', toolName: 'create_issue' }],
							annotationPolicy: 'destructive-requires-approval',
							trustedAnnotationNamespaces: [],
							writeTools: [],
						},
					},
				},
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	return configDir;
}

describe('MCP Portal plugin subprocess integration', () => {
	it('starts the supervisor, shares HMAC keys, and signs approved portal calls', async () => {
		const { registerMcpPortalPlugin } = await import('./plugin-registration.js');
		const configDir = await createConfigDir();
		const services: OpenClawPluginService[] = [];
		let beforeToolCallHandler: BeforeToolCallHandler | undefined;
		const captureOpenClawHook: NonNullable<OpenClawPortalPluginApi['on']> = (
			hookName,
			handler,
		): void => {
			if (hookName === 'before_tool_call') {
				beforeToolCallHandler = handler as BeforeToolCallHandler;
			}
		};

		registerMcpPortalPlugin({
			config: { tcpPool: { basePort: 19_000, size: 4 } },
			logger: { error: () => undefined },
			on: captureOpenClawHook,
			onDispose: () => undefined,
			pluginConfig: {
				binPath: '/tmp/agent-vm-mcp-portal-server',
				configDir,
			},
			registerService: (service) => {
				services.push(service);
			},
		});
		const service = services[0];
		if (service === undefined || beforeToolCallHandler === undefined) {
			throw new Error('Expected plugin to register subprocess service and before_tool_call hook.');
		}

		await service.start();
		const supervisorOptions = supervisorMocks.capturedOptions[0];
		if (supervisorOptions === undefined) {
			throw new Error('Expected plugin to create a portal subprocess supervisor.');
		}
		expect(supervisorOptions).toMatchObject({ host: '127.0.0.1', port: 18_791 });
		const keyHex = supervisorOptions.hmacEnv[portalHmacKeyEnvName('shravan')];
		if (keyHex === undefined) {
			throw new Error('Expected HMAC env to contain a shravan key.');
		}
		const argumentsValue = { title: 'Fix release' };
		const params: Record<string, unknown> = {
			calls: [
				{
					arguments: argumentsValue,
					id: 'create',
					namespace: 'linear',
					toolName: 'create_issue',
				},
			],
		};

		const result = await beforeToolCallHandler(
			{ params, toolName: 'mcp_portal_shravan__mcp_portal_call' },
			{ agentId: 'shravan' },
		);
		const token = params.portalApprovalToken;

		expect(supervisorMocks.start).toHaveBeenCalledTimes(1);
		expect(supervisorOptions).toMatchObject({
			binPath: '/tmp/agent-vm-mcp-portal-server',
			configDir,
			host: '127.0.0.1',
			port: 18_791,
		});
		expect(result).toMatchObject({ requireApproval: expect.any(Object) });
		expect(typeof token).toBe('string');
		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [
					{
						argumentsHash: hashCallArguments(argumentsValue),
						namespace: 'linear',
						toolName: 'create_issue',
					},
				],
				key: Buffer.from(keyHex, 'hex'),
				nowMs: Date.now(),
				token: typeof token === 'string' ? token : '',
			}),
		).toEqual({ ok: true });

		await service.stop?.();
		expect(supervisorMocks.stop).toHaveBeenCalledTimes(1);
	});
});
