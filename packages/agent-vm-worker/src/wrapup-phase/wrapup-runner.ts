import { z } from 'zod';

import type { VerificationCommandResult } from '../state/task-event-types.js';
import type {
	PersistentThread,
	PersistentThreadResponse,
} from '../work-executor/persistent-thread.js';

const wrapupFinalAnswerSchema = z.object({
	summary: z.string(),
	prUrl: z.string().url().nullable().optional(),
	branchName: z.string().nullable().optional(),
	pushedCommits: z.array(z.string()).default([]),
});

export type WrapupFinalAnswer = z.infer<typeof wrapupFinalAnswerSchema>;

const WRAPUP_RESPONSE_PREVIEW_LENGTH = 300;
const FALLBACK_SUMMARY_LENGTH = 2_000;

export interface RunWrapupProps {
	readonly wrapupThread: PersistentThread;
	readonly systemPromptWrapup: string;
	readonly spec: string;
	readonly plan: string;
	readonly workSummary: string;
	readonly gitContext: string;
	readonly validationResults: readonly VerificationCommandResult[];
	readonly validationSkipped: boolean;
	readonly onWrapupTurn: (result: PersistentThreadResponse) => void | Promise<void>;
}

export interface WrapupRunResult {
	readonly summary: string;
	readonly prUrl: string | null;
	readonly branchName: string | null;
	readonly pushedCommits: readonly string[];
}

function buildWrapupMessage(props: RunWrapupProps): string {
	return [
		`# System\n${props.systemPromptWrapup}`,
		`# Original task\n${props.spec}`,
		`# Final plan\n${props.plan}`,
		`# Work-agent summary\n${props.workSummary}`,
		`# Controller/git context\n${props.gitContext}`,
		`# Validation results\n${JSON.stringify(props.validationResults, null, 2)}`,
		`# Validation skipped\n${String(props.validationSkipped)}`,
		'# Required output JSON',
		'{ "summary": "...", "prUrl": "https://github.com/org/repo/pull/123 or null", "branchName": "agent/name or null", "pushedCommits": ["sha"] }',
	].join('\n\n');
}

function parseWrapupFinalAnswer(
	response: string,
):
	| { readonly success: true; readonly value: WrapupRunResult }
	| { readonly success: false; readonly error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: `wrapup agent response is not valid JSON: ${message}`,
		};
	}

	const result = wrapupFinalAnswerSchema.safeParse(parsed);
	if (!result.success) {
		return {
			success: false,
			error: `wrapup agent response does not match schema: ${result.error.message}`,
		};
	}
	return {
		success: true,
		value: {
			summary: result.data.summary,
			prUrl: result.data.prUrl ?? null,
			branchName: result.data.branchName ?? null,
			pushedCommits: result.data.pushedCommits,
		},
	};
}

function buildWrapupJsonRepairMessage(error: string, rawResponse: string): string {
	return [
		'Your previous wrapup response could not be parsed by the controller.',
		`Parse error: ${error}`,
		`Previous response preview: ${rawResponse.slice(0, WRAPUP_RESPONSE_PREVIEW_LENGTH)}`,
		'Return only valid JSON with this exact shape:',
		'{ "summary": "what was done", "prUrl": "https://github.com/org/repo/pull/123 or null", "branchName": "agent/name or null", "pushedCommits": ["sha"] }',
	].join('\n\n');
}

function extractPullRequestUrl(response: string): string | null {
	const match = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/u.exec(
		response,
	);
	return match?.[0] ?? null;
}

function buildFallbackWrapupResult(response: string, error: string): WrapupRunResult {
	const summary = response.trim().slice(0, FALLBACK_SUMMARY_LENGTH);
	return {
		summary:
			summary.length > 0
				? summary
				: `Wrapup agent did not provide a parseable final response. Last parse error: ${error}`,
		prUrl: extractPullRequestUrl(response),
		branchName: null,
		pushedCommits: [],
	};
}

export async function runWrapup(props: RunWrapupProps): Promise<WrapupRunResult> {
	const turnResult = await props.wrapupThread.send(buildWrapupMessage(props));
	await props.onWrapupTurn(turnResult);

	const parsed = parseWrapupFinalAnswer(turnResult.response);
	if (parsed.success) {
		return parsed.value;
	}

	const retryResult = await props.wrapupThread.send(
		buildWrapupJsonRepairMessage(parsed.error, turnResult.response),
	);
	await props.onWrapupTurn(retryResult);
	const retryParsed = parseWrapupFinalAnswer(retryResult.response);
	if (retryParsed.success) {
		return retryParsed.value;
	}

	return buildFallbackWrapupResult(retryResult.response, retryParsed.error);
}
