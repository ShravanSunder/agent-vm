import { openclawLifecycle } from '@agent-vm/openclaw-gateway';
import { workerLifecycle } from '@agent-vm/worker-gateway';
import { describe, expect, it } from 'vitest';

import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';

describe('loadGatewayLifecycle', () => {
	it('loads the openclaw lifecycle for openclaw zones', () => {
		expect(loadGatewayLifecycle('openclaw')).toBe(openclawLifecycle);
	});

	it('loads the worker lifecycle for worker zones', () => {
		expect(loadGatewayLifecycle('worker')).toBe(workerLifecycle);
	});
});
