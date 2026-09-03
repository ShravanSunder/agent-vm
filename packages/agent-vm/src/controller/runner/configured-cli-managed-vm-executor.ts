import { createHash, randomBytes } from 'node:crypto';

import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import type {
	ControllerConfiguredCliInput,
	EffectiveControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import { GatewayControlConfiguredCliControllerExecutionResultSchema } from '@agent-vm/gateway-control-contracts';
import type {
	OAuthAccountProfileId,
	OAuthApplicationId,
	OAuthServiceId,
} from '@agent-vm/oauth-broker-contracts';
import type {
	GoogleOAuthRuntimeCredentialResolution,
	GoogleOAuthRuntimeCredentialSnapshotValidation,
} from '@agent-vm/oauth-broker/google';
import { evaluateCliAllowanceInvocation } from '@agent-vm/tool-portal/cli-allowances';

import type {
	CredentialedRuntimeManager,
	CredentialedRuntimeOwnerIdentity,
} from '../credentialed-runtime/credentialed-runtime-manager.js';
import {
	configuredCliAuthorizedEvaluationsEqual,
	type ConfiguredCliAuthorizedOperation,
} from './configured-cli-authorization.js';
import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

type ConfiguredCliOperation = Extract<
	EffectiveControllerExecutionOperation,
	{ kind: 'configured_cli' }
>;

export interface ConfiguredCliManagedVmGatewayIdentity {
	readonly controllerEpoch: string;
	readonly gatewayEpoch: string;
	readonly parentGatewayVmId: string;
	readonly runtimeEpoch: string;
}

export interface CreateConfiguredCliManagedVmExecutorProps {
	readonly validateOAuthRuntimeCredentialSnapshot?: (request: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly applicationId: OAuthApplicationId;
		readonly credentialId: Extract<
			GoogleOAuthRuntimeCredentialResolution,
			{ kind: 'ready' }
		>['credentialId'];
		readonly materialRevision: Extract<
			GoogleOAuthRuntimeCredentialResolution,
			{ kind: 'ready' }
		>['materialRevision'];
		readonly minimumPermission: 'read' | 'write';
		readonly serviceId: OAuthServiceId;
		readonly zoneId: string;
	}) => GoogleOAuthRuntimeCredentialSnapshotValidation;
	readonly resolveOAuthRuntimeCredential?: (request: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly applicationId: OAuthApplicationId;
		readonly minimumPermission: 'read' | 'write';
		readonly serviceId: OAuthServiceId;
		readonly zoneId: string;
	}) => Promise<GoogleOAuthRuntimeCredentialResolution>;
	readonly resolveGatewayIdentity: (
		zoneId: string,
	) => Promise<ConfiguredCliManagedVmGatewayIdentity>;
	readonly runtimeManager: CredentialedRuntimeManager;
}

