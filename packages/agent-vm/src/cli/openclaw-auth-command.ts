import type { GatewayAuthConfig } from '@agent-vm/gateway-interface';
import { execa } from 'execa';

import { agentIdSchema, type SystemConfig } from '../config/system-config.js';
import {
	type CliDependencies,
	type CliIo,
	requireZone,
	resolveControllerBaseUrl,
} from './agent-vm-cli-support.js';
import { formatZodError } from './format-zod-error.js';
import { wrapWithOpenClawShellEnvironment } from './openclaw-shell-prefix.js';
import { resolveZoneAdminToken, zoneSshAccessResponseSchema } from './ssh-commands.js';

type OpenClawAuthTarget =
	| {
			readonly kind: 'default';
	  }
	| {
			readonly agentId: string;
			readonly kind: 'agent';
	  };

function resolveOpenClawAuthTargets(options: {
	readonly agentId: string | undefined;
	readonly allAgents: boolean;
	readonly zone: SystemConfig['zones'][number];
}): readonly OpenClawAuthTarget[] {
	if (options.agentId && options.allAgents) {
		throw new Error('Use either --agent or --all-agents, not both.');
	}
	if (options.agentId) {
		return [{ agentId: agentIdSchema.parse(options.agentId), kind: 'agent' }];
	}
	if (!options.allAgents) {
		return [{ kind: 'default' }];
	}

	const agentTargets = (options.zone.agents ?? []).map(
		(agent): OpenClawAuthTarget => ({ agentId: agent.id, kind: 'agent' }),
	);
	if (agentTargets.length === 0) {
		throw new Error(
			`Zone '${options.zone.id}' has no configured agents; use --agent <agentId> for a one-off login.`,
		);
	}
	return agentTargets;
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

export async function runOpenClawAuthCommand(options: {
	readonly agentId?: string;
	readonly allAgents?: boolean;
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
	if (!options.authConfig) {
		throw new Error(`Zone '${options.zoneId}' does not support interactive auth.`);
	}

	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});
	const zone = requireZone(options.systemConfig, options.zoneId);
	const targets = resolveOpenClawAuthTargets({
		agentId: options.agentId,
		allAgents: options.allAgents === true,
		zone,
	});
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

	const runInteractiveProcess =
		options.dependencies.runInteractiveProcess ??
		(async (command: string, arguments_: readonly string[]): Promise<void> => {
			await execa(command, arguments_, {
				stdio: 'inherit',
			});
		});

	for (const target of targets) {
		const targetAgentId = target.kind === 'agent' ? target.agentId : undefined;
		if (targetAgentId) {
			options.io.stdout.write(
				`Opening OpenClaw ${options.provider} login for zone '${options.zoneId}' agent '${targetAgentId}'.\n`,
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
					...(targetAgentId ? { agentId: targetAgentId } : {}),
					deviceCode: options.deviceCode === true,
					setDefault: options.setDefault === true,
				}),
			),
		];

		try {
			// oxlint-disable-next-line no-await-in-loop -- auth login is interactive and must run one target at a time
			await runInteractiveProcess('ssh', sshArguments);
		} catch (error) {
			throw new Error(
				`Auth failed for ${formatOpenClawAuthFailureContext({
					agentId: targetAgentId,
					provider: options.provider,
					zoneId: options.zoneId,
				})}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
}
