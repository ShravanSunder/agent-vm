import { describe, expect, it } from 'vitest';

import type {
	OpenClawPluginHookEventMap,
	OpenClawPluginHookResultMap,
	OpenClawRuntimeLifecycleRegistration,
	OpenClawPluginService,
} from './openclaw-plugin-api.js';
import {
	registerMcpPortalPlugin,
	validatePortalPluginApi,
	validatePortalPortAgainstTcpPool,
} from './plugin-registration.js';

describe('plugin registration validation', () => {
	it('requires service registration, prompt/tool hooks, and lifecycle cleanup APIs', () => {
		expect(() => validatePortalPluginApi({})).toThrow(/registerService/u);
		expect(() =>
			validatePortalPluginApi({
				registerRuntimeLifecycle: () => undefined,
				registerService: () => undefined,
			}),
		).toThrow(/prompt hook/u);
		expect(() =>
			validatePortalPluginApi({
				on: () => undefined,
				registerRuntimeLifecycle: () => undefined,
				registerService: () => undefined,
			}),
		).not.toThrow();
	});

	it('refuses a portal port inside the Tool VM TCP pool range', () => {
		expect(() =>
			validatePortalPortAgainstTcpPool({
				port: 19_001,
				tcpPool: { basePort: 19_000, size: 4 },
			}),
		).toThrow(/overlaps/u);
		expect(() =>
			validatePortalPortAgainstTcpPool({
				port: 18_790,
				tcpPool: { basePort: 19_000, size: 4 },
			}),
		).not.toThrow();
	});

	it('registers one subprocess service plus prompt and tool hooks', () => {
		const services: OpenClawPluginService[] = [];
		const hooks: string[] = [];
		let lifecycleRegistration: OpenClawRuntimeLifecycleRegistration | undefined;

		registerMcpPortalPlugin({
			config: {
				tcpPool: { basePort: 19_000, size: 4 },
			},
			logger: { error: () => undefined },
			lifecycle: {
				registerRuntimeLifecycle: (lifecycle) => {
					lifecycleRegistration = lifecycle;
				},
			},
			on: <THookName extends keyof OpenClawPluginHookEventMap>(
				hookName: THookName,
				_handler: (
					event: OpenClawPluginHookEventMap[THookName],
					context: { readonly agentId?: string },
				) =>
					| OpenClawPluginHookResultMap[THookName]
					| Promise<OpenClawPluginHookResultMap[THookName] | void>
					| void,
			): void => {
				hooks.push(hookName);
			},
			pluginConfig: {
				configDir: '/config/gateways/sunclaw',
			},
			registerService: (service) => {
				services.push(service);
			},
		});

		expect(services).toHaveLength(1);
		expect(services[0]).toMatchObject({ id: 'mcp-portal-subprocess' });
		expect(hooks).toEqual(['before_tool_call', 'before_prompt_build']);
		expect(lifecycleRegistration).toMatchObject({
			id: 'mcp-portal-subprocess',
		});
		expect(lifecycleRegistration?.cleanup).toEqual(expect.any(Function));
	});

	it('keeps the legacy onDispose cleanup fallback', () => {
		const services: OpenClawPluginService[] = [];
		const hooks: string[] = [];
		let cleanup: (() => Promise<void> | void) | undefined;

		registerMcpPortalPlugin({
			config: {
				tcpPool: { basePort: 19_000, size: 4 },
			},
			logger: { error: () => undefined },
			on: <THookName extends keyof OpenClawPluginHookEventMap>(
				hookName: THookName,
				_handler: (
					event: OpenClawPluginHookEventMap[THookName],
					context: { readonly agentId?: string },
				) =>
					| OpenClawPluginHookResultMap[THookName]
					| Promise<OpenClawPluginHookResultMap[THookName] | void>
					| void,
			): void => {
				hooks.push(hookName);
			},
			onDispose: (callback) => {
				cleanup = callback;
			},
			pluginConfig: {
				configDir: '/config/gateways/sunclaw',
			},
			registerService: (service) => {
				services.push(service);
			},
		});

		expect(services).toHaveLength(1);
		expect(services[0]).toMatchObject({ id: 'mcp-portal-subprocess' });
		expect(hooks).toEqual(['before_tool_call', 'before_prompt_build']);
		expect(cleanup).toEqual(expect.any(Function));
	});
});
