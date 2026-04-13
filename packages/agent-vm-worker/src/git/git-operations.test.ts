import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	buildCommitMessage,
	buildPushUrl,
	parseRepoFromUrl,
	sanitizeBranchName,
} from './git-operations.js';

describe('git-operations', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('parseRepoFromUrl', () => {
		it('extracts owner/repo from full https url', () => {
			expect(parseRepoFromUrl('https://github.com/acme/widgets.git')).toBe('acme/widgets');
		});

		it('extracts owner/repo from url without .git', () => {
			expect(parseRepoFromUrl('https://github.com/acme/widgets')).toBe('acme/widgets');
		});

		it('extracts owner/repo from url without scheme', () => {
			expect(parseRepoFromUrl('github.com/acme/widgets')).toBe('acme/widgets');
		});

		it('passes through short form owner/repo', () => {
			expect(parseRepoFromUrl('acme/widgets')).toBe('acme/widgets');
		});

		it('throws on invalid url', () => {
			expect(() => parseRepoFromUrl('invalid')).toThrow('Invalid GitHub repository');
		});
	});

	describe('sanitizeBranchName', () => {
		it('passes through valid branch names', () => {
			expect(sanitizeBranchName('agent/task-123')).toBe('agent/task-123');
		});

		it('replaces unsafe characters with dashes', () => {
			expect(sanitizeBranchName('agent/task 123!')).toBe('agent/task-123-');
		});
	});

	describe('buildCommitMessage', () => {
		it('appends co-author to message', () => {
			expect(buildCommitMessage('feat: add login', 'bot <bot@x>')).toBe(
				'feat: add login\n\nCo-Authored-By: bot <bot@x>',
			);
		});
	});

	describe('buildPushUrl', () => {
		it('builds authenticated push url', () => {
			vi.stubEnv('GITHUB_TOKEN', 'test-token-123');
			expect(buildPushUrl('acme/widgets')).toBe(
				'https://x-access-token:test-token-123@github.com/acme/widgets.git',
			);
		});

		it('throws when GITHUB_TOKEN is missing', () => {
			vi.stubEnv('GITHUB_TOKEN', '');
			delete process.env.GITHUB_TOKEN;
			expect(() => buildPushUrl('acme/widgets')).toThrow(
				'GITHUB_TOKEN environment variable is required',
			);
		});
	});
});
