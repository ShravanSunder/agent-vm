import type { BuildGatewayVmSpecOptions, GatewayProcessSpec } from '@agent-vm/gateway-contracts';
import {
	buildGatewaySessionLabel,
	composeNodeOptions,
	normalizeGitReposForSshReadAllowlist,
	splitResolvedGatewaySecrets,
	workerVmAllowedHosts,
} from '@agent-vm/gateway-contracts';
import {
	createGitReadOnlySshEgressOptions,
	type ManagedSshEgressOptions,
} from '@agent-vm/gondolin-adapter';
import type {
	GondolinGatewayLifecycle,
	GondolinGatewayVmSpec,
} from '@agent-vm/gondolin-gateway-types';

const workerGatewayGuestPath = '/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function buildWorkerBootstrapCommand(): string {
	return [
		'export PNPM_HOME=/pnpm PATH=/pnpm:$PATH',
		'mkdir -p /work/repos /work/tmp /work/cache/npm /work/cache/pnpm/store /work/cache/pip /work/cache/uv',
		'if [ -f /state/agent-vm-worker-packages/package.json ]; then cd /state/agent-vm-worker-packages && pnpm install --prod --ignore-scripts && worker_package_root="/state/agent-vm-worker-packages/node_modules"; elif [ -f /state/agent-vm-worker.tgz ]; then pnpm add -g --ignore-scripts /state/agent-vm-worker.tgz && worker_package_root="$(pnpm root -g --silent)"; fi',
		'if [ -n "${worker_package_root:-}" ]; then worker_bin_target="$worker_package_root/@agent-vm/agent-vm-worker/dist/main.js" && test -f "$worker_bin_target" && chmod 755 "$worker_bin_target" && ln -sfn "$worker_bin_target" /pnpm/agent-vm-worker; fi',
	].join(' && ');
}

function createManagedGitReadOnlySshEgressOptions(options: {
	readonly gitReadAllowlistRepos: readonly string[] | undefined;
}): ManagedSshEgressOptions | undefined {
	const agent = process.env.SSH_AUTH_SOCK;
	if (agent === undefined || agent.length === 0) {
		return undefined;
	}
	const normalizedAllowlist = normalizeGitReposForSshReadAllowlist(options.gitReadAllowlistRepos);
	if (
		normalizedAllowlist.allowedHosts.length === 0 ||
		normalizedAllowlist.allowedRepos.length === 0
	) {
		return undefined;
	}
	return createGitReadOnlySshEgressOptions({
		agent,
		allowedHosts: normalizedAllowlist.allowedHosts,
		allowedRepos: normalizedAllowlist.allowedRepos,
	});
}

export const workerLifecycle: GondolinGatewayLifecycle = {
	buildVmSpec({
		projectNamespace,
		resolvedSecrets,
		zone,
	}: BuildGatewayVmSpecOptions): GondolinGatewayVmSpec {
		if (zone.gateway.type !== 'worker') {
			throw new Error(`Worker lifecycle cannot build gateway type '${zone.gateway.type}'.`);
		}
		const { environmentSecrets, mediatedSecrets } = splitResolvedGatewaySecrets(
			zone,
			resolvedSecrets,
		);
		const sshEgress = createManagedGitReadOnlySshEgressOptions({
			gitReadAllowlistRepos: zone.gitReadAllowlistRepos,
		});

		return {
			allowedHosts: workerVmAllowedHosts(zone.egressHosts),
			environment: {
				HOME: '/home/coder',
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
			...(sshEgress === undefined ? {} : { sshEgress }),
			tcpHosts: {},
			websocketUpgrades: zone.websocketUpgrades ?? [],
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
			bootstrapCommand: buildWorkerBootstrapCommand(),
			// printf NODE_OPTIONS into the boot log so an env-loss regression
			// is visible in the log stream without SSHing into the VM.
			// See FORCE_IPV4_EGRESS_NODE_OPTIONS in @agent-vm/gateway-contracts.
			startCommand: `export PNPM_HOME=/pnpm PATH=/pnpm:$PATH && { printf 'worker-boot: NODE_OPTIONS=%s\\n' "$NODE_OPTIONS" > /tmp/agent-vm-worker.log; } && cd /work && nohup agent-vm-worker serve --port 18789 --config /state/effective-worker.json --state-dir /state >> /tmp/agent-vm-worker.log 2>&1 &`,
			healthCheck: { type: 'http', port: 18789, path: '/health' },
			serviceHealthCheck: { type: 'http', port: 18789, path: '/health' },
			guestListenPort: 18789,
			logPath: '/tmp/agent-vm-worker.log',
		};
	},
};
