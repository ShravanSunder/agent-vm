import { openclawLifecycle } from 'openclaw-gateway';
import { describe, expect, it } from 'vitest';
import { workerLifecycle } from 'worker-gateway';

import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';

describe('loadGatewayLifecycle', () => {
	it('loads the openclaw lifecycle for openclaw zones', () => {
		expect(loadGatewayLifecycle('openclaw')).toBe(openclawLifecycle);
	});

	it('loads the worker lifecycle for coding zones', () => {
		expect(loadGatewayLifecycle('coding')).toBe(workerLifecycle);
	});
});
