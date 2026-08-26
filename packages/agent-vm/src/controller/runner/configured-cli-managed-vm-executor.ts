import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import type {
	ConfiguredCliInput,
	EffectiveControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import { GatewayControlConfiguredCliControllerExecutionResultSchema } from '@agent-vm/gateway-control-contracts';
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
	readonly resolveGatewayIdentity: (
		zoneId: string,
	) => Promise<ConfiguredCliManagedVmGatewayIdentity>;
	readonly runtimeManager: CredentialedRuntimeManager;
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
	readonly input: ConfiguredCliInput;
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
		if (request.signal?.aborted === true) {
			throw new ConfiguredControllerExecutionError(
				'not_dispatched',
				'Configured Managed VM execution was cancelled before runtime acquisition.',
			);
		}
		const gatewayIdentity = await props.resolveGatewayIdentity(request.zoneId);
		const admissionSignalIsActive = (): boolean => request.signal?.aborted !== true;
		const acquired = await props.runtimeManager.acquireCommand({
			...(request.signal === undefined ? {} : { admissionSignal: request.signal }),
			finalAuthorization: async (): Promise<boolean> => {
				if (!admissionSignalIsActive()) return false;
				const current = await request.reloadAuthorization();
				return (
					admissionSignalIsActive() &&
					configuredCliAuthorizedEvaluationsEqual(
						request.authorization.evaluation,
						current.evaluation,
					) &&
					current.credentialedRuntime?.cohortRevision === resolution.cohortRevision &&
					current.credentialedRuntime.groupRevision === resolution.groupRevision
				);
			},
			operationId: request.authorization.evaluation.operationId,
			ownerIdentity: ownerIdentity({
				gateway: gatewayIdentity,
				stablePrincipal: request.stablePrincipal,
			}),
			resolution,
		});
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
