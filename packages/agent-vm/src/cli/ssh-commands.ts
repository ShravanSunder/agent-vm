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

const openClawShellEnvFilePath = '/etc/profile.d/openclaw-env.sh';
const openClawRuntimeSecretsEnvFilePath = '/run/openclaw/secrets.env';

function buildRemoteCommandPrefix(options: { readonly withSecrets: boolean }): string {
	if (!options.withSecrets) {
		return `source ${openClawShellEnvFilePath} && `;
	}
	return `source ${openClawShellEnvFilePath} && set -a && . ${openClawRuntimeSecretsEnvFilePath} && set +a && `;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function buildInteractiveSecretShellCommand(): string {
	return `bash -lc ${shellQuote(`${buildRemoteCommandPrefix({ withSecrets: true })}exec bash -l`)}`;
}

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
	return await secretResolver.resolve(
		secret.source === 'environment'
			? { source: 'environment', ref: secret.envVar }
			: { source: '1password', ref: secret.ref },
	);
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
	const withSecrets = options.restArguments.includes('--with-secrets');
	const restArguments = options.restArguments.filter((argument) => argument !== '--with-secrets');
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
			secretEnv: withSecrets ? 'with-secrets' : 'default',
		}),
	);
	if (!parsedSshResponse.success) {
		throw new Error('Controller returned an invalid SSH response.');
	}
	const sshResponse: ZoneSshAccessResponse = parsedSshResponse.data;

	if (!sshResponse.host || !sshResponse.port) {
		throw new Error('Controller returned incomplete SSH access details.');
	}
	const secretEnvEnabled = sshResponse.secretEnvEnabled === true;

	const sshArguments = [
		'-o',
		'StrictHostKeyChecking=no',
		'-o',
		'UserKnownHostsFile=/dev/null',
		...(sshResponse.identityFile ? ['-i', sshResponse.identityFile] : []),
		'-p',
		String(sshResponse.port),
		`${sshResponse.user ?? 'root'}@${sshResponse.host}`,
		...(secretEnvEnabled ? [buildInteractiveSecretShellCommand()] : []),
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
