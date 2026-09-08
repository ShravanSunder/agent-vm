import {
	encodeConfiguredCliPreparedImageIdentity,
	compileOAuthPolicy,
	configuredGoogleOperationKey,
	type EffectiveControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import {
	oauthAccountIdSchema,
	oauthAuthorizationIdSchema,
	managedGoogleReadyPreflightSchema,
	oauthCredentialIdSchema,
	oauthMaterialRevisionSchema,
} from '@agent-vm/oauth-broker-contracts';
import { getGooglePolicyCatalog } from '@agent-vm/oauth-broker/google';
import { describe, expect, it, vi } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import type {
	CredentialedRuntimeCommandHandle,
	CredentialedRuntimeManager,
} from '../credentialed-runtime/credentialed-runtime-manager.js';
import type { CredentialedRuntimeResolution } from '../credentialed-runtime/credentialed-runtime-registry.js';
import type { ConfiguredCliAuthorizedOperation } from './configured-cli-authorization.js';
import { createConfiguredCliManagedVmExecutor } from './configured-cli-managed-vm-executor.js';

type ConfiguredOperation = Extract<
	EffectiveControllerExecutionOperation,
	{ readonly kind: 'configured_cli' }
>;

const oauthCredentialId = oauthCredentialIdSchema.parse('11111111-1111-4111-8111-111111111111');
const accountId = oauthAccountIdSchema.parse('33333333-3333-4333-8333-333333333333');
const authorizationId = oauthAuthorizationIdSchema.parse('44444444-4444-4444-8444-444444444444');
const compiledGoogle = compileOAuthPolicy(createOAuthPolicyCompilerTestInput())
	.commandSetsByConfiguredOperation[configuredGoogleOperationKey('shared', 'google', 'gog')];
if (compiledGoogle === undefined) throw new Error('Expected compiled Google fixture.');
const googlePreflight = managedGoogleReadyPreflightSchema.parse({
	kind: 'ready',
	disposition: 'allow',
	binding: {
		accountId,
		authorizationId,
		applicationId: 'gmail-app',
		generation: 1,
		authorizationMetadataRevision: 1,
		overrideRevision: 1,
		defaultsRevision: 'a'.repeat(64),
		configRevision: 'config-current',
		clientBindingRevision: 'client-current',
		catalogVersion: 'google-gog-v0.38.1-v1',
		commandTableRevision: compiledGoogle.revision,
		operationId: 'gmail.search',
		gmailWriteAllowed: false,
	},
	display: {
		accountId,
		authorizationId,
		authorizationMetadataRevision: 1,
		accountAlias: 'Personal Google',
		applicationLabel: 'Gmail',
	},
});
const credentialBinding = {
	accountId,
	authorizationId,
	generation: 1,
	authorizationMetadataRevision: 1,
	gmailNoSend: true,
};

function operation(): ConfiguredOperation {
	return {
		calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
		commands: [{ flagRules: [], path: ['calendar', 'list'] }],
		deniedPatterns: [],
		executablePath: '/usr/local/bin/gog',
		executionTarget: {
			allowedHosts: ['www.googleapis.com'],
			credentialProjection: {
				credentialBinding: 'google',
				credentialEnvironment: { GOG_DATA_DIR: { kind: 'credential_root' } },
				credentialFiles: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
				kind: 'file_binding',
			},
			environment: { kind: 'empty' },
			guestCwd: '/work',
			imageReference: encodeConfiguredCliPreparedImageIdentity({
				fingerprint: 'sha256:gog-image',
				imageReference: '/images/gog',
				schemaVersion: 1,
			}),
			kind: 'ephemeral_managed_vm',
		},
		kind: 'configured_cli',
		mandatoryArgvPrefix: [],
		output: {
			modelVisibleStderr: 'none',
			overflow: 'truncate',
			stderrMaxBytes: 1024,
			stdoutMaxBytes: 1024,
		},
		safeHelp: 'List calendar events.',
		stdin: { kind: 'none' },
		timeout: { kind: 'quick' },
	};
}

function oauthOperation(): ConfiguredOperation {
	const configuredOperation = structuredClone(operation());
	configuredOperation.authorization = { kind: 'oauth_account' };
	configuredOperation.calls = { source: 'managed_google_policy', deny: [] };
	configuredOperation.compiledGoogle = compiledGoogle;
	configuredOperation.commands = [{ flagRules: [], path: ['gmail', 'search'] }];
	if (configuredOperation.executionTarget.kind !== 'ephemeral_managed_vm') {
		throw new Error('Expected Managed VM target.');
	}
	configuredOperation.executionTarget.allowedHosts = ['gmail.googleapis.com'];
	configuredOperation.executionTarget.credentialProjection = {
		environment: { GOG_ACCESS_TOKEN: { kind: 'oauth_access_token' } },
		kind: 'http_mediation',
	};
	return configuredOperation;
}

function runtimeResolution(configuredOperation = operation()): CredentialedRuntimeResolution {
	return {
		agentRuntimeRevision: 'sha256:group-current',
		agentId: 'sun',
		cohortRevision: 'binding:current',
		projection: {
			credentialBinding: {
				files: {
					'service-account': {
						ref: 'op://agent-vm-testing/google/sun',
						source: '1password',
					},
				},
			},
			credentialEnvironment: { GOG_DATA_DIR: { kind: 'credential_root' } },
			fileMappings: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
			kind: 'file_binding',
		},
		namespaceId: 'google',
		operation: configuredOperation,
		operationName: 'calendar_list',
		profileId: 'google-enabled',
		zoneId: 'zone-a',
	};
}

function oauthAuthorization(): ConfiguredCliAuthorizedOperation {
	const configuredOperation = oauthOperation();
	const resolution = runtimeResolution(configuredOperation);
	return {
		managedGoogle: googlePreflight,
		credentialedRuntime: {
			...resolution,
			projection: {
				environmentName: 'GOG_ACCESS_TOKEN',
				kind: 'oauth_http_mediation',
			},
		},
		evaluation: {
			authorityKind: 'without_approval',
			bindingRevision: 'binding:current',
			disposition: 'without_approval',
			fingerprint: `sha256:${'a'.repeat(64)}`,
			operationId: '11111111-1111-4111-8111-111111111111',
			operationName: 'gog_cli',
			targetKind: 'ephemeral_managed_vm',
		},
		operation: configuredOperation,
	};
}

function authorization(
	options: {
		readonly bindingRevision?: string;
		readonly agentRuntimeRevision?: string;
		readonly includeRuntime?: boolean;
	} = {},
): ConfiguredCliAuthorizedOperation {
	const resolution = runtimeResolution();
	return {
		...(options.includeRuntime === false
			? {}
			: {
					credentialedRuntime: {
						...resolution,
						agentRuntimeRevision: options.agentRuntimeRevision ?? resolution.agentRuntimeRevision,
					},
				}),
		evaluation: {
			authorityKind: 'without_approval',
			bindingRevision: options.bindingRevision ?? 'binding:current',
			disposition: 'without_approval',
			fingerprint: `sha256:${'a'.repeat(64)}`,
			operationId: '11111111-1111-4111-8111-111111111111',
			operationName: 'calendar_list',
			targetKind: 'ephemeral_managed_vm',
		},
		operation: resolution.operation,
	};
}

function commandHandle(
	options: {
		readonly execError?: Error;
	} = {},
): CredentialedRuntimeCommandHandle & {
	readonly complete: ReturnType<typeof vi.fn<CredentialedRuntimeCommandHandle['complete']>>;
	readonly exec: ReturnType<typeof vi.fn<CredentialedRuntimeCommandHandle['exec']>>;
} {
	return {
		complete: vi.fn(async () => {}),
		exec: vi.fn(async () => {
			if (options.execError !== undefined) throw options.execError;
			return {
				exitCode: 0,
				stderrTruncated: false,
				stdout: '{"ok":true}',
				stdoutTruncated: false,
			};
		}),
	};
}

const gatewayIdentity = {
	controllerEpoch: 'controller-a',
	gatewayEpoch: 'gateway-a',
	parentGatewayVmId: 'gateway-vm-a',
	runtimeEpoch: 'runtime-a',
} as const;

function executorWithManager(
	runtimeManager: CredentialedRuntimeManager,
	resolveOAuthRuntimeCredential?: NonNullable<
		Parameters<typeof createConfiguredCliManagedVmExecutor>[0]['resolveOAuthRuntimeCredential']
	>,
	validateOAuthRuntimeCredentialSnapshot?: NonNullable<
		Parameters<
			typeof createConfiguredCliManagedVmExecutor
		>[0]['validateOAuthRuntimeCredentialSnapshot']
	>,
): ReturnType<typeof createConfiguredCliManagedVmExecutor> {
	const execute = createConfiguredCliManagedVmExecutor({
		validateGooglePolicySnapshot: () => true,
		...(resolveOAuthRuntimeCredential === undefined ? {} : { resolveOAuthRuntimeCredential }),
		...(validateOAuthRuntimeCredentialSnapshot === undefined
			? {}
			: { validateOAuthRuntimeCredentialSnapshot }),
		resolveGatewayIdentity: vi.fn(async () => gatewayIdentity),
		runtimeManager,
	});
	return async (request) =>
		await execute({
			// This suite substitutes controller publication authority; its real boundary has separate tests.
			publishFileResults: async ({ folder }) =>
				await folder.publish({
					receiver: { leaseId: 'lease', leafGeneration: 'leaf', vmId: 'vm' },
					withPublicationAuthority: async (expose) => await expose(),
				}),
			...request,
		});
}

function managerWithAcquire(
	acquireCommand: CredentialedRuntimeManager['acquireCommand'],
): CredentialedRuntimeManager {
	return {
		acquireCommand,
		closeZone: vi.fn(async () => {}),
		invalidateMaterial: vi.fn(async () => ({ kind: 'absent' as const })),
		openZone: vi.fn(),
		reapExpired: vi.fn(async () => {}),
		recoverZone: vi.fn(async () => ({ kind: 'contained' as const })),
		retire: vi.fn(async () => ({ kind: 'absent' as const })),
	};
}

describe('configured CLI credentialed Managed VM executor', () => {
	it.each([false, true])(
		'stages approval-bound inputs before dispatch (source mismatch: %s)',
		async (mismatch) => {
			// Arrange: source lease/hash verification belongs to the injected controller file boundary.
			const base = oauthAuthorization();
			if (base.operation.compiledGoogle === undefined) throw new Error('Missing command set.');
			base.operation.compiledGoogle = {
				...base.operation.compiledGoogle,
				descriptors: base.operation.compiledGoogle.descriptors.map((descriptor) =>
					descriptor.operationId === 'gmail.search'
						? { ...descriptor, positionals: { minimum: 1, maximum: 1, fileInputs: [0] } }
						: descriptor,
				),
			};
			const fileInputs = {
				leaseId: 'lease',
				leafGeneration: 'leaf',
				vmId: 'vm',
				files: [{ relativePath: 'input.pdf', byteLength: 4, sha256: 'a'.repeat(64) }],
			};
			const current = {
				...base,
				managedGoogle: managedGoogleReadyPreflightSchema.parse({ ...googlePreflight, fileInputs }),
			};
			const command = commandHandle();
			const order: string[] = [];
			command.exec.mockImplementation(async () => {
				order.push('exec');
				return { exitCode: 0, stdout: '{}', stdoutTruncated: false, stderrTruncated: false };
			});
			const folder = {
				root: `/agent-vm/gog-work/operation-${current.evaluation.operationId}`,
				stageInput: vi.fn(async () => {}),
				publish: vi.fn(async () => ({
					publicationId: '55555555-5555-4555-8555-555555555555',
					expiresAtMs: 6000,
					files: [],
					failedFiles: [],
					cleanup: 'complete' as const,
				})),
			};
			const execute = executorWithManager(
				managerWithAcquire(async (request) => {
					if (!('materializeResolution' in request))
						throw new Error('Expected OAuth materialization.');
					await request.materializeResolution();
					return {
						kind: 'acquired',
						command: { ...command, prepareSharedStagingOperation: async () => folder },
					};
				}),
				async () => ({
					...credentialBinding,
					accessToken: new Uint8Array([1]),
					allowedHosts: ['gmail.googleapis.com'],
					credentialId: oauthCredentialId,
					kind: 'ready',
					materialRevision: oauthMaterialRevisionSchema.parse(
						`sha256:${Buffer.alloc(32, 7).toString('base64url')}`,
					),
				}),
				() => ({ kind: 'current' }),
			);
			const stageFileInputs = vi.fn(async () => {
				order.push('stage');
				if (mismatch) throw new Error('Input changed after approval');
			});
			// Act
			const result = execute({
				authorization: current,
				operation: current.operation,
				operationName: 'gog_cli',
				input: { accountId, argv: ['gmail', 'search', './input.pdf'], reason: 'Input fixture' },
				reloadAuthorization: async () => current,
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
				stageFileInputs,
			});
			// Assert
			if (mismatch) {
				await expect(result).rejects.toThrow('Input changed after approval');
				expect(order).toEqual(['stage']);
				expect(command.complete).toHaveBeenCalledWith(expect.objectContaining({ kind: 'retire' }));
			} else {
				expect(await result).toMatchObject({ exitCode: 0 });
				expect(order).toEqual(['stage', 'exec']);
			}
			expect(stageFileInputs).toHaveBeenCalledExactlyOnceWith({ folder, expected: fileInputs });
		},
	);

	it.each([
		{ sealFails: false, exitCode: 0 },
		{ sealFails: true, exitCode: 0 },
		{ sealFails: false, exitCode: 1 },
		{ sealFails: true, exitCode: 1 },
	])(
		'returns file availability separately from known command completion $sealFails/$exitCode',
		async ({ sealFails, exitCode }) => {
			// Arrange
			const current = oauthAuthorization();
			const compilerInput = createOAuthPolicyCompilerTestInput();
			const catalog = getGooglePolicyCatalog();
			const commands = [{ path: ['docs', 'export'], flagRules: [] }];
			compilerInput.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.commands =
				commands;
			compilerInput.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.executionTarget.allowedHosts =
				[...catalog.families.documents.allowedHosts];
			const fileCompiled = compileOAuthPolicy({
				...compilerInput,
				catalog,
				toolPortalConfig: {
					...compilerInput.toolPortalConfig,
					agents: Object.fromEntries(
						['sun', 'ember'].map((agentId) => [
							agentId,
							{
								profile: 'shared',
								googlePolicyDefaults: {
									kind: 'explicit',
									applications: { 'workspace-app': { docs: { read: 'allow', write: 'deny' } } },
								},
							},
						]),
					),
				},
				oauthConfig: {
					...compilerInput.oauthConfig,
					agents: Object.fromEntries(
						['sun', 'ember'].map((agentId) => [
							agentId,
							{
								applications: {
									'workspace-app': {
										ceiling: { kind: 'explicit', groupIds: ['docs.all-files.read'] },
									},
								},
							},
						]),
					),
				},
			}).commandSetsByConfiguredOperation[configuredGoogleOperationKey('shared', 'google', 'gog')];
			if (fileCompiled === undefined) throw new Error('Expected compiled file commands.');
			current.operation.compiledGoogle = fileCompiled;
			current.operation.commands = commands;
			const fileAuthorization = {
				...current,
				managedGoogle: managedGoogleReadyPreflightSchema.parse({
					...googlePreflight,
					binding: {
						...googlePreflight.binding,
						applicationId: 'workspace-app',
						operationId: 'docs.export',
						commandTableRevision: fileCompiled.revision,
					},
				}),
			};
			const command = commandHandle();
			command.exec.mockResolvedValue({
				exitCode,
				stdout: '{"path":"report.pdf","size":4}',
				stdoutTruncated: false,
				stderrTruncated: false,
			});
			const reference = { referenceId: '55555555-5555-4555-8555-555555555555', expiresAtMs: 6000 };
			const seal = vi.fn(async () => {
				if (sealFails) throw new Error('Folder read failed');
				return {
					publicationId: reference.referenceId,
					expiresAtMs: reference.expiresAtMs,
					files: [],
					failedFiles: [],
					cleanup: 'complete' as const,
				};
			});
			const prepareOperationFolder = vi.fn(async () => ({
				root: `/agent-vm/gog-work/operation-${current.evaluation.operationId}`,
				stageInput: vi.fn(async () => {}),
				publish: seal,
			}));
			const execute = executorWithManager(
				managerWithAcquire(async () => ({
					kind: 'acquired',
					command: { ...command, prepareSharedStagingOperation: prepareOperationFolder },
				})),
			);
			const input = {
				accountId,
				argv: [
					'docs',
					'export',
					'document-id',
					'--out',
					'./report.input',
					'--format',
					'pdf',
					'--json',
				],
				reason: 'File output fixture.',
			};
			// Act
			const result = await execute({
				authorization: fileAuthorization,
				input,
				operation: current.operation,
				operationName: 'gog_cli',
				reloadAuthorization: async () => fileAuthorization,
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			});
			// Assert
			expect(result).toMatchObject({
				exitCode,
				stdout: '{"path":"report.pdf","size":4}',
				operationFiles: sealFails
					? { kind: 'unavailable', reason: 'file-result-failed' }
					: { kind: 'available', ...reference },
			});
			expect(prepareOperationFolder).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ maximumBytes: 16 * 1024 * 1024 }),
			);
			expect(command.exec).toHaveBeenCalledExactlyOnceWith(input, {});
			expect(seal).toHaveBeenCalledTimes(1);
			expect(command.complete).toHaveBeenCalledWith(
				sealFails ? expect.objectContaining({ kind: 'retire' }) : { kind: 'completed' },
			);
		},
	);

	it('materializes the selected OAuth account only through the reserved runtime callback', async () => {
		const command = commandHandle();
		const acquireCommand = vi.fn(
			async (request: Parameters<CredentialedRuntimeManager['acquireCommand']>[0]) => {
				if (!('materializeResolution' in request)) {
					throw new Error('Expected deferred OAuth materialization.');
				}
				const materialization = await request.materializeResolution();
				expect(materialization).toMatchObject({
					dynamicHttpMediation: {
						allowedHosts: ['gmail.googleapis.com'],
						environmentName: 'GOG_ACCESS_TOKEN',
						kind: 'dynamic_http_mediation',
					},
				});
				return { command, kind: 'acquired' as const };
			},
		);
		const resolveOAuthRuntimeCredential = vi.fn(async () => ({
			...credentialBinding,
			accessToken: new TextEncoder().encode('oauth-access-token-marker'),
			allowedHosts: ['gmail.googleapis.com'],
			credentialId: oauthCredentialId,
			kind: 'ready' as const,
			materialRevision: oauthMaterialRevisionSchema.parse(
				`sha256:${Buffer.alloc(32, 7).toString('base64url')}`,
			),
		}));
		const execute = executorWithManager(
			managerWithAcquire(acquireCommand),
			resolveOAuthRuntimeCredential,
		);
		const currentAuthorization = oauthAuthorization();

		await expect(
			execute({
				authorization: currentAuthorization,
				input: {
					accountId,
					argv: ['gmail', 'search', 'unread'],
					reason: 'read messages',
				},
				operation: currentAuthorization.operation,
				operationName: 'gog_cli',
				reloadAuthorization: vi.fn(async () => currentAuthorization),
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).resolves.toMatchObject({ exitCode: 0 });
		expect(resolveOAuthRuntimeCredential).toHaveBeenCalledWith({
			accountId,
			agentId: 'sun',
			applicationId: 'gmail-app',
			operationId: 'gmail.search',
			gmailWriteAllowed: false,
			zoneId: 'zone-a',
		});
		expect(command.exec).toHaveBeenCalledWith(
			expect.objectContaining({ argv: ['gmail', 'search', 'unread'] }),
			{},
		);
	});

	it('surfaces a safe OAuth reauthorization reason from deferred materialization', async () => {
		const acquireCommand = vi.fn(
			async (request: Parameters<CredentialedRuntimeManager['acquireCommand']>[0]) => {
				if (!('materializeResolution' in request)) {
					throw new Error('Expected deferred OAuth materialization.');
				}
				try {
					await request.materializeResolution();
					throw new Error('OAuth materialization unexpectedly succeeded.');
				} catch (error) {
					return {
						kind: 'not-dispatched' as const,
						reason:
							request.materializationFailureReason?.(error) ??
							'credentialed runtime materialization failed',
					};
				}
			},
		);
		const execute = executorWithManager(managerWithAcquire(acquireCommand), async () => ({
			kind: 'unavailable',
			reason: 'reauthorization-required',
		}));
		const currentAuthorization = oauthAuthorization();

		await expect(
			execute({
				authorization: currentAuthorization,
				input: {
					accountId,
					argv: ['gmail', 'search', 'unread'],
					reason: 'read messages',
				},
				operation: currentAuthorization.operation,
				operationName: 'gog_cli',
				reloadAuthorization: vi.fn(async () => currentAuthorization),
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toMatchObject({
			code: 'not_dispatched',
			message: 'OAuth authorization is unavailable: reauthorization-required.',
		});
	});

	it('rejects OAuth dispatch when the materialized credential snapshot is no longer current', async () => {
		const command = commandHandle();
		const materialRevision = oauthMaterialRevisionSchema.parse(
			`sha256:${Buffer.alloc(32, 7).toString('base64url')}`,
		);
		const acquireCommand = vi.fn(
			async (request: Parameters<CredentialedRuntimeManager['acquireCommand']>[0]) => {
				if (!('materializeResolution' in request)) {
					throw new Error('Expected deferred OAuth materialization.');
				}
				await request.materializeResolution();
				return (await request.finalAuthorization()) && request.finalMaterialAuthorization?.()
					? { command, kind: 'acquired' as const }
					: { kind: 'not-dispatched' as const, reason: 'stale OAuth material' };
			},
		);
		const resolveOAuthRuntimeCredential = vi.fn(async () => ({
			...credentialBinding,
			accessToken: new TextEncoder().encode('oauth-access-token-marker'),
			allowedHosts: ['gmail.googleapis.com'],
			credentialId: oauthCredentialId,
			kind: 'ready' as const,
			materialRevision,
		}));
		const validateOAuthRuntimeCredentialSnapshot = vi.fn(
			() => ({ kind: 'stale', reason: 'credential-changed' }) as const,
		);
		const execute = executorWithManager(
			managerWithAcquire(acquireCommand),
			resolveOAuthRuntimeCredential,
			validateOAuthRuntimeCredentialSnapshot,
		);
		const currentAuthorization = oauthAuthorization();

		await expect(
			execute({
				authorization: currentAuthorization,
				input: {
					accountId,
					argv: ['gmail', 'search', 'unread'],
					reason: 'read messages',
				},
				operation: currentAuthorization.operation,
				operationName: 'gog_cli',
				reloadAuthorization: vi.fn(async () => currentAuthorization),
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toMatchObject({ code: 'not_dispatched' });
		expect(validateOAuthRuntimeCredentialSnapshot).toHaveBeenCalledWith({
			accountId,
			agentId: 'sun',
			applicationId: 'gmail-app',
			credentialId: oauthCredentialId,
			authorizationId,
			generation: 1,
			authorizationMetadataRevision: 1,
			materialRevision,
			operationId: 'gmail.search',
			gmailWriteAllowed: false,
			zoneId: 'zone-a',
		});
		expect(command.exec).not.toHaveBeenCalled();
	});

	it('acquires one current slot, executes, and returns the runtime to idle', async () => {
		const command = commandHandle();
		const acquireCommand = vi.fn(async () => ({ command, kind: 'acquired' as const }));
		const execute = executorWithManager(managerWithAcquire(acquireCommand));
		const currentAuthorization = authorization();

		await expect(
			execute({
				authorization: currentAuthorization,
				input: { argv: ['calendar', 'list'], reason: 'list events' },
				operation: currentAuthorization.operation,
				operationName: 'calendar_list',
				reloadAuthorization: vi.fn(async () => currentAuthorization),
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).resolves.toEqual({
			exitCode: 0,
			stderrTruncated: false,
			stdout: '{"ok":true}',
			stdoutTruncated: false,
		});
		expect(acquireCommand).toHaveBeenCalledOnce();
		expect(command.exec).toHaveBeenCalledOnce();
		expect(command.complete).toHaveBeenCalledWith({ kind: 'completed' });
	});

	it('maps a busy runtime to a retryable domain error without execution', async () => {
		const execute = executorWithManager(
			managerWithAcquire(async () => ({ kind: 'busy', retryable: true })),
		);
		const currentAuthorization = authorization();
		await expect(
			execute({
				authorization: currentAuthorization,
				input: { argv: ['calendar', 'list'], reason: 'busy proof' },
				operation: currentAuthorization.operation,
				operationName: 'calendar_list',
				reloadAuthorization: vi.fn(async () => currentAuthorization),
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toMatchObject({ code: 'runtime_busy' });
	});

	it('passes a final callback that rejects changed cohort or group authority', async () => {
		const currentAuthorization = authorization();
		const reloadAuthorization = vi.fn(async () =>
			authorization({ agentRuntimeRevision: 'sha256:changed' }),
		);
		const acquireCommand = vi.fn(
			async (request: Parameters<CredentialedRuntimeManager['acquireCommand']>[0]) =>
				(await request.finalAuthorization())
					? { command: commandHandle(), kind: 'acquired' as const }
					: { kind: 'not-dispatched' as const, reason: 'stale' },
		);
		const execute = executorWithManager(managerWithAcquire(acquireCommand));
		await expect(
			execute({
				authorization: currentAuthorization,
				input: { argv: ['calendar', 'list'], reason: 'stale proof' },
				operation: currentAuthorization.operation,
				operationName: 'calendar_list',
				reloadAuthorization,
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toMatchObject({ code: 'not_dispatched' });
		expect(reloadAuthorization).toHaveBeenCalledOnce();
	});

	it('binds cancellation into final admission before runtime acquisition completes', async () => {
		const currentAuthorization = authorization();
		const admissionController = new AbortController();
		const command = commandHandle();
		const reloadAuthorization = vi.fn(async () => {
			admissionController.abort(new Error('call expired'));
			return currentAuthorization;
		});
		const acquireCommand = vi.fn(
			async (request: Parameters<CredentialedRuntimeManager['acquireCommand']>[0]) =>
				(await request.finalAuthorization())
					? { command, kind: 'acquired' as const }
					: { kind: 'not-dispatched' as const, reason: 'stale' },
		);
		const execute = executorWithManager(managerWithAcquire(acquireCommand));

		await expect(
			execute({
				authorization: currentAuthorization,
				input: { argv: ['calendar', 'list'], reason: 'expiry proof' },
				operation: currentAuthorization.operation,
				operationName: 'calendar_list',
				reloadAuthorization,
				signal: admissionController.signal,
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toMatchObject({ code: 'not_dispatched' });
		expect(acquireCommand).toHaveBeenCalledWith(
			expect.objectContaining({ admissionSignal: admissionController.signal }),
		);
		expect(command.exec).not.toHaveBeenCalled();
	});

	it('retires the runtime after uncertain command failure', async () => {
		const command = commandHandle({ execError: new Error('lost result') });
		const execute = executorWithManager(
			managerWithAcquire(async () => ({ command, kind: 'acquired' })),
		);
		const currentAuthorization = authorization();
		await expect(
			execute({
				authorization: currentAuthorization,
				input: { argv: ['calendar', 'list'], reason: 'failure proof' },
				operation: currentAuthorization.operation,
				operationName: 'calendar_list',
				reloadAuthorization: vi.fn(async () => currentAuthorization),
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toThrow('lost result');
		expect(command.complete).toHaveBeenCalledWith({
			kind: 'retire',
			reason: 'configured command termination is unsafe',
		});
	});

	it('rejects a missing controller-only runtime resolution before acquisition', async () => {
		const acquireCommand = vi.fn();
		const execute = executorWithManager(managerWithAcquire(acquireCommand));
		const missingRuntime = authorization({ includeRuntime: false });
		await expect(
			execute({
				authorization: missingRuntime,
				input: { argv: ['calendar', 'list'], reason: 'missing runtime proof' },
				operation: missingRuntime.operation,
				operationName: 'calendar_list',
				reloadAuthorization: vi.fn(async () => missingRuntime),
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toMatchObject({ code: 'validation_failed' });
		expect(acquireCommand).not.toHaveBeenCalled();
	});
});
