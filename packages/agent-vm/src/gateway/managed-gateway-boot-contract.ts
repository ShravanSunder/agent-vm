import {
	parseManagedGatewayBootContract,
	type ManagedFrameworkServiceBootMetadata,
	type ManagedGatewayBootContract,
} from '@agent-vm/gateway-lifecycle';

import type { ManagedGatewayImageBootProjection } from '../build/gondolin-managed-vm-build-tooling.js';

export const managedGatewayBootInputPaths = Object.freeze({
	environmentRoot: '/run/agent-vm/managed-gateway-environment',
	structuredRoot: '/run/agent-vm/managed-gateway',
});

export function createManagedGatewayBootContract(
	frameworkService: ManagedFrameworkServiceBootMetadata,
): ManagedGatewayBootContract {
	return parseManagedGatewayBootContract({
		contractVersion: 1,
		frameworkService,
		kind: 'managed-gateway-exact-two-role',
		toolPortalService: {
			bootEntry: 'agent-vm-gateway-runtime',
			configurationInputPath: `${managedGatewayBootInputPaths.structuredRoot}/tool-portal-service.json`,
			environmentInputPath: `${managedGatewayBootInputPaths.environmentRoot}/tool-portal.environment.sh`,
			logIdentity: {
				guestPath: '/var/log/agent-vm/tool-portal-service.log',
				serviceName: 'agent-vm-tool-portal',
			},
			readiness: {
				evidencePath: '/run/agent-vm/gateway-runtime/tool-portal.readiness.json',
				kind: 'tool-portal-evidence',
				socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
			},
			role: 'tool-portal-service',
		},
	});
}

export function projectManagedGatewayBootForImage(
	contract: ManagedGatewayBootContract,
): ManagedGatewayImageBootProjection {
	return {
		frameworkBootEntry:
			contract.frameworkService.framework === 'openclaw'
				? 'openclaw-framework-service'
				: 'hermes-framework-service',
		kind: 'managed-gateway-exact-two-role',
	};
}
