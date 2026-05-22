import { createSecretResolver } from '@agent-vm/secrets';
import { describe, expect, it } from 'vitest';

import { defaultCliDependencies } from './agent-vm-cli-support.js';

describe('defaultCliDependencies', () => {
	it('uses the SDK-first secret resolver by default', () => {
		expect(defaultCliDependencies.createSecretResolver).toBe(createSecretResolver);
	});
});
