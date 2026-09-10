import { isDeepStrictEqual } from 'node:util';

import {
	controllerConfiguredCliInputSchema,
	configuredGoogleOperationKey,
	isControllerEphemeralManagedVmConfiguredCliOperation,
	resolveCompiledGoogleCommand,
} from '@agent-vm/config-contracts';
import type { GatewayRuntimeApprovalChallengeIntent } from '@agent-vm/gateway-control-contracts';

import type { PreparedControllerOAuthRuntime } from './controller-oauth-runtime.js';

/** Resolve current host policy and authenticated display, never a caller's cached disposition. */
export function validateGoogleApprovalIntent(props: {
	readonly intent: GatewayRuntimeApprovalChallengeIntent;
	readonly runtime:
		| Pick<PreparedControllerOAuthRuntime, 'zoneId' | 'compiledOAuthPolicy' | 'policyService'>
		| undefined;
	readonly zoneId: string;
}): boolean {
	const { intent, runtime } = props;
	if (runtime === undefined || runtime.zoneId !== props.zoneId)
		return intent.managedGoogle === undefined;
	const principal = intent.trustedContext.principal;
	const namespace =
		runtime.compiledOAuthPolicy.toolPortalConfig.profiles[principal.toolPortalProfileId]
			?.namespaces[intent.call.namespace];
	const operation =
		namespace?.backend.kind === 'controller_execution'
			? namespace.backend.operations[intent.call.name]
			: undefined;
	if (
		operation?.kind !== 'configured_cli' ||
		!isControllerEphemeralManagedVmConfiguredCliOperation(operation) ||
		operation.authorization?.kind !== 'oauth_account'
	)
		return intent.managedGoogle === undefined;
	const input = controllerConfiguredCliInputSchema.safeParse(intent.call.arguments);
	if (
		!input.success ||
		intent.managedGoogle === undefined ||
		intent.backendKind !== 'controller_execution'
	)
		return false;
	const current = runtime.policyService.resolveManagedGoogleInvocation({
		agentId: principal.agentId,
		profileId: principal.toolPortalProfileId,
		namespaceId: intent.call.namespace,
		operationName: intent.call.name,
		input: input.data,
	});
	const { fileInputs, ...policyIntent } = intent.managedGoogle;
	const commandSet =
		runtime.compiledOAuthPolicy.commandSetsByConfiguredOperation[
			configuredGoogleOperationKey(
				principal.toolPortalProfileId,
				intent.call.namespace,
				intent.call.name,
			)
		];
	if (commandSet === undefined) return false;
	const classification = resolveCompiledGoogleCommand(commandSet, input.data.argv);
	if (classification.kind !== 'oauth') return false;
	const paths = classification.files?.inputs ?? [];
	if (
		paths.length === 0
			? fileInputs !== undefined
			: !isDeepStrictEqual(
					paths,
					fileInputs?.files.map((file) => file.relativePath),
				)
	)
		return false;
	// Byte authority is checked asynchronously by the ledger's input validator.
	// Keep this policy check synchronous after that read and durable record I/O.
	return (
		current.kind === 'ready' &&
		current.disposition === 'ask' &&
		isDeepStrictEqual(current, policyIntent)
	);
}
