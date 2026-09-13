import { oauthServiceIdSchema } from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from './oauth-policy-compiler-test-fixture.js';
import { compileOAuthPolicy } from './oauth-tool-portal-config.js';

describe('OAuth and Tool Portal compiler', () => {
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
		input.toolPortalConfig.agents.ember.googlePolicyDefaults.applications['gmail-app'].gmail.read =
			'allow';
		const changed = compileOAuthPolicy(input);
		// Assert
		expect(changed.defaultsRevision).not.toBe(first.defaultsRevision);
		input.oauthConfig.owners.owner.label = 'Updated display label';
		expect(compileOAuthPolicy(input).defaultsRevision).toBe(changed.defaultsRevision);
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
	it('allows a deliberate Write Allow default with qualified write commands, without forcing Ask', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		input.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.commands.push({
			path: ['gmail', 'send'],
			flagRules: [],
		});
		input.toolPortalConfig.agents.ember.googlePolicyDefaults.applications['gmail-app'].gmail.write =
			'allow';
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
		defaults.toolPortalConfig.agents.ember.googlePolicyDefaults.applications[
			'gmail-app'
		].gmail.write = 'allow';
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
