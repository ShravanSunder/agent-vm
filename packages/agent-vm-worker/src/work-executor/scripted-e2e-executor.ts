import { randomUUID } from 'node:crypto';

import type {
	ExecutorCapabilities,
	ExecutorResult,
	StructuredInput,
	ToolDefinition,
	WorkExecutor,
} from './executor-interface.js';

export const SCRIPTED_E2E_EXECUTOR_ENV_NAME = 'AGENT_VM_WORKER_SCRIPTED_E2E_EXECUTOR';
export const SCRIPTED_E2E_EXECUTOR_PROVIDER = 'scripted-e2e';

interface ScriptedE2eExecutorConfig {
	readonly capabilities: ExecutorCapabilities;
}

function inputToText(input: readonly StructuredInput[]): string {
	return input
		.map((item) => {
			switch (item.type) {
				case 'text':
					return item.text;
				case 'skill':
					return `[Skill: ${item.name}]\n${item.content}`;
				default: {
					const exhaustiveItem: never = item;
					return exhaustiveItem;
				}
			}
		})
		.join('\n\n');
}

function findTool(
	tools: readonly ToolDefinition[],
	toolName: 'git-push' | 'git-pull-default' | 'run_validation',
): ToolDefinition | undefined {
	return tools.find((tool) => tool.name === toolName);
}

function buildExecutorResult(threadId: string, response: string): ExecutorResult {
	return {
		response,
		threadId,
		tokenCount: 0,
	};
}

function buildApprovedReviewJson(): string {
	return JSON.stringify({
		approved: true,
		comments: [],
		summary: 'scripted e2e reviewer approved the deterministic worker-control path.',
		validationResults: [],
	});
}

function assertToolResultSucceeded(toolName: string, result: unknown): void {
	if (typeof result !== 'object' || result === null || !('success' in result)) {
		throw new Error(`${toolName} returned a malformed result: ${JSON.stringify(result)}`);
	}
	if (result.success !== true) {
		throw new Error(`${toolName} failed: ${JSON.stringify(result)}`);
	}
}

async function runWorkerControlGitTools(
	tools: readonly ToolDefinition[],
): Promise<Readonly<Record<string, unknown>>> {
	const gitPushTool = findTool(tools, 'git-push');
	const gitPullDefaultTool = findTool(tools, 'git-pull-default');
	if (gitPushTool === undefined || gitPullDefaultTool === undefined) {
		throw new Error('scripted-e2e executor expected git-push and git-pull-default tools.');
	}

	const gitPush = await gitPushTool.execute({});
	assertToolResultSucceeded('git-push', gitPush);
	const gitPullDefault = await gitPullDefaultTool.execute({});
	assertToolResultSucceeded('git-pull-default', gitPullDefault);
	return {
		gitPullDefault,
		gitPush,
	};
}

export function createScriptedE2eExecutor(config: ScriptedE2eExecutorConfig): WorkExecutor {
	const threadId = `scripted-e2e-${randomUUID()}`;
	let workAgentToolResults: Readonly<Record<string, unknown>> | null = null;

	async function respond(input: readonly StructuredInput[]): Promise<ExecutorResult> {
		const text = inputToText(input);
		const tools = config.capabilities.tools;
		const hasWorkerControlGitTools =
			findTool(tools, 'git-push') !== undefined &&
			findTool(tools, 'git-pull-default') !== undefined;
		const hasValidationTool = findTool(tools, 'run_validation') !== undefined;

		if (text.includes('# Required output JSON')) {
			return buildExecutorResult(
				threadId,
				JSON.stringify({
					branchName: 'agent/scripted-e2e',
					prUrl: null,
					pushedCommits: [],
					summary: 'scripted e2e wrapup completed after worker-control git RPC tools ran.',
				}),
			);
		}

		if (text.includes('Summarize in detail the work')) {
			return buildExecutorResult(
				threadId,
				JSON.stringify({
					commits: [],
					filesChanged: [],
					knownRisks: [],
					reviewNotes: 'scripted e2e worker-control git RPC proof',
					suggestedPrBody: 'scripted e2e proof only',
					suggestedPrTitle: 'scripted e2e worker-control git RPC proof',
					summary: `worker-control git RPC results: ${JSON.stringify(workAgentToolResults)}`,
					validation: 'no validation commands configured for scripted e2e',
				}),
			);
		}

		if (hasWorkerControlGitTools) {
			if (workAgentToolResults !== null) {
				return buildExecutorResult(
					threadId,
					`scripted e2e worker-control git RPC already ran: ${JSON.stringify(workAgentToolResults)}`,
				);
			}
			workAgentToolResults = await runWorkerControlGitTools(tools);
			return buildExecutorResult(
				threadId,
				`scripted e2e worker-control git RPC results: ${JSON.stringify(workAgentToolResults)}`,
			);
		}

		if (hasValidationTool) {
			return buildExecutorResult(threadId, buildApprovedReviewJson());
		}

		return buildExecutorResult(
			threadId,
			JSON.stringify({
				plan: 'Run the deterministic scripted e2e worker-control git RPC proof.',
			}),
		);
	}

	return {
		execute: respond,
		fix: respond,
		getThreadId(): string {
			return threadId;
		},
		async resumeOrRebuild(_threadId, _context): Promise<void> {
			return;
		},
	};
}
