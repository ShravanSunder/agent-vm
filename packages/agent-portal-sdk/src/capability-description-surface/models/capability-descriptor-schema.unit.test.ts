import { describe, expect, it } from 'vitest';

import {
	CompactCapabilityDescriptionCodePointLimit,
	compactCapabilitySummaryDescription,
} from './capability-descriptor-schema.js';

describe('compactCapabilitySummaryDescription', () => {
	it('bounds descriptions by Unicode code point and reports truncation', () => {
		// Arrange
		const fullDescription = `${'a'.repeat(CompactCapabilityDescriptionCodePointLimit - 1)}🛰️tail`;
		const summary = {
			description: fullDescription,
			input: { optional: [], propertyCount: 0, required: [], type: 'object' as const },
			name: 'inspect',
			namespace: 'fixture',
			safety: {},
			toolRef: 'fixture:inspect',
		};

		// Act
		const compactSummary = compactCapabilitySummaryDescription(summary);

		// Assert
		expect(Array.from(compactSummary.description ?? '')).toHaveLength(
			CompactCapabilityDescriptionCodePointLimit,
		);
		expect(compactSummary.description).toBe(
			`${'a'.repeat(CompactCapabilityDescriptionCodePointLimit - 1)}…`,
		);
		expect(compactSummary.descriptionTruncated).toBe(true);
		expect(summary.description).toBe(fullDescription);
	});

	it('preserves descriptions at the limit and reports that they were not truncated', () => {
		// Arrange
		const description = '😀'.repeat(CompactCapabilityDescriptionCodePointLimit);
		const summary = {
			description,
			input: { optional: [], propertyCount: 0, required: [], type: 'object' as const },
			name: 'inspect',
			namespace: 'fixture',
			safety: {},
			toolRef: 'fixture:inspect',
		};

		// Act
		const compactSummary = compactCapabilitySummaryDescription(summary);

		// Assert
		expect(compactSummary.description).toBe(description);
		expect(compactSummary.descriptionTruncated).toBe(false);
	});
});
