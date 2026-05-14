import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createPortalSubprocessSupervisor } from './portal-subprocess-supervisor.js';

function silentLogger(): { error: () => void; info: () => void; warn: () => void } {
	return { error: () => undefined, info: () => undefined, warn: () => undefined };
}

class FakeChildProcess extends EventEmitter {
	killed = false;

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
	it('spawns the portal binary with config dir, port, and HMAC env', async () => {
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
			spawnFn,
		});

		await supervisor.start();

		expect(spawnFn).toHaveBeenCalledWith(
			'/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server',
			['--config-dir', '/config/gateways/sunclaw'],
			expect.objectContaining({
				env: expect.objectContaining({ PORTAL_HMAC_KEY__shravan: '00'.repeat(32) }),
			}),
		);
		expect(supervisor.isAlive()).toBe(true);
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
		const supervisor = createPortalSubprocessSupervisor({
			backoffSteps: [1, 1, 1],
			binPath: '/x',
			configDir: '/config',
			fetchFn: vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
			host: '127.0.0.1',
			hmacEnv: {},
			logger: silentLogger(),
			maxRestarts: 2,
			onFatal,
			port: 18_790,
			spawnFn: () => new FakeChildProcess(1) as unknown as ChildProcess,
		});

		await supervisor.start();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(onFatal).toHaveBeenCalledWith('backoff-exhausted');
		await supervisor.stop();
	});
});
