import type { ManagedHermesServiceBootMetadata } from '@agent-vm/gateway-lifecycle';
import { describe, expect, it } from 'vitest';

import {
	createManagedGatewayBootContract,
	managedGatewayBootInputPaths,
	projectManagedGatewayBootForImage,
} from './managed-gateway-boot-contract.js';

const hermesFrameworkService = {
	bootEntry: 'hermes-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway-environment/framework.environment.sh',
	framework: 'hermes',
	ingress: { guestPort: 18789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/hermes-service.log',
		serviceName: 'agent-vm-hermes-test',
	},
	readiness: { guestPort: 18789, kind: 'framework-http', path: '/readyz' },
	role: 'framework-service',
} as const satisfies ManagedHermesServiceBootMetadata;

describe('managed Gateway boot composition', () => {
	it('joins one common Tool Portal entry with one selected framework entry', () => {
		// Act
		const contract = createManagedGatewayBootContract(hermesFrameworkService);

		// Assert
		expect(contract.toolPortalService).toMatchObject({
			bootEntry: 'agent-vm-gateway-runtime',
			configurationInputPath: '/run/agent-vm/managed-gateway/tool-portal-service.json',
			environmentInputPath: '/run/agent-vm/managed-gateway-environment/tool-portal.environment.sh',
			role: 'tool-portal-service',
		});
		expect(contract.frameworkService).toEqual(hermesFrameworkService);
		expect(Object.isFrozen(contract)).toBe(true);
		expect(Object.isFrozen(contract.toolPortalService)).toBe(true);
	});

	it('separates writable environment staging from read-only structured inputs', () => {
		expect(managedGatewayBootInputPaths).toEqual({
			environmentRoot: '/run/agent-vm/managed-gateway-environment',
			structuredRoot: '/run/agent-vm/managed-gateway',
		});
		expect(Object.isFrozen(managedGatewayBootInputPaths)).toBe(true);
	});

	it('projects only the closed image boot discriminator to the backend build seam', () => {
		// Act
		const projection = projectManagedGatewayBootForImage(
			createManagedGatewayBootContract(hermesFrameworkService),
		);

		// Assert
		expect(projection).toEqual({
			frameworkBootEntry: 'hermes-framework-service',
			kind: 'managed-gateway-exact-two-role',
		});
		expect(projection).not.toHaveProperty('configurationInputPath');
		expect(projection).not.toHaveProperty('environmentInputPath');
		expect(projection).not.toHaveProperty('command');
	});
});
