import { describe, expect, it } from 'vitest';

import type {
	ExecutorResult,
	StructuredInput,
	WorkExecutor,
} from '../work-executor/executor-interface.js';
import { createPlanner } from './planner.js';

function createMockExecutor(overrides?: {
	readonly executeResponse?: string;
	readonly fixResponse?: string;
}): WorkExecutor & {
	readonly executeCalls: StructuredInput[][];
	readonly fixCalls: StructuredInput[][];
} {
	const executeCalls: StructuredInput[][] = [];
	const fixCalls: StructuredInput[][] = [];
	let threadId: string | null = null;

	return {
		async execute(input: readonly StructuredInput[]): Promise<ExecutorResult> {
			executeCalls.push([...input]);
			threadId = 'planner-thread-1';
			return {
				response: overrides?.executeResponse ?? 'Plan v1',
				tokenCount: 100,
				threadId,
			};
		},
		async fix(input: readonly StructuredInput[]): Promise<ExecutorResult> {
			fixCalls.push([...input]);
			return {
				response: overrides?.fixResponse ?? 'Plan v2 (revised)',
				tokenCount: 80,
				threadId: threadId ?? 'planner-thread-1',
			};
		},
		async resumeOrRebuild(): Promise<void> {},
		getThreadId(): string | null {
			return threadId;
		},
		executeCalls,
		fixCalls,
	};
}

describe('planner', () => {
	it('plan() calls executor.execute() and returns plan result', async () => {
		const executor = createMockExecutor({ executeResponse: 'Step 1: do X' });
		const planner = createPlanner(executor);

		const result = await planner.plan([{ type: 'text', text: 'Create a plan' }]);

		expect(result.plan).toBe('Step 1: do X');
		expect(result.threadId).toBe('planner-thread-1');
		expect(result.tokenCount).toBe(100);
		expect(executor.executeCalls).toHaveLength(1);
	});

	it('revise() calls executor.fix() to continue the same thread', async () => {
		const executor = createMockExecutor({ fixResponse: 'Revised plan with more detail' });
		const planner = createPlanner(executor);

		await planner.plan([{ type: 'text', text: 'Create a plan' }]);
		const revised = await planner.revise([{ type: 'text', text: 'Add more detail' }]);

		expect(revised.plan).toBe('Revised plan with more detail');
		expect(executor.fixCalls).toHaveLength(1);
	});

	it('getThreadId() returns the executor thread ID', async () => {
		const executor = createMockExecutor();
		const planner = createPlanner(executor);

		expect(planner.getThreadId()).toBeNull();
		await planner.plan([{ type: 'text', text: 'plan' }]);
		expect(planner.getThreadId()).toBe('planner-thread-1');
	});
});
