import { realpath } from 'node:fs/promises';
import path from 'node:path';

import {
	buildToolSessionLabel,
	createWebSocketUpgradeRequestGuard,
	egressHostsForAudience,
	FORCE_IPV4_EGRESS_NODE_OPTIONS,
	normalizeGitReposForSshReadAllowlist,
	splitResolvedSecretsByInjection,
} from '@agent-vm/gateway-lifecycle';
import {
	type ManagedVm,
	type ManagedVmExactProcessTerminationCapability,
	type ManagedVmFactory,
	type ManagedVmFilteredWorkspacePolicy,
	type ManagedVmGitReadOnlySshEgress,
	type ManagedVmImageCapability,
	type ManagedVmOwnedDirectoryCapability,
} from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { ToolVmProfile } from '../controller/leases/lease-manager.js';
import { validateControllerSelectedToolVmDirectory as validateControllerSelectedToolVmDirectoryDefault } from '../controller/leases/lease-work-mount-paths.js';
import { resolveZoneSecrets } from '../gateway/credential-manager.js';
import { resolveManagedAgentGitDirectoryRoot } from '../gateway/managed-agent-root-storage.js';
import { terminateLiveManagedVm } from '../shared/controller-managed-vm-termination.js';
import { readProcessIdentity, sleep, type ProcessIdentity } from '../shared/managed-vm-process.js';
import { createManagedVmWithFilteredAgentWorkspace } from './managed-agent-tool-vm-mounts.js';
import { selectToolVmMediatedSecretNamesForAgent } from './tool-vm-secret-selection.js';

const TOOL_VM_MEDIATED_ENV_PROFILE_PATH = '/etc/profile.d/agent-vm-mediated-env.sh';
const TOOL_VM_MEDIATED_ENVIRONMENT_PATH = '/etc/environment';
const TOOL_VM_MEDIATED_SSHD_CONFIG_PATH = '/etc/ssh/sshd_config';
const TOOL_VM_GIT_SAFE_DIRECTORY_ARGV = [
	'git',
	'config',
	'--system',
	'--replace-all',
	'safe.directory',
	'/workspace',
] as const;
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
	readonly managedAgentRootMountDependencies?: Parameters<
		typeof createManagedVmWithFilteredAgentWorkspace
	>[1];
	readonly managedVmFactory: ManagedVmFactory;
	readonly managedVmImages: ManagedVmImageCapability;
	readonly managedVmOwnedDirectories: ManagedVmOwnedDirectoryCapability;
	readonly validateControllerSelectedToolVmDirectory?: typeof validateControllerSelectedToolVmDirectoryDefault;
}

export interface StartedToolVmLifecycleDependencies extends ToolVmLifecycleDependencies {
	readonly managedVmExactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmTerminationSleep?: (delayMs: number) => Promise<void>;
	readonly readProcessIdentity?: typeof readProcessIdentity;
}

export interface UnstartedToolVmProvisioning {
	readonly vm: ManagedVm;
	prepareStartedVm(): Promise<void>;
}

export interface ToolVmRootBinding {
	readonly hostGitDirectoryRoot: string;
	readonly hostWorkspaceRoot: string;
	readonly kind: 'managed-agent-workspace';
}

function managedAgentWorkspacePolicy(
	zone: LoadedSystemConfig['zones'][number],
): ManagedVmFilteredWorkspacePolicy {
	if (zone.gateway.type === 'worker') {
		throw new Error(
			`Gateway type '${zone.gateway.type}' does not yet define a managed agent workspace policy.`,
		);
	}
	return {
		hiddenPaths: [],
		readonlyInputs: [],
		temporaryPaths: [],
		visibility: { kind: 'whole-root-writable' },
	};
}

