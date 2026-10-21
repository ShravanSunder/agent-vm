// Factories copied from configured-cli-call-policy.unit.test.ts and tool-portal-service-common.unit.test.ts at 3031ad24.
import {
	toolPortalConfigSchema,
	preparedManagedToolPortalConfigSchema,
	createEffectiveManagedToolPortalConfig,
	createGatewayRuntimeManagedToolPortalConfig,
	compileOAuthPolicy,
	configuredGoogleOperationKey,
	effectiveControllerEphemeralManagedVmConfiguredCliOperationSchema,
	encodeConfiguredCliPreparedImageIdentity,
	isControllerEphemeralManagedVmConfiguredCliOperation,
	isEffectiveControllerEphemeralManagedVmConfiguredCliOperation,
	normalizePreparedControllerExecutionOperation,
	type GatewayRuntimeManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import { createOAuthPolicyCompilerTestInput } from '@agent-vm/config-contracts-test-support/oauth-policy-compiler-test-fixture.js';
export function createPreparedCliConfig(): GatewayRuntimeManagedToolPortalConfig {
	const authoredConfig = toolPortalConfigSchema.parse({
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
	return createGatewayRuntimeManagedToolPortalConfig(
		createEffectiveManagedToolPortalConfig(
			preparedManagedToolPortalConfigSchema.parse(authoredConfig),
		),
	);
}

export function createPreparedGoogleConfig(
	mode: 'mixed' | 'static' = 'mixed',
): GatewayRuntimeManagedToolPortalConfig {
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
	if (
		operation?.kind !== 'configured_cli' ||
		!isControllerEphemeralManagedVmConfiguredCliOperation(operation) ||
		commandSet === undefined
	)
		throw new Error('Expected compiled Google operation.');
	const normalizedOperation = normalizePreparedControllerExecutionOperation({
		...operation,
		executionTarget: {
			...operation.executionTarget,
			imageReference: encodeConfiguredCliPreparedImageIdentity({
				fingerprint: 'sha256:gog-image',
				imageReference: operation.executionTarget.imageReference,
				schemaVersion: 1,
			}),
		},
	});
	if (
		normalizedOperation.kind === 'registered_action' ||
		!isEffectiveControllerEphemeralManagedVmConfiguredCliOperation(normalizedOperation)
	) {
		throw new Error('Expected normalized Google operation.');
	}
	const compiledOperation = effectiveControllerEphemeralManagedVmConfiguredCliOperationSchema.parse(
		{
			...normalizedOperation,
			compiledGoogle: commandSet,
		},
	);
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
								operations: { gog_cli: compiledOperation },
							},
						},
					},
				},
			},
		}),
	);
	return runtime;
}
