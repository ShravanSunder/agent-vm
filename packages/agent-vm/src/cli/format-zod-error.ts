import type { ZodError, ZodIssue } from 'zod';

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

function formatIssue(issue: ZodIssue): string {
	return `  ${formatIssuePath(issue.path)}: ${issue.message}`;
}

export function formatZodError(title: string, error: ZodError): string {
	return [title, ...error.issues.map(formatIssue)].join('\n');
}
