import { describe, expect, it } from 'vitest';

import { parseProcessIdentityOutput } from './managed-vm-process.js';

describe('parseProcessIdentityOutput', () => {
	it('keeps the ps lstart year out of the command field', () => {
		expect(
			parseProcessIdentityOutput('Fri May 22 10:00:00 2026 qemu-system-aarch64 -m 4G -smp 4'),
		).toEqual({
			command: 'qemu-system-aarch64 -m 4G -smp 4',
			lstart: 'Fri May 22 10:00:00 2026',
		});
	});

	it('returns null when the command column is missing', () => {
		expect(parseProcessIdentityOutput('Fri May 22 10:00:00 2026')).toBeNull();
	});
});
