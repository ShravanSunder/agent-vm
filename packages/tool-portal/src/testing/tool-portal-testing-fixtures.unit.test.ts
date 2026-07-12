import { toolPortalConfigSchema } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { CliAllowanceSchema } from '../cli-allowances/index.js';
import { createCliAllowanceFixture, createToolPortalConfigFixture } from './index.js';

describe('tool portal testing fixtures', () => {
	it('exports valid Tool Portal config and CLI allowance fixtures', () => {
		expect(toolPortalConfigSchema.safeParse(createToolPortalConfigFixture()).success).toBe(true);
		expect(CliAllowanceSchema.safeParse(createCliAllowanceFixture()).success).toBe(true);
	});
});
