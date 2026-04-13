import { describe, expect, it } from 'vitest';

import { codingGatewayConfigSchema, loadConfig } from './config.js';

describe('CodingGatewayConfig', () => {
	it('default config parses with correct defaults', () => {
		const result = codingGatewayConfigSchema.parse({});

		expect(result).toEqual({
			model: 'gpt-5.4-mini',
			reviewModel: 'gpt-5.4-mini',
			plannerSkills: ['writing-plans', 'brainstorming'],
			planReviewerSkills: ['generic-plan-review'],
			coderSkills: ['test-driven-development', 'verification-before-completion'],
			codeReviewerSkills: ['generic-code-review'],
			maxPlanReviewLoops: 2,
			maxCodeReviewLoops: 3,
			maxSanityRetries: 3,
			verificationTimeoutMs: 300_000,
			testCommand: 'npm test',
			lintCommand: 'npm run lint',
			branchPrefix: 'agent/',
			commitCoAuthor: 'agent-vm-coding <noreply@agent-vm>',
			idleTimeoutMs: 1_800_000,
			stateDir: '/state',
		});
	});

	it('custom partial config merges correctly', () => {
		const result = codingGatewayConfigSchema.parse({
			model: 'gpt-5.4-turbo',
			reviewModel: 'gpt-5.4-mini',
			plannerSkills: ['brainstorming'],
			maxCodeReviewLoops: 5,
			testCommand: 'pnpm test',
		});

		expect(result).toEqual({
			model: 'gpt-5.4-turbo',
			reviewModel: 'gpt-5.4-mini',
			plannerSkills: ['brainstorming'],
			planReviewerSkills: ['generic-plan-review'],
			coderSkills: ['test-driven-development', 'verification-before-completion'],
			codeReviewerSkills: ['generic-code-review'],
			maxPlanReviewLoops: 2,
			maxCodeReviewLoops: 5,
			maxSanityRetries: 3,
			verificationTimeoutMs: 300_000,
			testCommand: 'pnpm test',
			lintCommand: 'npm run lint',
			branchPrefix: 'agent/',
			commitCoAuthor: 'agent-vm-coding <noreply@agent-vm>',
			idleTimeoutMs: 1_800_000,
			stateDir: '/state',
		});
	});

	it('invalid config with negative code review loops throws', () => {
		expect(() => {
			codingGatewayConfigSchema.parse({ maxCodeReviewLoops: -1 });
		}).toThrow();
	});

	it('invalid config with empty model throws', () => {
		expect(() => {
			codingGatewayConfigSchema.parse({ model: '' });
		}).toThrow();
	});

	it('invalid config with zero plan review loops throws', () => {
		expect(() => {
			codingGatewayConfigSchema.parse({ maxPlanReviewLoops: 0 });
		}).toThrow();
	});

	it('invalid config with negative timeout throws', () => {
		expect(() => {
			codingGatewayConfigSchema.parse({ verificationTimeoutMs: -100 });
		}).toThrow();
	});

	it('invalid config with unknown skill throws', () => {
		expect(() => {
			codingGatewayConfigSchema.parse({
				plannerSkills: ['not-a-real-skill'],
			});
		}).toThrow();
	});
});

describe('loadConfig', () => {
	it('returns default config when no path provided', () => {
		const result = loadConfig();

		expect(result).toEqual({
			model: 'gpt-5.4-mini',
			reviewModel: 'gpt-5.4-mini',
			plannerSkills: ['writing-plans', 'brainstorming'],
			planReviewerSkills: ['generic-plan-review'],
			coderSkills: ['test-driven-development', 'verification-before-completion'],
			codeReviewerSkills: ['generic-code-review'],
			maxPlanReviewLoops: 2,
			maxCodeReviewLoops: 3,
			maxSanityRetries: 3,
			verificationTimeoutMs: 300_000,
			testCommand: 'npm test',
			lintCommand: 'npm run lint',
			branchPrefix: 'agent/',
			commitCoAuthor: 'agent-vm-coding <noreply@agent-vm>',
			idleTimeoutMs: 1_800_000,
			stateDir: '/state',
		});
	});
});
