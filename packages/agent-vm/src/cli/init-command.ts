import fs from 'node:fs';
import path from 'node:path';

export interface ScaffoldAgentVmProjectOptions {
	readonly targetDir: string;
	readonly zoneId: string;
}

export interface ScaffoldAgentVmProjectResult {
	readonly created: readonly string[];
	readonly skipped: readonly string[];
}

const defaultSystemConfig = (zoneId: string): object => ({
	host: {
		controllerPort: 18800,
		secretsProvider: {
			type: '1password',
			tokenSource: {
				type: 'env',
				envVar: 'OP_SERVICE_ACCOUNT_TOKEN',
			},
		},
	},
	images: {
		gateway: {
			buildConfig: './images/gateway/build-config.json',
		},
		tool: {
			buildConfig: './images/tool/build-config.json',
		},
	},
	zones: [
		{
			id: zoneId,
			gateway: {
				memory: '2G',
				cpus: 2,
				port: 18791,
				openclawConfig: `./config/${zoneId}/openclaw.json`,
				stateDir: `./state/${zoneId}`,
				workspaceDir: `./workspaces/${zoneId}`,
			},
			secrets: {
				DISCORD_BOT_TOKEN: {
					source: '1password',
					injection: 'env',
				},
				PERPLEXITY_API_KEY: {
					source: '1password',
					hosts: ['api.perplexity.ai'],
					injection: 'http-mediation',
				},
				OPENCLAW_GATEWAY_TOKEN: {
					source: '1password',
					injection: 'env',
				},
			},
			allowedHosts: [
				'api.openai.com',
				'auth.openai.com',
				'api.perplexity.ai',
				'discord.com',
				'cdn.discordapp.com',
				'api.github.com',
				'registry.npmjs.org',
			],
			websocketBypass: [
				'gateway.discord.gg:443',
				'web.whatsapp.com:443',
				'g.whatsapp.net:443',
				'mmg.whatsapp.net:443',
			],
			toolProfile: 'standard',
		},
	],
	toolProfiles: {
		standard: {
			memory: '1G',
			cpus: 1,
			workspaceRoot: './workspaces/tools',
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
});

const defaultEnvTemplate = `# agent-vm environment configuration
# Fill in required values below.

# === 1Password Service Account Token (required) ===
OP_SERVICE_ACCOUNT_TOKEN=

# === Secret References (1Password op:// URIs) ===
DISCORD_BOT_TOKEN_REF=op://agent-vm/agent-discord-app/bot-token
PERPLEXITY_API_KEY_REF=op://agent-vm/agent-perplexity/credential
OPENCLAW_GATEWAY_TOKEN_REF=op://agent-vm/agent-shravan-claw-gateway/password

# === Snapshot Encryption ===
# Generate with: age-keygen
AGE_IDENTITY_KEY=
`;

const defaultOpenClawConfig = (zoneId: string): object => ({
	gateway: {
		auth: { mode: 'token' },
		bind: 'loopback',
		mode: 'local',
		port: 18789,
	},
	agents: {
		defaults: {
			model: { primary: 'openai-codex/gpt-5.4' },
			sandbox: { backend: 'gondolin', mode: 'all', scope: 'session' },
			workspace: '/home/openclaw/workspace',
		},
	},
	tools: { elevated: { enabled: false } },
	plugins: {
		entries: {
			gondolin: {
				enabled: true,
				config: {
					controllerUrl: 'http://controller.vm.host:18800',
					zoneId,
				},
			},
		},
	},
	channels: {},
});

function writeFileIfMissing(filePath: string, content: string): 'created' | 'skipped' {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	try {
		fs.writeFileSync(filePath, content, {
			encoding: 'utf8',
			flag: 'wx',
		});
		return 'created';
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
			return 'skipped';
		}

		throw error;
	}
}

export function scaffoldAgentVmProject(
	options: ScaffoldAgentVmProjectOptions,
): ScaffoldAgentVmProjectResult {
	const created: string[] = [];
	const skipped: string[] = [];

	const systemConfigPath = path.join(options.targetDir, 'system.json');
	const systemConfigStatus = writeFileIfMissing(
		systemConfigPath,
		`${JSON.stringify(defaultSystemConfig(options.zoneId), null, '\t')}\n`,
	);
	(systemConfigStatus === 'created' ? created : skipped).push('system.json');

	const envFilePath = path.join(options.targetDir, '.env.local');
	const envFileStatus = writeFileIfMissing(envFilePath, defaultEnvTemplate);
	(envFileStatus === 'created' ? created : skipped).push('.env.local');

	const openClawConfigPath = path.join(
		options.targetDir,
		'config',
		options.zoneId,
		'openclaw.json',
	);
	const openClawConfigStatus = writeFileIfMissing(
		openClawConfigPath,
		`${JSON.stringify(defaultOpenClawConfig(options.zoneId), null, '\t')}\n`,
	);
	(openClawConfigStatus === 'created' ? created : skipped).push(
		`config/${options.zoneId}/openclaw.json`,
	);

	for (const directoryPath of [
		path.join(options.targetDir, 'state', options.zoneId),
		path.join(options.targetDir, 'workspaces', options.zoneId),
		path.join(options.targetDir, 'workspaces', 'tools'),
	]) {
		fs.mkdirSync(directoryPath, { recursive: true });
	}

	return { created, skipped };
}
