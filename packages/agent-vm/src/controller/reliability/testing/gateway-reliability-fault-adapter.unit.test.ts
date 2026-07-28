import { describe, expect, it, vi } from 'vitest';

import { createManagedExecProcessStub } from '../../../testing/managed-vm-test-helpers.js';
import {
	readManagedGatewaySiblingProcessIdentity,
	terminateManagedGatewaySibling,
	type GatewayReliabilityFaultVmOperations,
} from './gateway-reliability-fault-adapter.js';

describe('Gateway reliability fault adapter', () => {
	it('reads and terminates one identity-fenced managed Gateway sibling', async () => {
		// Arrange
		const exec = vi
			.fn<GatewayReliabilityFaultVmOperations['exec']>()
			.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '28407 99123\n' }))
			.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '28407 99123\n' }));
		const gatewayVm = { exec, id: 'gateway-vm-test' };

		// Act
		const identity = await readManagedGatewaySiblingProcessIdentity({
			gatewayVm,
			guestPort: 18_789,
			role: 'framework',
		});
		const receipt = await terminateManagedGatewaySibling({
			gatewayVm,
			identity,
			role: 'framework',
		});

		// Assert
		expect(identity).toEqual({ processId: 28_407, startIdentity: '99123' });
		expect(receipt).toEqual({
			gatewayVmId: 'gateway-vm-test',
			processId: 28_407,
			role: 'framework',
			startIdentity: '99123',
		});
		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec.mock.calls[0]?.[0]).toContain('port_hex="$(printf \'%04X\' 18789)"');
		expect(exec.mock.calls[1]?.[0]).toContain('expected_start_identity=99123');
	});

	it('rejects a changed process identity without returning a termination receipt', async () => {
		// Arrange
		const exec = vi.fn<GatewayReliabilityFaultVmOperations['exec']>(() =>
			createManagedExecProcessStub({
				exitCode: 1,
				stderr: 'refusing to signal a process whose start identity changed',
			}),
		);

		// Act / Assert
		await expect(
			terminateManagedGatewaySibling({
				gatewayVm: { exec, id: 'gateway-vm-test' },
				identity: { processId: 28_407, startIdentity: '99123' },
				role: 'framework',
			}),
		).rejects.toThrow(/start identity changed/u);
	});
});
