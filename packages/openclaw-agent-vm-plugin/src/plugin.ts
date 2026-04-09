import { createGondolinSandboxBackendFactory, type FsBridgeLeaseContext, type GondolinFsBridge } from './backend.js';
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
	readonly createRemoteShellSandboxFsBridge: (params: {
		readonly runtime: {
			readonly remoteAgentWorkspaceDir: string;
			readonly remoteWorkspaceDir: string;
			readonly runRemoteShellScript: (shellParams: {
				readonly allowFailure?: boolean;
				readonly args?: string[];
				readonly script: string;
				readonly signal?: AbortSignal;
				readonly stdin?: Buffer | string;
			}) => Promise<{ readonly code: number; readonly stderr: Buffer; readonly stdout: Buffer }>;
		};
		readonly sandbox: unknown;
	}) => GondolinFsBridge;
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

interface BackendDeps {
	readonly buildExecSpec: (params: {
		readonly command: string;
		readonly env: Record<string, string>;
		readonly ssh: { readonly host: string; readonly identityPem: string; readonly port: number; readonly user: string };
		readonly usePty: boolean;
		readonly workdir: string;
	}) => Promise<{
		readonly argv: string[];
		readonly env: Record<string, string>;
		readonly stdinMode: 'pipe-open';
	}>;
	readonly createFsBridgeBuilder: (
		leaseContext: FsBridgeLeaseContext,
	) => (params: { readonly sandbox: unknown }) => GondolinFsBridge;
	readonly runRemoteShellScript: (params: {
		readonly script: string;
		readonly ssh: { readonly host: string; readonly identityPem: string; readonly port: number; readonly user: string };
	}) => Promise<{ readonly code: number; readonly stderr: Buffer; readonly stdout: Buffer }>;
}

function createBackendDeps(ssh: SshHelpers): BackendDeps {
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
		createFsBridgeBuilder: (leaseContext: FsBridgeLeaseContext) => {
			return (params: { readonly sandbox: unknown }): GondolinFsBridge => {
				return ssh.createRemoteShellSandboxFsBridge({
					sandbox: params.sandbox,
					runtime: {
						remoteWorkspaceDir: leaseContext.remoteWorkspaceDir,
						remoteAgentWorkspaceDir: leaseContext.remoteAgentWorkspaceDir,
						runRemoteShellScript: leaseContext.runRemoteShellScript,
					},
				});
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

interface OpenClawSandboxSdk extends SshHelpers {
	registerSandboxBackend: (
		id: string,
		reg: { factory: ReturnType<typeof createGondolinSandboxBackendFactory> },
	) => void;
}

function assertSdkShape(value: unknown): asserts value is OpenClawSandboxSdk {
	if (typeof value !== 'object' || value === null) {
		throw new TypeError('OpenClaw SDK module is not an object');
	}

	const requiredFunctions = [
		'buildExecRemoteCommand',
		'buildRemoteCommand',
		'buildSshSandboxArgv',
		'createRemoteShellSandboxFsBridge',
		'createSshSandboxSessionFromSettings',
		'runSshSandboxCommand',
		'sanitizeEnvVars',
		'registerSandboxBackend',
	] as const;

	const record = value as Record<string, unknown>;
	for (const name of requiredFunctions) {
		if (typeof record[name] !== 'function') {
			throw new TypeError(`OpenClaw SDK missing required export: ${name}`);
		}
	}
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

		// Lazy-load OpenClaw SDK from the global install path.
		// Our plugin lives at /opt/extensions/gondolin/ (outside OpenClaw's node_modules),
		// so bare specifier 'openclaw/plugin-sdk/sandbox' won't resolve.
		// Use absolute path to the SDK entry point in OpenClaw's global install.
		const sdkPath = '/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/sandbox.js';
		const sdkPromise = import(sdkPath).then((sdkRaw: Record<string, unknown>) => {
			assertSdkShape(sdkRaw);

			const ssh: SshHelpers = {
				buildExecRemoteCommand: sdkRaw.buildExecRemoteCommand,
				buildRemoteCommand: sdkRaw.buildRemoteCommand,
				buildSshSandboxArgv: sdkRaw.buildSshSandboxArgv,
				createRemoteShellSandboxFsBridge: sdkRaw.createRemoteShellSandboxFsBridge,
				createSshSandboxSessionFromSettings: sdkRaw.createSshSandboxSessionFromSettings,
				runSshSandboxCommand: sdkRaw.runSshSandboxCommand,
				sanitizeEnvVars: sdkRaw.sanitizeEnvVars,
			};

			sdkRaw.registerSandboxBackend('gondolin', {
				factory: createGondolinSandboxBackendFactory(pluginConfig, createBackendDeps(ssh)),
			});
		});

		// Fire and forget — OpenClaw's plugin system expects register() to be sync,
		// but the sandbox backend registration is async. The backend won't be
		// available until the import resolves (~1 tick). In practice, sandbox
		// backends are used at tool-call time, not at startup, so this is safe.
		sdkPromise.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			process.stderr.write(`[gondolin] failed to load OpenClaw SDK: ${message}\n`);
		});
	},
};

export default plugin;

// Named export for testing
export { createBackendDeps };
export type { SshHelpers };
