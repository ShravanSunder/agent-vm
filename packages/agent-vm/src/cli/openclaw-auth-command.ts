import type { GatewayAuthConfig } from '@agent-vm/gateway-lifecycle';
import { execa } from 'execa';

import { agentIdSchema, type SystemConfig } from '../config/system-config.js';
import {
	type CliDependencies,
	type CliIo,
	requireZone,
	resolveControllerBaseUrl,
} from './agent-vm-cli-support.js';
import { formatZodError } from './format-zod-error.js';
import { wrapWithOpenClawGatewayTokenShellEnvironment } from './openclaw-shell-prefix.js';
import { resolveZoneAdminToken, zoneSshAccessResponseSchema } from './ssh-commands.js';

function resolveOpenClawProfileIds(options: {
	readonly allConfiguredProfiles: boolean;
	readonly configuredProfileIds: readonly string[] | undefined;
	readonly explicitProfileIds: readonly string[] | undefined;
	readonly provider: string;
	readonly zoneId: string;
}): readonly string[] {
	const explicitProfileIds = options.explicitProfileIds ?? [];
	if (explicitProfileIds.length > 0 && options.allConfiguredProfiles) {
		throw new Error('Use either --profile-id or --all-configured-profiles, not both.');
	}
	if (explicitProfileIds.some((profileId) => profileId.trim().length === 0)) {
		throw new Error('OpenClaw auth profile ids must not be empty.');
	}
	if (explicitProfileIds.length > 0) {
		return explicitProfileIds;
	}
	if (!options.allConfiguredProfiles) {
		throw new Error(
			'No profile ids provided. Pass --profile-id or --all-configured-profiles. For custom auth, use agent-vm controller ssh.',
		);
	}
	if (!options.configuredProfileIds || options.configuredProfileIds.length === 0) {
		throw new Error(
			`No configured OpenClaw auth profiles for provider '${options.provider}' in zone '${options.zoneId}'. Expected gateway.authLogin.providers.${options.provider}.profileIds.`,
		);
	}
	return options.configuredProfileIds;
}

function resolveOpenClawAuthAgentId(options: {
	readonly agentId: string | undefined;
	readonly defaultAgent: string | undefined;
	readonly zoneId: string;
}): string {
	if (options.agentId) {
		return agentIdSchema.parse(options.agentId);
	}
	if (options.defaultAgent) {
		return options.defaultAgent;
	}
	throw new Error(
		`No gateway.authLogin.defaultAgent configured for zone '${options.zoneId}'. Set it, pass --agent, or use controller ssh and run OpenClaw auth manually.`,
	);
}

function formatOpenClawAuthFailureContext(options: {
	readonly agentId: string | undefined;
	readonly provider: string;
	readonly zoneId: string;
}): string {
	return options.agentId
		? `${options.provider} in zone '${options.zoneId}' agent '${options.agentId}'`
		: `${options.provider} in zone '${options.zoneId}'`;
}

function writeOpenClawAuthDryRun(options: {
	readonly agentId: string;
	readonly io: CliIo;
	readonly profileIds: readonly string[];
	readonly provider: string;
	readonly zoneId: string;
}): void {
	options.io.stdout.write(
		`OpenClaw auth login plan for zone '${options.zoneId}' provider '${options.provider}' agent '${options.agentId}'.\n`,
	);
	options.io.stdout.write(`Profiles (${options.profileIds.length}):\n`);
	for (const profileId of options.profileIds) {
		options.io.stdout.write(`  - ${profileId}\n`);
	}
	options.io.stdout.write('Verification: enabled\n');
}

