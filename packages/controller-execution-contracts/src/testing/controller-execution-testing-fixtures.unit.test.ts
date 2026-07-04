import { ManagedVmExecRequestSchema as PublicManagedVmExecRequestSchema } from '@agent-vm/controller-execution-contracts/tool-vm-runner-boundary';
import { describe, expect, it } from 'vitest';

import { ControllerDispatchIntentSchema, ManagedVmExecRequestSchema } from '../index.js';
import {
	createControllerDispatchIntentFixture,
	createManagedVmExecRequestFixture,
} from './index.js';

describe('controller execution testing fixtures', () => {
	it('exports valid controller dispatch and managed VM runner fixtures', () => {
		expect(
			ControllerDispatchIntentSchema.safeParse(createControllerDispatchIntentFixture()).success,
		).toBe(true);
		expect(ManagedVmExecRequestSchema.safeParse(createManagedVmExecRequestFixture()).success).toBe(
			true,
		);
		expect(
			PublicManagedVmExecRequestSchema.safeParse(createManagedVmExecRequestFixture()).success,
		).toBe(true);
	});
});
