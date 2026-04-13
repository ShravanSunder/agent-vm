import { describe, expect, it, vi } from 'vitest';

import type { CodexClient, CodexThread } from '../shared-types.js';
import { createPlanReviewerAgent } from './plan-reviewer-agent.js';

describe('plan-reviewer-agent', () => {
	it('parses a valid JSON review', async () => {
		const thread: CodexThread = {
			run: vi.fn().mockResolvedValue({
				finalResponse: JSON.stringify({
					approved: true,
					comments: [],
					summary: 'Looks good',
				}),
			}),
			getThreadId: vi.fn().mockReturnValue('thread-1'),
		};
		const client: CodexClient = {
			startThread: vi.fn().mockReturnValue(thread),
			resumeThread: vi.fn(),
		};

		const agent = createPlanReviewerAgent({ model: 'gpt-5.4-mini' }, client);
		const result = await agent.review([{ type: 'text', text: 'Review plan' }]);

		expect(result.approved).toBe(true);
		expect(result.summary).toBe('Looks good');
	});

	it('throws when JSON parsing fails', async () => {
		const thread: CodexThread = {
			run: vi.fn().mockResolvedValue({
				finalResponse: 'plain text response',
			}),
			getThreadId: vi.fn().mockReturnValue('thread-1'),
		};
		const client: CodexClient = {
			startThread: vi.fn().mockReturnValue(thread),
			resumeThread: vi.fn(),
		};

		const agent = createPlanReviewerAgent({ model: 'gpt-5.4-mini' }, client);
		await expect(agent.review([{ type: 'text', text: 'Review plan' }])).rejects.toThrow(
			'Review response is not valid JSON',
		);
	});

	it('creates a fresh thread for each review', async () => {
		const thread: CodexThread = {
			run: vi.fn().mockResolvedValue({
				finalResponse: JSON.stringify({
					approved: true,
					comments: [],
					summary: 'Looks good',
				}),
			}),
			getThreadId: vi.fn().mockReturnValue('thread-1'),
		};
		const startThread = vi.fn().mockReturnValue(thread);
		const client: CodexClient = {
			startThread,
			resumeThread: vi.fn(),
		};

		const agent = createPlanReviewerAgent({ model: 'gpt-5.4-mini' }, client);
		await agent.review([{ type: 'text', text: 'First review' }]);
		await agent.review([{ type: 'text', text: 'Second review' }]);

		expect(startThread).toHaveBeenCalledTimes(2);
	});
});
