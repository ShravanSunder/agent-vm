import { serve } from '@hono/node-server';

import { createCodeReviewerAgent } from './agents/code-reviewer/code-reviewer-agent.js';
import { createCoderAgent } from './agents/coder/coder-agent.js';
import { createCodexClientFromSdk } from './agents/codex-client-factory.js';
import { createPlanReviewerAgent } from './agents/plan-reviewer/plan-reviewer-agent.js';
import { createPlannerAgent } from './agents/planner/planner-agent.js';
import { loadConfig } from './config.js';
import { createCoordinator, type CreateTaskInput } from './coordinator/coordinator.js';
import { createApp } from './server.js';

function writeStdout(message: string): void {
	process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
	const configPath = process.env['CODING_GATEWAY_CONFIG'] ?? '/etc/agent-vm-coding/config.json';
	const config = loadConfig(configPath);
	const apiKey = process.env['CODEX_API_KEY'];

	if (!apiKey) {
		throw new Error('CODEX_API_KEY environment variable is required');
	}

	const workspaceDir = process.env['WORKSPACE_DIR'] ?? '/workspace';
	const codexClient = createCodexClientFromSdk(apiKey, workspaceDir);

	const plannerAgent = createPlannerAgent({ model: config.model }, codexClient);
	const planReviewerAgent = createPlanReviewerAgent({ model: config.reviewModel }, codexClient);
	const coderAgent = createCoderAgent({ model: config.model }, codexClient);
	const codeReviewerAgent = createCodeReviewerAgent({ model: config.reviewModel }, codexClient);

	const coordinator = createCoordinator({
		plannerAgent,
		planReviewerAgent,
		coderAgent,
		codeReviewerAgent,
		config,
		workspaceDir,
	});

	const app = createApp({
		getActiveTaskId: () => coordinator.getActiveTaskId(),
		getTaskState: (taskId: string) => coordinator.getTaskState(taskId),
		submitTask: async (input): Promise<{ taskId: string; status: 'accepted' }> => {
			const taskInput: CreateTaskInput = {
				prompt: input.prompt,
				repoUrl: input.repoUrl,
				baseBranch: input.baseBranch,
				testCommand: input.testCommand,
				lintCommand: input.lintCommand,
			};

			return coordinator.submitTask(taskInput);
		},
		submitFollowup: async (taskId: string, prompt: string) =>
			coordinator.submitFollowup(taskId, prompt),
		closeTask: async (taskId: string) => coordinator.closeTask(taskId),
	});

	const port = Number.parseInt(process.env['PORT'] ?? '8080', 10);
	serve(
		{
			fetch: app.fetch,
			port,
		},
		(info) => {
			writeStdout(`[main] Server listening on http://localhost:${info.port}`);
		},
	);
}

main().catch((error: unknown) => {
	writeStderr(`[main] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
