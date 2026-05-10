import { Buffer } from 'node:buffer';

export function buildGithubAuthConfigArgs(githubToken: string): readonly string[] {
	const header = `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`;
	return ['-c', `http.https://github.com/.extraheader=${header}`];
}

export class GitHubRepositoryValidationError extends Error {}

export function parseGithubRepositoryFromUrl(repoUrl: string): string {
	const cleaned = repoUrl.replace(/\.git$/u, '');
	const urlPattern = /(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)$/u;
	const match = urlPattern.exec(cleaned);

	if (match?.[1]) {
		return match[1];
	}
	if (/^[^\s/]+\/[^\s/]+$/u.test(cleaned)) {
		return cleaned;
	}

	throw new GitHubRepositoryValidationError(`Invalid GitHub repository: ${repoUrl}`);
}

export function buildGithubTokenUrl(repoUrl: string, githubToken: string): string {
	return `https://x-access-token:${githubToken}@github.com/${parseGithubRepositoryFromUrl(repoUrl)}.git`;
}

export function scrubGithubTokenFromOutput(text: string): string {
	return text
		.replace(/https:\/\/x-access-token:[^@]*@/gu, 'https://x-access-token:***@')
		.replace(/Authorization: Basic [A-Za-z0-9+/=]+/gu, 'Authorization: Basic ***');
}
