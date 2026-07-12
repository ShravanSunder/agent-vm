import { describe, expect, it } from 'vitest';

import {
	normalizeGitRepoForSshReadAllowlist,
	normalizeGitReposForSshReadAllowlist,
} from './git-read-allowlist.js';

describe('Git SSH read allowlist normalization', () => {
	it('derives hosts and repo paths from generic trusted repo URLs', () => {
		expect(
			normalizeGitReposForSshReadAllowlist([
				'ssh://git@git.example.com/team/service.git',
				'git@gitlab.internal:platform/nested/repo.git',
				'https://github.com/Shravan/Zone-Files.git',
				'acme/widgets',
			]),
		).toEqual({
			allowedHosts: ['git.example.com', 'github.com', 'gitlab.internal'],
			allowedRepos: ['Shravan/Zone-Files', 'acme/widgets', 'platform/nested/repo', 'team/service'],
		});
	});

	it('rejects malformed trusted repo entries instead of widening the allowlist', () => {
		expect(normalizeGitRepoForSshReadAllowlist('https://git.example.com/one')).toBeUndefined();
		expect(normalizeGitRepoForSshReadAllowlist('git@example.com:')).toBeUndefined();
		expect(normalizeGitRepoForSshReadAllowlist('not a repo url')).toBeUndefined();
	});
});
