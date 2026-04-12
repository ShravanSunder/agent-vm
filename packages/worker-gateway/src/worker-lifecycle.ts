import type {
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayVmSpec,
	GatewayZoneConfig,
} from 'gateway-interface';
import { splitResolvedGatewaySecrets } from 'gateway-interface';

export const workerLifecycle: GatewayLifecycle = {
	buildVmSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
		controllerPort: number,
	): GatewayVmSpec {
		const { environmentSecrets, mediatedSecrets } = splitResolvedGatewaySecrets(
			zone,
			resolvedSecrets,
		);

		return {
			allowedHosts: [...zone.allowedHosts],
			environment: {
				HOME: '/home/coder',
				NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
				STATE_DIR: '/state',
				...environmentSecrets,
			},
			mediatedSecrets,
			rootfsMode: 'cow',
			sessionLabel: `${zone.id}-coding`,
			tcpHosts: {
				'controller.vm.host:18800': `127.0.0.1:${controllerPort}`,
			},
			vfsMounts: {
				'/state': {
					hostPath: zone.gateway.stateDir,
					kind: 'realfs',
				},
				'/workspace': {
					hostPath: zone.gateway.workspaceDir,
					kind: 'realfs',
				},
			},
		};
	},

	buildProcessSpec(): GatewayProcessSpec {
		throw new Error(
			"Worker gateway process start is blocked: 'agent-vm-worker' is not present in this repo yet.",
		);
	},
};
