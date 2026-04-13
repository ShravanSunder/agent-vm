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
				WORKER_CONFIG_PATH: '/state/effective-worker.json',
				WORKSPACE_DIR: '/workspace',
				...environmentSecrets,
			},
			mediatedSecrets,
			rootfsMode: 'cow',
			sessionLabel: `${zone.id}-worker`,
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
		return {
			bootstrapCommand: 'true',
			startCommand:
				'cd /workspace && nohup node /opt/agent-vm-worker/dist/main.js serve --port 18789 > /tmp/agent-vm-worker.log 2>&1 &',
			healthCheck: { type: 'http', port: 18789, path: '/health' },
			guestListenPort: 18789,
			logPath: '/tmp/agent-vm-worker.log',
		};
	},
};
