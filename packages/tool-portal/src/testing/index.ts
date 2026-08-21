import { toolPortalConfigSchema, type ToolPortalConfig } from '@agent-vm/config-contracts';

import {
	CliAllowanceSchema,
	type CliAllowance,
} from '../cli-allowances/models/cli-allowance-schema.js';

export interface CreateToolPortalConfigFixtureProps {
	readonly agentId?: string;
	readonly namespace?: string;
	readonly profileId?: string;
	readonly name?: string;
}

export interface CreateCliAllowanceFixtureProps {
	readonly timeoutKind?: 'open' | 'quick';
}

export function createToolPortalConfigFixture(
	props: CreateToolPortalConfigFixtureProps = {},
): ToolPortalConfig {
	const namespace = props.namespace ?? 'github';
	const name = props.name ?? 'get_issue';
	const profileId = props.profileId ?? 'code-builder';
	return toolPortalConfigSchema.parse({
		agents: {
			[props.agentId ?? 'agent-1']: {
				profile: profileId,
			},
		},
		mode: 'managed',
		profiles: {
			[profileId]: {
				namespaces: {
					[namespace]: {
						backend: { kind: 'mcp_provider' },
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: { allow: [name] },
						},
						tools: {
							allow: [name],
						},
					},
				},
			},
		},
		schemaVersion: 1,
	});
}

export function createCliAllowanceFixture(
	props: CreateCliAllowanceFixtureProps = {},
): CliAllowance {
	return CliAllowanceSchema.parse({
		commands: [
			{
				flagRules: [{ kind: 'deny', names: ['--config', '--token'] }],
				path: ['issue', 'view'],
			},
		],
		deniedPatterns: [{ kind: 'literal', value: '../' }],
		stdin: { kind: 'none' },
		timeout: { kind: props.timeoutKind ?? 'quick' },
	});
}
