import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
	getKeychainTokenSource,
	hasServiceAccountToken,
	storeServiceAccountToken,
} from './keychain-credential.js';

export interface ScaffoldAgentVmProjectOptions {
	readonly gatewayType: GatewayType;
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

export type GatewayType = 'coding' | 'openclaw';

const defaultGatewayIngressPort = 18791;

function resolveGatewayConfigFileName(gatewayType: GatewayType): 'coding.json' | 'openclaw.json' {
	return gatewayType === 'coding' ? 'coding.json' : 'openclaw.json';
}

const defaultSystemConfig = (zoneId: string, gatewayType: GatewayType): object => ({
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
				type: gatewayType,
				memory: '2G',
				cpus: 2,
				port: defaultGatewayIngressPort,
				gatewayConfig: `./config/${zoneId}/${resolveGatewayConfigFileName(gatewayType)}`,
				stateDir: `./state/${zoneId}`,
				workspaceDir: `./workspaces/${zoneId}`,
			},
			secrets: defaultSecretsForGatewayType(gatewayType),
			allowedHosts: defaultAllowedHostsForGatewayType(gatewayType),
			websocketBypass: defaultWebsocketBypassForGatewayType(gatewayType),
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

function defaultSecretsForGatewayType(gatewayType: GatewayType): Record<string, object> {
	if (gatewayType === 'coding') {
		return {
			ANTHROPIC_API_KEY: {
				source: '1password',
				ref: 'op://agent-vm/agent-anthropic/api-key',
				hosts: ['api.anthropic.com'],
				injection: 'http-mediation',
			},
			OPENAI_API_KEY: {
				source: '1password',
				ref: 'op://agent-vm/agent-openai/api-key',
				hosts: ['api.openai.com'],
				injection: 'http-mediation',
			},
		};
	}

	return {
		DISCORD_BOT_TOKEN: {
			source: '1password',
			ref: 'op://agent-vm/agent-discord-app/bot-token',
			injection: 'env',
		},
		PERPLEXITY_API_KEY: {
			source: '1password',
			ref: 'op://agent-vm/agent-perplexity/credential',
			hosts: ['api.perplexity.ai'],
			injection: 'http-mediation',
		},
		OPENCLAW_GATEWAY_TOKEN: {
			source: '1password',
			ref: 'op://agent-vm/agent-shravan-claw-gateway/password',
			injection: 'env',
		},
	};
}

function defaultAllowedHostsForGatewayType(gatewayType: GatewayType): readonly string[] {
	if (gatewayType === 'coding') {
		return [
			'api.anthropic.com',
			'api.openai.com',
			'auth.openai.com',
			'api.github.com',
			'registry.npmjs.org',
		];
	}

	return [
		'api.openai.com',
		'auth.openai.com',
		'api.perplexity.ai',
		'discord.com',
		'cdn.discordapp.com',
		'api.github.com',
		'registry.npmjs.org',
	];
}

function defaultWebsocketBypassForGatewayType(gatewayType: GatewayType): readonly string[] {
	if (gatewayType === 'coding') {
		return [];
	}

	return [
		'gateway.discord.gg:443',
		'web.whatsapp.com:443',
		'g.whatsapp.net:443',
		'mmg.whatsapp.net:443',
	];
}

function defaultEnvTemplateForGatewayType(): string {
	return `# agent-vm environment configuration
# 1Password token is stored in macOS Keychain by agent-vm init.
# Only set this for CI or non-macOS environments:
# OP_SERVICE_ACCOUNT_TOKEN=
`;
}

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

const defaultCodingGatewayDockerfile = `FROM node:24-slim

RUN apt-get update && \\
    apt-get install -y --no-install-recommends \\
      openssh-server \\
      ca-certificates \\
      git \\
      curl \\
      python3 && \\
    rm -rf /var/lib/apt/lists/* && \\
    update-ca-certificates && \\
    npm install -g @openai/codex-cli && \\
    useradd -m -s /bin/bash coder && \\
    mkdir -p /workspace /run/sshd /state && \\
    chown -R coder:coder /workspace /state && \\
    ln -sf /proc/self/fd /dev/fd 2>/dev/null || true
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

const defaultOpenClawConfig = (zoneId: string, gatewayIngressPort: number): object => ({
	gateway: {
		auth: { mode: 'token' },
		bind: 'loopback',
		controlUi: {
			allowedOrigins: [
				`http://127.0.0.1:${gatewayIngressPort}`,
				`http://localhost:${gatewayIngressPort}`,
			],
		},
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

const defaultCodingGatewayConfig = (): object => ({
	agentTimeoutMs: 600_000,
	branchPrefix: 'agent/',
	commitCoAuthor: 'agent-vm-worker <noreply@agent-vm>',
	idleTimeoutMs: 1_800_000,
	lintCommand: 'pnpm lint',
	maxRetries: 3,
	model: 'gpt-5.4-mini',
	stateDir: '/state',
	testCommand: 'pnpm test',
	verificationTimeoutMs: 300_000,
});

