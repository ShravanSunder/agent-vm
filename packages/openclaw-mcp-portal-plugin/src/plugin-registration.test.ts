import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
	createRequestFromIncomingMessage,
	createPortalRuntimeFingerprintInput,
	registerMcpPortalPlugin,
	validatePortalPluginApi,
	writeFetchResponseToServerResponse,
} from './plugin-registration.js';
import { PortalConfigWatcher } from './portal-config-watcher.js';

class RecordingServerResponse extends EventEmitter {
	readonly chunks: Buffer[] = [];
	readonly headers = new Map<string, number | readonly string[] | string>();
	destroyed = false;
	ended = false;
	statusCode = 0;

	constructor(
		private readonly onWrite?: () => void,
		private readonly writeResult = true,
	) {
		super();
	}

	setHeader(name: string, value: number | readonly string[] | string): this {
		this.headers.set(name, value);
		return this;
	}

	write(chunk: string | Uint8Array): boolean {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		this.onWrite?.();
		return this.writeResult;
	}

	end(chunk?: string | Uint8Array): this {
		if (chunk !== undefined) {
			this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		this.ended = true;
		this.emit('finish');
		return this;
	}

	destroy(error?: Error): this {
		this.destroyed = true;
		void error;
		return this;
	}
}

class RecordingIncomingMessage extends EventEmitter {
	readonly headers = { host: '127.0.0.1:18789' };
	complete = false;
	destroyed = false;
	method = 'POST';
	url = '/mcp-portal/bindings/binding-a/mcp';

