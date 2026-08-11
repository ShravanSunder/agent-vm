import { describe, expect, it, vi } from 'vitest';

import { dispatchGatewayRuntimeCommand } from './gateway-runtime-cli-dispatcher.js';

describe('Gateway Runtime CLI dispatcher', () => {
	it('dispatches start exactly once to the Gateway Runtime lifecycle operation', async () => {
		const runStartLifecycle = vi.fn(async (): Promise<void> => undefined);
		const command = {
			command: 'start',
			configPath: '/tmp/gateway-runtime.json',
		} as const;

		await dispatchGatewayRuntimeCommand(command, { runStartLifecycle });

		expect(runStartLifecycle).toHaveBeenCalledOnce();
		expect(runStartLifecycle).toHaveBeenCalledWith(command);
	});
});