function createManagedAgentGitReadOnlySshEgress(options: {
	readonly agentId: string;
	readonly zone: LoadedSystemConfig['zones'][number];
}): ManagedVmGitReadOnlySshEgress | undefined {
	const configuredAgent = options.zone.agents?.find((agent) => agent.id === options.agentId);
	if (configuredAgent?.workspaceGit?.mode !== 'remote') {
		return undefined;
	}
	const agentSocket = process.env.SSH_AUTH_SOCK;
	if (agentSocket === undefined || agentSocket.length === 0) {
		return undefined;
	}
	const normalizedAllowlist = normalizeGitReposForSshReadAllowlist([
		configuredAgent.workspaceGit.remote.repoUrl,
	]);
	if (
		normalizedAllowlist.allowedHosts.length === 0 ||
		normalizedAllowlist.allowedRepos.length === 0
	) {
		return undefined;
	}
	return {
		agentSocket,
		allowedHosts: normalizedAllowlist.allowedHosts,
		allowedRepositories: normalizedAllowlist.allowedRepos,
		kind: 'git-read-only',
	};
}

async function validateControllerDerivedAgentGitDirectoryRoot(options: {
	readonly agentId: string;
	readonly hostGitDirectoryRoot: string;
	readonly runtimeDir: string;
	readonly zoneId: string;
}): Promise<string> {
	const [hostGitDirectoryRoot, expectedGitDirectoryRoot] = await Promise.all([
		realpath(options.hostGitDirectoryRoot),
		realpath(
			resolveManagedAgentGitDirectoryRoot({
				agentId: options.agentId,
				runtimeDir: options.runtimeDir,
				zoneId: options.zoneId,
			}),
		),
	]);
	if (hostGitDirectoryRoot !== expectedGitDirectoryRoot) {
		throw new Error(
			`Managed agent Git directory root '${hostGitDirectoryRoot}' does not match controller-derived path '${expectedGitDirectoryRoot}'.`,
		);
	}
	return hostGitDirectoryRoot;
}

