import type { EffectiveControllerExecutionOperation } from '@agent-vm/config-contracts';

import type { CredentialedRuntimeResolution } from '../credentialed-runtime/credentialed-runtime-registry.js';
import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

type ConfiguredCliOperation = Extract<
	EffectiveControllerExecutionOperation,
	{ kind: 'configured_cli' }
>;

export interface ConfiguredCliAuthorizedEvaluation {
	readonly authorityKind: 'controller_approval_reservation' | 'without_approval';
	readonly bindingRevision: string;
	readonly disposition: 'requires_approval' | 'without_approval';
	readonly fingerprint: string;
	readonly operationId: string;
	readonly operationName: string;
	readonly targetKind: ConfiguredCliOperation['executionTarget']['kind'];
}

export interface ConfiguredCliAuthorizedOperation {
	readonly credentialedRuntime?: CredentialedRuntimeResolution;
	readonly evaluation: ConfiguredCliAuthorizedEvaluation;
	readonly operation: ConfiguredCliOperation;
}

export function requireCurrentConfiguredCliAuthorization(authorization: {
	readonly authorized: boolean;
	readonly configuredCli?: ConfiguredCliAuthorizedOperation;
}): ConfiguredCliAuthorizedOperation {
	if (!authorization.authorized || authorization.configuredCli === undefined) {
		throw new ConfiguredControllerExecutionError(
			'not_dispatched',
			'Configured controller execution operation is no longer authorized.',
		);
	}
	return authorization.configuredCli;
}

export function configuredCliAuthorizedEvaluationsEqual(
	left: ConfiguredCliAuthorizedEvaluation,
	right: ConfiguredCliAuthorizedEvaluation,
): boolean {
	return (
		left.authorityKind === right.authorityKind &&
		left.bindingRevision === right.bindingRevision &&
		left.disposition === right.disposition &&
		left.fingerprint === right.fingerprint &&
		left.operationId === right.operationId &&
		left.operationName === right.operationName &&
		left.targetKind === right.targetKind
	);
}
