import { MANAGED_VM_OWNERSHIP_PRINCIPAL_MAX_CODE_UNITS } from '@agent-vm/gondolin-adapter';
import { describe, expect, it } from 'vitest';

import {
	serializeVmOwnershipPrincipal,
	type VmOwnershipPrincipal,
} from './vm-ownership-contracts.js';

const maximumConfigPath = `/${'p'.repeat(4095)}`;
const maximumText = 'a'.repeat(1024);

const maximumPrincipals = [
	{
		configPath: maximumConfigPath,
		controllerPort: 65_535,
		kind: 'gateway-zone',
		projectNamespace: maximumText,
		zoneId: maximumText,
	},
	{
		agentId: maximumText,
		configPath: maximumConfigPath,
		controllerPort: 65_535,
		kind: 'stable-agent',
		projectNamespace: maximumText,
		zoneId: maximumText,
	},
	{
		configPath: maximumConfigPath,
		controllerPort: 65_535,
		kind: 'worker-task',
		projectNamespace: maximumText,
		taskId: maximumText,
		zoneId: maximumText,
	},
] satisfies readonly VmOwnershipPrincipal[];

describe('VM ownership principal serialization', () => {
	it.each(maximumPrincipals)('preserves a maximum valid $kind authority record', (principal) => {
		const serialized = serializeVmOwnershipPrincipal(principal);

		expect(JSON.parse(serialized)).toEqual(principal);
		expect(serialized.length).toBeLessThanOrEqual(MANAGED_VM_OWNERSHIP_PRINCIPAL_MAX_CODE_UNITS);
	});

	it('rejects typed values that do not satisfy the runtime ownership schema', () => {
		const overlongStableAgentPrincipal = {
			agentId: 'a'.repeat(1025),
			configPath: maximumConfigPath,
			controllerPort: 65_535,
			kind: 'stable-agent' as const,
			projectNamespace: maximumText,
			zoneId: maximumText,
		};

		expect(() => serializeVmOwnershipPrincipal(overlongStableAgentPrincipal)).toThrow();
	});
});
