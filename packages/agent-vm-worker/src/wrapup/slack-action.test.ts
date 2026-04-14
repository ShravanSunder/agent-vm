import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSlackToolDefinition } from './slack-action.js';

describe('slack-action', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('posts a message to the configured webhook', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('ok', { status: 200 }));

		const tool = createSlackToolDefinition({
			webhookUrl: 'https://hooks.slack.com/services/test',
			channel: '#engineering',
		});
		const result = await tool.execute({ message: 'done' });

		expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.com/services/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: 'done', channel: '#engineering' }),
		});
		expect(result).toEqual({
			type: 'slack-post',
			success: true,
			artifact: 'Message posted successfully.',
		});
	});

	it('returns a failure artifact when the webhook returns an error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
		);

		const tool = createSlackToolDefinition({
			webhookUrl: 'https://hooks.slack.com/services/test',
		});

		await expect(tool.execute({ message: 'done' })).resolves.toEqual({
			type: 'slack-post',
			success: false,
			artifact: 'Slack webhook returned 403: Forbidden',
		});
	});
});