function runtimeRevisionWithOAuthMaterial(props: {
	readonly accountProfileId: string;
	readonly baseRevision: string;
	readonly credentialId: string;
	readonly materialRevision: string;
}): string {
	return `sha256:${createHash('sha256')
		.update('credentialed-oauth-runtime')
		.update('\0')
		.update(props.baseRevision)
		.update('\0')
		.update(props.accountProfileId)
		.update('\0')
		.update(props.credentialId)
		.update('\0')
		.update(props.materialRevision)
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
	readonly stablePrincipal: GatewayStablePrincipalDigest;
	readonly zoneId: string;
}) => Promise<{
	readonly exitCode: number;
	readonly stderrSummary?: string;
	readonly stderrTruncated: boolean;
	readonly stdout: string;
	readonly stdoutTruncated: boolean;
}> {
	return async (request) => {
		const resolution = request.authorization.credentialedRuntime;
		if (
			resolution === undefined ||
			request.operation.executionTarget.kind !== 'ephemeral_managed_vm'
		) {
			throw new ConfiguredControllerExecutionError(
				'validation_failed',
				'Configured CLI operation has no current credentialed runtime authority.',
			);
		}
		const validation = evaluateCliAllowanceInvocation({
			allowance: request.operation,
			baseline: 'without_approval',
			input: request.input,
		});
		if (!validation.ok) {
			throw new ConfiguredControllerExecutionError('validation_failed', validation.error.message);
		}
		const oauthRule =
			request.operation.authorization?.kind === 'oauth_account_profile'
				? request.operation.authorization.rules.find(
						(rule) =>
							JSON.stringify(rule.match.path) === JSON.stringify(validation.matchedCommandPath),
					)
				: undefined;
		if (
			request.operation.authorization?.kind === 'oauth_account_profile' &&
			oauthRule === undefined
		) {
			throw new ConfiguredControllerExecutionError(
				'validation_failed',
				'Configured CLI command has no current OAuth authorization classification.',
			);
		}
		if (request.signal?.aborted === true) {
			throw new ConfiguredControllerExecutionError(
				'not_dispatched',
				'Configured Managed VM execution was cancelled before runtime acquisition.',
			);
		}
		const gatewayIdentity = await props.resolveGatewayIdentity(request.zoneId);
		const admissionSignalIsActive = (): boolean => request.signal?.aborted !== true;
		const oauthRequirement =
			oauthRule?.requirement.kind === 'oauth' ? oauthRule.requirement : undefined;
		let materializedOAuthCredential:
			| Pick<
					Extract<GoogleOAuthRuntimeCredentialResolution, { kind: 'ready' }>,
					'credentialId' | 'materialRevision'
			  >
			| undefined;
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
				if (oauthRequirement === undefined) return true;
				if (
					!('accountProfile' in request.input) ||
					materializedOAuthCredential === undefined ||
					props.validateOAuthRuntimeCredentialSnapshot === undefined
				) {
					return false;
				}
				return (
					props.validateOAuthRuntimeCredentialSnapshot({
						accountProfileId: request.input.accountProfile,
						agentId: resolution.agentId,
						applicationId: oauthRequirement.applicationId,
						credentialId: materializedOAuthCredential.credentialId,
						materialRevision: materializedOAuthCredential.materialRevision,
						minimumPermission: oauthRequirement.minimumPermission,
						serviceId: oauthRequirement.serviceId,
						zoneId: resolution.zoneId,
					}).kind === 'current'
				);
			},
			operationId: request.authorization.evaluation.operationId,
			ownerIdentity: ownerIdentity({
				gateway: gatewayIdentity,
				stablePrincipal: request.stablePrincipal,
			}),
		};
		const acquired =
			oauthRequirement !== undefined
				? await props.runtimeManager.acquireCommand({
						...commonAcquisition,
						materializationFailureReason: (error): string =>
							error instanceof ConfiguredControllerExecutionError
								? error.message
								: 'credentialed runtime materialization failed',
						materializeResolution: async () => {
							if (!('accountProfile' in request.input)) {
								throw new ConfiguredControllerExecutionError(
									'validation_failed',
									'OAuth-configured CLI input requires an account profile.',
								);
							}
							if (props.resolveOAuthRuntimeCredential === undefined) {
								throw new ConfiguredControllerExecutionError(
									'not_dispatched',
									'OAuth credential resolution is unavailable.',
								);
							}
							const credential = await props.resolveOAuthRuntimeCredential({
								accountProfileId: request.input.accountProfile,
								agentId: resolution.agentId,
								applicationId: oauthRequirement.applicationId,
								minimumPermission: oauthRequirement.minimumPermission,
								serviceId: oauthRequirement.serviceId,
								zoneId: resolution.zoneId,
							});
							if (credential.kind !== 'ready') {
								throw new ConfiguredControllerExecutionError(
									'not_dispatched',
									`OAuth authorization is unavailable: ${credential.reason}.`,
								);
							}
							materializedOAuthCredential = {
								credentialId: credential.credentialId,
								materialRevision: credential.materialRevision,
							};
							return {
								dynamicHttpMediation: {
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
										accountProfileId: request.input.accountProfile,
										baseRevision: resolution.agentRuntimeRevision,
										credentialId: credential.credentialId,
										materialRevision: credential.materialRevision,
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
			const result = await acquired.command.exec(
				request.input,
				request.signal === undefined ? {} : { signal: request.signal },
			);
			const parsedResult = GatewayControlConfiguredCliControllerExecutionResultSchema.parse({
				kind: 'configured_cli',
				operationName: request.operationName,
				result,
			}).result;
			return {
				exitCode: parsedResult.exitCode,
				...(parsedResult.stderrSummary === undefined
					? {}
					: { stderrSummary: parsedResult.stderrSummary }),
				stderrTruncated: parsedResult.stderrTruncated,
				stdout: parsedResult.stdout,
				stdoutTruncated: parsedResult.stdoutTruncated,
			};
		} catch (error) {
			outcome = { kind: 'retire', reason: 'configured command termination is unsafe' };
			throw error;
		} finally {
			await acquired.command.complete(outcome);
		}
	};
}
