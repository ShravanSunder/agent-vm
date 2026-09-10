import { describe, expect, it } from 'vitest';

import { permissionSelectionSummary } from './permission-selection-summary.js';

describe('consent selection summary shared by native and enhanced pages', () => {
	it.each([
		{ counts: [], expected: 'No Google access selected.' },
		{ counts: [0, 0, 0], expected: 'No Google access selected.' },
		{ counts: [1, 0, 0], expected: '1 permission group selected across 1 application.' },
		{ counts: [2, 0, 0], expected: '2 permission groups selected across 1 application.' },
		{ counts: [1, 2, 1], expected: '4 permission groups selected across 3 applications.' },
	])('describes $counts', ({ counts, expected }) => {
		// Arrange / Act
		const summary = permissionSelectionSummary(counts);
		// Assert
		expect(summary).toBe(expected);
	});
});
