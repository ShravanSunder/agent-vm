import type { GatewayAuthConfig } from '@agent-vm/gateway-interface';
import { execa } from 'execa';

import type { SystemConfig } from '../config/system-config.js';
import {
	type CliDependencies,
	type CliIo,
	requireZone,
	resolveControllerBaseUrl,
} from './agent-vm-cli-support.js';
import { formatZodError } from './format-zod-error.js';
import { wrapWithOpenClawShellEnvironment } from './openclaw-shell-prefix.js';
import { resolveZoneAdminToken, zoneSshAccessResponseSchema } from './ssh-commands.js';

export async function runOpenClawAuthCommand(options: {
	readonly authConfig: GatewayAuthConfig | undefined;
	readonly dependencies: Pick<
		CliDependencies,
		| 'createControllerClient'
		| 'createSecretResolver'
		| 'resolveServiceAccountToken'
		| 'runInteractiveProcess'
	>;
	readonly deviceCode?: boolean;
	readonly io: CliIo;
	readonly provider: string;
	readonly systemConfig: SystemConfig;
	readonly setDefault?: boolean;
	readonly zoneId: string;
}): Promise<void> {
	if (options.provider === 'openai-codex') {
		throw new Error(
			`Refusing to run OpenClaw provider login for 'openai-codex'. Use 'agent-vm auth codex-harness --zone ${options.zoneId} --agent <agentId>' for native Codex CLI auth, or use provider 'openai' for OpenClaw-managed auth.`,
		);
	}
	if (!options.authConfig) {
		throw new Error(`Zone '${options.zoneId}' does not support interactive auth.`);
	}

	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});
	const zone = requireZone(options.systemConfig, options.zoneId);
	const adminToken = await resolveZoneAdminToken({
		dependencies: options.dependencies,
		systemConfig: options.systemConfig,
		zone,
	});
	const parsedSshResponse = zoneSshAccessResponseSchema.safeParse(
		await controllerClient.enableZoneSsh(options.zoneId, {
			...(adminToken ? { adminToken } : {}),
			secretEnv: 'default',
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
		wrapWithOpenClawShellEnvironment(
			options.authConfig.buildLoginCommand(options.provider, {
				deviceCode: options.deviceCode === true,
				setDefault: options.setDefault === true,
			}),
		),
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
			`Auth failed for ${options.provider} in zone '${options.zoneId}': ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}
