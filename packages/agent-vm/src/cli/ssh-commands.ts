import { execa } from 'execa';
import { z } from 'zod';

import type { SystemConfig } from '../config/system-config.js';
import {
	type CliDependencies,
	type CliIo,
	createResolverFromSystemConfig,
	readZoneFlag,
	requireZone,
	resolveControllerBaseUrl,
} from './agent-vm-cli-support.js';
import { formatZodError } from './format-zod-error.js';
import {
	wrapWithOpenClawAllSecretsShellEnvironment,
	wrapWithOpenClawGatewayTokenShellEnvironment,
} from './openclaw-shell-prefix.js';

interface RunSshCommandOptions {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly restArguments: readonly string[];
	readonly systemConfig: SystemConfig;
}

export const zoneSshAccessResponseSchema = z
	.object({
		command: z.string().min(1).optional(),
		host: z.string().min(1).optional(),
		identityFile: z.string().min(1).optional(),
		port: z.number().int().positive().optional(),
		secretEnvEnabled: z.boolean().optional(),
		user: z.string().min(1).optional(),
	})
	.passthrough();

export type ZoneSshAccessResponse = z.infer<typeof zoneSshAccessResponseSchema>;

type SshSecretEnvRequest = 'gateway-token' | 'all-secrets';

export async function resolveZoneAdminToken(options: {
	readonly dependencies: Pick<
		CliDependencies,
		'createSecretResolver' | 'resolveServiceAccountToken'
	>;
	readonly systemConfig: SystemConfig;
	readonly zone: SystemConfig['zones'][number];
}): Promise<string | undefined> {
	const adminAccess = options.zone.adminAccess ?? { mode: 'none' as const };
	if (adminAccess.mode === 'none') {
		return undefined;
	}

	const secretResolver = await createResolverFromSystemConfig(
		options.systemConfig,
		options.dependencies,
	);
	const secret = adminAccess.secret;
	switch (secret.source) {
		case 'environment':
			return await secretResolver.resolve({ source: 'environment', ref: secret.envVar });
		case '1password':
			return await secretResolver.resolve({ source: '1password', ref: secret.ref });
		case 'config':
			return await secretResolver.resolve({ source: 'config', value: secret.value });
		default: {
			const exhaustiveCheck: never = secret;
			throw new Error(`Unsupported zone admin secret source: ${JSON.stringify(exhaustiveCheck)}`);
		}
	}
}

export async function runSshCommand(options: RunSshCommandOptions): Promise<void> {
	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});
	if (options.restArguments.includes('--')) {
		throw new Error(
			'controller ssh opens an interactive shell only; remote commands are not supported.',
		);
	}
	const requestAllSecrets = options.restArguments.includes('--all-secrets');
	const restArguments = options.restArguments.filter((argument) => argument !== '--all-secrets');
	if (restArguments.includes('--print')) {
		throw new Error('--print is not supported for controller ssh.');
	}
	const zone = requireZone(options.systemConfig, readZoneFlag(restArguments));
	const adminToken = await resolveZoneAdminToken({
		dependencies: options.dependencies,
		systemConfig: options.systemConfig,
		zone,
	});
	const parsedSshResponse = zoneSshAccessResponseSchema.safeParse(
		await controllerClient.enableZoneSsh(zone.id, {
			...(adminToken ? { adminToken } : {}),
			secretEnv: requestAllSecrets ? 'all-secrets' : 'gateway-token',
		}),
	);
	if (!parsedSshResponse.success) {
		throw new Error(
			formatZodError('Controller returned an invalid SSH response:', parsedSshResponse.error),
			{ cause: parsedSshResponse.error },
		);
	}
	const sshResponse: ZoneSshAccessResponse = parsedSshResponse.data;

	if (!sshResponse.host || !sshResponse.port) {
		throw new Error('Controller returned incomplete SSH access details.');
	}
	const secretEnvEnabled = sshResponse.secretEnvEnabled === true;
	if (!secretEnvEnabled) {
		throw new Error(
			'Controller did not enable the gateway token for this SSH session. Check the zone gateway.ssh.secretEnv policy and configured gateway.controllerAuth.secret.',
		);
	}
	const secretEnvRequest: SshSecretEnvRequest = requestAllSecrets ? 'all-secrets' : 'gateway-token';
	const remoteShellCommand =
		secretEnvRequest === 'all-secrets'
			? wrapWithOpenClawAllSecretsShellEnvironment('exec bash -l')
			: wrapWithOpenClawGatewayTokenShellEnvironment('exec bash -l');

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
		remoteShellCommand,
	];
	const runInteractiveProcess =
		options.dependencies.runInteractiveProcess ??
		(async (command: string, arguments_: readonly string[]): Promise<void> => {
			await execa(command, arguments_, {
				stdio: 'inherit',
			});
		});
	try {
		await runInteractiveProcess('ssh', sshArguments);
	} catch (error) {
		throw new Error(
			`Failed to open SSH session to ${sshResponse.user ?? 'root'}@${sshResponse.host}:${sshResponse.port}: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}
}
