import { describe, expect, it, vi } from 'vitest';

import { dispatchToolPortalCommand } from './tool-portal-cli-dispatcher.js';

describe('Tool Portal CLI dispatcher', () => {
	it('dispatches one parsed command to the existing operation', async () => {
		const operation = vi.fn().mockResolvedValue(0);
		const command = {
			inputJson: '{}',
			operation: 'list',
			transport: {
				authorizationEnvironmentName: 'TOOL_PORTAL_AUTH',
				endpoint: 'https://example.test/mcp',
				kind: 'http',
			},
		} as const;

		await expect(dispatchToolPortalCommand(command, process.env, operation)).resolves.toBe(0);
		expect(operation).toHaveBeenCalledOnce();
		expect(operation).toHaveBeenCalledWith(command, process.env);
	});
});
