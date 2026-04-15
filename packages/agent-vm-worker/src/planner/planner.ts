import type {
	ExecutorResult,
	StructuredInput,
	WorkExecutor,
} from '../work-executor/executor-interface.js';

export interface PlanResult {
	readonly plan: string;
	readonly threadId: string;
	readonly tokenCount: number;
}

export interface Planner {
	plan(input: readonly StructuredInput[]): Promise<PlanResult>;
	revise(input: readonly StructuredInput[]): Promise<PlanResult>;
	getThreadId(): string | null;
}

function toPlanResult(result: ExecutorResult): PlanResult {
	return {
		plan: result.response,
		threadId: result.threadId,
		tokenCount: result.tokenCount,
	};
}

export function createPlanner(executor: WorkExecutor): Planner {
	return {
		async plan(input: readonly StructuredInput[]): Promise<PlanResult> {
			return toPlanResult(await executor.execute(input));
		},

		async revise(input: readonly StructuredInput[]): Promise<PlanResult> {
			return toPlanResult(await executor.fix(input));
		},

		getThreadId(): string | null {
			return executor.getThreadId();
		},
	};
}
