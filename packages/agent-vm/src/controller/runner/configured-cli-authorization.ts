import type { ControllerExecutionOperation } from '@agent-vm/config-contracts';

type ConfiguredCliOperation = Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>;

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
	readonly evaluation: ConfiguredCliAuthorizedEvaluation;
	readonly operation: ConfiguredCliOperation;
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
