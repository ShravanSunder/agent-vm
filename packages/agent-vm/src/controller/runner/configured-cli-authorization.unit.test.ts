import { describe, expect, it } from 'vitest';

import { requireCurrentConfiguredCliAuthorization } from './configured-cli-authorization.js';
import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

describe('requireCurrentConfiguredCliAuthorization', () => {
	it('reports denied final reauthorization as proven pre-dispatch rejection', () => {
		expect(() => requireCurrentConfiguredCliAuthorization({ authorized: false })).toThrowError(
			expect.objectContaining({
				code: 'not_dispatched',
				name: ConfiguredControllerExecutionError.name,
			}),
		);
	});
});
