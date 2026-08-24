import { toolPortalConfigSchema, type ToolPortalConfig } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import {
	callPolicyDecision,
	type ToolPortalCallPolicyDecision,
} from './tool-portal-service-common.js';

function createConfig(): ToolPortalConfig {
	return toolPortalConfigSchema.parse({
		agents: { agent: { profile: 'profile' } },
		mode: 'managed',
		profiles: {
			profile: {
				namespaces: {
					google: {
						backend: {
							kind: 'controller_execution',
							operations: {
								gog: {
									calls: {
										deny: [
											{
												flags: [{ names: ['--permanent'] }, { names: ['--force', '-f'] }],
												path: ['drive', 'delete'],
											},
										],
										requiresApproval: [
											{
												flags: [{ names: ['--permanent'] }],
												path: ['drive', 'delete'],
											},
										],
										withoutApproval: 'remaining_admitted',
									},
									commands: [
										{ flagRules: [], path: ['drive', 'ls'] },
										{ flagRules: [], path: ['drive', 'delete'] },
									],
									deniedPatterns: [],
									executablePath: '/usr/bin/gog',
									executionTarget: {
										cwd: '/var/empty',
										environment: { kind: 'empty' },
										kind: 'controller_host',
									},
									kind: 'configured_cli',
									mandatoryArgvPrefix: [],
									output: {
										modelVisibleStderr: 'none',
										overflow: 'fail',
										stderrMaxBytes: 1_024,
										stdoutMaxBytes: 1_024,
									},
									safeHelp: 'Use gog with tokenized argv.',
									stdin: { kind: 'none' },
									timeout: { kind: 'quick' },
								},
							},
						},
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: { allow: ['gog'] },
						},
						discovery: {},
						tools: { allow: ['gog'] },
					},
				},
			},
		},
		schemaVersion: 1,
	});
}

function decide(
	argv: readonly string[],
	extras: { readonly stdin?: string } = {},
): ToolPortalCallPolicyDecision {
	return callPolicyDecision({
		call: {
			arguments: {
				argv: [...argv],
				reason: 'call policy proof',
				...(extras.stdin === undefined ? {} : { stdin: extras.stdin }),
			},
			id: 'call-1',
			name: 'gog',
			namespace: 'google',
		},
		config: createConfig(),
		profileId: 'profile',
		semanticSnapshot: {
			surfaceEligibilityByProfile: { profile: { google: ['protected_uds'] } },
		},
		surfaceClass: 'protected_uds',
	});
}

describe('configured CLI Tool Portal call policy', () => {
	it.each([
		{ argv: ['drive', 'ls'], kind: 'without-approval' },
		{ argv: ['drive', 'delete', 'file-1', '--permanent'], kind: 'requires-approval' },
		{ argv: ['drive', 'delete', 'file-1', '--permanent', '--force'], kind: 'denied' },
		{ argv: ['mail', 'send'], kind: 'denied' },
	] as const)('classifies exact configured input $argv as $kind', ({ argv, kind }) => {
		expect(decide(argv)).toMatchObject({ kind });
	});

	it('denies configured input that violates stdin admission', () => {
		expect(decide(['drive', 'ls'], { stdin: 'not admitted' })).toEqual({ kind: 'denied' });
	});
});
