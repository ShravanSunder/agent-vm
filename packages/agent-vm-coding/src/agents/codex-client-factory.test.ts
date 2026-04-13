import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const sdkThread = {
		id: 'thread-123',
		run: vi.fn(),
	};

	const codexInstance = {
		startThread: vi.fn(() => sdkThread),
		resumeThread: vi.fn(() => sdkThread),
	};

	class Codex {
		startThread = codexInstance.startThread;
		resumeThread = codexInstance.resumeThread;
	}

	return {
		Codex,
		sdkThread,
		codexInstance,
	};
});

vi.mock('@openai/codex-sdk', () => ({
	Codex: mocks.Codex,
}));

import { createCodexClientFromSdk } from './codex-client-factory.js';

describe('codex-client-factory', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.sdkThread.id = 'thread-123';
		mocks.sdkThread.run.mockResolvedValue({
			finalResponse: 'ok',
			usage: { output_tokens: 11 },
		});
	});

	it('maps skill inputs into text instructions for the SDK', async () => {
		const client = createCodexClientFromSdk('api-key', '/workspace');

		const thread = client.startThread({ model: 'gpt-5.4-mini' });
		await thread.run([
			{ type: 'text', text: 'Do the work' },
			{
				type: 'skill',
				name: 'writing-plans',
				path: '~/.agents/skills/writing-plans/SKILL.md',
			},
		]);

		expect(mocks.sdkThread.run).toHaveBeenCalledWith([
			{ type: 'text', text: 'Do the work' },
			{
				type: 'text',
				text: "Load skill 'writing-plans' from ~/.agents/skills/writing-plans/SKILL.md and follow it.",
			},
		]);
	});

	it('configures full-access thread options', () => {
		const client = createCodexClientFromSdk('api-key', '/workspace');

		client.startThread({ model: 'gpt-5.4-mini' });

		expect(mocks.codexInstance.startThread).toHaveBeenCalledWith({
			model: 'gpt-5.4-mini',
			approvalPolicy: 'never',
			sandboxMode: 'danger-full-access',
			workingDirectory: '/workspace',
			networkAccessEnabled: true,
		});
	});
});
