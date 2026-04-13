import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
	ExecutorResult,
	StructuredInput,
	WorkExecutor,
} from '../work-executor/executor-interface.js';
import { reviewWork } from './work-reviewer.js';

const mocks = vi.hoisted(() => ({
	runVerification: vi.fn(),
	allVerificationsPassed: vi.fn(),
}));

vi.mock('./verification-runner.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('./verification-runner.js')>();
	return {
		...original,
		runVerification: mocks.runVerification,
		allVerificationsPassed: mocks.allVerificationsPassed,
	};
});

function createMockReviewExecutor(response: string): WorkExecutor {
	return {
		async execute(_input: readonly StructuredInput[]): Promise<ExecutorResult> {
			return {
				response,
				tokenCount: 50,
				threadId: 'review-thread',
			};
		},
		async fix(): Promise<ExecutorResult> {
			throw new Error('Should not call fix on reviewer');
		},
		async resumeOrRebuild(): Promise<void> {},
		getThreadId(): string | null {
			return null;
		},
	};
}

describe('work-reviewer', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'work-reviewer-test-'));
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('returns verification failure without running review', async () => {
		const failedResults = [{ name: 'test', passed: false, exitCode: 1, output: 'FAIL' }];
		mocks.runVerification.mockResolvedValue(failedResults);
		mocks.allVerificationsPassed.mockReturnValue(false);

		const result = await reviewWork(createMockReviewExecutor('should not be called'), {
			reviewPrompt: [{ type: 'text', text: 'review' }],
			verificationOptions: {
				commands: [{ name: 'test', command: 'npm test' }],
				cwd: tempDir,
				timeoutMs: 10_000,
			},
		});

		expect(result.verificationPassed).toBe(false);
		expect(result.review).toBeNull();
		expect(result.verificationResults).toEqual(failedResults);
	});

	it('runs review when verification passes', async () => {
		const passedResults = [{ name: 'test', passed: true, exitCode: 0, output: '' }];
		mocks.runVerification.mockResolvedValue(passedResults);
		mocks.allVerificationsPassed.mockReturnValue(true);

		const result = await reviewWork(
			createMockReviewExecutor(
				JSON.stringify({ approved: true, comments: [], summary: 'Code looks good.' }),
			),
			{
				reviewPrompt: [{ type: 'text', text: 'review the code' }],
				verificationOptions: {
					commands: [{ name: 'test', command: 'npm test' }],
					cwd: tempDir,
					timeoutMs: 10_000,
				},
			},
		);

		expect(result.verificationPassed).toBe(true);
		expect(result.review?.approved).toBe(true);
		expect(result.review?.summary).toBe('Code looks good.');
	});

	it('returns review rejection', async () => {
		const passedResults = [{ name: 'test', passed: true, exitCode: 0, output: '' }];
		mocks.runVerification.mockResolvedValue(passedResults);
		mocks.allVerificationsPassed.mockReturnValue(true);

		const result = await reviewWork(
			createMockReviewExecutor(
				JSON.stringify({
					approved: false,
					comments: [{ file: 'src/main.ts', severity: 'critical', comment: 'Bug here' }],
					summary: 'Fix the bug in main.ts',
				}),
			),
			{
				reviewPrompt: [{ type: 'text', text: 'review' }],
				verificationOptions: {
					commands: [{ name: 'test', command: 'npm test' }],
					cwd: tempDir,
					timeoutMs: 10_000,
				},
			},
		);

		expect(result.review?.approved).toBe(false);
		expect(result.review?.comments).toHaveLength(1);
	});

	it('throws on invalid review JSON', async () => {
		const passedResults = [{ name: 'test', passed: true, exitCode: 0, output: '' }];
		mocks.runVerification.mockResolvedValue(passedResults);
		mocks.allVerificationsPassed.mockReturnValue(true);

		await expect(
			reviewWork(createMockReviewExecutor('not json'), {
				reviewPrompt: [{ type: 'text', text: 'review' }],
				verificationOptions: {
					commands: [{ name: 'test', command: 'npm test' }],
					cwd: tempDir,
					timeoutMs: 10_000,
				},
			}),
		).rejects.toThrow('not valid JSON');
	});
});
