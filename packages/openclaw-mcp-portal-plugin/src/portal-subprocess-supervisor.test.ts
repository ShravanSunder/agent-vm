import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createPortalSubprocessSupervisor } from './portal-subprocess-supervisor.js';

function silentLogger(): { error: () => void; info: () => void; warn: () => void } {
	return { error: () => undefined, info: () => undefined, warn: () => undefined };
}

class FakeChildProcess extends EventEmitter {
	killed = false;
	readonly stderr = new PassThrough();
	readonly stdout = new PassThrough();

	constructor(readonly exitAfterMs?: number) {
		super();
		if (exitAfterMs !== undefined) {
			setTimeout(() => {
				if (!this.killed) {
					this.emit('exit', 1, null);
				}
			}, exitAfterMs);
		}
	}

	kill(): boolean {
		this.killed = true;
		setTimeout(() => this.emit('exit', 0, null), 1);
		return true;
	}
}

describe('createPortalSubprocessSupervisor', () => {
	it('spawns the portal binary with config dir, HMAC env, and explicit portal env', async () => {
		const previousSecret = process.env.AGENT_VM_SECRET_TOKEN;
		process.env.AGENT_VM_SECRET_TOKEN = 'do-not-leak';
		const spawnFn = vi.fn(
			(_command: string, _args: readonly string[], _options: SpawnOptions) =>
				new FakeChildProcess() as unknown as ChildProcess,
		);
		const supervisor = createPortalSubprocessSupervisor({
			binPath: '/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server',
			configDir: '/config/gateways/sunclaw',
			fetchFn: vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
			host: '127.0.0.1',
			hmacEnv: { PORTAL_HMAC_KEY__shravan: '00'.repeat(32) },
			logger: silentLogger(),
			port: 18_790,
			portalEnv: { MCP_PORTAL_SERVER_SECRET: 'portal-secret' },
			spawnFn,
		});

		await supervisor.start();

		const spawnOptions = spawnFn.mock.calls[0]?.[2];
		const spawnedEnv = spawnOptions?.env ?? {};
		expect(spawnFn).toHaveBeenCalledWith(
			'/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server',
			['--config-dir', '/config/gateways/sunclaw'],
			expect.objectContaining({
				env: expect.objectContaining({
					MCP_PORTAL_SERVER_SECRET: 'portal-secret',
					PORTAL_HMAC_KEY__shravan: '00'.repeat(32),
				}),
			}),
		);
		expect(spawnedEnv).not.toHaveProperty('AGENT_VM_SECRET_TOKEN');
		expect(supervisor.isAlive()).toBe(true);
		await supervisor.stop();
		if (previousSecret === undefined) {
			delete process.env.AGENT_VM_SECRET_TOKEN;
		} else {
			process.env.AGENT_VM_SECRET_TOKEN = previousSecret;
		}
	});

	it('drains child stdout and stderr into the logger', async () => {
		const child = new FakeChildProcess();
		const logger = {
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		};
		const supervisor = createPortalSubprocessSupervisor({
			binPath: '/x',
			configDir: '/config',
			fetchFn: vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
			host: '127.0.0.1',
			hmacEnv: {},
			logger,
			port: 18_790,
			spawnFn: () => child as unknown as ChildProcess,
		});

		await supervisor.start();
		child.stdout.write('ready\n');
		child.stderr.write('warned\n');
		child.stdout.emit('error', new Error('stdout broke'));
		child.stderr.emit('error', new Error('stderr broke'));

		expect(logger.info).toHaveBeenCalledWith('[mcp-portal stdout] ready');
		expect(logger.warn).toHaveBeenCalledWith('[mcp-portal stderr] warned');
		expect(logger.warn).toHaveBeenCalledWith('[mcp-portal stdout] stream error: stdout broke');
		expect(logger.warn).toHaveBeenCalledWith('[mcp-portal stderr] stream error: stderr broke');
		await supervisor.stop();
	});

	it('polls health until the portal is ready', async () => {
		let attempts = 0;
		const healthUrls: string[] = [];
		const supervisor = createPortalSubprocessSupervisor({
			binPath: '/x',
			configDir: '/config',
			fetchFn: vi.fn(async (url) => {
				healthUrls.push(String(url));
				attempts += 1;
				if (attempts < 3) {
					throw new Error('not ready');
				}
				return new Response(JSON.stringify({ ok: true }));
			}),
			healthPollIntervalMs: 1,
			host: 'localhost',
			hmacEnv: {},
			logger: silentLogger(),
			port: 18_790,
			spawnFn: () => new FakeChildProcess() as unknown as ChildProcess,
		});

		await supervisor.start();

		expect(attempts).toBe(3);
		expect(healthUrls).toEqual([
			'http://localhost:18790/health',
			'http://localhost:18790/health',
			'http://localhost:18790/health',
		]);
		await supervisor.stop();
	});

	it('reports fatal when restart budget is exhausted', async () => {
		const onFatal = vi.fn();
		let healthOk = true;
		const children: FakeChildProcess[] = [];
		const supervisor = createPortalSubprocessSupervisor({
			backoffSteps: [1, 1, 1],
			binPath: '/x',
			configDir: '/config',
			fetchFn: vi.fn(async () => {
				if (!healthOk) {
					throw new Error('not ready');
				}
				return new Response(JSON.stringify({ ok: true }));
			}),
			healthPollIntervalMs: 1,
			healthTimeoutMs: 5,
			host: '127.0.0.1',
			hmacEnv: {},
			logger: silentLogger(),
			maxRestarts: 2,
			onFatal,
			port: 18_790,
			spawnFn: () => {
				const child = new FakeChildProcess();
				children.push(child);
				return child as unknown as ChildProcess;
			},
		});

		await supervisor.start();
		healthOk = false;
		children[0]?.emit('exit', 1, null);
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(onFatal).toHaveBeenCalledWith('backoff-exhausted');
		await supervisor.stop();
	});

	it('resets the restart budget after a restarted subprocess becomes healthy', async () => {
		const onFatal = vi.fn();
		const children: FakeChildProcess[] = [];
		const supervisor = createPortalSubprocessSupervisor({
			backoffSteps: [1],
			binPath: '/x',
			configDir: '/config',
			fetchFn: vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
			host: '127.0.0.1',
			hmacEnv: {},
			logger: silentLogger(),
			maxRestarts: 1,
			onFatal,
			port: 18_790,
			spawnFn: () => {
				const child = new FakeChildProcess();
				children.push(child);
				return child as unknown as ChildProcess;
			},
		});

		await supervisor.start();
		children[0]?.emit('exit', 1, null);
		await new Promise((resolve) => setTimeout(resolve, 20));
		children[1]?.emit('exit', 1, null);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(children).toHaveLength(3);
		expect(onFatal).not.toHaveBeenCalled();
		await supervisor.stop();
	});

	it('rejects start with the spawn error instead of a health timeout', async () => {
		const onFatal = vi.fn();
		const logger = {
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		};
		const supervisor = createPortalSubprocessSupervisor({
			backoffSteps: [1],
			binPath: '/missing',
			configDir: '/config',
			fetchFn: vi.fn(async () => {
				throw new Error('health should not win');
			}),
			healthPollIntervalMs: 1,
			healthTimeoutMs: 100,
			host: '127.0.0.1',
			hmacEnv: {},
			logger,
			maxRestarts: 1,
			onFatal,
			port: 18_790,
			spawnFn: () => {
				const child = new FakeChildProcess();
				queueMicrotask(() => child.emit('error', new Error('ENOENT')));
				return child as unknown as ChildProcess;
			},
		});

		await expect(supervisor.start()).rejects.toThrow('ENOENT');

		expect(logger.error).toHaveBeenCalledWith('[mcp-portal] subprocess spawn failed: ENOENT');
		expect(onFatal).not.toHaveBeenCalled();
		await supervisor.stop();
	});
});
