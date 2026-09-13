import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import type {
	ControllerConfiguredCliInput,
	EffectiveControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import {
	resolveCompiledGoogleCommand,
	isEffectiveControllerEphemeralManagedVmConfiguredCliOperation,
} from '@agent-vm/config-contracts';
import {
	GatewayControlConfiguredCliControllerExecutionResultSchema,
	type GatewayControlToolPortalControllerExecutionResult,
} from '@agent-vm/gateway-control-contracts';
import type {
	GogFileInputSnapshot,
	ManagedGoogleInvocationBinding,
} from '@agent-vm/oauth-broker-contracts';
import type {
	GoogleOAuthRuntimeCredentialRequest,
	GoogleOAuthRuntimeCredentialBinding,
	GoogleOAuthRuntimeCredentialResolution,
	GoogleOAuthRuntimeCredentialSnapshotValidation,
} from '@agent-vm/oauth-broker/google';
import { validateCliAllowanceInvocation } from '@agent-vm/tool-portal/cli-allowances';

import type {
	CredentialedRuntimeManager,
	CredentialedRuntimeOwnerIdentity,
} from '../credentialed-runtime/credentialed-runtime-manager.js';
import type { SharedStagingOperationSession } from '../credentialed-runtime/shared-staging-operation-session.js';
import { OperationFolderAccessError } from '../files/operation-folder-guest-access.js';
import type { ManagedGoogleInvocationRequest } from '../oauth/google-permission-policy-service.js';
import {
	configuredCliAuthorizedEvaluationsEqual,
	type ConfiguredCliAuthorizedOperation,
} from './configured-cli-authorization.js';
import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

type ConfiguredCliOperation = Extract<
	EffectiveControllerExecutionOperation,
	{ kind: 'configured_cli' }
>;
type ConfiguredCliResult = Extract<
	GatewayControlToolPortalControllerExecutionResult,
	{ kind: 'configured_cli' }
>['result'];

export interface ConfiguredCliManagedVmGatewayIdentity {
	readonly controllerEpoch: string;
	readonly gatewayEpoch: string;
	readonly parentGatewayVmId: string;
	readonly runtimeEpoch: string;
}

export interface CreateConfiguredCliManagedVmExecutorProps {
	readonly validateGooglePolicySnapshot?: (props: {
		readonly request: ManagedGoogleInvocationRequest;
		readonly expected: ManagedGoogleInvocationBinding;
		readonly zoneId: string;
	}) => boolean;
	readonly validateOAuthRuntimeCredentialSnapshot?: (
		request: GoogleOAuthRuntimeCredentialRequest &
			GoogleOAuthRuntimeCredentialBinding & { readonly zoneId: string },
	) => GoogleOAuthRuntimeCredentialSnapshotValidation;
	readonly resolveOAuthRuntimeCredential?: (
		request: GoogleOAuthRuntimeCredentialRequest & { readonly zoneId: string },
	) => Promise<GoogleOAuthRuntimeCredentialResolution>;
	readonly resolveGatewayIdentity: (
		zoneId: string,
	) => Promise<ConfiguredCliManagedVmGatewayIdentity>;
	readonly runtimeManager: CredentialedRuntimeManager;
}

function runtimeRevisionWithOAuthMaterial(props: {
	readonly baseRevision: string;
	readonly credential: GoogleOAuthRuntimeCredentialBinding;
	readonly policy: ManagedGoogleInvocationBinding;
}): string {
	return `sha256:${createHash('sha256')
		.update(
			JSON.stringify([
				'credentialed-oauth-runtime',
				props.baseRevision,
				props.credential,
				props.policy,
			]),
		)
		.digest('hex')}`;
}

function ownerIdentity(props: {
	readonly gateway: ConfiguredCliManagedVmGatewayIdentity;
	readonly stablePrincipal: GatewayStablePrincipalDigest;
}): CredentialedRuntimeOwnerIdentity {
	return { ...props.gateway, stablePrincipal: props.stablePrincipal };
}

export function createConfiguredCliManagedVmExecutor(
	props: CreateConfiguredCliManagedVmExecutorProps,
): (request: {
	readonly authorization: ConfiguredCliAuthorizedOperation;
	readonly input: ControllerConfiguredCliInput;
	readonly operation: ConfiguredCliOperation;
	readonly operationName: string;
	readonly reloadAuthorization: () => Promise<ConfiguredCliAuthorizedOperation>;
	readonly signal?: AbortSignal;
	readonly stageFileInputs?: (props: {
		readonly folder: SharedStagingOperationSession;
		readonly expected: GogFileInputSnapshot;
	}) => Promise<void>;
	readonly publishFileResults?: (props: {
		readonly folder: SharedStagingOperationSession;
		readonly assertCurrent: () => void;
	}) => ReturnType<SharedStagingOperationSession['publish']>;
	readonly stablePrincipal: GatewayStablePrincipalDigest;
	readonly zoneId: string;
}) => Promise<ConfiguredCliResult> {
	return async (request) => {
		const resolution = request.authorization.credentialedRuntime;
		if (
			resolution === undefined ||
			!isEffectiveControllerEphemeralManagedVmConfiguredCliOperation(request.operation)
		) {
			throw new ConfiguredControllerExecutionError(
				'validation_failed',
				'Configured CLI operation has no current credentialed runtime authority.',
			);
		}
		const validation = validateCliAllowanceInvocation({
			allowance: request.operation,
			input: request.input,
		});
		if (!validation.ok || validation.matchedDenyRule)
			throw new ConfiguredControllerExecutionError(
				'validation_failed',
				'Configured command shape is not admitted.',
			);
		const isGoogle = request.operation.authorization?.kind === 'oauth_account';
		const classification =
			isGoogle && request.operation.compiledGoogle !== undefined
				? resolveCompiledGoogleCommand(request.operation.compiledGoogle, request.input.argv)
				: undefined;
		const managedGoogle = request.authorization.managedGoogle;
		if (isGoogle && (classification === undefined || classification.kind === 'denied'))
			throw new ConfiguredControllerExecutionError(
				'validation_failed',
				'Google command classification is unavailable.',
			);
		if (
			classification?.kind === 'oauth' &&
			(managedGoogle === undefined ||
				!('accountId' in request.input) ||
				managedGoogle.binding.accountId !== request.input.accountId ||
				managedGoogle.binding.operationId !== classification.operationId ||
				managedGoogle.binding.commandTableRevision !== request.operation.compiledGoogle?.revision)
		)
			throw new ConfiguredControllerExecutionError(
				'not_dispatched',
				'Google account authority does not match this command.',
			);
		if ((!isGoogle || classification?.kind === 'no-oauth') && managedGoogle !== undefined)
			throw new ConfiguredControllerExecutionError(
				'validation_failed',
				'Unexpected Google account authority.',
			);
		const inputPaths = classification?.kind === 'oauth' ? (classification.files?.inputs ?? []) : [];
		const approvedInputs = managedGoogle?.fileInputs;
		if (
			inputPaths.length > 0 &&
			(request.stageFileInputs === undefined ||
				approvedInputs === undefined ||
				!isDeepStrictEqual(
					inputPaths,
					approvedInputs.files.map((file) => file.relativePath),
				))
		)
			throw new ConfiguredControllerExecutionError(
				'not_dispatched',
				'Approved file input staging is unavailable.',
			);
		if (inputPaths.length === 0 && approvedInputs !== undefined)
			throw new ConfiguredControllerExecutionError(
				'not_dispatched',
				'Unexpected file input authority.',
			);
		if (request.signal?.aborted === true) {
			throw new ConfiguredControllerExecutionError(
				'not_dispatched',
				'Configured Managed VM execution was cancelled before runtime acquisition.',
			);
		}
		const gatewayIdentity = await props.resolveGatewayIdentity(request.zoneId);
		const admissionSignalIsActive = (): boolean => request.signal?.aborted !== true;
		const credentialRequest =
			managedGoogle === undefined
				? undefined
				: {
						accountId: managedGoogle.binding.accountId,
						agentId: resolution.agentId,
						applicationId: managedGoogle.binding.applicationId,
						operationId: managedGoogle.binding.operationId,
						gmailWriteAllowed: managedGoogle.binding.gmailWriteAllowed,
						zoneId: resolution.zoneId,
					};
		const policyRequest: ManagedGoogleInvocationRequest = {
			agentId: resolution.agentId,
			profileId: resolution.profileId,
			namespaceId: resolution.namespaceId,
			operationName: resolution.operationName,
			input: request.input,
		};
		let materializedOAuthCredential: GoogleOAuthRuntimeCredentialBinding | undefined;
		const commonAcquisition = {
			...(request.signal === undefined ? {} : { admissionSignal: request.signal }),
			finalAuthorization: async (): Promise<boolean> => {
				if (!admissionSignalIsActive()) return false;
				const current = await request.reloadAuthorization();
				const policyIsCurrent =
					admissionSignalIsActive() &&
					configuredCliAuthorizedEvaluationsEqual(
						request.authorization.evaluation,
						current.evaluation,
					) &&
					current.credentialedRuntime?.cohortRevision === resolution.cohortRevision &&
					current.credentialedRuntime.agentRuntimeRevision === resolution.agentRuntimeRevision;
				return policyIsCurrent;
			},
			finalMaterialAuthorization: (): boolean => {
				if (managedGoogle === undefined) return true;
				if (
					credentialRequest === undefined ||
					materializedOAuthCredential === undefined ||
					props.validateOAuthRuntimeCredentialSnapshot === undefined ||
					props.validateGooglePolicySnapshot === undefined
				)
					return false;
				return (
					props.validateOAuthRuntimeCredentialSnapshot({
						...credentialRequest,
						...materializedOAuthCredential,
					}).kind === 'current' &&
					props.validateGooglePolicySnapshot({
						request: policyRequest,
						expected: managedGoogle.binding,
						zoneId: resolution.zoneId,
					})
				);
			},
			operationId: request.authorization.evaluation.operationId,
			ownerIdentity: ownerIdentity({
				gateway: gatewayIdentity,
				stablePrincipal: request.stablePrincipal,
			}),
		};
		const acquired =
			credentialRequest !== undefined && managedGoogle !== undefined
				? await props.runtimeManager.acquireCommand({
						...commonAcquisition,
						materializationFailureReason: (error): string =>
							error instanceof ConfiguredControllerExecutionError
								? error.message
								: 'credentialed runtime materialization failed',
						materializeResolution: async () => {
							if (props.resolveOAuthRuntimeCredential === undefined) {
								throw new ConfiguredControllerExecutionError(
									'not_dispatched',
									'OAuth credential resolution is unavailable.',
								);
							}
							const credential = await props.resolveOAuthRuntimeCredential(credentialRequest);
							if (credential.kind !== 'ready') {
								throw new ConfiguredControllerExecutionError(
									'not_dispatched',
									`OAuth authorization is unavailable: ${credential.reason}.`,
								);
							}
							if (
								credential.accountId !== managedGoogle.binding.accountId ||
								credential.authorizationId !== managedGoogle.binding.authorizationId ||
								credential.generation !== managedGoogle.binding.generation ||
								credential.authorizationMetadataRevision !==
									managedGoogle.binding.authorizationMetadataRevision
							) {
								credential.accessToken.fill(0);
								throw new ConfiguredControllerExecutionError(
									'not_dispatched',
									'Google credential binding changed during materialization.',
								);
							}
							materializedOAuthCredential = {
								accountId: credential.accountId,
								authorizationId: credential.authorizationId,
								generation: credential.generation,
								authorizationMetadataRevision: credential.authorizationMetadataRevision,
								credentialId: credential.credentialId,
								materialRevision: credential.materialRevision,
							};
							return {
								dynamicHttpMediation: {
									authorization: {
										accountId: credential.accountId,
										applicationId: credentialRequest.applicationId,
										authorizationId: credential.authorizationId,
										generation: credential.generation,
										overrideRevision: managedGoogle.binding.overrideRevision,
									},
									gmailNoSend: credential.gmailNoSend,
									allowedHosts: credential.allowedHosts,
									credentialId: credential.credentialId,
									environmentName: 'GOG_ACCESS_TOKEN',
									kind: 'dynamic_http_mediation',
									materialRevision: credential.materialRevision,
									placeholderValue: `GONDOLIN_SECRET_${randomBytes(24).toString('hex')}`,
									secretValue: credential.accessToken,
								},
								resolution: {
									...resolution,
									agentRuntimeRevision: runtimeRevisionWithOAuthMaterial({
										baseRevision: resolution.agentRuntimeRevision,
										credential: materializedOAuthCredential,
										policy: managedGoogle.binding,
									}),
								},
							};
						},
						runtimeIdentity: { agentId: resolution.agentId, zoneId: resolution.zoneId },
					})
				: await props.runtimeManager.acquireCommand({ ...commonAcquisition, resolution });
		if (acquired.kind === 'busy') {
			throw new ConfiguredControllerExecutionError(
				'runtime_busy',
				'Credentialed runtime is busy; submit a new independently authorized call later.',
			);
		}
		if (acquired.kind === 'not-dispatched') {
			throw new ConfiguredControllerExecutionError('not_dispatched', acquired.reason);
		}
		if (acquired.kind === 'owner-unsafe') {
			throw new ConfiguredControllerExecutionError('execution_failed', acquired.reason);
		}

		let outcome:
			| { readonly kind: 'completed' }
			| { readonly kind: 'retire'; readonly reason: string } = { kind: 'completed' };
		try {
			const fileArguments = classification?.kind === 'oauth' ? classification.files : undefined;
			let folder:
				| Awaited<ReturnType<NonNullable<typeof acquired.command.prepareSharedStagingOperation>>>
				| undefined;
			if (fileArguments !== undefined) {
				if (
					acquired.command.prepareSharedStagingOperation === undefined ||
					request.publishFileResults === undefined
				)
					throw new ConfiguredControllerExecutionError(
						'not_dispatched',
						'Operation file access is unavailable.',
					);
				try {
					folder = await acquired.command.prepareSharedStagingOperation({
						maximumBytes: fileArguments.outputs.some((output) => output.kind === 'directory')
							? 64 * 1024 * 1024
							: Math.min(
									64 * 1024 * 1024,
									fileArguments.outputs.length * 16 * 1024 * 1024 +
										(approvedInputs?.files.reduce((total, file) => total + file.byteLength, 0) ??
											0),
								),
						authorityIsCurrent: commonAcquisition.finalMaterialAuthorization,
					});
				} catch {
					throw new ConfiguredControllerExecutionError(
						'not_dispatched',
						'Operation folder preparation failed.',
					);
				}
				const expectedRoot = `/agent-vm/gog-work/operation-${request.authorization.evaluation.operationId}`;
				if (folder.root !== expectedRoot || !(await commonAcquisition.finalAuthorization()))
					throw new ConfiguredControllerExecutionError(
						'not_dispatched',
						'Operation folder authorization changed.',
					);
				if (approvedInputs !== undefined && request.stageFileInputs !== undefined) {
					await request.stageFileInputs({ folder, expected: approvedInputs });
					if (
						!(await commonAcquisition.finalAuthorization()) ||
						!commonAcquisition.finalMaterialAuthorization()
					)
						throw new ConfiguredControllerExecutionError(
							'not_dispatched',
							'File input authority changed before command dispatch.',
						);
				}
			}
			const result = await acquired.command.exec(
				request.input,
				request.signal === undefined ? {} : { signal: request.signal },
			);
			let operationFiles: ConfiguredCliResult['operationFiles'];
			if (folder !== undefined) {
				try {
					// A known terminal outcome permits inspecting retained files even when
					// Gog failed. Availability describes bytes, not producer success;
					// preserve exitCode independently so the agent can decide what to use.
					if (request.publishFileResults === undefined)
						throw new OperationFolderAccessError('unavailable');
					if (!(await commonAcquisition.finalAuthorization()))
						throw new OperationFolderAccessError('unavailable');
					const published = await request.publishFileResults({
						folder,
						assertCurrent: () => {
							if (!admissionSignalIsActive() || !commonAcquisition.finalMaterialAuthorization())
								throw new OperationFolderAccessError('unavailable');
						},
					});
					const files = published.files.slice(0, 256);
					const failedFiles = published.failedFiles.slice(0, 256);
					while (Buffer.byteLength(JSON.stringify({ files, failedFiles })) > 30 * 1024) {
						if (failedFiles.length > 0) failedFiles.pop();
						else if (files.length > 0) files.pop();
						else break;
					}
					operationFiles = {
						kind: 'available',
						referenceId: published.publicationId,
						expiresAtMs: published.expiresAtMs,
						directoryPath: `/agent-vm/files/${published.publicationId}`,
						files,
						failedFiles,
						limitReached:
							files.length !== published.files.length ||
							failedFiles.length !== published.failedFiles.length,
						cleanup: published.cleanup,
					};
				} catch (error) {
					// The remote command already completed. Preserve that result even if
					// its folder cannot be retained or delivered; never replay the command.
					outcome = { kind: 'retire', reason: 'configured command file result is unavailable' };
					operationFiles = {
						kind: 'unavailable',
						reason:
							error instanceof OperationFolderAccessError && error.reason === 'size-limit'
								? 'size-limit'
								: 'file-result-failed',
					};
				}
			}
			const parsedResult = GatewayControlConfiguredCliControllerExecutionResultSchema.parse({
				kind: 'configured_cli',
				operationName: request.operationName,
				result: { ...result, ...(operationFiles === undefined ? {} : { operationFiles }) },
			}).result;
			return parsedResult;
		} catch (error) {
			outcome = { kind: 'retire', reason: 'configured command termination is unsafe' };
			throw error;
		} finally {
			await acquired.command.complete(outcome);
		}
	};
}
