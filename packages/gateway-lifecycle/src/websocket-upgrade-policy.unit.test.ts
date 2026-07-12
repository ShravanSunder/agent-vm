import { describe, expect, it } from 'vitest';

import { createWebSocketUpgradeRequestGuard } from './websocket-upgrade-policy.js';

describe('createWebSocketUpgradeRequestGuard', () => {
	it('does not restrict non-websocket requests', async () => {
		const guard = createWebSocketUpgradeRequestGuard({
			rules: [
				{
					audience: 'gateway',
					host: 'gateway.discord.gg',
					path: '/',
					port: 443,
					scheme: 'wss',
				},
			],
			runtimeAudience: 'gateway',
		});

		const result = await guard(new Request('https://gateway.discord.gg/api/v10/gateway/bot'));

		expect(result).toBeUndefined();
	});

	it('allows matching secure websocket upgrade requests', async () => {
		const guard = createWebSocketUpgradeRequestGuard({
			rules: [
				{
					audience: 'gateway',
					host: 'gateway-*.discord.gg',
					path: '/',
					port: 443,
					scheme: 'wss',
				},
			],
			runtimeAudience: 'gateway',
		});

		const result = await guard(
			new Request('https://gateway-us-east1-c.discord.gg/?v=10&encoding=json', {
				headers: {
					Connection: 'Upgrade',
					Upgrade: 'websocket',
				},
			}),
		);

		expect(result).toBeUndefined();
	});

	it('blocks websocket upgrade requests that miss the configured URL policy', async () => {
		const guard = createWebSocketUpgradeRequestGuard({
			rules: [
				{
					audience: 'gateway',
					host: 'gateway.discord.gg',
					path: '/',
					port: 443,
					scheme: 'wss',
				},
			],
			runtimeAudience: 'gateway',
		});

		const result = await guard(
			new Request('https://evil.discord.gg/?v=10&encoding=json', {
				headers: {
					Connection: 'Upgrade',
					Upgrade: 'websocket',
				},
			}),
		);

		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(403);
	});

	it('blocks websocket upgrade requests with a non-matching path', async () => {
		const guard = createWebSocketUpgradeRequestGuard({
			rules: [
				{
					audience: 'gateway',
					host: 'gateway.discord.gg',
					path: '/',
					port: 443,
					scheme: 'wss',
				},
			],
			runtimeAudience: 'gateway',
		});

		const result = await guard(
			new Request('https://gateway.discord.gg/socket', {
				headers: {
					Connection: 'Upgrade',
					Upgrade: 'websocket',
				},
			}),
		);

		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(403);
	});

	it('uses the secure websocket default port when a rule omits port', async () => {
		const guard = createWebSocketUpgradeRequestGuard({
			rules: [
				{
					audience: 'gateway',
					host: 'gateway.discord.gg',
					scheme: 'wss',
				},
			],
			runtimeAudience: 'gateway',
		});

		const defaultPortResult = await guard(
			new Request('https://gateway.discord.gg/?v=10&encoding=json', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		const nonDefaultPortResult = await guard(
			new Request('https://gateway.discord.gg:8443/?v=10&encoding=json', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);

		expect(defaultPortResult).toBeUndefined();
		expect(nonDefaultPortResult).toBeInstanceOf(Response);
		expect((nonDefaultPortResult as Response).status).toBe(403);
	});

	it('uses the websocket default port when a rule omits port', async () => {
		const guard = createWebSocketUpgradeRequestGuard({
			rules: [
				{
					audience: 'gateway',
					host: 'local-websocket.test',
					scheme: 'ws',
				},
			],
			runtimeAudience: 'gateway',
		});

		const defaultPortResult = await guard(
			new Request('http://local-websocket.test/socket', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		const nonDefaultPortResult = await guard(
			new Request('http://local-websocket.test:8080/socket', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);

		expect(defaultPortResult).toBeUndefined();
		expect(nonDefaultPortResult).toBeInstanceOf(Response);
		expect((nonDefaultPortResult as Response).status).toBe(403);
	});
});