async function writeFileIfMissing(
	filePath: string,
	content: string,
): Promise<'created' | 'skipped'> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	try {
		await fs.writeFile(filePath, content, {
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
): Promise<ScaffoldAgentVmProjectResult> {
	return scaffoldAgentVmProjectInternal(options, dependencies);
}

async function scaffoldAgentVmProjectInternal(
	options: ScaffoldAgentVmProjectOptions,
	dependencies: ScaffoldAgentVmProjectDependencies = {},
): Promise<ScaffoldAgentVmProjectResult> {
	const created: string[] = [];
	const skipped: string[] = [];
	const gatewayType = options.gatewayType;

	const systemConfigPath = path.join(options.targetDir, 'system.json');
	const systemConfigStatus = await writeFileIfMissing(
		systemConfigPath,
		`${JSON.stringify(defaultSystemConfig(options.zoneId, gatewayType), null, '\t')}\n`,
	);
	(systemConfigStatus === 'created' ? created : skipped).push('system.json');

	const envFilePath = path.join(options.targetDir, '.env.local');
	const envFileStatus = await writeFileIfMissing(envFilePath, defaultEnvTemplateForGatewayType());
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
			await fs.appendFile(envFilePath, `AGE_IDENTITY_KEY=${ageIdentityKey}\n`, 'utf8');
		}
	}

	const gatewayConfigFileName = resolveGatewayConfigFileName(gatewayType);
	const gatewayConfigPath = path.join(
		options.targetDir,
		'config',
		options.zoneId,
		gatewayConfigFileName,
	);
	const gatewayConfigStatus = await writeFileIfMissing(
		gatewayConfigPath,
		`${JSON.stringify(
			gatewayType === 'openclaw'
				? defaultOpenClawConfig(options.zoneId, defaultGatewayIngressPort)
				: defaultCodingGatewayConfig(),
			null,
			'\t',
		)}\n`,
	);
	(gatewayConfigStatus === 'created' ? created : skipped).push(
		`config/${options.zoneId}/${gatewayConfigFileName}`,
	);

	const gatewayDockerfilePath = path.join(options.targetDir, 'images', 'gateway', 'Dockerfile');
	const gatewayDockerfileStatus = await writeFileIfMissing(
		gatewayDockerfilePath,
		gatewayType === 'openclaw' ? defaultGatewayDockerfile : defaultCodingGatewayDockerfile,
	);
	(gatewayDockerfileStatus === 'created' ? created : skipped).push('images/gateway/Dockerfile');

	const gatewayBuildConfigPath = path.join(
		options.targetDir,
		'images',
		'gateway',
		'build-config.json',
	);
	const gatewayBuildConfigStatus = await writeFileIfMissing(
		gatewayBuildConfigPath,
		`${JSON.stringify(defaultGatewayBuildConfig(), null, '\t')}\n`,
	);
	(gatewayBuildConfigStatus === 'created' ? created : skipped).push(
		'images/gateway/build-config.json',
	);

	const toolDockerfilePath = path.join(options.targetDir, 'images', 'tool', 'Dockerfile');
	const toolDockerfileStatus = await writeFileIfMissing(toolDockerfilePath, defaultToolDockerfile);
	(toolDockerfileStatus === 'created' ? created : skipped).push('images/tool/Dockerfile');

	const toolBuildConfigPath = path.join(options.targetDir, 'images', 'tool', 'build-config.json');
	const toolBuildConfigStatus = await writeFileIfMissing(
		toolBuildConfigPath,
		`${JSON.stringify(defaultToolBuildConfig(), null, '\t')}\n`,
	);
	(toolBuildConfigStatus === 'created' ? created : skipped).push('images/tool/build-config.json');

	await Promise.all(
		[
			path.join(options.targetDir, 'state', options.zoneId),
			path.join(options.targetDir, 'workspaces', options.zoneId),
			path.join(options.targetDir, 'workspaces', 'tools'),
		].map(async (directoryPath) => await fs.mkdir(directoryPath, { recursive: true })),
	);

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

	// Use a muted output stream so readline doesn't echo the token
	const { Writable } = await import('node:stream');
	const mutedOutput = new Writable({
		write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
			callback();
		},
	});

	const rl =
		dependencies.createReadlineInterface?.() ??
		readline.createInterface({ input: process.stdin, output: mutedOutput, terminal: true });

	try {
		process.stderr.write(
			'Paste your 1Password service account token (from https://my.1password.com/developer-tools/service-accounts):\n> ',
		);
		const token = await rl.question('');
		process.stderr.write('\n');

		const trimmedToken = token.trim();
		if (!trimmedToken) {
			return false;
		}

		storeToken(trimmedToken);
		process.stderr.write('✓ Stored in macOS Keychain\n');
		return true;
	} finally {
		rl.close();
	}
}
