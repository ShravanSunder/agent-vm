import { describe, expect, it } from 'vitest';

import {
	DEFAULT_BASE_INSTRUCTIONS,
	DEFAULT_PHASE_INSTRUCTIONS,
	getDefaultPhaseInstruction,
} from './prompt-defaults.js';

describe('prompt-defaults', () => {
	it('exports the default base instructions used by the worker runtime', () => {
		expect(DEFAULT_BASE_INSTRUCTIONS).toContain('Do NOT run git push');
		expect(DEFAULT_BASE_INSTRUCTIONS).toContain('request controller-side push and PR creation');
	});

	it('exports default instructions for every supported configurable phase', () => {
		expect(DEFAULT_PHASE_INSTRUCTIONS.plan).toContain('Do not write code yet');
		expect(DEFAULT_PHASE_INSTRUCTIONS['plan-review']).toContain('Review the plan');
		expect(DEFAULT_PHASE_INSTRUCTIONS.work).toContain('Implement the approved plan');
		expect(DEFAULT_PHASE_INSTRUCTIONS['work-review']).toContain('Review the code changes');
		expect(DEFAULT_PHASE_INSTRUCTIONS.wrapup).toContain('configured wrapup actions');
	});

	it('returns undefined for phases without a built-in default instruction', () => {
		expect(getDefaultPhaseInstruction('verification')).toBeUndefined();
	});
});
