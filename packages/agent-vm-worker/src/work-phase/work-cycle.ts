/* oxlint-disable eslint/no-await-in-loop -- cycle turns are stateful and sequential */
import { z } from 'zod';

import type { WorkCycleConfig } from '../config/worker-config.js';
import {
	buildInitialWorkMessage,
	buildWorkReviewMessage,
	buildWorkReviseMessage,
} from '../prompt/message-builders.js';
import { reviewResultSchema, type ReviewResult } from '../shared/review-result.js';
import { writeStderr } from '../shared/stderr.js';
import {
	verificationCommandResultSchema,
	type VerificationCommandResult,
} from '../state/task-event-types.js';
import type { VerificationCommand } from '../validation-runner/verification-runner.js';
import type {
	PersistentThread,
	PersistentThreadResponse,
} from '../work-executor/persistent-thread.js';

export interface RunWorkCycleProps {
	readonly spec: string;
	readonly plan: string;
	readonly planReview: ReviewResult | null;
	readonly validationCommandList: readonly VerificationCommand[];
	readonly cycle: WorkCycleConfig;
	readonly workThread: PersistentThread;
	readonly reviewThread: PersistentThread;
	readonly systemPromptWorkAgent: string;
	readonly systemPromptWorkReviewer: string;
	readonly getDiff: () => Promise<string>;
	readonly onWorkAgentTurn: (
		cycle: number,
		result: PersistentThreadResponse,
	) => void | Promise<void>;
	readonly onWorkReviewerTurn: (
		cycle: number,
		result: PersistentThreadResponse,
		review: ReviewResult,
		validationResults: readonly VerificationCommandResult[],
		validationSkipped: boolean,
	) => void | Promise<void>;
	/** Abort signal from the coordinator; when set, cycle stops after the current turn. */
	readonly isClosed?: () => boolean;
}

export interface WorkCycleResult {
	readonly review: ReviewResult;
	readonly validationResults: readonly VerificationCommandResult[];
	readonly validationSkipped: boolean;
}

interface WorkReviewPayload {
	readonly review: ReviewResult;
	readonly validationResults: readonly VerificationCommandResult[];
	readonly validationSkipped: boolean;
}

const runValidationToolEnvelopeSchema = z
	.array(
		z.object({
			tool: z.literal('run_validation'),
			result: z.array(verificationCommandResultSchema),
		}),
	)
	.length(1);
const nestedValidationResultsSchema = z.array(z.array(verificationCommandResultSchema)).length(1);

const REVIEWER_NUDGE =
	'You did not call run_validation in the previous turn because validationResults was empty. Call it now, include the results in validationResults, and return the same JSON schema.';
const MALFORMED_REVIEW_NUDGE =
	'Your previous review response did not match the required JSON schema. Return valid JSON with approved, summary, comments, and validationResults. Every comment must include file, severity, and comment.';

function firstTurn(systemPrompt: string, userMessage: string): string {
	return `# System\n${systemPrompt}\n\n# Task\n${userMessage}`;
}

function parseWorkReview(response: string): WorkReviewPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(response);
	} catch (error) {
		throw new Error(`work-reviewer response is not valid JSON. Raw: ${response.slice(0, 200)}`, {
			cause: error,
		});
	}

	const reviewResult = reviewResultSchema.safeParse(parsed);
	if (!reviewResult.success) {
		throw new Error(
			`work-reviewer response does not match ReviewResult schema: ${reviewResult.error.message}. Raw: ${response.slice(0, 200)}`,
		);
	}

	const rawValidationResults =
		typeof parsed === 'object' && parsed !== null && 'validationResults' in parsed
			? parsed.validationResults
			: [];
	const envelopeParse = runValidationToolEnvelopeSchema.safeParse(rawValidationResults);
	const nestedParse = nestedValidationResultsSchema.safeParse(rawValidationResults);
	const normalizedValidationResults = envelopeParse.success
		? (envelopeParse.data[0]?.result ?? [])
		: nestedParse.success
			? (nestedParse.data[0] ?? [])
			: rawValidationResults;
	const validationResultsParse = z
		.array(verificationCommandResultSchema)
		.safeParse(normalizedValidationResults);
	if (!validationResultsParse.success) {
		throw new Error(
			`work-reviewer response has malformed validationResults: ${validationResultsParse.error.message}. Raw: ${response.slice(0, 200)}`,
		);
	}

	return {
		review: reviewResult.data,
		validationResults: validationResultsParse.data,
		validationSkipped: false,
	};
}

export async function runWorkCycle(props: RunWorkCycleProps): Promise<WorkCycleResult> {
	const initialResponse = await props.workThread.send(
		firstTurn(
			props.systemPromptWorkAgent,
			buildInitialWorkMessage({
				spec: props.spec,
				plan: props.plan,
				planReview: props.planReview,
				validationCommandList: props.validationCommandList,
			}),
		),
	);
	await props.onWorkAgentTurn(0, initialResponse);

	let lastReview: WorkReviewPayload | null = null;
	const cycleCount = props.cycle.cycleCount;

	for (let cycle = 1; cycle <= cycleCount; cycle += 1) {
		if (props.isClosed?.()) {
			break;
		}

		const reviewMessage = buildWorkReviewMessage({
			spec: props.spec,
			plan: props.plan,
			diff: await props.getDiff(),
			cycle,
			validationCommandList: props.validationCommandList,
		});
		let reviewResponse = await props.reviewThread.send(
			cycle === 1 ? firstTurn(props.systemPromptWorkReviewer, reviewMessage) : reviewMessage,
		);
		let parsedReview: WorkReviewPayload;
		try {
			parsedReview = parseWorkReview(reviewResponse.response);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes('does not match ReviewResult schema')) {
				throw error;
			}
			writeStderr(
				`[work-cycle] reviewer cycle ${String(cycle)} returned malformed review JSON; nudging once: ${
					message
				}`,
			);
			reviewResponse = await props.reviewThread.send(MALFORMED_REVIEW_NUDGE);
			parsedReview = parseWorkReview(reviewResponse.response);
		}

		if (props.validationCommandList.length > 0 && parsedReview.validationResults.length === 0) {
			writeStderr(
				`[work-cycle] reviewer cycle ${String(cycle)} returned empty validationResults; nudging once`,
			);
			reviewResponse = await props.reviewThread.send(REVIEWER_NUDGE);
			parsedReview = parseWorkReview(reviewResponse.response);
			if (parsedReview.validationResults.length === 0) {
				writeStderr(
					`[work-cycle] reviewer cycle ${String(cycle)} returned empty validationResults after nudge; proceeding`,
				);
				parsedReview = { ...parsedReview, validationSkipped: true };
			}
		}

		lastReview = parsedReview;
		await props.onWorkReviewerTurn(
			cycle,
			reviewResponse,
			parsedReview.review,
			parsedReview.validationResults,
			parsedReview.validationSkipped,
		);

		if (props.isClosed?.()) {
			break;
		}

		// Always revise after every review — reviewer feedback always reaches the agent.
		// Cycle = <agent> → review → <agent>; the final state is the revised agent output.
		const reviseResponse = await props.workThread.send(
			buildWorkReviseMessage({
				cycle,
				review: parsedReview.review,
				validationResults: parsedReview.validationResults,
			}),
		);
		await props.onWorkAgentTurn(cycle, reviseResponse);
	}

	if (lastReview === null) {
		throw new Error('runWorkCycle expected at least one review turn.');
	}

	return {
		review: lastReview.review,
		validationResults: lastReview.validationResults,
		validationSkipped: lastReview.validationSkipped,
	};
}