async function resetInheritedToolVmSshHostIdentity(toolVm: ManagedVm): Promise<void> {
	const result = await toolVm.exec(TOOL_VM_SSH_HOST_KEY_RESET_COMMAND);
	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to remove inherited Tool VM SSH host identity: ${result.stderr || result.stdout}`,
		);
	}
}

async function configureToolVmGitSafeDirectory(toolVm: ManagedVm): Promise<void> {
	const result = await toolVm.exec(TOOL_VM_GIT_SAFE_DIRECTORY_ARGV);
	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to configure the Tool VM Git safe directory: ${result.stderr || result.stdout}`,
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
		readonly rootBinding: ToolVmRootBinding;
		readonly zoneId: string;
		readonly secretResolver: SecretResolver;
	},
	dependencies: ToolVmLifecycleDependencies,
): Promise<UnstartedToolVmProvisioning> {
	const validateControllerSelectedToolVmDirectory =
		dependencies.validateControllerSelectedToolVmDirectory ??
		validateControllerSelectedToolVmDirectoryDefault;
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
	await Promise.all([
		validateControllerSelectedToolVmDirectory({
			agentId: options.agentId,
			hostDirectory: options.rootBinding.hostWorkspaceRoot,
			kind: 'managed-agent-workspace',
			zone,
		}),
		validateControllerDerivedAgentGitDirectoryRoot({
			agentId: options.agentId,
			hostGitDirectoryRoot: options.rootBinding.hostGitDirectoryRoot,
			runtimeDir: options.systemConfig.runtimeDir,
			zoneId: options.zoneId,
		}),
	]);
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
	const toolImage = await dependencies.managedVmImages.prepareImage({
		cacheDirectory: toolImageCacheDir,
		recipePath: toolImageProfile.buildConfig,
	});
	const sshEgress = createManagedAgentGitReadOnlySshEgress({
		agentId: options.agentId,
		zone,
	});

	// Internal createToolVm callers bypass the /lease route; validate and acquire
	// host-directory authority immediately before handing it to the provider.
	const managedAgentWorkspaceRoot = {
		hostGitDirectoryRoot: await validateControllerDerivedAgentGitDirectoryRoot({
			agentId: options.agentId,
			hostGitDirectoryRoot: options.rootBinding.hostGitDirectoryRoot,
			runtimeDir: options.systemConfig.runtimeDir,
			zoneId: options.zoneId,
		}),
		hostWorkspaceRoot: await validateControllerSelectedToolVmDirectory({
			agentId: options.agentId,
			hostDirectory: options.rootBinding.hostWorkspaceRoot,
			kind: 'managed-agent-workspace',
			zone,
		}),
	};
	let toolVm: ManagedVm | undefined;
	try {
		const managedVmRequest = {
			allowedHosts: egressHostsForAudience(zone.egressHosts, 'tool-vm'),
			environment: {
				NODE_OPTIONS: FORCE_IPV4_EGRESS_NODE_OPTIONS,
			},
			imageReference: toolImage.imageReference,
			mediatedSecrets: Object.entries(mediatedSecrets).map(([environmentVariable, secret]) => ({
				allowedHosts: secret.hosts,
				environmentVariable,
				value: secret.value,
			})),
			mediation: {
				onRequest: createWebSocketUpgradeRequestGuard({
					rules: zone.websocketUpgrades ?? [],
					runtimeAudience: 'tool-vm',
				}),
			},
			resources: { cpuCount: options.profile.cpus, memory: options.profile.memory },
			rootfsMode: 'cow' as const,
			...(options.profile.runtimeRootfsSize
				? { runtimeRootfsSize: options.profile.runtimeRootfsSize }
				: {}),
			sessionLabel: buildToolSessionLabel(
				options.systemConfig.host.projectNamespace,
				options.zoneId,
				options.tcpSlot,
			),
			...(sshEgress === undefined ? {} : { sshEgress }),
			tcpHosts: [],
		};
		toolVm = await createManagedVmWithFilteredAgentWorkspace(
			{
				factory: dependencies.managedVmFactory,
				hostGitDirectoryRoot: managedAgentWorkspaceRoot.hostGitDirectoryRoot,
				hostWorkspaceRoot: managedAgentWorkspaceRoot.hostWorkspaceRoot,
				ownedDirectories: dependencies.managedVmOwnedDirectories,
				request: managedVmRequest,
				workspacePolicy: managedAgentWorkspacePolicy(zone),
			},
			dependencies.managedAgentRootMountDependencies,
		);
		const createdToolVm = toolVm;
		return {
			async prepareStartedVm(): Promise<void> {
				assertToolVmMediatedSecretNames(mediatedSecrets);
				await resetInheritedToolVmSshHostIdentity(createdToolVm);
				await configureToolVmGitSafeDirectory(createdToolVm);
				await writeToolVmMediatedEnvBootstrap(createdToolVm, mediatedSecrets);
			},
			vm: createdToolVm,
		};
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		if (toolVm) {
			try {
				await toolVm.close();
			} catch (caughtCloseError) {
				cleanupErrors.push(caughtCloseError);
			}
		}
		if (cleanupErrors.length > 0) {
			const aggregateError = new AggregateError(
				[error, ...cleanupErrors],
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
	dependencies: StartedToolVmLifecycleDependencies,
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
		const hostPid = vm.getHostProcessId();
		if (hostPid === null || !Number.isSafeInteger(hostPid) || hostPid <= 0) {
			throw new Error(`Tool VM '${vm.id}' did not expose a positive host process id after start.`);
		}
		const processIdentity = await (dependencies.readProcessIdentity ?? readProcessIdentity)(
			hostPid,
		);
		if (processIdentity === null) {
			throw new Error(
				`Tool VM '${vm.id}' pid ${String(hostPid)} disappeared before process identity capture.`,
			);
		}
		processTarget = { hostPid, processIdentity, vmId: vm.id };
		await provisioning.prepareStartedVm();
		return vm;
	} catch (error) {
		let cleanupError: unknown;
		try {
			if (processTarget === undefined) {
				if (vm.getHostProcessId() !== null) {
					throw new Error(
						`Tool VM '${vm.id}' has a live runner without captured process identity; refusing stock close.`,
						{ cause: error },
					);
				}
				await vm.close();
			} else {
				await terminateLiveManagedVm({
					contextLabel: `Tool VM '${vm.id}' creation rollback`,
					exactProcessTermination: dependencies.managedVmExactProcessTermination,
					sleep: dependencies.managedVmTerminationSleep ?? sleep,
					target: processTarget,
					vm: {
						close: async () => await vm.close(),
						getHostProcessId: () => vm.getHostProcessId(),
						id: vm.id,
					},
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
