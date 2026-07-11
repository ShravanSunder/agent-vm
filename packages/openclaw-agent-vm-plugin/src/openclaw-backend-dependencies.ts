import type { SshHelpers, SshSandboxSession } from './openclaw-sandbox-sdk-contract.js';
import type {
	CreateBackendDependencies,
	OpenClawFsBridgeLeaseContext,
	OpenClawSandboxFsBridge,
} from './sandbox-backend-factory.js';

export const OPENCLAW_SSH_SESSION_SCRATCH_ROOT = '/work';

export function createBackendDeps(ssh: SshHelpers): {
	readonly buildExecSpec: CreateBackendDependencies['buildExecSpec'];
	readonly createFsBridgeBuilder: (
		leaseContext: OpenClawFsBridgeLeaseContext,
	) => (params: { readonly sandbox: unknown }) => OpenClawSandboxFsBridge;
	readonly runRemoteShellScript: CreateBackendDependencies['runRemoteShellScript'];
} {
	return {
		buildExecSpec: async ({ command, env, ssh: sshCreds, usePty, workdir }) => {
			const session = await ssh.createSshSandboxSessionFromSettings({
				command: 'ssh',
				identityData: sshCreds.identityPem,
				knownHostsData: sshCreds.knownHostsLine,
				strictHostKeyChecking: true,
				target: `${sshCreds.user}@${sshCreds.host}:${sshCreds.port}`,
				updateHostKeys: false,
				workspaceRoot: OPENCLAW_SSH_SESSION_SCRATCH_ROOT,
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
		createFsBridgeBuilder:
			(leaseContext: OpenClawFsBridgeLeaseContext) =>
			(params: { readonly sandbox: unknown }): OpenClawSandboxFsBridge =>
				ssh.createRemoteShellSandboxFsBridge({
					sandbox: params.sandbox,
					runtime: {
						remoteAgentWorkspaceDir: leaseContext.remoteAgentWorkspaceDir,
						remoteWorkspaceDir: leaseContext.remoteWorkspaceDir,
						runRemoteShellScript: leaseContext.runRemoteShellScript,
					},
				}),
		runRemoteShellScript: async ({ allowFailure, script, signal, ssh: sshCreds, stdin }) => {
			const session = await ssh.createSshSandboxSessionFromSettings({
				command: 'ssh',
				identityData: sshCreds.identityPem,
				knownHostsData: sshCreds.knownHostsLine,
				strictHostKeyChecking: true,
				target: `${sshCreds.user}@${sshCreds.host}:${sshCreds.port}`,
				updateHostKeys: false,
				workspaceRoot: OPENCLAW_SSH_SESSION_SCRATCH_ROOT,
			});
			return await ssh.runSshSandboxCommand({
				...(allowFailure !== undefined ? { allowFailure } : {}),
				remoteCommand: ssh.buildRemoteCommand(['/bin/sh', '-c', script, 'gondolin-sandbox-fs']),
				session,
				...(signal !== undefined ? { signal } : {}),
				...(stdin !== undefined ? { stdin } : {}),
			});
		},
	};
}

export type { SshHelpers, SshSandboxSession };
