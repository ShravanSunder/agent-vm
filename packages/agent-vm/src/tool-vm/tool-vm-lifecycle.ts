import { realpath } from 'node:fs/promises';
import path from 'node:path';

import {
	buildToolSessionLabel,
	createWebSocketUpgradeRequestGuard,
	egressHostsForAudience,
	FORCE_IPV4_EGRESS_NODE_OPTIONS,
	splitResolvedSecretsByInjection,
} from '@agent-vm/gateway-lifecycle';
import {
	closePinnedRealFsRoot as closePinnedRealFsRootDefault,
	createManagedVm as createManagedVmFromCore,
	pinRealFsRoot as pinRealFsRootDefault,
	type ManagedVm,
	type PinnedRealFsRoot,
} from '@agent-vm/gondolin-adapter';
import type { SecretResolver } from '@agent-vm/secret-management';

import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import { readPreparedGondolinImage } from '../build/prepared-gondolin-image-cache.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import type { ToolVmProfile } from '../controller/leases/lease-manager.js';
import {
	OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
	validateResolvedToolWorkMountDir as validateResolvedToolWorkMountDirDefault,
} from '../controller/leases/lease-work-mount-paths.js';
import {
	OPENCLAW_ZONE_FILES_GUEST_ROOT,
	OPENCLAW_ZONE_GIT_GUEST_ROOT,
	resolveZoneGitPaths,
	type ZoneGitToolVmMount,
} from '../controller/zone-git/zone-git-paths.js';
import { resolveZoneSecrets } from '../gateway/credential-manager.js';
import { terminateLiveManagedVm } from '../shared/controller-managed-vm-termination.js';
import {
	isProcessAlive,
	killProcess,
	readProcessCommand,
	readProcessIdentity,
	sleep,
	type ManagedVmKillDependencies,
	type ProcessIdentity,
} from '../shared/managed-vm-process.js';
import { selectToolVmMediatedSecretNamesForAgent } from './tool-vm-secret-selection.js';

const TOOL_VM_MEDIATED_ENV_PROFILE_PATH = '/etc/profile.d/agent-vm-mediated-env.sh';
const TOOL_VM_MEDIATED_ENVIRONMENT_PATH = '/etc/environment';
const TOOL_VM_MEDIATED_SSHD_CONFIG_PATH = '/etc/ssh/sshd_config';
const TOOL_VM_SSH_HOST_KEY_RESET_COMMAND = 'rm -f /etc/ssh/ssh_host_*';
const reservedToolVmMediatedSecretNames = new Set([
	'BASH_ENV',
	'HOME',
	'LOGNAME',
	'NODE_OPTIONS',
	'PATH',
	'SHELL',
	'USER',
]);
const shellEnvironmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface ToolVmLifecycleDependencies {
	readonly buildGondolinImage?: (options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
		readonly fullReset?: boolean;
	}) => ReturnType<typeof buildGondolinImageDefault>;
	readonly createManagedVm?: typeof createManagedVmFromCore;
	readonly managedVmKillDependencies?: ManagedVmKillDependencies;
	readonly closePinnedRealFsRoot?: (root: PinnedRealFsRoot) => void;
	readonly pinRealFsRoot?: (hostPath: string) => PinnedRealFsRoot;
	readonly validateResolvedToolWorkMountDir?: typeof validateResolvedToolWorkMountDirDefault;
}

export interface UnstartedToolVmProvisioning {
	readonly vm: ManagedVm;
	prepareStartedVm(): Promise<void>;
}

