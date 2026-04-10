import type {
	CreateBackendDependencies,
	FsBridgeLeaseContext,
	GondolinFsBridge,
} from './sandbox-backend-factory.js';
import type {
	SshHelpers,
	SshSandboxSession,
} from './openclaw-sandbox-sdk-contract.js';

export function createBackendDeps(ssh: SshHelpers): {
	readonly buildExecSpec: CreateBackendDependencies['buildExecSpec'];
	readonly createFsBridgeBuilder: (
		leaseContext: FsBridgeLeaseContext,
	) => (params: { readonly sandbox: unknown }) => GondolinFsBridge;
	readonly runRemoteShellScript: CreateBackendDependencies['runRemoteShellScript'];
} {
	return {
		buildExecSpec: async ({
			command,
			env,
			ssh: sshCreds,
			usePty,
			workdir,
		}) => {
			const session = await ssh.createSshSandboxSessionFromSettings({
				command: 'ssh',
				identityData: sshCreds.identityPem,
				strictHostKeyChecking: false,
				target: `${sshCreds.user}@${sshCreds.host}:${sshCreds.port}`,
				updateHostKeys: false,
				workspaceRoot: workdir,
			});
			const disposeSshSandboxSession = ssh.disposeSshSandboxSession;
			return {
				argv: ssh.buildSshSandboxArgv({
					remoteCommand: ssh.buildExecRemoteCommand({
						command,
						env,
						workdir,
					}),
					session,
					tty: usePty,
				}),
				env: ssh.sanitizeEnvVars(process.env).allowed,
				finalizeToken: {
					dispose: async (): Promise<void> => {
						if (disposeSshSandboxSession) {
							await disposeSshSandboxSession(session);
						}
					},
					session,
				},
				stdinMode: 'pipe-open' as const,
			};
		},
		createFsBridgeBuilder: (leaseContext: FsBridgeLeaseContext) =>
			(params: { readonly sandbox: unknown }): GondolinFsBridge =>
				ssh.createRemoteShellSandboxFsBridge({
					sandbox: params.sandbox,
					runtime: {
						remoteAgentWorkspaceDir: leaseContext.remoteAgentWorkspaceDir,
						remoteWorkspaceDir: leaseContext.remoteWorkspaceDir,
						runRemoteShellScript: leaseContext.runRemoteShellScript,
					},
				}),
		runRemoteShellScript: async ({ script, ssh: sshCreds, stdin }) => {
			const session = await ssh.createSshSandboxSessionFromSettings({
				command: 'ssh',
				identityData: sshCreds.identityPem,
				strictHostKeyChecking: false,
				target: `${sshCreds.user}@${sshCreds.host}:${sshCreds.port}`,
				updateHostKeys: false,
				workspaceRoot: '/workspace',
			});
			return await ssh.runSshSandboxCommand({
				remoteCommand: ssh.buildRemoteCommand([
					'/bin/sh',
					'-c',
					script,
					'gondolin-sandbox-fs',
				]),
				session,
				...(stdin !== undefined ? { stdin } : {}),
			});
		},
	};
}

export type { SshHelpers, SshSandboxSession };
