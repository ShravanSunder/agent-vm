import { execa } from 'execa';
import { z } from 'zod';

import type { SystemConfig } from '../config/system-config.js';
import { loadGatewayLifecycle } from '../gateway/gateway-lifecycle-loader.js';
import {
	type CliDependencies,
	type CliIo,
	createResolverFromSystemConfig,
	requireZone,
	resolveControllerBaseUrl,
} from './agent-vm-cli-support.js';
import { formatZodError } from './format-zod-error.js';

interface RunSshCommandOptions {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
}

export const zoneSshAccessResponseSchema = z
	.object({
		command: z.string().min(1).optional(),
		host: z.string().min(1).optional(),
		identityFile: z.string().min(1).optional(),
		port: z.number().int().positive().optional(),
		user: z.string().min(1).optional(),
	})
	.passthrough();

export type ZoneSshAccessResponse = z.infer<typeof zoneSshAccessResponseSchema>;

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
	const zone = requireZone(options.systemConfig, options.zoneId);
	const lifecycle = loadGatewayLifecycle(zone.gateway.type);
	if (lifecycle.executionModel !== 'managed-gateway') {
		throw new Error(
			`controller ssh is not implemented for gateway type '${zone.gateway.type}'; use the Worker task APIs.`,
		);
	}
	const interactiveSshSession = lifecycle.interactiveSsh.buildSession();
	const adminToken = await resolveZoneAdminToken({
		dependencies: options.dependencies,
		systemConfig: options.systemConfig,
		zone,
	});
	const parsedSshResponse = zoneSshAccessResponseSchema.safeParse(
		await controllerClient.enableZoneSsh(zone.id, adminToken ? { adminToken } : {}),
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
		interactiveSshSession.remoteShellCommand,
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
