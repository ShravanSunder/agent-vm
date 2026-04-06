import { createGondolinSandboxBackendFactory } from './backend.js';
import { resolveGondolinPluginConfig } from './config.js';

export function createGondolinPlugin(dependencies: {
	readonly registerSandboxBackend: (
		id: string,
		registration: {
			factory: ReturnType<typeof createGondolinSandboxBackendFactory>;
		},
	) => void;
	readonly sshHelpers: {
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
	};
}): {
	readonly description: string;
	readonly id: string;
	readonly name: string;
	register(api: { pluginConfig: Record<string, unknown>; registrationMode: string }): void;
} {
	return {
		description: 'Gondolin-backed sandbox runtime for OpenClaw agent execution.',
		id: 'gondolin',
		name: 'Gondolin Sandbox',
		register(api: { pluginConfig: Record<string, unknown>; registrationMode: string }): void {
			if (api.registrationMode !== 'full') {
				return;
			}

			const pluginConfig = resolveGondolinPluginConfig(api.pluginConfig);
			const ssh = dependencies.sshHelpers;

			dependencies.registerSandboxBackend('gondolin', {
				factory: createGondolinSandboxBackendFactory(pluginConfig, {
					buildExecSpec: async ({ command, env, ssh: sshCreds, usePty, workdir }) => {
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
					runRemoteShellScript: async ({ script, ssh: sshCreds }) => {
						const session = await ssh.createSshSandboxSessionFromSettings({
							target: `${sshCreds.user}@${sshCreds.host}:${sshCreds.port}`,
							identityData: sshCreds.identityPem,
							strictHostKeyChecking: false,
							updateHostKeys: false,
							command: 'ssh',
							workspaceRoot: '/workspace',
						});

						return await ssh.runSshSandboxCommand({
							session,
							remoteCommand: ssh.buildRemoteCommand([
								'/bin/sh',
								'-c',
								script,
								'gondolin-sandbox-fs',
							]),
						});
					},
				}),
			});
		},
	};
}

// Runtime default export: dynamically import OpenClaw SDK helpers
type RuntimeRegisterSandboxBackend = (
	id: string,
	registration: {
		factory: ReturnType<typeof createGondolinSandboxBackendFactory>;
	},
) => void;

let runtimeDeps: {
	registerSandboxBackend: RuntimeRegisterSandboxBackend;
	sshHelpers: Parameters<typeof createGondolinPlugin>[0]['sshHelpers'];
} | null = null;

try {
	const sandboxModule = await import('openclaw/plugin-sdk/sandbox');
	runtimeDeps = {
		registerSandboxBackend: sandboxModule.registerSandboxBackend as RuntimeRegisterSandboxBackend,
		sshHelpers: {
			buildExecRemoteCommand: sandboxModule.buildExecRemoteCommand,
			buildRemoteCommand: sandboxModule.buildRemoteCommand,
			buildSshSandboxArgv: sandboxModule.buildSshSandboxArgv,
			createSshSandboxSessionFromSettings: sandboxModule.createSshSandboxSessionFromSettings,
			runSshSandboxCommand: sandboxModule.runSshSandboxCommand,
			sanitizeEnvVars: sandboxModule.sanitizeEnvVars,
		},
	};
} catch {
	runtimeDeps = null;
}

const defaultPlugin = createGondolinPlugin({
	registerSandboxBackend: (id, registration): void => {
		if (!runtimeDeps) {
			throw new Error(
				'openclaw/plugin-sdk/sandbox is unavailable; load this package inside an OpenClaw runtime.',
			);
		}
		runtimeDeps.registerSandboxBackend(id, registration);
	},
	sshHelpers: {
		buildExecRemoteCommand: (...args) => {
			if (!runtimeDeps) throw new Error('OpenClaw runtime unavailable');
			return runtimeDeps.sshHelpers.buildExecRemoteCommand(...args);
		},
		buildRemoteCommand: (...args) => {
			if (!runtimeDeps) throw new Error('OpenClaw runtime unavailable');
			return runtimeDeps.sshHelpers.buildRemoteCommand(...args);
		},
		buildSshSandboxArgv: (...args) => {
			if (!runtimeDeps) throw new Error('OpenClaw runtime unavailable');
			return runtimeDeps.sshHelpers.buildSshSandboxArgv(...args);
		},
		createSshSandboxSessionFromSettings: async (...args) => {
			if (!runtimeDeps) throw new Error('OpenClaw runtime unavailable');
			return await runtimeDeps.sshHelpers.createSshSandboxSessionFromSettings(...args);
		},
		runSshSandboxCommand: async (...args) => {
			if (!runtimeDeps) throw new Error('OpenClaw runtime unavailable');
			return await runtimeDeps.sshHelpers.runSshSandboxCommand(...args);
		},
		sanitizeEnvVars: (...args) => {
			if (!runtimeDeps) throw new Error('OpenClaw runtime unavailable');
			return runtimeDeps.sshHelpers.sanitizeEnvVars(...args);
		},
	},
});

export default defaultPlugin;
