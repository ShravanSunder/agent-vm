import type { RepoLocation } from '../shared/repo-location.js';
import type { ReviewResult } from '../shared/review-result.js';
import type { VerificationCommandResult } from '../state/task-event-types.js';
import type { VerificationCommand } from '../validation-runner/verification-runner.js';

function formatComments(comments: readonly ReviewResult['comments'][number][]): string {
	if (comments.length === 0) return '(no comments)';
	return comments
		.map((comment) => {
			const location =
				typeof comment.line === 'number' ? `${comment.file}:${String(comment.line)}` : comment.file;
			return `- [${comment.severity}] ${location} - ${comment.comment}`;
		})
		.join('\n');
}

function formatRepos(repos: readonly RepoLocation[]): string {
	if (repos.length === 0) return '(no repositories)';
	return repos
		.map((repo) => `- ${repo.repoUrl} (branch: ${repo.baseBranch})\n  Work: ${repo.workPath}`)
		.join('\n');
}

function formatValidationList(commands: readonly VerificationCommand[]): string {
	if (commands.length === 0) {
		return '(none configured - run_validation will return an empty array)';
	}
	return commands.map((command) => `- ${command.name}: ${command.command}`).join('\n');
}

function formatValidationResults(results: readonly VerificationCommandResult[]): string {
	if (results.length === 0) return '(no validation results recorded)';
	return results
		.map(
			(result) =>
				`- ${result.name}: passed=${String(result.passed)} exitCode=${String(result.exitCode)}\n  output: ${result.output.slice(0, 800)}`,
		)
		.join('\n');
}

export interface BuildInitialPlanMessageProps {
	readonly spec: string;
	readonly repos: readonly RepoLocation[];
	readonly repoSummary: string | null;
	readonly context: Record<string, unknown>;
}

export function buildInitialPlanMessage(props: BuildInitialPlanMessageProps): string {
	const parts = [`Spec:\n${props.spec}`, `Repositories:\n${formatRepos(props.repos)}`];
	if (props.repoSummary) parts.push(`Repo summary:\n${props.repoSummary}`);
	if (Object.keys(props.context).length > 0) {
		parts.push(`Context:\n${JSON.stringify(props.context, null, 2)}`);
	}
	parts.push('Produce a plan. Return JSON: { "plan": "..." }');
	return parts.join('\n\n');
}

export interface BuildPlanReviewMessageProps {
	readonly spec: string;
	readonly plan: string;
	readonly cycle: number;
}

export function buildPlanReviewMessage(props: BuildPlanReviewMessageProps): string {
	return [
		`Spec:\n${props.spec}`,
		`Plan v${String(props.cycle)}:\n${props.plan}`,
		'Review. Return JSON per the ReviewResult schema from your instructions.',
	].join('\n\n');
}

export interface BuildPlanReviseMessageProps {
	readonly cycle: number;
	readonly review: ReviewResult;
}

export function buildPlanReviseMessage(props: BuildPlanReviseMessageProps): string {
	return [
		`Plan reviewer cycle ${String(props.cycle)} feedback:`,
		`Summary: ${props.review.summary}`,
		`Comments:\n${formatComments(props.review.comments)}`,
		'Revise the plan. Return JSON: { "plan": "..." }',
	].join('\n\n');
}

export interface BuildInitialWorkMessageProps {
	readonly spec: string;
	readonly plan: string;
	readonly planReview: ReviewResult | null;
	readonly validationCommandList: readonly VerificationCommand[];
}

export function buildInitialWorkMessage(props: BuildInitialWorkMessageProps): string {
	const parts = [`Spec:\n${props.spec}`, `Approved plan:\n${props.plan}`];
	if (props.planReview) {
		parts.push(
			`Plan review commentary (advisory):\nSummary: ${props.planReview.summary}\nComments:\n${formatComments(props.planReview.comments)}`,
		);
	}
	parts.push(
		`Validation commands available:\n${formatValidationList(props.validationCommandList)}`,
	);
	parts.push(
		'Implement the plan. Return JSON: { "summary": "...", "commitShas": [], "remainingConcerns": "" }',
	);
	return parts.join('\n\n');
}

export interface BuildWorkReviewMessageProps {
	readonly spec: string;
	readonly plan: string;
	readonly diff: string;
	readonly cycle: number;
	readonly validationCommandList?: readonly VerificationCommand[];
}

export function buildWorkReviewMessage(props: BuildWorkReviewMessageProps): string {
	return [
		`Spec:\n${props.spec}`,
		`Plan:\n${props.plan}`,
		`Diff v${String(props.cycle)}:\n${props.diff}`,
		`Validation commands configured:\n${formatValidationList(props.validationCommandList ?? [])}`,
		'You MUST call run_validation exactly once before returning your review. Return JSON per the ReviewResult schema from your instructions.',
	].join('\n\n');
}

export interface BuildWorkReviseMessageProps {
	readonly cycle: number;
	readonly review: ReviewResult;
	readonly validationResults: readonly VerificationCommandResult[];
}

export function buildWorkReviseMessage(props: BuildWorkReviseMessageProps): string {
	return [
		`Work reviewer cycle ${String(props.cycle)} feedback:`,
		`Summary: ${props.review.summary}`,
		`Comments:\n${formatComments(props.review.comments)}`,
		`Validation results:\n${formatValidationResults(props.validationResults)}`,
		'Revise. Return JSON: { "summary": "...", "commitShas": [], "remainingConcerns": "" }',
	].join('\n\n');
}
