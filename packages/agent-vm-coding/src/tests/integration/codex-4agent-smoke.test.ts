/**
 * 4-agent Codex smoke test
 *
 * Uses REAL Codex SDK with the 4-agent coordinator.
 * Requires CODEX_API_KEY env var — skipped without it.
 *
 * What's REAL: planner, plan-reviewer, coder, code-reviewer (all Codex SDK)
 * What's MOCKED: git push, PR creation (no remote needed)
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach, vi } from 'vitest';

import { createCodeReviewerAgent } from '../../agents/code-reviewer/code-reviewer-agent.js';
import { createCoderAgent } from '../../agents/coder/coder-agent.js';
import { createCodexClientFromSdk } from '../../agents/codex-client-factory.js';
import { createPlanReviewerAgent } from '../../agents/plan-reviewer/plan-reviewer-agent.js';
import { createPlannerAgent } from '../../agents/planner/planner-agent.js';
import { createCoordinator } from '../../coordinator/coordinator.js';
import { createGatewayConfigFixture } from '../support/task-fixtures.js';

vi.mock('../../git/git-operations.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../git/git-operations.js')>();
	return {
		...actual,
		configureGit: vi.fn(async (): Promise<void> => undefined),
		createBranch: vi.fn(async (): Promise<void> => undefined),
		stageAndCommit: vi.fn(async (): Promise<void> => undefined),
		pushBranch: vi.fn(async (): Promise<void> => undefined),
		createPullRequest: vi.fn(async (): Promise<string> => 'https://github.com/test/repo/pull/99'),
	};
});

const hasApiKey = Boolean(process.env['CODEX_API_KEY']);

describe.skipIf(!hasApiKey)('4-agent Codex smoke test (requires CODEX_API_KEY)', () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs) {
			await rm(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	it('should complete plan + implement cycle with real Codex and reach awaiting-followup', async () => {
		const baseDir = await mkdtemp(join(tmpdir(), 'codex-4agent-smoke-'));
		const workspaceDir = join(baseDir, 'workspace');
		const stateDir = join(baseDir, 'state');
		tempDirs.push(baseDir);

		await mkdir(workspaceDir, { recursive: true });
		await mkdir(stateDir, { recursive: true });

		// Seed workspace with a simple project
		await writeFile(
			join(workspaceDir, 'package.json'),
			JSON.stringify({ name: 'smoke-test', version: '1.0.0', private: true }, null, 2),
		);
		await writeFile(
			join(workspaceDir, 'sum.js'),
			'function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n',
		);
		await writeFile(
			join(workspaceDir, 'sum.test.js'),
			[
				'const { sum } = require("./sum");',
				'const assert = require("assert");',
				'assert.strictEqual(sum(1, 2), 3);',
				'console.log("All tests passed");',
			].join('\n') + '\n',
		);

		// Create real Codex client and agents
		const apiKey = process.env['CODEX_API_KEY'] ?? '';
		const codexClient = createCodexClientFromSdk(apiKey, workspaceDir);

		const plannerAgent = createPlannerAgent({ model: 'gpt-5.4-mini' }, codexClient);
		const planReviewerAgent = createPlanReviewerAgent({ model: 'gpt-5.4-mini' }, codexClient);
		const coderAgent = createCoderAgent({ model: 'gpt-5.4-mini' }, codexClient);
		const codeReviewerAgent = createCodeReviewerAgent({ model: 'gpt-5.4-mini' }, codexClient);

		const config = createGatewayConfigFixture(stateDir, {
			testCommand: 'node sum.test.js',
			lintCommand: 'true',
			// Empty skills — no skill files on disk in test environment
			plannerSkills: [],
			planReviewerSkills: [],
			coderSkills: [],
			codeReviewerSkills: [],
		});

		const coordinator = createCoordinator({
			plannerAgent,
			planReviewerAgent,
			coderAgent,
			codeReviewerAgent,
			config,
			workspaceDir,
		});

		const { taskId } = await coordinator.submitTask({
			prompt:
				'Add a multiply function to sum.js that takes two numbers and returns their product. Export it. Add a test in sum.test.js: assert.strictEqual(multiply(3, 4), 12).',
			repoUrl: 'test/repo',
			baseBranch: 'main',
			testCommand: 'node sum.test.js',
			lintCommand: 'true',
		});

		// Wait for task to reach a terminal-ish state (max 5 min)
		const start = Date.now();
		const maxWaitMs = 300_000;
		while (Date.now() - start < maxWaitMs) {
			const state = coordinator.getTaskState(taskId);
			if (state?.status === 'awaiting-followup' || state?.status === 'failed') {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		const finalState = coordinator.getTaskState(taskId);
		// eslint-disable-next-line no-console
		console.log(
			`[codex-smoke] task ${taskId}: status=${finalState?.status}, prUrl=${finalState?.prUrl}`,
		);

		// The task should reach awaiting-followup (PR "created" via mock)
		expect(finalState?.status).toBe('awaiting-followup');
		expect(finalState?.prUrl).toBe('https://github.com/test/repo/pull/99');

		// Verify sum.js was actually modified
		const sumContent = readFileSync(join(workspaceDir, 'sum.js'), 'utf-8');
		expect(sumContent).toContain('multiply');

		// Verify tests still pass independently
		const { execa } = await import('execa');
		const testResult = await execa('node', ['sum.test.js'], {
			cwd: workspaceDir,
			reject: false,
		});
		expect(testResult.exitCode).toBe(0);
	}, 300_000);
});
