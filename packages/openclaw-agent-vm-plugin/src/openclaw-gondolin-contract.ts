const agentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;

export const OPENCLAW_DEFAULT_AGENT_ID = 'main';

export const OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS = [
	{ expectedValue: 'gondolin', key: 'backend' },
	{ expectedValue: 'all', key: 'mode' },
	{ expectedValue: 'agent', key: 'scope' },
	{ expectedValue: 'rw', key: 'workspaceAccess' },
] as const;

export const OPENCLAW_GONDOLIN_LEASE_SCOPE_GUIDANCE =
	'Managed OpenClaw/Gondolin leases are agent-scoped. The plugin derives agentId from sessionKey and does not send OpenClaw scopeKey to the controller.';

export type OpenClawGondolinSandboxRequirement =
	(typeof OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS)[number];

export type OpenClawGondolinSandboxRequirementKey = OpenClawGondolinSandboxRequirement['key'];

export interface OpenClawGondolinSandboxSnapshot {
	readonly backend?: unknown;
	readonly mode?: unknown;
	readonly scope?: unknown;
	readonly workspaceAccess?: unknown;
}

export interface OpenClawGondolinAgentConfig {
	readonly id?: unknown;
	readonly sandbox?: OpenClawGondolinSandboxSnapshot;
	readonly workspace?: unknown;
}

export function isOpenClawAgentId(value: string): boolean {
	return agentIdPattern.test(value.trim());
}

export function effectiveOpenClawGondolinSandboxValue(
	defaults: OpenClawGondolinAgentConfig,
	agentConfig: OpenClawGondolinAgentConfig,
	key: OpenClawGondolinSandboxRequirementKey,
): unknown {
	return agentConfig.sandbox?.[key] ?? defaults.sandbox?.[key];
}

export function formatOpenClawGondolinRequirementFieldPath(
	label: string,
	key: OpenClawGondolinSandboxRequirementKey,
): string {
	return `agents.${label}.sandbox.${key}`;
}

export function formatOpenClawGondolinRequirementFindingId(options: {
	readonly fieldPath: string;
	readonly label: string;
	readonly zoneId: string;
}): string {
	return `openclaw-tool-vm-${options.fieldPath.replace(/[.[\]]/gu, '-')}-${options.zoneId}-${options.label}`;
}

export function formatOpenClawGondolinRequirementHint(options: {
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
	return isOpenClawAgentId(trimmed) ? trimmed : OPENCLAW_DEFAULT_AGENT_ID;
}

export function resolveOpenClawAgentIdFromSessionKey(sessionKey: string): string {
	const parts = sessionKey.trim().split(':');
	if (parts[0] !== 'agent' || !parts[1]) {
		return OPENCLAW_DEFAULT_AGENT_ID;
	}
	return normalizeOpenClawAgentId(parts[1]);
}

export function isOpenClawAgentSessionKey(sessionKey: string): boolean {
	const parts = sessionKey.trim().split(':');
	return parts[0] === 'agent' && parts[1] !== undefined && isOpenClawAgentId(parts[1]);
}

export function snapshotOpenClawGondolinSandboxConfig(cfg: OpenClawGondolinSandboxSnapshot): {
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

export function findOpenClawGondolinSandboxMismatch(
	sandbox: OpenClawGondolinSandboxSnapshot,
): OpenClawGondolinSandboxRequirement | undefined {
	return OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS.find(
		(requirement) => sandbox[requirement.key] !== requirement.expectedValue,
	);
}
