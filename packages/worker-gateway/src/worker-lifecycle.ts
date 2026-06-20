import type {
	BuildGatewayVmSpecOptions,
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayVmSpec,
} from '@agent-vm/gateway-interface';
import {
	buildGatewaySessionLabel,
	composeNodeOptions,
	controllerVmHost,
	gatewayVmAllowedHosts,
	splitResolvedGatewaySecrets,
} from '@agent-vm/gateway-interface';

const workerGatewayGuestPath = '/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

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
			allowedHosts: gatewayVmAllowedHosts(zone.egressHosts),
			environment: {
				HOME: '/home/coder',
				CONTROLLER_BASE_URL: 'http://controller.vm.host:18800',
				NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
				AGENT_VM_ZONE_ID: zone.id,
				PATH: workerGatewayGuestPath,
				PNPM_HOME: '/pnpm',
				STATE_DIR: '/state',
				WORKER_CONFIG_PATH: '/state/effective-worker.json',
				WORK_DIR: '/work',
				REPOS_DIR: '/work/repos',
				TMPDIR: '/work/tmp',
				TMP: '/work/tmp',
				TEMP: '/work/tmp',
				npm_config_cache: '/work/cache/npm',
				pnpm_config_store_dir: '/work/cache/pnpm/store',
				PIP_CACHE_DIR: '/work/cache/pip',
				UV_CACHE_DIR: '/work/cache/uv',
				...environmentSecrets,
				// NODE_OPTIONS goes AFTER the spread so a user-supplied
				// NODE_OPTIONS in environmentSecrets cannot drop the
				// forced IPv4-preference flags. composeNodeOptions
				// preserves the user value as additional flags.
				NODE_OPTIONS: composeNodeOptions(environmentSecrets.NODE_OPTIONS),
			},
			mediatedSecrets,
			rootfsMode: 'cow',
			...(zone.gateway.runtimeRootfsSize
				? { runtimeRootfsSize: zone.gateway.runtimeRootfsSize }
				: {}),
			sessionLabel: buildGatewaySessionLabel(projectNamespace, zone.id),
			tcpHosts: {
				[`${controllerVmHost}:18800`]: `127.0.0.1:${controllerPort}`,
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
				'export PNPM_HOME=/pnpm PATH=/pnpm:$PATH && mkdir -p /work/repos /work/tmp /work/cache/npm /work/cache/pnpm/store /work/cache/pip /work/cache/uv && if [ -f /state/agent-vm-worker.tgz ]; then pnpm add -g --ignore-scripts /state/agent-vm-worker.tgz && worker_package_root="$(pnpm root -g)" && worker_bin_target="$worker_package_root/@agent-vm/agent-vm-worker/dist/main.js" && test -f "$worker_bin_target" && chmod 755 "$worker_bin_target" && ln -sfn "$worker_bin_target" /pnpm/agent-vm-worker; fi',
			// printf NODE_OPTIONS into the boot log so an env-loss regression
			// is visible in the log stream without SSHing into the VM.
			// See FORCE_IPV4_EGRESS_NODE_OPTIONS in @agent-vm/gateway-interface.
			startCommand: `export PNPM_HOME=/pnpm PATH=/pnpm:$PATH && { printf 'worker-boot: NODE_OPTIONS=%s\\n' "$NODE_OPTIONS" > /tmp/agent-vm-worker.log; } && cd /work && nohup agent-vm-worker serve --port 18789 --config /state/effective-worker.json --state-dir /state >> /tmp/agent-vm-worker.log 2>&1 &`,
			healthCheck: { type: 'http', port: 18789, path: '/health' },
			serviceHealthCheck: { type: 'http', port: 18789, path: '/health' },
			guestListenPort: 18789,
			logPath: '/tmp/agent-vm-worker.log',
		};
	},
};
