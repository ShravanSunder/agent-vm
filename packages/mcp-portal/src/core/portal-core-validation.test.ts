import { describe, expect, it } from 'vitest';

import { isPortalCoreJsonValue } from './portal-core-validation.js';

describe('portal core validation helpers', () => {
	it('rejects circular JSON-shaped values without recursing forever', () => {
		const circularValue: Record<string, unknown> = {};
		circularValue.self = circularValue;

		expect(isPortalCoreJsonValue(circularValue)).toBe(false);
	});

	it('accepts repeated object references when they are not circular', () => {
		const sharedValue = { id: 'same-object' };

		expect(isPortalCoreJsonValue([sharedValue, sharedValue])).toBe(true);
	});
});
