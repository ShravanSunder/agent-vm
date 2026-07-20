import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

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
	readonly agentAccountId?: string;
	readonly agentDir?: string;
	readonly agentId?: string;
	readonly requesterSenderId?: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
	readonly workspaceDir?: string;
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

export interface OpenClawPluginLogger {
	readonly debug?: (message: string) => void;
	readonly error: (message: string) => void;
	readonly info: (message: string) => void;
	readonly warn: (message: string) => void;
}

export interface OpenClawPluginServiceContext {
	readonly config: Readonly<Record<string, unknown>>;
	readonly logger: OpenClawPluginLogger;
	readonly stateDir: string;
	readonly workspaceDir?: string;
}

export interface OpenClawPluginService {
	readonly id: string;
	readonly start: (context: OpenClawPluginServiceContext) => Promise<void> | void;
	readonly stop?: (context: OpenClawPluginServiceContext) => Promise<void> | void;
}

export interface OpenClawPluginServiceRegistrationApi {
	readonly registerService?: (service: OpenClawPluginService) => void;
}

export interface OpenClawSandboxBackendRegistrationApi {
	readonly registerSandboxBackend: (
		id: string,
		registration: Readonly<Record<string, unknown>>,
	) => () => void;
}

export function assertSdkShape(
	value: unknown,
): asserts value is OpenClawSandboxBackendRegistrationApi {
	if (typeof value !== 'object' || value === null) {
		throw new TypeError('OpenClaw SDK module is not an object');
	}

	for (const exportName of ['registerSandboxBackend'] as const) {
		if (typeof (value as Record<string, unknown>)[exportName] !== 'function') {
			throw new TypeError(`OpenClaw SDK missing required export: ${exportName}`);
		}
	}
}
