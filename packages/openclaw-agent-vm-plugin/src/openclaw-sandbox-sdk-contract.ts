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
	}) => import('./sandbox-backend-factory.js').OpenClawSandboxFsBridge;
	readonly createSshSandboxSessionFromSettings: (settings: {
		readonly command: string;
		readonly identityData?: string;
		readonly knownHostsData?: string;
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

export interface OpenClawToolRegistration {
	readonly description: string;
	readonly execute: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: (update: Record<string, unknown>) => Promise<void> | void,
	) => Promise<OpenClawToolResult>;
	readonly label?: string;
	readonly name: string;
	readonly parameters: Record<string, unknown>;
}

export interface OpenClawToolRegistrationOptions {
	readonly name?: string;
	readonly names?: readonly string[];
	readonly optional?: boolean;
}

export interface OpenClawToolResult {
	readonly content: string;
	readonly details?: unknown;
}

export interface OpenClawPluginToolContext {
	readonly agentDir?: string;
	readonly agentId?: string;
	readonly workspaceDir?: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
}

export interface OpenClawToolRegistrationApi {
	readonly registerTool?: (
		tool:
			| OpenClawToolRegistration
			| ((context: OpenClawPluginToolContext) => readonly OpenClawToolRegistration[]),
		options?: OpenClawToolRegistrationOptions,
	) => void;
}

export interface OpenClawHttpRouteRegistration {
	readonly auth: 'gateway' | 'plugin';
	readonly handler: (
		req: IncomingMessage,
		res: ServerResponse,
	) => Promise<boolean | void> | boolean | void;
	readonly handleUpgrade?: (
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => Promise<boolean | void> | boolean | void;
	readonly match?: 'exact' | 'prefix';
	readonly path: string;
	readonly replaceExisting?: boolean;
}

export interface OpenClawHttpRouteRegistrationApi {
	readonly registerHttpRoute?: (route: OpenClawHttpRouteRegistration) => void;
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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