export async function runOpenClawAuthCommand(options: {
	readonly agentId?: string;
	readonly allConfiguredProfiles?: boolean;
	readonly authConfig: GatewayAuthConfig | undefined;
	readonly dependencies: Pick<
		CliDependencies,
		| 'createControllerClient'
		| 'createSecretResolver'
		| 'resolveServiceAccountToken'
		| 'runCommand'
		| 'runInteractiveProcess'
	>;
	readonly deviceCode?: boolean;
	readonly dryRun?: boolean;
	readonly io: CliIo;
	readonly profileIds?: readonly string[];
	readonly provider: string;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
}): Promise<void> {
	if (!options.authConfig) {
		throw new Error(`Zone '${options.zoneId}' does not support interactive auth.`);
	}

	const zone = requireZone(options.systemConfig, options.zoneId);
	if (zone.gateway.type !== 'openclaw') {
		throw new Error(`Zone '${options.zoneId}' does not support OpenClaw auth login.`);
	}
	const profileIds = resolveOpenClawProfileIds({
		allConfiguredProfiles: options.allConfiguredProfiles === true,
		configuredProfileIds: zone.gateway.authLogin?.providers[options.provider]?.profileIds,
		explicitProfileIds: options.profileIds,
		provider: options.provider,
		zoneId: options.zoneId,
	});
	const authAgentId = resolveOpenClawAuthAgentId({
		agentId: options.agentId,
		defaultAgent: zone.gateway.authLogin?.defaultAgent,
		zoneId: options.zoneId,
	});
	if (options.dryRun === true) {
		writeOpenClawAuthDryRun({
			agentId: authAgentId,
			io: options.io,
			profileIds,
			provider: options.provider,
			zoneId: options.zoneId,
		});
		return;
	}
	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});
	const adminToken = await resolveZoneAdminToken({
		dependencies: options.dependencies,
		systemConfig: options.systemConfig,
		zone,
	});
	const parsedSshResponse = zoneSshAccessResponseSchema.safeParse(
		await controllerClient.enableZoneSsh(options.zoneId, {
			...(adminToken ? { adminToken } : {}),
			secretEnv: 'gateway-token',
		}),
	);
	if (!parsedSshResponse.success) {
		throw new Error(
			formatZodError('Controller returned an invalid SSH response:', parsedSshResponse.error),
			{ cause: parsedSshResponse.error },
		);
	}

	const sshResponse = parsedSshResponse.data;
	if (!sshResponse.host || !sshResponse.port) {
		throw new Error(
			`Cannot auth: controller returned incomplete SSH access for zone '${options.zoneId}'.`,
		);
	}
	if (sshResponse.secretEnvEnabled !== true) {
		throw new Error(
			`Controller did not enable the OpenClaw gateway token for auth in zone '${options.zoneId}'.`,
		);
	}

	const runInteractiveProcess =
		options.dependencies.runInteractiveProcess ??
		(async (command: string, arguments_: readonly string[]): Promise<void> => {
			await execa(command, arguments_, {
				stdio: 'inherit',
			});
		});
	const runCommand =
		options.dependencies.runCommand ??
		(async (
			command: string,
			arguments_: readonly string[],
		): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> => {
			const result = await execa(command, [...arguments_], { reject: false });
			return {
				exitCode: result.exitCode ?? 1,
				stderr: result.stderr,
				stdout: result.stdout,
			};
		});

	for (const profileId of profileIds) {
		options.io.stdout.write(
			`Opening OpenClaw ${options.provider} login for zone '${options.zoneId}' agent '${authAgentId}' profile '${profileId}'.\n`,
		);
		const sshArguments = [
			'-t',
			'-o',
			'StrictHostKeyChecking=no',
			'-o',
			'UserKnownHostsFile=/dev/null',
			...(sshResponse.identityFile ? ['-i', sshResponse.identityFile] : []),
			'-p',
			String(sshResponse.port),
			`${sshResponse.user ?? 'root'}@${sshResponse.host}`,
			wrapWithOpenClawGatewayTokenShellEnvironment(
				options.authConfig.buildLoginCommand(options.provider, {
					agentId: authAgentId,
					deviceCode: options.deviceCode === true,
					profileId,
				}),
			),
		];

		try {
			// oxlint-disable-next-line no-await-in-loop -- auth login is interactive and must run one target at a time
			await runInteractiveProcess('ssh', sshArguments);
		} catch (error) {
			throw new Error(
				`Auth failed for ${formatOpenClawAuthFailureContext({
					agentId: authAgentId,
					provider: options.provider,
					zoneId: options.zoneId,
				})}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}

	const verifyArguments = [
		'-o',
		'StrictHostKeyChecking=no',
		'-o',
		'UserKnownHostsFile=/dev/null',
		...(sshResponse.identityFile ? ['-i', sshResponse.identityFile] : []),
		'-p',
		String(sshResponse.port),
		`${sshResponse.user ?? 'root'}@${sshResponse.host}`,
		wrapWithOpenClawGatewayTokenShellEnvironment(
			options.authConfig.buildProfileListCommand(options.provider, { agentId: authAgentId }),
		),
	];
	const verificationResult = await runCommand('ssh', verifyArguments);
	if (verificationResult.exitCode !== 0) {
		throw new Error(
			`OpenClaw auth verification failed for ${formatOpenClawAuthFailureContext({
				agentId: authAgentId,
				provider: options.provider,
				zoneId: options.zoneId,
			})}: ${verificationResult.stderr || `ssh exited with code ${verificationResult.exitCode}`}`,
		);
	}
	const missingProfileIds = profileIds.filter(
		(profileId) => !verificationResult.stdout.includes(profileId),
	);
	if (missingProfileIds.length > 0) {
		throw new Error(
			`OpenClaw auth verification for ${formatOpenClawAuthFailureContext({
				agentId: authAgentId,
				provider: options.provider,
				zoneId: options.zoneId,
			})} did not list profile id(s): ${missingProfileIds.join(', ')}`,
		);
	}
}
