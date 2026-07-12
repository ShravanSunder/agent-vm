const agentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;

export const OPENCLAW_DEFAULT_AGENT_ID = 'main';

export interface OpenClawAgentVmSandboxRequirement {
	readonly expectedValue: string;
	readonly key: 'backend' | 'mode' | 'scope' | 'workspaceAccess';
}

export const OPENCLAW_AGENT_VM_SANDBOX_REQUIREMENTS: readonly OpenClawAgentVmSandboxRequirement[] =
	[
		{ expectedValue: 'gondolin', key: 'backend' },
		{ expectedValue: 'all', key: 'mode' },
		{ expectedValue: 'agent', key: 'scope' },
		{ expectedValue: 'rw', key: 'workspaceAccess' },
	] as const;

export const OPENCLAW_AGENT_VM_LEASE_SCOPE_GUIDANCE: string =
	'Managed OpenClaw/Gondolin leases are agent-scoped. The plugin derives agentId from sessionKey and does not send OpenClaw scope keys to the controller.';

export type OpenClawAgentVmSandboxRequirementKey = OpenClawAgentVmSandboxRequirement['key'];

export interface OpenClawAgentVmSandboxSnapshot {
	readonly backend?: unknown;
	readonly mode?: unknown;
	readonly scope?: unknown;
	readonly workspaceAccess?: unknown;
}

export interface OpenClawAgentVmAgentConfig {
	readonly id?: unknown;
	readonly sandbox?: OpenClawAgentVmSandboxSnapshot;
	readonly workspace?: unknown;
}

export class OpenClawAgentIdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OpenClawAgentIdError';
	}
}

export function isOpenClawAgentId(value: string): boolean {
	return agentIdPattern.test(value.trim());
}

export function effectiveOpenClawAgentVmSandboxValue(
	defaults: OpenClawAgentVmAgentConfig,
	agentConfig: OpenClawAgentVmAgentConfig,
	key: OpenClawAgentVmSandboxRequirementKey,
): unknown {
	return agentConfig.sandbox?.[key] ?? defaults.sandbox?.[key];
}

export function formatOpenClawAgentVmRequirementFieldPath(
	label: string,
	key: OpenClawAgentVmSandboxRequirementKey,
): string {
	return `agents.${label}.sandbox.${key}`;
}

export function formatOpenClawAgentVmRequirementFindingId(options: {
	readonly fieldPath: string;
	readonly label: string;
	readonly zoneId: string;
}): string {
	return `openclaw-tool-vm-${options.fieldPath.replace(/[.[\]]/gu, '-')}-${options.zoneId}-${options.label}`;
}

export function formatOpenClawAgentVmRequirementHint(options: {
	readonly expectedValue: string;
	readonly fieldPath: string;
	readonly ok: boolean;
}): string {
	return options.ok
		? `${options.fieldPath}=${options.expectedValue}`
		: `Set ${options.fieldPath} to "${options.expectedValue}" for OpenClaw Tool VM mediation.`;
}

export function normalizeOpenClawAgentId(value: string | undefined | null): string {
	const trimmed = (value ?? '').trim().toLowerCase();
	if (trimmed === '') {
		return OPENCLAW_DEFAULT_AGENT_ID;
	}
	if (!isOpenClawAgentId(trimmed)) {
		throw new OpenClawAgentIdError(`Invalid OpenClaw agentId '${value}'.`);
	}
	return trimmed;
}

export function resolveOpenClawAgentIdFromSessionKey(sessionKey: string): string {
	const parts = sessionKey.trim().split(':');
	if (parts[0] !== 'agent' || !parts[1] || !isOpenClawAgentId(parts[1])) {
		throw new OpenClawAgentIdError(
			`OpenClaw sessionKey '${sessionKey}' must be agent-shaped and include a valid agentId.`,
		);
	}
	return normalizeOpenClawAgentId(parts[1]);
}

export function isOpenClawAgentSessionKey(sessionKey: string): boolean {
	const parts = sessionKey.trim().split(':');
	return parts[0] === 'agent' && parts[1] !== undefined && isOpenClawAgentId(parts[1]);
}

export function snapshotOpenClawAgentVmSandboxConfig(cfg: OpenClawAgentVmSandboxSnapshot): {
	readonly backend: unknown;
	readonly mode: unknown;
	readonly scope: unknown;
	readonly workspaceAccess: unknown;
} {
	return {
		backend: cfg.backend,
		mode: cfg.mode,
		scope: cfg.scope,
		workspaceAccess: cfg.workspaceAccess,
	};
}

export function findOpenClawAgentVmSandboxMismatch(
	sandbox: OpenClawAgentVmSandboxSnapshot,
): OpenClawAgentVmSandboxRequirement | undefined {
	return OPENCLAW_AGENT_VM_SANDBOX_REQUIREMENTS.find(
		(requirement) => sandbox[requirement.key] !== requirement.expectedValue,
	);
}
