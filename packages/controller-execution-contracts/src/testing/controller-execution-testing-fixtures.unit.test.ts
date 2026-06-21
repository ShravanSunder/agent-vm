import { describe, expect, it } from 'vitest';

import {
	ControllerDispatchIntentSchema,
	CredentialedRunnerRequestSchema,
	ManagedVmExecRequestSchema,
} from '../index.js';
import {
	createControllerDispatchIntentFixture,
	createCredentialedRunnerRequestFixture,
	createManagedVmExecRequestFixture,
} from './index.js';

describe('controller execution testing fixtures', () => {
	it('exports valid controller dispatch, managed VM, and credentialed runner fixtures', () => {
		expect(
			ControllerDispatchIntentSchema.safeParse(createControllerDispatchIntentFixture()).success,
		).toBe(true);
		expect(ManagedVmExecRequestSchema.safeParse(createManagedVmExecRequestFixture()).success).toBe(
			true,
		);
		expect(
			CredentialedRunnerRequestSchema.safeParse(createCredentialedRunnerRequestFixture()).success,
		).toBe(true);
	});
});
