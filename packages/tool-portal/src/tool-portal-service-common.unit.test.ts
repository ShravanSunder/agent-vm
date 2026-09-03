import { toolPortalConfigSchema } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { capabilityDiscoveryMetadata } from './tool-portal-service-common.js';

function oauthConfiguredCliPolicy(
	mode: 'mixed' | 'static' = 'mixed',
): ReturnType<typeof toolPortalConfigSchema.parse>['profiles'][string]['namespaces'][string] {
	const config = toolPortalConfigSchema.parse({
		agents: { hermes: { profile: 'default' } },
		mode: 'managed',
		profiles: {
			default: {
				namespaces: {
					gog: {
						backend: {
							kind: 'controller_execution',
							operations: {
								gog_cli: {
									authorization: {
										kind: 'oauth_account_profile',
										rules: [
											{
												match: { flags: [], path: ['gmail', 'search'] },
												requirement: {
													applicationId: 'gmail-app',
													kind: 'oauth',
													minimumPermission: 'read',
													serviceId: 'gmail',
												},
											},
											...(mode === 'mixed'
												? [
														{
															match: { flags: [], path: ['gmail', 'send'] },
															requirement: {
																applicationId: 'gmail-app',
																kind: 'oauth',
																minimumPermission: 'write',
																serviceId: 'gmail',
															},
														},
													]
												: []),
										],
									},
									calls: {
										deny: [],
										requiresApproval:
											mode === 'mixed' ? [{ flags: [], path: ['gmail', 'send'] }] : [],
										withoutApproval: 'remaining_admitted',
									},
									commands: [
										{ path: ['gmail', 'search'] },
										...(mode === 'mixed' ? [{ path: ['gmail', 'send'] }] : []),
									],
									deniedPatterns: [],
									executablePath: '/usr/bin/gog',
									executionTarget: {
										allowedHosts: ['gmail.googleapis.com'],
										credentialProjection: {
											environment: {
												GOG_ACCESS_TOKEN: { kind: 'oauth_access_token' },
											},
											kind: 'http_mediation',
										},
										environment: { kind: 'empty' },
										guestCwd: '/work',
										imageReference: '../../vm-images/controller-runners/gog/build-config.json',
										kind: 'ephemeral_managed_vm',
									},
									kind: 'configured_cli',
									mandatoryArgvPrefix: [],
									output: {
										modelVisibleStderr: 'none',
										overflow: 'truncate',
										stderrMaxBytes: 1_024,
										stdoutMaxBytes: 1_024,
									},
									safeHelp: 'Run one admitted Gog command.',
									stdin: { kind: 'none' },
									timeout: { kind: 'quick' },
								},
							},
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: { allow: ['gog_cli'], deny: [] },
						},
						tools: { allow: ['gog_cli'], deny: [] },
					},
				},
			},
		},
		schemaVersion: 1,
	});
	const policy = config.profiles.default?.namespaces.gog;
	if (policy === undefined) throw new Error('Expected the Gog fixture policy.');
	return policy;
}

describe('capabilityDiscoveryMetadata', () => {
	it('marks mixed configured CLI approval and OAuth rules as invocation-dependent', () => {
		// Arrange
		const policy = oauthConfiguredCliPolicy();

		// Act
		const metadata = capabilityDiscoveryMetadata({ policy, toolName: 'gog_cli' });

		// Assert
		expect(metadata).toEqual({
			callDisposition: { describeBeforeCall: true, kind: 'invocation-dependent' },
			oauthRequirement: {
				accountProfileArgument: 'accountProfile',
				describeBeforeCall: true,
				kind: 'invocation-dependent-oauth-account-profile',
			},
		});
	});

	it('does not publish metadata for a hidden tool', () => {
		// Arrange
		const policy = oauthConfiguredCliPolicy();

		// Act
		const metadata = capabilityDiscoveryMetadata({ policy, toolName: 'hidden' });

		// Assert
		expect(metadata).toBeUndefined();
	});

	it('publishes one static OAuth requirement when every command uses the same grant', () => {
		const metadata = capabilityDiscoveryMetadata({
			policy: oauthConfiguredCliPolicy('static'),
			toolName: 'gog_cli',
		});

		expect(metadata?.oauthRequirement).toEqual({
			applicationId: 'gmail-app',
			kind: 'oauth-account-profile',
			minimumPermission: 'read',
			serviceId: 'gmail',
		});
	});

	it('uses call-time without-approval precedence when authored selectors overlap', () => {
		const policy = structuredClone(oauthConfiguredCliPolicy('static'));
		policy.calls.requiresApproval = { allow: ['gog_cli'], deny: [] };

		expect(capabilityDiscoveryMetadata({ policy, toolName: 'gog_cli' })).toMatchObject({
			callDisposition: { kind: 'without-approval' },
		});
	});
});
