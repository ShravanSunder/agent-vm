import type { ToolDefinition } from '../work-executor/executor-interface.js';
import type { WrapupActionResult } from './wrapup-types.js';

export interface SlackActionConfig {
	readonly webhookUrl: string;
	readonly channel?: string;
}

export function createSlackToolDefinition(config: SlackActionConfig): ToolDefinition {
	return {
		name: 'slack-post',
		description:
			'Post a message to a Slack channel via webhook. Use for task completion notifications, status updates, or alerts.',
		inputSchema: {
			type: 'object',
			properties: {
				message: {
					type: 'string',
					description: 'The message text to post (supports Slack markdown)',
				},
			},
			required: ['message'],
		},
		execute: async (params: Record<string, unknown>): Promise<WrapupActionResult> => {
			try {
				const message = typeof params.message === 'string' ? params.message : 'Task completed.';
				const payload: Record<string, unknown> = { text: message };
				if (config.channel) {
					payload.channel = config.channel;
				}

				const response = await fetch(config.webhookUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});

				if (!response.ok) {
					return {
						type: 'slack-post',
						success: false,
						artifact: `Slack webhook returned ${response.status}: ${response.statusText}`,
					};
				}

				return {
					type: 'slack-post',
					success: true,
					artifact: 'Message posted successfully.',
				};
			} catch (error) {
				return {
					type: 'slack-post',
					success: false,
					artifact: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}
