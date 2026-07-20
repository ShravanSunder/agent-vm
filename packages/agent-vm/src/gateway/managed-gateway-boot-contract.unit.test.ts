import type { ManagedOpenClawServiceBootMetadata } from '@agent-vm/gateway-lifecycle';
import { describe, expect, it } from 'vitest';

import {
	createManagedGatewayBootContract,
	managedGatewayBootInputPaths,
	projectManagedGatewayBootForImage,
} from './managed-gateway-boot-contract.js';

const openClawFrameworkService = {
	bootEntry: 'openclaw-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'openclaw',
	ingress: { guestPort: 18789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/openclaw-service.log',
		serviceName: 'agent-vm-openclaw-test',
	},
	readiness: { guestPort: 18789, kind: 'framework-http', path: '/readyz' },
	role: 'framework-service',
} as const satisfies ManagedOpenClawServiceBootMetadata;

describe('managed Gateway boot composition', () => {
	it('joins one common Tool Portal entry with one selected framework entry', () => {
		// Act
		const contract = createManagedGatewayBootContract(openClawFrameworkService);

		// Assert
		expect(contract.toolPortalService).toMatchObject({
			bootEntry: 'agent-vm-gateway-runtime',
			configurationInputPath: '/run/agent-vm/managed-gateway/tool-portal-service.json',
			environmentInputPath: '/run/agent-vm/managed-gateway/tool-portal.environment.sh',
			role: 'tool-portal-service',
		});
		expect(contract.frameworkService).toEqual(openClawFrameworkService);
		expect(Object.isFrozen(contract)).toBe(true);
		expect(Object.isFrozen(contract.toolPortalService)).toBe(true);
	});

	it('separates the controller-mounted staging root from service-owned runtime inputs', () => {
		expect(managedGatewayBootInputPaths).toEqual({
			runtimeRoot: '/run/agent-vm/managed-gateway',
			stagingRoot: '/run/agent-vm/managed-gateway-inputs',
		});
		expect(Object.isFrozen(managedGatewayBootInputPaths)).toBe(true);
	});

	it('projects only the closed image boot discriminator to the backend build seam', () => {
		// Act
		const projection = projectManagedGatewayBootForImage(
			createManagedGatewayBootContract(openClawFrameworkService),
		);

		// Assert
		expect(projection).toEqual({
			frameworkBootEntry: 'openclaw-framework-service',
			kind: 'managed-gateway-exact-two-role',
		});
		expect(projection).not.toHaveProperty('configurationInputPath');
		expect(projection).not.toHaveProperty('environmentInputPath');
		expect(projection).not.toHaveProperty('command');
	});
});
