import { describe, expect, it, vi } from 'vitest';

import type { OpenClawToolRegistration } from './openclaw-sandbox-sdk-contract.js';
import { registerZoneGitTool } from './zone-git-tool.js';

describe('registerZoneGitTool', () => {
	it('registers zone_git_push when OpenClaw exposes registerTool', () => {
		const registerTool = vi.fn();

		registerZoneGitTool({
			api: { registerTool },
			controllerUrl: 'http://127.0.0.1:18800',
			zoneId: 'sunfam',
		});

		expect(registerTool).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringContaining('Push committed OpenClaw zone workspace changes'),
				name: 'zone_git_push',
				parameters: expect.objectContaining({ type: 'object' }),
			}),
			{ name: 'zone_git_push', optional: true },
		);
	});

	it('executes push through the controller endpoint', async () => {
		let registeredTool: OpenClawToolRegistration | undefined;
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true })));

		registerZoneGitTool({
			api: {
				registerTool: (tool) => {
					registeredTool = tool;
				},
			},
			controllerUrl: 'http://127.0.0.1:18800/',
			fetchImpl,
			zoneGitToken: 'push-token',
			zoneId: 'sunfam',
		});

		if (!registeredTool) {
			throw new Error('Expected zone_git_push tool to be registered.');
		}
		await expect(
			registeredTool.execute('tool-call-1', { expectedHead: 'abc123' }),
		).resolves.toEqual({
			content: JSON.stringify({ success: true }),
			details: { success: true },
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			'http://127.0.0.1:18800/zones/sunfam/zone-git/push',
			expect.objectContaining({
				body: JSON.stringify({ expectedHead: 'abc123' }),
				headers: {
					'content-type': 'application/json',
					'x-agent-vm-zone-git-token': 'push-token',
				},
				method: 'POST',
			}),
		);
	});

	it('passes an AbortSignal through the bounded controller request policy', async () => {
		let registeredTool: OpenClawToolRegistration | undefined;
		let signal: AbortSignal | undefined;
		const fetchImpl = vi.fn(async (_input, init) => {
			signal = init?.signal ?? undefined;
			return new Response(JSON.stringify({ success: true }));
		});

		registerZoneGitTool({
			api: {
				registerTool: (tool) => {
					registeredTool = tool;
				},
			},
			controllerUrl: 'http://127.0.0.1:18800',
			fetchImpl,
			zoneId: 'sunfam',
		});

		if (!registeredTool) {
			throw new Error('Expected zone_git_push tool to be registered.');
		}
		await registeredTool.execute('tool-call-1', { expectedHead: 'abc123' });

		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it('throws controller error payloads from failed pushes', async () => {
		let registeredTool: OpenClawToolRegistration | undefined;
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: 'zone git rejected push' }), {
					status: 409,
				}),
		);

		registerZoneGitTool({
			api: {
				registerTool: (tool) => {
					registeredTool = tool;
				},
			},
			controllerUrl: 'http://127.0.0.1:18800',
			fetchImpl,
			zoneId: 'sunfam',
		});

		if (!registeredTool) {
			throw new Error('Expected zone_git_push tool to be registered.');
		}
		await expect(registeredTool.execute('tool-call-1', { expectedHead: 'abc123' })).rejects.toThrow(
			'zone_git_push failed: 409 {"error":"zone git rejected push"}',
		);
		expect(fetchImpl).toHaveBeenCalledWith(
			'http://127.0.0.1:18800/zones/sunfam/zone-git/push',
			expect.objectContaining({
				body: JSON.stringify({ expectedHead: 'abc123' }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			}),
		);
	});

	it('rejects missing expectedHead before calling the controller', async () => {
		let registeredTool: OpenClawToolRegistration | undefined;
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true })));

		registerZoneGitTool({
			api: {
				registerTool: (tool) => {
					registeredTool = tool;
				},
			},
			controllerUrl: 'http://127.0.0.1:18800',
			fetchImpl,
			zoneId: 'sunfam',
		});

		if (!registeredTool) {
			throw new Error('Expected zone_git_push tool to be registered.');
		}
		await expect(registeredTool.execute('tool-call-1', {})).rejects.toThrow(
			'zone_git_push requires expectedHead.',
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('reports non-JSON controller success responses clearly', async () => {
		let registeredTool: OpenClawToolRegistration | undefined;
		const fetchImpl = vi.fn(async () => new Response('not json'));

		registerZoneGitTool({
			api: {
				registerTool: (tool) => {
					registeredTool = tool;
				},
			},
			controllerUrl: 'http://127.0.0.1:18800',
			fetchImpl,
			zoneId: 'sunfam',
		});

		if (!registeredTool) {
			throw new Error('Expected zone_git_push tool to be registered.');
		}
		await expect(registeredTool.execute('tool-call-1', { expectedHead: 'abc123' })).rejects.toThrow(
			'zone_git_push returned non-JSON response: not json',
		);
	});
});
