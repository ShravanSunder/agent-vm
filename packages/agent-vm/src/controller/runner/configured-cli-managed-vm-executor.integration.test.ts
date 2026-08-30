import {
	encodeConfiguredCliPreparedImageIdentity,
	type EffectiveControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthMaterialRevisionSchema,
	oauthServiceIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it, vi } from 'vitest';

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
	configuredOperation.authorization = {
		kind: 'oauth_account_profile',
		rules: [
			{
				match: { flags: [], path: ['gmail', 'search'] },
				requirement: {
					applicationId: oauthApplicationIdSchema.parse('gmail-app'),
					kind: 'oauth',
					minimumPermission: 'read',
					serviceId: oauthServiceIdSchema.parse('gmail'),
				},
			},
		],
	};
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
	readonly complete: ReturnType<typeof vi.fn>;
	readonly exec: ReturnType<typeof vi.fn>;
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
): ReturnType<typeof createConfiguredCliManagedVmExecutor> {
	return createConfiguredCliManagedVmExecutor({
		...(resolveOAuthRuntimeCredential === undefined ? {} : { resolveOAuthRuntimeCredential }),
		resolveGatewayIdentity: vi.fn(async () => gatewayIdentity),
		runtimeManager,
	});
}

function managerWithAcquire(
	acquireCommand: CredentialedRuntimeManager['acquireCommand'],
): CredentialedRuntimeManager {
	return {
		acquireCommand,
		closeZone: vi.fn(async () => {}),
		openZone: vi.fn(),
		reapExpired: vi.fn(async () => {}),
		recoverZone: vi.fn(async () => {}),
		retire: vi.fn(async () => ({ kind: 'absent' as const })),
	};
}

describe('configured CLI credentialed Managed VM executor', () => {
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
			accessToken: new TextEncoder().encode('oauth-access-token-marker'),
			allowedHosts: ['gmail.googleapis.com'],
			credentialId: 'credential-a',
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
					accountProfile: oauthAccountProfileIdSchema.parse('personal-google'),
					argv: ['gmail', 'search'],
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
			accountProfileId: 'personal-google',
			agentId: 'sun',
			applicationId: 'gmail-app',
			minimumPermission: 'read',
			serviceId: 'gmail',
			zoneId: 'zone-a',
		});
		expect(command.exec).toHaveBeenCalledWith(
			expect.objectContaining({ argv: ['gmail', 'search'] }),
			{},
		);
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
