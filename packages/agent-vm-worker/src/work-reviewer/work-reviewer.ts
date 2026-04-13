import { reviewResultSchema, type ReviewResult } from '../shared/review-result.js';
import type { StructuredInput, WorkExecutor } from '../work-executor/executor-interface.js';
import type { VerificationCommandResult } from './verification-runner.js';
import {
	allVerificationsPassed,
	runVerification,
	type RunVerificationOptions,
} from './verification-runner.js';

export interface WorkReviewInput {
	readonly reviewPrompt: readonly StructuredInput[];
	readonly verificationOptions: RunVerificationOptions;
}

export interface WorkReviewResult {
	readonly verificationResults: readonly VerificationCommandResult[];
	readonly verificationPassed: boolean;
	readonly review: ReviewResult | null;
}

export async function reviewWork(
	reviewExecutor: WorkExecutor,
	input: WorkReviewInput,
): Promise<WorkReviewResult> {
	const verificationResults = await runVerification(input.verificationOptions);
	const verificationPassed = allVerificationsPassed(verificationResults);

	if (!verificationPassed) {
		return {
			verificationResults,
			verificationPassed: false,
			review: null,
		};
	}

	const response = (await reviewExecutor.execute(input.reviewPrompt)).response;
	let parsed: unknown;
	try {
		parsed = JSON.parse(response);
	} catch {
		throw new Error(`Review response is not valid JSON. Raw: ${response.slice(0, 200)}`);
	}

	const parseResult = reviewResultSchema.safeParse(parsed);
	if (!parseResult.success) {
		throw new Error(
			`Review JSON doesn't match schema: ${parseResult.error.message}. Raw: ${response.slice(0, 200)}`,
		);
	}

	return {
		verificationResults,
		verificationPassed: true,
		review: parseResult.data,
	};
}
