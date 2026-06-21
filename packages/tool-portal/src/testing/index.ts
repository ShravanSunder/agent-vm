import { toolPortalConfigSchema, type ToolPortalConfig } from '@agent-vm/config-contracts';

import {
	CliAllowanceSchema,
	type CliAllowance,
} from '../cli-allowances/models/cli-allowance-schema.js';

export interface CreateToolPortalConfigFixtureProps {
	readonly agentId?: string;
	readonly namespace?: string;
	readonly profileId?: string;
	readonly toolName?: string;
}

export interface CreateCliAllowanceFixtureProps {
	readonly credentialProfileId?: string;
	readonly executablePath?: string;
	readonly namespace?: string;
	readonly toolName?: string;
}

export function createToolPortalConfigFixture(
	props: CreateToolPortalConfigFixtureProps = {},
): ToolPortalConfig {
	const namespace = props.namespace ?? 'github';
	const toolName = props.toolName ?? 'get_issue';
	const profileId = props.profileId ?? 'code-builder';
	return toolPortalConfigSchema.parse({
		agents: {
			[props.agentId ?? 'agent-1']: {
				profile: profileId,
			},
		},
		profiles: {
			[profileId]: {
				capabilities: {
					[namespace]: {
						backend: { kind: 'mcp' },
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: { allow: [toolName] },
						},
						tools: {
							allow: [toolName],
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
	const namespace = props.namespace ?? 'github';
	const toolName = props.toolName ?? 'issue_view';
	return CliAllowanceSchema.parse({
		allowedFlags: [{ flag: '--json', value: 'none' }],
		allowedSubcommands: [['issue', 'view']],
		approval: 'required',
		artifacts: {
			maxArtifacts: 0,
			mode: 'none',
			noFollowRequired: true,
		},
		capability: {
			namespace,
			toolName,
		},
		cancellation: {
			onCancel: 'close_vm',
			timeoutMs: 30_000,
		},
		credentialProfileId: props.credentialProfileId ?? 'github-readonly',
		custodyMode: 'ephemeral_material',
		cwd: { kind: 'fixed', path: '/work' },
		deniedFlags: ['--config', '--token'],
		deniedPatterns: ['../'],
		egress: {
			allowedHosts: ['api.github.com'],
			denyEndpointOverrides: true,
		},
		environment: {
			allowedVariables: [],
			deniedPatterns: [],
			mode: 'empty',
		},
		executablePath: props.executablePath ?? '/usr/local/bin/gh',
		inputSchemaId: `${namespace}.${toolName}.input`,
		output: {
			modelVisibleStderr: 'safe_summary',
			redactionProfile: 'default',
			stderrMaxBytes: 1024,
			stdoutMaxBytes: 1024,
			truncationMode: 'truncate',
		},
		safeHelp: 'Fixture allowance for tests.',
	});
}
