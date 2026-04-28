import type {
	BuildGatewayVmSpecOptions,
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayVmSpec,
} from '@agent-vm/gateway-interface';
import { buildGatewaySessionLabel, splitResolvedGatewaySecrets } from '@agent-vm/gateway-interface';

export const workerLifecycle: GatewayLifecycle = {
	buildVmSpec({
		controllerPort,
		projectNamespace,
		resolvedSecrets,
		zone,
	}: BuildGatewayVmSpecOptions): GatewayVmSpec {
		if (zone.gateway.type !== 'worker') {
			throw new Error(`Worker lifecycle cannot build gateway type '${zone.gateway.type}'.`);
		}
		const { environmentSecrets, mediatedSecrets } = splitResolvedGatewaySecrets(
			zone,
			resolvedSecrets,
		);

		return {
			allowedHosts: [...zone.allowedHosts],
			environment: {
				HOME: '/home/coder',
				CONTROLLER_BASE_URL: 'http://controller.vm.host:18800',
				NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
				AGENT_VM_ZONE_ID: zone.id,
				STATE_DIR: '/state',
				WORKER_CONFIG_PATH: '/state/effective-worker.json',
				WORK_DIR: '/work',
				REPOS_DIR: '/work/repos',
				TMPDIR: '/work/tmp',
				TMP: '/work/tmp',
				TEMP: '/work/tmp',
				npm_config_cache: '/work/cache/npm',
				PIP_CACHE_DIR: '/work/cache/pip',
				UV_CACHE_DIR: '/work/cache/uv',
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
			},
		};
	},

	buildProcessSpec(): GatewayProcessSpec {
		return {
			bootstrapCommand:
				'mkdir -p /work/repos /work/tmp /work/cache/npm /work/cache/pip /work/cache/uv && if [ -f /state/agent-vm-worker.tgz ]; then npm install -g --force @openai/codex /state/agent-vm-worker.tgz; fi',
			startCommand:
				'cd /work && nohup agent-vm-worker serve --port 18789 --config /state/effective-worker.json --state-dir /state > /tmp/agent-vm-worker.log 2>&1 &',
			healthCheck: { type: 'http', port: 18789, path: '/health' },
			guestListenPort: 18789,
			logPath: '/tmp/agent-vm-worker.log',
		};
	},
};