async function configureZoneGitToolVm(toolVm: ManagedVm): Promise<void> {
	const result = await toolVm.exec(
		`git config --global --add safe.directory ${OPENCLAW_ZONE_FILES_GUEST_ROOT}`,
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to configure Tool VM Git safe.directory for ${OPENCLAW_ZONE_FILES_GUEST_ROOT}: ${result.stderr || result.stdout}`,
		);
	}
}

async function resetInheritedToolVmSshHostIdentity(toolVm: ManagedVm): Promise<void> {
	const result = await toolVm.exec(TOOL_VM_SSH_HOST_KEY_RESET_COMMAND);
	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to remove inherited Tool VM SSH host identity: ${result.stderr || result.stdout}`,
		);
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertShellEnvironmentName(secretName: string): void {
	if (!shellEnvironmentNamePattern.test(secretName)) {
		throw new Error(
			`Tool VM mediated secret name '${secretName}' cannot be exported as a shell environment variable.`,
		);
	}
	if (reservedToolVmMediatedSecretNames.has(secretName)) {
		throw new Error(
			`Tool VM mediated secret name '${secretName}' is reserved by agent-vm runtime bootstrap.`,
		);
	}
}

function assertToolVmMediatedSecretNames(mediatedSecrets: Record<string, unknown>): void {
	for (const secretName of Object.keys(mediatedSecrets)) {
		assertShellEnvironmentName(secretName);
	}
}

function buildToolVmMediatedEnvBootstrapCommand(secretNames: readonly string[]): string {
	for (const secretName of secretNames) {
		assertShellEnvironmentName(secretName);
	}

	const quotedSecretNames = secretNames.map((secretName) => shellQuote(secretName)).join(' ');

	return [
		'set -eu',
		`profile_path=${shellQuote(TOOL_VM_MEDIATED_ENV_PROFILE_PATH)}`,
		`environment_path=${shellQuote(TOOL_VM_MEDIATED_ENVIRONMENT_PATH)}`,
		`sshd_config_path=${shellQuote(TOOL_VM_MEDIATED_SSHD_CONFIG_PATH)}`,
		"managed_start='# agent-vm mediated env start'",
		"managed_end='# agent-vm mediated env end'",
		'mkdir -p "$(dirname "$profile_path")" "$(dirname "$sshd_config_path")"',
		'profile_tmp="${profile_path}.$$"',
		'environment_tmp="${environment_path}.$$"',
		'sshd_config_tmp="${sshd_config_path}.$$"',
		'sshd_config_body_tmp="${sshd_config_path}.body.$$"',
		'trap \'rm -f "$profile_tmp" "$environment_tmp" "$sshd_config_tmp" "$sshd_config_body_tmp"\' EXIT',
		"missing=''",
		"unsafe=''",
		'{',
		`  printf '%s\\n' ${shellQuote('# Generated by agent-vm. Contains mediated secret placeholders only.')}`,
		`  for name in ${quotedSecretNames}; do`,
		'    value=$(printenv "$name" || true)',
		'    if [ -z "$value" ]; then',
		'      missing="${missing} ${name}"',
		'      continue',
		'    fi',
		'    case "$value" in',
		'      *[!A-Za-z0-9_./:@%+=,-]*)',
		'        unsafe="${unsafe} ${name}"',
		'        continue',
		'        ;;',
		'    esac',
		'    printf \'export %s=%s\\n\' "$name" "$value"',
		'  done',
		'} > "$profile_tmp"',
		'if [ -n "$missing" ]; then',
		'  rm -f "$profile_tmp" "$environment_tmp" "$sshd_config_tmp" "$sshd_config_body_tmp"',
		`  printf '%s%s\\n' ${shellQuote('Missing mediated placeholder env:')} "$missing" >&2`,
		'  exit 1',
		'fi',
		'if [ -n "$unsafe" ]; then',
		'  rm -f "$profile_tmp" "$environment_tmp" "$sshd_config_tmp" "$sshd_config_body_tmp"',
		`  printf '%s%s\\n' ${shellQuote('Unsafe mediated placeholder env:')} "$unsafe" >&2`,
		'  exit 1',
		'fi',
		'chmod 0644 "$profile_tmp"',
		'mv "$profile_tmp" "$profile_path"',
		'if [ -r "$environment_path" ]; then',
		'  sed \'/^# agent-vm mediated env start$/,/^# agent-vm mediated env end$/d\' "$environment_path" > "$environment_tmp"',
		'else',
		'  : > "$environment_tmp"',
		'fi',
		'{',
		'  printf \'%s\\n\' "$managed_start"',
		'  printf \'BASH_ENV=%s\\n\' "$profile_path"',
		`  for name in ${quotedSecretNames}; do`,
		'    value=$(printenv "$name")',
		'    printf \'%s=%s\\n\' "$name" "$value"',
		'  done',
		'  printf \'%s\\n\' "$managed_end"',
		'} >> "$environment_tmp"',
		'chmod 0644 "$environment_tmp"',
		'mv "$environment_tmp" "$environment_path"',
		'if [ -r "$sshd_config_path" ]; then',
		'  sed \'/^# agent-vm mediated env start$/,/^# agent-vm mediated env end$/d\' "$sshd_config_path" > "$sshd_config_body_tmp"',
		'else',
		'  : > "$sshd_config_body_tmp"',
		'fi',
		'{',
		'  printf \'%s\\n\' "$managed_start"',
		'  printf \'SetEnv BASH_ENV=%s\' "$profile_path"',
		`  for name in ${quotedSecretNames}; do`,
		'    value=$(printenv "$name")',
		'    printf \' %s=%s\' "$name" "$value"',
		'  done',
		"  printf '\\n'",
		'  printf \'%s\\n\' "$managed_end"',
		'  cat "$sshd_config_body_tmp"',
		'} > "$sshd_config_tmp"',
		'rm -f "$sshd_config_body_tmp"',
		'if [ -e "$sshd_config_path" ]; then',
		'  cat "$sshd_config_tmp" > "$sshd_config_path"',
		'  rm -f "$sshd_config_tmp"',
		'else',
		'  chmod 0644 "$sshd_config_tmp"',
		'  mv "$sshd_config_tmp" "$sshd_config_path"',
		'fi',
	].join('\n');
}

async function writeToolVmMediatedEnvBootstrap(
	toolVm: ManagedVm,
	mediatedSecrets: Record<string, unknown>,
): Promise<void> {
	const secretNames = Object.keys(mediatedSecrets).toSorted();
	if (secretNames.length === 0) {
		return;
	}

	const result = await toolVm.exec(buildToolVmMediatedEnvBootstrapCommand(secretNames));
	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to install Tool VM mediated secret placeholders: ${result.stderr || result.stdout}`,
		);
	}
}

export async function createUnstartedToolVm(
	options: {
		readonly agentId: string;
		readonly cacheDir: string;
		readonly profile: ToolVmProfile;
		readonly systemConfig: LoadedSystemConfig;
		readonly tcpSlot: number;
		readonly hostWorkMountDir: string;
		readonly zoneGitMount?: ZoneGitToolVmMount;
		readonly zoneId: string;
		readonly secretResolver: SecretResolver;
	},
	dependencies: ToolVmLifecycleDependencies = {},
): Promise<UnstartedToolVmProvisioning> {
	const buildGondolinImage = dependencies.buildGondolinImage ?? buildGondolinImageDefault;
	const createManagedVm = dependencies.createManagedVm ?? createManagedVmFromCore;
	const closePinnedRealFsRoot = dependencies.closePinnedRealFsRoot ?? closePinnedRealFsRootDefault;
	const pinRealFsRoot = dependencies.pinRealFsRoot ?? pinRealFsRootDefault;
	const validateResolvedToolWorkMountDir =
		dependencies.validateResolvedToolWorkMountDir ?? validateResolvedToolWorkMountDirDefault;
	const zone = options.systemConfig.zones.find(
		(configuredZone) => configuredZone.id === options.zoneId,
	);
	if (!zone) {
		throw new Error(`Zone '${options.zoneId}' is not configured.`);
	}
	const toolImageProfile = options.systemConfig.imageProfiles.toolVms[options.profile.imageProfile];
	if (!toolImageProfile) {
		throw new Error(`Tool VM image profile '${options.profile.imageProfile}' is not configured.`);
	}
	// Fail bad lease paths before doing any expensive image work.
	await validateResolvedToolWorkMountDir({
		hostWorkMountDir: options.hostWorkMountDir,
		zone,
	});
	const toolVmSecretNames = selectToolVmMediatedSecretNamesForAgent({
		agentId: options.agentId,
		zone,
	});
	const resolvedSecrets = await resolveZoneSecrets({
		audience: 'tool-vm',
		injection: 'http-mediation',
		secretNames: toolVmSecretNames,
		secretResolver: options.secretResolver,
		systemConfig: options.systemConfig,
		zoneId: options.zoneId,
	});
	const { mediatedSecrets } = splitResolvedSecretsByInjection(zone.secrets, resolvedSecrets, {
		audience: 'tool-vm',
		logPrefix: 'tool-vm-secrets',
	});
	const toolImageCacheDir = path.join(
		options.cacheDir,
		'tool-vm-images',
		options.profile.imageProfile,
	);
	const preparedToolImage = await readPreparedGondolinImage({
		buildConfigPath: toolImageProfile.buildConfig,
		cacheDir: toolImageCacheDir,
	});
	const toolImage =
		preparedToolImage ??
		(await buildGondolinImage({
			buildConfigPath: toolImageProfile.buildConfig,
			cacheDir: toolImageCacheDir,
		}));

	// Internal createToolVm callers bypass the /lease route; validate and pin
	// immediately before handing the RealFS root to the VM adapter.
	const hostWorkMountDirectory = await validateResolvedToolWorkMountDir({
		hostWorkMountDir: options.hostWorkMountDir,
		zone,
	});
	const pinnedRoots: PinnedRealFsRoot[] = [];
	const pinRoot = (hostPath: string): PinnedRealFsRoot => {
		const pinnedRoot = pinRealFsRoot(hostPath);
		pinnedRoots.push(pinnedRoot);
		return pinnedRoot;
	};
	let pinnedRootsTransferredToManagedVm = false;
	let toolVm: ManagedVm | undefined;
	try {
		let vfsMounts: Parameters<typeof createManagedVm>[0]['vfsMounts'];
		if (options.zoneGitMount) {
			const hostZoneFilesDirectory = await validateResolvedToolWorkMountDir({
				hostWorkMountDir: options.zoneGitMount.hostZoneFilesDir,
				zone,
			});
			const hostZoneGitRoot = await realpath(options.zoneGitMount.hostZoneGitRoot);
			const expectedZoneGitRoot = await realpath(
				resolveZoneGitPaths({
					runtimeDir: options.systemConfig.runtimeDir,
					zoneId: options.zoneId,
				}).hostZoneGitRoot,
			);
			if (hostZoneGitRoot !== expectedZoneGitRoot) {
				throw new Error(
					`Zone Git root '${hostZoneGitRoot}' does not match expected runtime path '${expectedZoneGitRoot}' for zone '${options.zoneId}'.`,
				);
			}
			const pinnedZoneFilesRoot = pinRoot(hostZoneFilesDirectory);
			const pinnedZoneGitRoot = pinRoot(hostZoneGitRoot);
			await validateResolvedToolWorkMountDir({
				hostWorkMountDir: pinnedZoneFilesRoot.realPath,
				zone,
			});
			vfsMounts = {
				[OPENCLAW_ZONE_GIT_GUEST_ROOT]: {
					hostPath: hostZoneGitRoot,
					kind: 'realfs',
					pinnedHostRoot: pinnedZoneGitRoot,
				},
				[OPENCLAW_ZONE_FILES_GUEST_ROOT]: {
					hostPath: hostZoneFilesDirectory,
					kind: 'realfs',
					pinnedHostRoot: pinnedZoneFilesRoot,
				},
			};
		} else {
			const pinnedWorkMountRoot = pinRoot(hostWorkMountDirectory);
			await validateResolvedToolWorkMountDir({
				hostWorkMountDir: pinnedWorkMountRoot.realPath,
				zone,
			});
			vfsMounts = {
				[OPENCLAW_TOOL_VM_WORKSPACE_MOUNT]: {
					hostPath: hostWorkMountDirectory,
					kind: 'realfs',
					pinnedHostRoot: pinnedWorkMountRoot,
				},
			};
		}
		// createManagedVm owns every pinned root in vfsMounts once invoked. It
		// closes them on construction failure and through ManagedVm.close().
		// The lifecycle retains ownership only for failures before this boundary.
		pinnedRootsTransferredToManagedVm = true;
		toolVm = await createManagedVm({
			allowedHosts: egressHostsForAudience(zone.egressHosts, 'tool-vm'),
			cpus: options.profile.cpus,
			env: {
				NODE_OPTIONS: FORCE_IPV4_EGRESS_NODE_OPTIONS,
			},
			imagePath: toolImage.imagePath,
			memory: options.profile.memory,
			rootfsMode: 'cow',
			...(options.profile.runtimeRootfsSize
				? { runtimeRootfsSize: options.profile.runtimeRootfsSize }
				: {}),
			onRequest: createWebSocketUpgradeRequestGuard({
				rules: zone.websocketUpgrades ?? [],
				runtimeAudience: 'tool-vm',
			}),
			sessionLabel: buildToolSessionLabel(
				options.systemConfig.host.projectNamespace,
				options.zoneId,
				options.tcpSlot,
			),
			secrets: mediatedSecrets,
			vfsMounts,
		});
		const createdToolVm = toolVm;
		return {
			async prepareStartedVm(): Promise<void> {
				assertToolVmMediatedSecretNames(mediatedSecrets);
				await resetInheritedToolVmSshHostIdentity(createdToolVm);
				await writeToolVmMediatedEnvBootstrap(createdToolVm, mediatedSecrets);
				if (options.zoneGitMount) {
					await configureZoneGitToolVm(createdToolVm);
				}
			},
			vm: createdToolVm,
		};
	} catch (error) {
		let closeError: unknown;
		if (toolVm) {
			try {
				await toolVm.close();
			} catch (caughtCloseError) {
				closeError = caughtCloseError;
			}
		}
		if (!pinnedRootsTransferredToManagedVm) {
			for (const pinnedRoot of pinnedRoots) {
				closePinnedRealFsRoot(pinnedRoot);
			}
		}
		if (closeError !== undefined) {
			const aggregateError = new AggregateError(
				[error, closeError],
				'Tool VM creation failed and cleanup also failed.',
			);
			aggregateError.cause = error;
			throw aggregateError;
		}
		throw error;
	}
}

export async function createToolVm(
	options: Parameters<typeof createUnstartedToolVm>[0],
	dependencies: ToolVmLifecycleDependencies = {},
): Promise<ManagedVm> {
	const provisioning = await createUnstartedToolVm(options, dependencies);
	const { vm } = provisioning;
	let processTarget:
		| {
				readonly hostPid: number;
				readonly processIdentity: ProcessIdentity;
				readonly vmId: string;
		  }
		| undefined;
	try {
		await vm.start();
		const hostPid = vm.getHostPid();
		if (hostPid !== null) {
			const identityReader =
				dependencies.managedVmKillDependencies?.readProcessIdentity ?? readProcessIdentity;
			const processIdentity = await identityReader(hostPid);
			if (processIdentity === null) {
				throw new Error(
					`Tool VM '${vm.id}' pid ${String(hostPid)} disappeared before process identity capture.`,
				);
			}
			processTarget = { hostPid, processIdentity, vmId: vm.id };
		}
		await provisioning.prepareStartedVm();
		return vm;
	} catch (error) {
		let cleanupError: unknown;
		try {
			if (processTarget === undefined) {
				if (vm.getHostPid() !== null) {
					throw new Error(
						`Tool VM '${vm.id}' has a live runner without captured process identity; refusing stock close.`,
						{ cause: error },
					);
				}
				await vm.close();
			} else {
				await terminateLiveManagedVm({
					contextLabel: `Tool VM '${vm.id}' creation rollback`,
					dependencies: dependencies.managedVmKillDependencies ?? {
						isProcessAlive,
						killProcess,
						readProcessCommand,
						readProcessIdentity,
						sleep,
					},
					target: processTarget,
					vm,
				});
			}
		} catch (caughtCleanupError) {
			cleanupError = caughtCleanupError;
		}
		if (cleanupError !== undefined) {
			const aggregateError = new AggregateError(
				[error, cleanupError],
				'Tool VM preparation failed and controller-managed cleanup also failed.',
			);
			aggregateError.cause = error;
			throw aggregateError;
		}
		throw error;
	}
}
