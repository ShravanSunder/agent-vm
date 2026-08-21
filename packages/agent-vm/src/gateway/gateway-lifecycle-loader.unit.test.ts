import { hermesLifecycle } from '@agent-vm/hermes-gateway';
import { openclawLifecycle } from '@agent-vm/openclaw-gateway';
import { workerLifecycle } from '@agent-vm/worker-gateway';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';

describe('loadGatewayLifecycle', () => {
	it('loads the openclaw lifecycle for openclaw zones', () => {
		const lifecycle = loadGatewayLifecycle('openclaw');
		expect(lifecycle).toBe(openclawLifecycle);
		expect(lifecycle.executionModel).toBe('managed-gateway');
		expectTypeOf(lifecycle.executionModel).toEqualTypeOf<'managed-gateway'>();
		expect(lifecycle.capabilities).toEqual({ nativeApprovalPresenter: false });
	});

	it('loads the Hermes lifecycle for Hermes zones', () => {
		const lifecycle = loadGatewayLifecycle('hermes');
		expect(lifecycle).toBe(hermesLifecycle);
		expect(lifecycle.executionModel).toBe('managed-gateway');
		expectTypeOf(lifecycle.executionModel).toEqualTypeOf<'managed-gateway'>();
		expect(lifecycle.capabilities).toEqual({ nativeApprovalPresenter: true });
	});

	it('loads the worker lifecycle for worker zones', () => {
		const lifecycle = loadGatewayLifecycle('worker');
		expect(lifecycle).toBe(workerLifecycle);
		expect(lifecycle.executionModel).toBe('direct-process');
		expectTypeOf(lifecycle.executionModel).toEqualTypeOf<'direct-process'>();
		expect(lifecycle.capabilities).toEqual({ nativeApprovalPresenter: false });
	});
});
