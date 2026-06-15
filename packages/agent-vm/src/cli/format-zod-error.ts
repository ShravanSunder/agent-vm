import type { ZodError, ZodIssue } from 'zod';

interface FormattedZodIssue {
	readonly message: string;
	readonly path: readonly PropertyKey[];
}

interface UnionIssueScore {
	readonly discriminatorMismatches: number;
	readonly issueCount: number;
}

function formatIssuePath(pathSegments: readonly PropertyKey[]): string {
	if (pathSegments.length === 0) {
		return '(root)';
	}

	return pathSegments.reduce((currentPath: string, pathSegment) => {
		if (typeof pathSegment === 'number') {
			return `${currentPath}[${pathSegment}]`;
		}

		return currentPath.length > 0 ? `${currentPath}.${String(pathSegment)}` : String(pathSegment);
	}, '');
}

function isInvalidUnionIssue(
	issue: ZodIssue,
): issue is ZodIssue & { readonly errors: readonly (readonly ZodIssue[])[] } {
	return (
		issue.code === 'invalid_union' &&
		'errors' in issue &&
		Array.isArray(issue.errors) &&
		issue.errors.every((branchIssues) => Array.isArray(branchIssues))
	);
}

function isDiscriminatorMismatchIssue(issue: ZodIssue): boolean {
	const pathSegment = issue.path[0];
	return (
		issue.code === 'invalid_value' &&
		issue.path.length === 1 &&
		typeof pathSegment === 'string' &&
		['source', 'injection', 'audience'].includes(pathSegment)
	);
}

function addUnionIssueScores(left: UnionIssueScore, right: UnionIssueScore): UnionIssueScore {
	return {
		discriminatorMismatches: left.discriminatorMismatches + right.discriminatorMismatches,
		issueCount: left.issueCount + right.issueCount,
	};
}

function compareUnionIssueScores(left: UnionIssueScore, right: UnionIssueScore): number {
	if (left.discriminatorMismatches !== right.discriminatorMismatches) {
		return left.discriminatorMismatches - right.discriminatorMismatches;
	}
	return left.issueCount - right.issueCount;
}

function scoreUnionIssue(issue: ZodIssue): UnionIssueScore {
	if (!isInvalidUnionIssue(issue)) {
		return {
			discriminatorMismatches: isDiscriminatorMismatchIssue(issue) ? 1 : 0,
			issueCount: 1,
		};
	}

	const branchScores = issue.errors.map(scoreUnionBranch);
	return branchScores.reduce((bestScore, branchScore) =>
		compareUnionIssueScores(branchScore, bestScore) < 0 ? branchScore : bestScore,
	);
}

function scoreUnionBranch(branchIssues: readonly ZodIssue[]): UnionIssueScore {
	return branchIssues
		.map(scoreUnionIssue)
		.reduce(addUnionIssueScores, { discriminatorMismatches: 0, issueCount: 0 });
}

function selectUnionBranch(branches: readonly (readonly ZodIssue[])[]): readonly ZodIssue[] {
	return branches.reduce((bestBranch, branch) => {
		const branchScore = scoreUnionBranch(branch);
		const bestBranchScore = scoreUnionBranch(bestBranch);
		return compareUnionIssueScores(branchScore, bestBranchScore) < 0 ? branch : bestBranch;
	});
}

function isAgentAccessPath(pathSegments: readonly PropertyKey[]): boolean {
	return pathSegments[pathSegments.length - 1] === 'agentAccess';
}

function expandIssue(
	issue: ZodIssue,
	pathPrefix: readonly PropertyKey[] = [],
): readonly FormattedZodIssue[] {
	const issuePath = [...pathPrefix, ...issue.path];
	if (!isInvalidUnionIssue(issue)) {
		return [{ path: issuePath, message: issue.message }];
	}

	if (isAgentAccessPath(issuePath)) {
		return [
			{
				path: issuePath,
				message: 'agentAccess must be "all" or a non-empty array of declared zone agent ids',
			},
		];
	}

	return selectUnionBranch(issue.errors).flatMap((nestedIssue) =>
		expandIssue(nestedIssue, issuePath),
	);
}

function formatIssue(issue: FormattedZodIssue): string {
	return `  ${formatIssuePath(issue.path)}: ${issue.message}`;
}

export function formatZodError(title: string, error: ZodError): string {
	return [title, ...error.issues.flatMap((issue) => expandIssue(issue)).map(formatIssue)].join(
		'\n',
	);
}
