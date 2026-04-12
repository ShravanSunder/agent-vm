import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
	getKeychainTokenSource,
	hasServiceAccountToken,
	storeServiceAccountToken,
} from './keychain-credential.js';

export interface ScaffoldAgentVmProjectOptions {
	readonly targetDir: string;
	readonly zoneId: string;
}

export interface ScaffoldAgentVmProjectResult {
	readonly created: readonly string[];
	readonly keychainStored: boolean;
	readonly skipped: readonly string[];
}

interface ScaffoldAgentVmProjectDependencies {
	readonly generateAgeIdentityKey?: () => string | undefined;
}

export interface PromptAndStoreTokenDependencies {
	readonly hasKeychainToken?: () => boolean;
	readonly storeKeychainToken?: (token: string) => void;
	readonly createReadlineInterface?: () => readline.Interface;
}

const defaultSystemConfig = (zoneId: string): object => ({
	host: {
		controllerPort: 18800,
		secretsProvider: {
			type: '1password',
			tokenSource: getKeychainTokenSource(),
		},
	},
	cacheDir: './cache',
	images: {
		gateway: {
			buildConfig: './images/gateway/build-config.json',
			dockerfile: './images/gateway/Dockerfile',
		},
		tool: {
			buildConfig: './images/tool/build-config.json',
			dockerfile: './images/tool/Dockerfile',
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
# 1Password token is stored in macOS Keychain by agent-vm init.
# Only set this for CI or non-macOS environments:
# OP_SERVICE_ACCOUNT_TOKEN=

# === Secret References (1Password op:// URIs) ===
DISCORD_BOT_TOKEN_REF=op://agent-vm/agent-discord-app/bot-token
PERPLEXITY_API_KEY_REF=op://agent-vm/agent-perplexity/credential
OPENCLAW_GATEWAY_TOKEN_REF=op://agent-vm/agent-shravan-claw-gateway/password
`;

const defaultGatewayDockerfile = `FROM node:24-slim

RUN apt-get update && \\
    apt-get install -y --no-install-recommends \\
      openssh-server \\
      ca-certificates \\
      git \\
      curl \\
      python3 && \\
    rm -rf /var/lib/apt/lists/* && \\
    update-ca-certificates && \\
    npm install -g openclaw@2026.4.2 && \\
    useradd -m -s /bin/bash openclaw && \\
    mkdir -p /home/openclaw/.openclaw /home/openclaw/workspace /run/sshd /root && \\
    chown -R openclaw:openclaw /home/openclaw && \\
    ln -sf /proc/self/fd /dev/fd 2>/dev/null || true && \\
    mkdir -p /usr/local/lib/node_modules/openclaw/dist/extensions/gondolin
`;

const defaultToolDockerfile = `FROM node:24-slim

RUN apt-get update && \\
    apt-get install -y --no-install-recommends \\
      openssh-server \\
      ca-certificates \\
      git \\
      curl \\
      python3 && \\
    rm -rf /var/lib/apt/lists/* && \\
    update-ca-certificates && \\
    useradd -m -s /bin/bash sandbox && \\
    mkdir -p /workspace /run/sshd && \\
    chown sandbox:sandbox /workspace && \\
    ln -sf /proc/self/fd /dev/fd 2>/dev/null || true
`;

const defaultGatewayBuildConfig = (): object => ({
	arch: 'aarch64',
	distro: 'alpine',
	alpine: {
		version: '3.23.0',
		kernelPackage: 'linux-virt',
		kernelImage: 'vmlinuz-virt',
		rootfsPackages: [],
		initramfsPackages: [],
	},
	oci: {
		image: 'agent-vm-gateway:latest',
		pullPolicy: 'never',
	},
	rootfs: {
		label: 'gondolin-root',
		sizeMb: 4096,
	},
});

const defaultToolBuildConfig = (): object => ({
	arch: 'aarch64',
	distro: 'alpine',
	alpine: {
		version: '3.23.0',
		kernelPackage: 'linux-virt',
		kernelImage: 'vmlinuz-virt',
		rootfsPackages: [],
		initramfsPackages: [],
	},
	oci: {
		image: 'agent-vm-tool:latest',
		pullPolicy: 'never',
	},
	rootfs: {
		label: 'tool-root',
		sizeMb: 2048,
	},
});

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
	dependencies: ScaffoldAgentVmProjectDependencies = {},
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
	if (envFileStatus === 'created') {
		const generateAgeIdentityKey =
			dependencies.generateAgeIdentityKey ??
			((): string | undefined => {
				try {
					const keygenOutput = execFileSync('age-keygen', [], { encoding: 'utf8' });
					return keygenOutput
						.split('\n')
						.find((line) => line.startsWith('AGE-SECRET-KEY-'))
						?.trim();
				} catch {
					return undefined;
				}
			});
		const ageIdentityKey = generateAgeIdentityKey();
		if (ageIdentityKey) {
			fs.appendFileSync(envFilePath, `AGE_IDENTITY_KEY=${ageIdentityKey}\n`, 'utf8');
		}
	}

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

	const gatewayDockerfilePath = path.join(options.targetDir, 'images', 'gateway', 'Dockerfile');
	const gatewayDockerfileStatus = writeFileIfMissing(
		gatewayDockerfilePath,
		defaultGatewayDockerfile,
	);
	(gatewayDockerfileStatus === 'created' ? created : skipped).push('images/gateway/Dockerfile');

	const gatewayBuildConfigPath = path.join(
		options.targetDir,
		'images',
		'gateway',
		'build-config.json',
	);
	const gatewayBuildConfigStatus = writeFileIfMissing(
		gatewayBuildConfigPath,
		`${JSON.stringify(defaultGatewayBuildConfig(), null, '\t')}\n`,
	);
	(gatewayBuildConfigStatus === 'created' ? created : skipped).push(
		'images/gateway/build-config.json',
	);

	const toolDockerfilePath = path.join(options.targetDir, 'images', 'tool', 'Dockerfile');
	const toolDockerfileStatus = writeFileIfMissing(toolDockerfilePath, defaultToolDockerfile);
	(toolDockerfileStatus === 'created' ? created : skipped).push('images/tool/Dockerfile');

	const toolBuildConfigPath = path.join(options.targetDir, 'images', 'tool', 'build-config.json');
	const toolBuildConfigStatus = writeFileIfMissing(
		toolBuildConfigPath,
		`${JSON.stringify(defaultToolBuildConfig(), null, '\t')}\n`,
	);
	(toolBuildConfigStatus === 'created' ? created : skipped).push('images/tool/build-config.json');

	for (const directoryPath of [
		path.join(options.targetDir, 'state', options.zoneId),
		path.join(options.targetDir, 'workspaces', options.zoneId),
		path.join(options.targetDir, 'workspaces', 'tools'),
	]) {
		fs.mkdirSync(directoryPath, { recursive: true });
	}

	return { created, keychainStored: false, skipped };
}

/**
 * Interactively prompt for the 1Password service account token and store it
 * in macOS Keychain. Skips if stdin is not a TTY or if a token already exists.
 */
export async function promptAndStoreServiceAccountToken(
	dependencies: PromptAndStoreTokenDependencies = {},
): Promise<boolean> {
	const hasToken = dependencies.hasKeychainToken ?? hasServiceAccountToken;
	const storeToken = dependencies.storeKeychainToken ?? storeServiceAccountToken;

	if (hasToken()) {
		return false;
	}

	if (!process.stdin.isTTY) {
		return false;
	}

	const rl =
		dependencies.createReadlineInterface?.() ??
		readline.createInterface({ input: process.stdin, output: process.stdout });

	try {
		const token = await rl.question(
			'Paste your 1Password service account token (from https://my.1password.com/developer-tools/service-accounts):\n> ',
		);

		const trimmedToken = token.trim();
		if (!trimmedToken) {
			return false;
		}

		storeToken(trimmedToken);
		return true;
	} finally {
		rl.close();
	}
}
