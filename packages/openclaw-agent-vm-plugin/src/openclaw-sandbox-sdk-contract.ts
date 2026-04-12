export interface SshSandboxSession {
	readonly command: string;
	readonly configPath: string;
	readonly host: string;
}

export interface SshHelpers {
	readonly buildExecRemoteCommand: (params: {
		readonly command: string;
		readonly env: Record<string, string>;
		readonly workdir?: string;
	}) => string;
	readonly buildRemoteCommand: (argv: readonly string[]) => string;
	readonly buildSshSandboxArgv: (params: {
		readonly remoteCommand: string;
		readonly session: SshSandboxSession;
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
			}) => Promise<{
				readonly code: number;
				readonly stderr: Buffer;
				readonly stdout: Buffer;
			}>;
		};
		readonly sandbox: unknown;
	}) => import('./sandbox-backend-factory.js').GondolinFsBridge;
	readonly createSshSandboxSessionFromSettings: (settings: {
		readonly command: string;
		readonly identityData?: string;
		readonly strictHostKeyChecking: boolean;
		readonly target: string;
		readonly updateHostKeys: boolean;
		readonly workspaceRoot: string;
	}) => Promise<SshSandboxSession>;
	readonly disposeSshSandboxSession?: (session: SshSandboxSession) => Promise<void>;
	readonly runSshSandboxCommand: (params: {
		readonly allowFailure?: boolean;
		readonly remoteCommand: string;
		readonly session: SshSandboxSession;
		readonly signal?: AbortSignal;
		readonly stdin?: Buffer | string;
	}) => Promise<{
		readonly code: number;
		readonly stderr: Buffer;
		readonly stdout: Buffer;
	}>;
	readonly sanitizeEnvVars: (env: NodeJS.ProcessEnv) => {
		readonly allowed: Record<string, string>;
	};
}

export function assertSdkShape(value: unknown): asserts value is SshHelpers & {
	registerSandboxBackend: (
		id: string,
		registration: {
			factory: ReturnType<
				typeof import('./sandbox-backend-factory.js').createGondolinSandboxBackendFactory
			>;
			manager?: ReturnType<
				typeof import('./sandbox-backend-factory.js').createGondolinSandboxBackendManager
			>;
		},
	) => void;
} {
	if (typeof value !== 'object' || value === null) {
		throw new TypeError('OpenClaw SDK module is not an object');
	}

	for (const exportName of [
		'buildExecRemoteCommand',
		'buildRemoteCommand',
		'buildSshSandboxArgv',
		'createRemoteShellSandboxFsBridge',
		'createSshSandboxSessionFromSettings',
		'runSshSandboxCommand',
		'sanitizeEnvVars',
		'registerSandboxBackend',
	] as const) {
		if (typeof (value as Record<string, unknown>)[exportName] !== 'function') {
			throw new TypeError(`OpenClaw SDK missing required export: ${exportName}`);
		}
	}
}
