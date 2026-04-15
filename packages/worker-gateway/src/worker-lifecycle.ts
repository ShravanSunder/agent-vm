import type {
	BuildGatewayVmSpecOptions,
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayVmSpec,
} from '@shravansunder/gateway-interface';
import {
	buildGatewaySessionLabel,
	splitResolvedGatewaySecrets,
} from '@shravansunder/gateway-interface';

export const workerLifecycle: GatewayLifecycle = {
	buildVmSpec({
		controllerPort,
		projectNamespace,
		resolvedSecrets,
		zone,
	}: BuildGatewayVmSpecOptions): GatewayVmSpec {
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
			sessionLabel: buildGatewaySessionLabel(projectNamespace, zone.id),
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
			bootstrapCommand:
				'if [ -f /state/agent-vm-worker.tgz ]; then npm install -g @openai/codex /state/agent-vm-worker.tgz; fi',
			startCommand:
				'cd /workspace && nohup agent-vm-worker serve --port 18789 --config /state/effective-worker.json --state-dir /state > /tmp/agent-vm-worker.log 2>&1 &',
			healthCheck: { type: 'http', port: 18789, path: '/health' },
			guestListenPort: 18789,
			logPath: '/tmp/agent-vm-worker.log',
		};
	},
};
