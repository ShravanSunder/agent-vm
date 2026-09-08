import {
	compileOAuthPolicy,
	configuredGoogleOperationKey,
	createEffectiveManagedToolPortalConfig,
	createGatewayRuntimeManagedToolPortalConfig,
	type GatewayRuntimeManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import { capabilityDiscoveryMetadata } from './tool-portal-service-common.js';

function oauthConfiguredCliPolicy(
	mode: 'mixed' | 'static' = 'mixed',
): GatewayRuntimeManagedToolPortalConfig['profiles'][string]['namespaces'][string] {
	const input = createOAuthPolicyCompilerTestInput();
	if (mode === 'mixed')
		input.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.commands.push({
			path: ['gmail', 'send'],
			flagRules: [],
		});
	const compiled = compileOAuthPolicy(input);
	const source = compiled.toolPortalConfig.profiles.shared?.namespaces.google;
	if (source?.backend.kind !== 'controller_execution')
		throw new Error('Expected Google namespace.');
	const operation = source.backend.operations.gog;
	const commandSet =
		compiled.commandSetsByConfiguredOperation[
			configuredGoogleOperationKey('shared', 'google', 'gog')
		];
	if (operation?.kind !== 'configured_cli' || commandSet === undefined)
		throw new Error('Expected compiled Google operation.');
	const runtime = createGatewayRuntimeManagedToolPortalConfig(
		createEffectiveManagedToolPortalConfig({
			...compiled.toolPortalConfig,
			profiles: {
				shared: {
					namespaces: {
						gog: {
							...source,
							discovery: {},
							tools: { allow: ['gog_cli'], deny: [] },
							backend: {
								kind: 'controller_execution',
								operations: { gog_cli: { ...operation, compiledGoogle: commandSet } },
							},
						},
					},
				},
			},
		}),
	);
	const policy = runtime.profiles.shared?.namespaces.gog;
	if (policy === undefined) throw new Error('Expected Gog policy.');
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
				accountArgument: 'accountId',
				describeBeforeCall: true,
				kind: 'google-account',
				operations: [
					{ applicationId: 'gmail-app', operationId: 'gmail.search' },
					{ applicationId: 'gmail-app', operationId: 'gmail.send' },
				],
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

	it('keeps one qualified operation account-dependent rather than publishing a static approval decision', () => {
		const metadata = capabilityDiscoveryMetadata({
			policy: oauthConfiguredCliPolicy('static'),
			toolName: 'gog_cli',
		});

		expect(metadata?.oauthRequirement).toEqual({
			kind: 'google-account',
			accountArgument: 'accountId',
			describeBeforeCall: true,
			operations: [{ applicationId: 'gmail-app', operationId: 'gmail.search' }],
		});
	});

	it('uses call-time without-approval precedence when authored selectors overlap', () => {
		const policy = structuredClone(oauthConfiguredCliPolicy('static'));
		if (policy.backend.kind !== 'controller_execution')
			throw new Error('Expected controller namespace.');
		const operation = policy.backend.operations.gog_cli;
		if (operation?.kind !== 'configured_cli') throw new Error('Expected operation.');
		operation.authorization = { kind: 'none' };
		delete operation.compiledGoogle;
		operation.calls = { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' };
		policy.calls = {
			requiresApproval: { allow: ['gog_cli'], deny: [] },
			withoutApproval: { allow: ['gog_cli'], deny: [] },
		};

		expect(capabilityDiscoveryMetadata({ policy, toolName: 'gog_cli' })).toMatchObject({
			callDisposition: { kind: 'without-approval' },
		});
	});
});