	destroy(): this {
		this.destroyed = true;
		return this;
	}
}

describe('plugin registration validation', () => {
	it('requires HTTP routes, prompt hooks, and lifecycle cleanup APIs', () => {
		expect(() => validatePortalPluginApi({})).toThrow(/registerHttpRoute/);
		expect(() =>
			validatePortalPluginApi({
				on: () => undefined,
				onDispose: () => undefined,
				registerHttpRoute: () => undefined,
			}),
		).not.toThrow();
	});

	it('registers the portal HTTP route, prompt hook, tool approval hook, and cleanup', () => {
		const routes: unknown[] = [];
		const hooks: string[] = [];
		let cleanup: (() => Promise<void> | void) | undefined;

		registerMcpPortalPlugin({
			config: {
				agents: { list: [{ id: 'sun' }] },
				gateway: { port: 18789 },
				mcp: {
					servers: {
						linear: {
							transport: 'streamable-http',
							url: 'https://mcp.example.test',
						},
						mcp_portal_sun_27756f050e14: {
							headers: { 'x-mcp-portal-binding-secret': 'secret' },
							transport: 'streamable-http',
							url: 'http://127.0.0.1:18789/mcp-portal/bindings/mcp-portal-sun-27756f050e14/mcp',
						},
					},
				},
				plugins: {
					entries: {
						'mcp-portal': {
							config: { enabledNamespacesByAgent: { sun: ['linear'] } },
						},
					},
				},
			},
			logger: { info: () => undefined, warn: () => undefined },
			on: (hookName) => {
				hooks.push(hookName);
			},
			onDispose: (callback) => {
				cleanup = callback;
			},
			registerHttpRoute: (route) => {
				routes.push(route);
			},
		});

		expect(routes).toEqual([
			expect.objectContaining({
				auth: 'plugin',
				match: 'prefix',
				path: '/mcp-portal',
				replaceExisting: true,
			}),
		]);
		expect(hooks).toEqual(['before_prompt_build', 'before_tool_call']);
		expect(cleanup).toEqual(expect.any(Function));
	});

	it('streams fetch responses into the OpenClaw server response without buffering', async () => {
		const encoder = new TextEncoder();
		const streamController: {
			current?: ReadableStreamDefaultController<Uint8Array>;
		} = {};
		let resolveFirstWrite: (() => void) | undefined;
		const firstWrite = new Promise<void>((resolve) => {
			resolveFirstWrite = resolve;
		});
		const serverResponse = new RecordingServerResponse(() => {
			resolveFirstWrite?.();
		});
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(nextController) {
					streamController.current = nextController;
					nextController.enqueue(encoder.encode('first'));
				},
			}),
			{ headers: { 'content-type': 'text/event-stream' }, status: 202 },
		);

		const writePromise = writeFetchResponseToServerResponse(
			response,
			serverResponse as unknown as ServerResponse,
		);
		await firstWrite;

		expect(Buffer.concat(serverResponse.chunks).toString('utf8')).toBe('first');
		expect(serverResponse.ended).toBe(false);
		expect(serverResponse.statusCode).toBe(202);
		expect(serverResponse.headers.get('content-type')).toBe('text/event-stream');

		if (!streamController.current) {
			throw new Error('test stream controller was not initialized');
		}
		streamController.current.enqueue(encoder.encode('second'));
		streamController.current.close();
		await writePromise;

		expect(Buffer.concat(serverResponse.chunks).toString('utf8')).toBe('firstsecond');
		expect(serverResponse.ended).toBe(true);
	});

	it('wraps incoming OpenClaw requests as a live stream without waiting for end', async () => {
		const incomingMessage = new RecordingIncomingMessage();
		const request = createRequestFromIncomingMessage(incomingMessage as unknown as IncomingMessage);

		expect(request.method).toBe('POST');
		if (!request.body) {
			throw new Error('request body stream was not created');
		}
		const reader = request.body.getReader();
		incomingMessage.emit('data', Buffer.from('first'));
		const firstRead = await reader.read();
		expect(firstRead.done).toBe(false);
		expect(Buffer.from(firstRead.value ?? new Uint8Array()).toString('utf8')).toBe('first');

		incomingMessage.complete = true;
		incomingMessage.emit('end');
		await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
	});

	it('cancels upstream response reads when the client closes between chunks', async () => {
		const encoder = new TextEncoder();
		let resolveFirstWrite: (() => void) | undefined;
		const firstWrite = new Promise<void>((resolve) => {
			resolveFirstWrite = resolve;
		});
		let resolveCancel: (() => void) | undefined;
		const cancelled = new Promise<void>((resolve) => {
			resolveCancel = resolve;
		});
		const serverResponse = new RecordingServerResponse(() => {
			resolveFirstWrite?.();
		});
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					resolveCancel?.();
				},
				start(controller) {
					controller.enqueue(encoder.encode('first'));
				},
			}),
		);

		const writePromise = writeFetchResponseToServerResponse(
			response,
			serverResponse as unknown as ServerResponse,
		);
		await firstWrite;
		serverResponse.emit('close');

		await expect(writePromise).rejects.toThrow(/closed while streaming/);
		await cancelled;
		expect(serverResponse.destroyed).toBe(true);
	});

	it('terminates stream forwarding when the client closes before drain', async () => {
		let resolveWrite: (() => void) | undefined;
		const firstWrite = new Promise<void>((resolve) => {
			resolveWrite = resolve;
		});
		const serverResponse = new RecordingServerResponse(() => {
			resolveWrite?.();
		}, false);
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('blocked'));
				},
			}),
		);

		const writePromise = writeFetchResponseToServerResponse(
			response,
			serverResponse as unknown as ServerResponse,
		);
		await firstWrite;
		serverResponse.emit('close');

		await expect(writePromise).rejects.toThrow(/closed before drain/);
		expect(serverResponse.destroyed).toBe(true);
	});

	it('terminates stream forwarding when close fires during a backpressured write', async () => {
		const serverResponse = new RecordingServerResponse(() => {
			serverResponse.emit('close');
		}, false);
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('blocked'));
				},
			}),
		);

		await expect(
			writeFetchResponseToServerResponse(response, serverResponse as unknown as ServerResponse),
		).rejects.toThrow(/closed before drain/);
		expect(serverResponse.destroyed).toBe(true);
	});

	it('reload fingerprint changes when only plugin config changes', () => {
		const watcher = new PortalConfigWatcher();
		const api = {
			config: { agents: { list: [{ id: 'sun' }] } },
			pluginConfig: { enabledNamespacesByAgent: { sun: ['linear'] } },
		};

		expect(watcher.hasChanged(createPortalRuntimeFingerprintInput(api))).toBe(true);
		expect(watcher.hasChanged(createPortalRuntimeFingerprintInput(api))).toBe(false);
		api.pluginConfig = { enabledNamespacesByAgent: { sun: ['readwise'] } };

		expect(watcher.hasChanged(createPortalRuntimeFingerprintInput(api))).toBe(true);
	});
});
