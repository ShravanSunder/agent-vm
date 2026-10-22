import { resolveCompiledGoogleCommand } from '@agent-collaboration/tool-access/authorization';
import { controllerConfiguredCliInputSchema } from '@agent-collaboration/tool-access/contracts';
import type { PortalCallRequest } from '@agent-vm/agent-portal-sdk';
import { type GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import type { ManagedGoogleReadyPreflight } from '@agent-vm/oauth-broker-contracts';

/** Preserve the existing managed preflight binding; portable references do not carry it. */
export function resolveManagedGoogleBinding(props: {
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly profileId: string;
	readonly call: PortalCallRequest['calls'][number];
	readonly preflight: ManagedGoogleReadyPreflight | null;
}): ManagedGoogleReadyPreflight | undefined {
	const namespace = props.config.profiles[props.profileId]?.namespaces[props.call.namespace];
	if (namespace === undefined || !('source' in namespace.calls)) return undefined;
	const operation =
		namespace.backend.kind === 'controller_execution'
			? namespace.backend.operations[props.call.name]
			: undefined;
	if (
		operation?.kind !== 'configured_cli' ||
		operation.targetKind !== 'ephemeral_managed_vm' ||
		operation.compiledGoogle === undefined
	)
		throw new Error('Managed Google command table is unavailable.');
	const input = controllerConfiguredCliInputSchema.parse(props.call.arguments);
	const local = resolveCompiledGoogleCommand(operation.compiledGoogle, input.argv);
	if (local.kind === 'no-oauth') return undefined;
	const result = props.preflight;
	if (
		local.kind !== 'oauth' ||
		result === null ||
		!('accountId' in input) ||
		result.binding.accountId !== input.accountId ||
		result.display.accountId !== input.accountId ||
		result.display.authorizationId !== result.binding.authorizationId ||
		result.display.authorizationMetadataRevision !== result.binding.authorizationMetadataRevision ||
		result.binding.operationId !== local.operationId ||
		result.binding.applicationId !==
			operation.compiledGoogle.applicationIdsByFamily[local.familyId] ||
		result.binding.commandTableRevision !== operation.compiledGoogle.revision
	)
		throw new Error('Managed Google preflight binding does not match this call.');
	return result;
}
