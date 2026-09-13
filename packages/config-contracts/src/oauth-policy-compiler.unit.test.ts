import { oauthServiceIdSchema } from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from './oauth-policy-compiler-test-fixture.js';
import { compileOAuthPolicy } from './oauth-tool-portal-config.js';

describe('OAuth and Tool Portal compiler', () => {
	it('compiles profile-owned explicit recommendations and defaults from authored OAuth without agents', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		const oauthConfig = input.oauthConfig;
		const profile = input.toolPortalConfig.profiles.shared;
		const toolPortalConfig = {
			...input.toolPortalConfig,
			agents: { sun: { profile: 'shared' }, ember: { profile: 'shared' } },
			profiles: {
				shared: {
					...profile,
					oauthApplications: {
						'gmail-app': {
							ceiling: { kind: 'explicit', groupIds: ['gmail.read', 'gmail.write'] },
							consentRecommendation: {
								kind: 'explicit',
								groupIds: ['gmail.read'],
							},
							policyDefaults: {
								kind: 'explicit',
								services: { gmail: { read: 'ask', write: 'deny' } },
							},
						},
					},
				},
			},
		};
		// Act
		const compiled = compileOAuthPolicy({ ...input, oauthConfig, toolPortalConfig });
		// Assert
		expect(compiled.oauthConfig.agents.sun?.applications['gmail-app']).toBeDefined();
		expect(compiled.recommendationSelectionsByAgent.sun).toEqual({
			'gmail-app': ['gmail.read'],
		});
		expect(compiled.recommendationSelectionsByAgent.ember).toEqual({
			'gmail-app': ['gmail.read'],
		});
		expect(compiled.defaultsByAgentApplication.sun?.['gmail-app']).toEqual({
			gmail: { read: 'ask', write: 'deny' },
		});
		expect(compiled.defaultsByAgentApplication.ember).toEqual(
			compiled.defaultsByAgentApplication.sun,
		);
	});
	it('compiles executable offers and independent per-agent defaults without account slots', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		// Act
		const compiled = compileOAuthPolicy(input);
		// Assert
		expect(compiled.offeredGroupIdsByAgentApplication.sun?.['gmail-app']).toEqual(['gmail.read']);
		expect(compiled.operationIdsByAgent.sun).toEqual(['gmail.search']);
		expect(compiled.defaultsByAgentApplication.sun?.['gmail-app']).toEqual({
			gmail: { read: 'allow', write: 'deny' },
		});
		expect(compiled.defaultsByAgentApplication.ember?.['gmail-app']).toEqual({
			gmail: { read: 'ask', write: 'deny' },
		});
		expect(compiled.defaultsSnapshot.sourcesByAgent).toEqual({
			sun: { kind: 'collection', collectionId: 'read-only-assistant', version: '1' },
			ember: { kind: 'explicit' },
		});
		expect(compiled.recommendationSelectionsByAgent.sun).toEqual({ 'gmail-app': ['gmail.read'] });
		expect(compiled.toolPortalConfig.profiles.shared?.namespaces.google?.backend).toMatchObject({
			operations: {
				gog: {
					output:
						input.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.output,
				},
			},
		});
	});
	it('changes the defaults revision when defaults change, not when labels or key refs change', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		const first = compileOAuthPolicy(input);
		// Act
		input.toolPortalConfig.profiles.ask.oauthApplications[
			'gmail-app'
		].policyDefaults.services.gmail.read = 'allow';
		const changed = compileOAuthPolicy(input);
		// Assert
		expect(changed.defaultsRevision).not.toBe(first.defaultsRevision);
		input.oauthConfig.owners.owner.label = 'Updated display label';
		expect(compileOAuthPolicy(input).defaultsRevision).toBe(changed.defaultsRevision);
		const sharedProfile = input.toolPortalConfig.profiles.shared;
		const recommendationChanged = {
			...input.toolPortalConfig,
			profiles: {
				...input.toolPortalConfig.profiles,
				shared: {
					...sharedProfile,
					oauthApplications: {
						...sharedProfile.oauthApplications,
						'gmail-app': {
							...sharedProfile.oauthApplications['gmail-app'],
							consentRecommendation: { kind: 'explicit', groupIds: ['gmail.read'] },
						},
					},
				},
			},
		};
		expect(
			compileOAuthPolicy({ ...input, toolPortalConfig: recommendationChanged }).defaultsRevision,
		).toBe(changed.defaultsRevision);
	});
	it.each(['version', 'commit'] as const)('rejects mismatched pinned Gog %s', (field) => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		input.catalog.gogBuildIdentity = {
			...input.catalog.gogBuildIdentity,
			[field]: field === 'commit' ? 'a'.repeat(40) : '0.1.0',
		};
		// Act / Assert
		expect(() => compileOAuthPolicy(input)).toThrow();
	});
	it.each([{ path: ['gmail'] }, { path: ['api'] }, { path: ['gmail', 'unclassified'] }])(
		'rejects unqualified path %j',
		({ path }) => {
			// Arrange
			const input = createOAuthPolicyCompilerTestInput();
			input.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.commands[0] =
				{ path, flagRules: [] };
			// Act / Assert
			expect(() => compileOAuthPolicy(input)).toThrow();
		},
	);
	it('rejects a recommendation above the hard maximum instead of silently clamping it', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		input.catalog.collections['read-only-assistant'].selections.communications.push('gmail.write');
		// Act / Assert
		expect(() => compileOAuthPolicy(input)).toThrow();
	});
	it('keeps omitted recommendations and defaults independently absent', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		const sharedProfile = input.toolPortalConfig.profiles.shared;
		const toolPortalConfig = {
			...input.toolPortalConfig,
			profiles: {
				...input.toolPortalConfig.profiles,
				shared: {
					...sharedProfile,
					oauthApplications: {
						'gmail-app': {
							ceiling: sharedProfile.oauthApplications['gmail-app'].ceiling,
						},
					},
				},
			},
		};
		// Act
		const compiled = compileOAuthPolicy({ ...input, toolPortalConfig });
		// Assert
		expect(compiled.recommendationSelectionsByAgent.sun).toEqual({});
		expect(compiled.defaultsByAgentApplication.sun).toEqual({});
		expect(compiled.defaultsSnapshot.sourcesByAgent.sun).toEqual({ kind: 'missing' });
	});
	it.each([
		{
			name: 'a foreign explicit recommendation group',
			application: {
				consentRecommendation: { kind: 'explicit', groupIds: ['youtube.read'] },
			},
			error: 'foreign recommendation',
		},
		{
			name: 'an above-offer explicit recommendation group',
			application: {
				consentRecommendation: { kind: 'explicit', groupIds: ['gmail.write'] },
			},
			error: 'exceeds the executable hard maximum',
		},
		{
			name: 'an unknown recommendation collection',
			application: {
				consentRecommendation: {
					kind: 'collection',
					collectionId: 'unknown-collection',
					version: '1',
				},
			},
			error: 'unknown or foreign recommendation',
		},
		{
			name: 'an unknown defaults collection',
			application: {
				policyDefaults: {
					kind: 'collection',
					collectionId: 'unknown-collection',
					version: '1',
				},
			},
			error: 'unknown defaults collection',
		},
	] as const)('rejects $name', ({ application, error }) => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		const sharedProfile = input.toolPortalConfig.profiles.shared;
		const toolPortalConfig = {
			...input.toolPortalConfig,
			profiles: {
				...input.toolPortalConfig.profiles,
				shared: {
					...sharedProfile,
					oauthApplications: {
						...sharedProfile.oauthApplications,
						'gmail-app': {
							...sharedProfile.oauthApplications['gmail-app'],
							...application,
						},
					},
				},
			},
		};
		// Act / Assert
		expect(() => compileOAuthPolicy({ ...input, toolPortalConfig })).toThrow(error);
	});
	it('allows a deliberate Write Allow default with qualified write commands, without forcing Ask', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		input.toolPortalConfig.profiles.ask.namespaces.google.backend.operations.gog.commands.push({
			path: ['gmail', 'send'],
			flagRules: [],
		});
		input.toolPortalConfig.profiles.ask.oauthApplications[
			'gmail-app'
		].policyDefaults.services.gmail.write = 'allow';
		// Act / Assert
		expect(
			compileOAuthPolicy(input).defaultsByAgentApplication.ember?.['gmail-app']?.[
				oauthServiceIdSchema.parse('gmail')
			]?.write,
		).toBe('allow');
	});
	it('rejects excessive defaults, unqualified hosts and fixed argv auth escapes', () => {
		// Arrange
		const defaults = createOAuthPolicyCompilerTestInput();
		defaults.toolPortalConfig.profiles.ask.oauthApplications[
			'gmail-app'
		].policyDefaults.services.gmail.write = 'allow';
		const hosts = createOAuthPolicyCompilerTestInput();
		hosts.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.executionTarget.allowedHosts.push(
			'untrusted.example.test',
		);
		const argv = createOAuthPolicyCompilerTestInput();
		argv.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.mandatoryArgvPrefix.push(
			'--access-token=other',
		);
		// Act / Assert
		expect(() => compileOAuthPolicy(defaults)).toThrow();
		expect(() => compileOAuthPolicy(hosts)).toThrow();
		expect(() => compileOAuthPolicy(argv)).toThrow();
	});
});
