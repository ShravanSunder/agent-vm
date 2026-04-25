/* oxlint-disable eslint/no-await-in-loop -- cycle turns are stateful and sequential */
import type { PlanCycleConfig } from '../config/worker-config.js';
import {
	buildInitialPlanMessage,
	buildPlanReviewMessage,
	buildPlanReviseMessage,
} from '../prompt/message-builders.js';
import type { RepoLocation } from '../shared/repo-location.js';
import { reviewResultSchema, type ReviewResult } from '../shared/review-result.js';
import type {
	PersistentThread,
	PersistentThreadResponse,
} from '../work-executor/persistent-thread.js';

export interface RunPlanCycleProps {
	readonly spec: string;
	readonly repos: readonly RepoLocation[];
	readonly repoSummary: string | null;
	readonly context: Record<string, unknown>;
	readonly cycle: PlanCycleConfig;
	readonly planThread: PersistentThread;
	/** Required when cycle.kind === 'review'; unused when 'noReview'. */
	readonly reviewThread: PersistentThread | null;
	readonly systemPromptPlanAgent: string;
	/** Required when cycle.kind === 'review'; unused when 'noReview'. */
	readonly systemPromptPlanReviewer: string | null;
	readonly onPlanAgentTurn: (
		cycle: number,
		result: PersistentThreadResponse,
	) => void | Promise<void>;
	readonly onPlanReviewerTurn: (
		cycle: number,
		result: PersistentThreadResponse,
		review: ReviewResult,
	) => void | Promise<void>;
	/** Abort signal from the coordinator; when set, cycle stops after the current turn. */
	readonly isClosed?: () => boolean;
}

export interface PlanCycleResult {
	readonly plan: string;
	readonly review: ReviewResult | null;
}

function firstTurn(systemPrompt: string, userMessage: string): string {
	return `# System\n${systemPrompt}\n\n# Task\n${userMessage}`;
}

function parsePlan(response: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(response);
	} catch (error) {
		throw new Error(`plan-agent response is not valid JSON. Raw: ${response.slice(0, 200)}`, {
			cause: error,
		});
	}

	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('plan' in parsed) ||
		typeof parsed.plan !== 'string'
	) {
		throw new Error(
			`plan-agent response missing string plan field. Raw: ${response.slice(0, 200)}`,
		);
	}

	return parsed.plan;
}

function parseReview(response: string): ReviewResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(response);
	} catch (error) {
		throw new Error(`plan-reviewer response is not valid JSON. Raw: ${response.slice(0, 200)}`, {
			cause: error,
		});
	}

	const result = reviewResultSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			`plan-reviewer response does not match ReviewResult schema: ${result.error.message}. Raw: ${response.slice(0, 200)}`,
		);
	}
	return result.data;
}

export async function runPlanCycle(props: RunPlanCycleProps): Promise<PlanCycleResult> {
	const initialMessage = buildInitialPlanMessage({
		spec: props.spec,
		repos: props.repos,
		repoSummary: props.repoSummary,
		context: props.context,
	});
	const initialResponse = await props.planThread.send(
		firstTurn(props.systemPromptPlanAgent, initialMessage),
	);
	await props.onPlanAgentTurn(0, initialResponse);
	let currentPlan = parsePlan(initialResponse.response);

	// kind === 'noReview': agent only. No reviewer thread used.
	if (props.cycle.kind === 'noReview') {
		return { plan: currentPlan, review: null };
	}

	if (props.reviewThread === null || props.systemPromptPlanReviewer === null) {
		throw new Error(
			'runPlanCycle: kind="review" requires reviewThread and systemPromptPlanReviewer',
		);
	}
	const reviewThread = props.reviewThread;
	const systemPromptReviewer = props.systemPromptPlanReviewer;

	const cycleCount = props.cycle.cycleCount;
	let lastReview: ReviewResult | null = null;

	for (let cycle = 1; cycle <= cycleCount; cycle += 1) {
		if (props.isClosed?.()) {
			return { plan: currentPlan, review: lastReview };
		}

		const reviewMessage = buildPlanReviewMessage({
			spec: props.spec,
			plan: currentPlan,
			cycle,
		});
		const reviewResponse = await reviewThread.send(
			cycle === 1 ? firstTurn(systemPromptReviewer, reviewMessage) : reviewMessage,
		);
		lastReview = parseReview(reviewResponse.response);
		await props.onPlanReviewerTurn(cycle, reviewResponse, lastReview);

		if (props.isClosed?.()) {
			return { plan: currentPlan, review: lastReview };
		}

		// Always revise after every review — reviewer feedback always reaches the agent.
		const reviseResponse = await props.planThread.send(
			buildPlanReviseMessage({ cycle, review: lastReview }),
		);
		await props.onPlanAgentTurn(cycle, reviseResponse);
		currentPlan = parsePlan(reviseResponse.response);
	}

	return { plan: currentPlan, review: lastReview };
}
