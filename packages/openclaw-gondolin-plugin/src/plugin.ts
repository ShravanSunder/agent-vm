import { createGondolinSandboxBackendFactory } from './backend.js';
import { resolveGondolinPluginConfig } from './config.js';

interface SshHelpers {
	readonly buildExecRemoteCommand: (params: {
		readonly command: string;
		readonly env: Record<string, string>;
		readonly workdir?: string;
	}) => string;
	readonly buildRemoteCommand: (argv: readonly string[]) => string;
	readonly buildSshSandboxArgv: (params: {
		readonly remoteCommand: string;
		readonly session: { readonly command: string; readonly configPath: string; readonly host: string };
		readonly tty?: boolean;
	}) => string[];
	readonly createSshSandboxSessionFromSettings: (settings: {
		readonly command: string;
		readonly identityData?: string;
		readonly strictHostKeyChecking: boolean;
		readonly target: string;
		readonly updateHostKeys: boolean;
		readonly workspaceRoot: string;
	}) => Promise<{ readonly command: string; readonly configPath: string; readonly host: string }>;
	readonly runSshSandboxCommand: (params: {
		readonly allowFailure?: boolean;
		readonly remoteCommand: string;
		readonly session: { readonly command: string; readonly configPath: string; readonly host: string };
		readonly stdin?: Buffer | string;
	}) => Promise<{ readonly code: number; readonly stderr: Buffer; readonly stdout: Buffer }>;
	readonly sanitizeEnvVars: (
		env: NodeJS.ProcessEnv,
	) => { readonly allowed: Record<string, string> };
}

function createBackendDeps(ssh: SshHelpers) {
	return {
		buildExecSpec: async ({
			command,
			env,
			ssh: sshCreds,
			usePty,
			workdir,
		}: {
			command: string;
			env: Record<string, string>;
			ssh: { host: string; identityPem: string; port: number; user: string };
			usePty: boolean;
			workdir: string;
		}) => {
			const session = await ssh.createSshSandboxSessionFromSettings({
				target: `${sshCreds.user}@${sshCreds.host}:${sshCreds.port}`,
				identityData: sshCreds.identityPem,
				strictHostKeyChecking: false,
				updateHostKeys: false,
				command: 'ssh',
				workspaceRoot: workdir,
			});
			return {
				argv: ssh.buildSshSandboxArgv({
					session,
					remoteCommand: ssh.buildExecRemoteCommand({ command, workdir, env }),
					tty: usePty,
				}),
				env: ssh.sanitizeEnvVars(process.env).allowed,
				stdinMode: 'pipe-open' as const,
			};
		},
		runRemoteShellScript: async ({
			script,
			ssh: sshCreds,
		}: {
			script: string;
			ssh: { host: string; identityPem: string; port: number; user: string };
		}) => {
			const session = await ssh.createSshSandboxSessionFromSettings({
				target: `${sshCreds.user}@${sshCreds.host}:${sshCreds.port}`,
				identityData: sshCreds.identityPem,
				strictHostKeyChecking: false,
				updateHostKeys: false,
				command: 'ssh',
				workspaceRoot: '/workspace',
			});
			return ssh.runSshSandboxCommand({
				session,
				remoteCommand: ssh.buildRemoteCommand(['/bin/sh', '-c', script, 'gondolin-sandbox-fs']),
			});
		},
	};
}

// Default export: OpenClaw plugin that loads SDK helpers lazily at register() time.
// No top-level await — compatible with CommonJS require().
const plugin = {
	id: 'gondolin',
	name: 'Gondolin VM Sandbox',
	description: 'Sandbox backend powered by Gondolin micro-VMs.',

	register(api: { pluginConfig: Record<string, unknown>; registrationMode: string }): void {
		if (api.registrationMode !== 'full') {
			return;
		}

		const pluginConfig = resolveGondolinPluginConfig(api.pluginConfig);

		// Lazy-load OpenClaw SDK — this import runs at register() time, not at module load.
		// OpenClaw guarantees register() is called inside an async context.
		const sdkPromise = import('openclaw/plugin-sdk/sandbox' as string).then((sdk) => {
			const ssh: SshHelpers = {
				buildExecRemoteCommand: sdk.buildExecRemoteCommand,
				buildRemoteCommand: sdk.buildRemoteCommand,
				buildSshSandboxArgv: sdk.buildSshSandboxArgv,
				createSshSandboxSessionFromSettings: sdk.createSshSandboxSessionFromSettings,
				runSshSandboxCommand: sdk.runSshSandboxCommand,
				sanitizeEnvVars: sdk.sanitizeEnvVars,
			};

			sdk.registerSandboxBackend('gondolin', {
				factory: createGondolinSandboxBackendFactory(pluginConfig, createBackendDeps(ssh)),
			});
		});

		// Fire and forget — OpenClaw's plugin system expects register() to be sync,
		// but the sandbox backend registration is async. The backend won't be
		// available until the import resolves (~1 tick). In practice, sandbox
		// backends are used at tool-call time, not at startup, so this is safe.
		sdkPromise.catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[gondolin] failed to load OpenClaw SDK: ${message}`);
		});
	},
};

export default plugin;

// Named export for testing
export { createBackendDeps };
export type { SshHelpers };
