import { Buffer } from 'node:buffer';

export function buildGithubAuthConfigArgs(githubToken: string): readonly string[] {
	const header = `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`;
	return ['-c', `http.https://github.com/.extraheader=${header}`];
}

export function scrubGithubTokenFromOutput(text: string): string {
	return text
		.replace(/https:\/\/x-access-token:[^@]*@/gu, 'https://x-access-token:***@')
		.replace(/Authorization: Basic [A-Za-z0-9+/=]+/gu, 'Authorization: Basic ***');
}
