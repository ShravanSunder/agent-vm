import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { buildGithubAuthConfigArgs, scrubGithubTokenFromOutput } from './git-auth-support.js';

describe('git-auth-support', () => {
	it('builds ordered git config args with a decodable GitHub token header', () => {
		const args = buildGithubAuthConfigArgs('ghp_secret-token');

		expect(args[0]).toBe('-c');
		expect(args[1]).toMatch(/^http\.https:\/\/github\.com\/\.extraheader=Authorization: Basic /u);
		const encodedHeader = args[1]?.replace(
			'http.https://github.com/.extraheader=Authorization: Basic ',
			'',
		);
		expect(Buffer.from(encodedHeader ?? '', 'base64').toString('utf8')).toBe(
			'x-access-token:ghp_secret-token',
		);
	});

	it('scrubs URL-embedded GitHub tokens from output', () => {
		expect(
			scrubGithubTokenFromOutput(
				'fatal: https://x-access-token:ghp_secret-token@github.com/acme/widgets.git failed',
			),
		).toBe('fatal: https://x-access-token:***@github.com/acme/widgets.git failed');
	});

	it('scrubs header-embedded GitHub tokens from output', () => {
		expect(
			scrubGithubTokenFromOutput('fatal: Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0'),
		).toBe('fatal: Authorization: Basic ***');
	});
});
