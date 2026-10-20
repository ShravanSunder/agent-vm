import {
	accessProfileProjection,
	configuredCliPolicySchema,
	type AccessNamespacePolicy,
	type AssessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import type { GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';

type ManagedExecutableBackend = Exclude<
	GatewayRuntimeManagedToolPortalConfig['profiles'][string]['namespaces'][string]['backend'],
	{ readonly kind: 'mcp_provider' }
>;
type ManagedCapabilityOperation = ManagedExecutableBackend['operations'][string];

/** Project decision inputs; managed execution bindings remain with their owner. */
export function projectManagedAccessProfile(props: {
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly profileId: string;
}): AssessAccessInput['facts']['assignment']['profile'] {
	const profile = props.config.profiles[props.profileId];
	if (profile === undefined) throw new Error('Managed access profile is not configured.');
	const namespaces: Record<string, AccessNamespacePolicy> = {};
	for (const [namespace, policy] of Object.entries(profile.namespaces)) {
		const operations: AccessNamespacePolicy['operations'] = {};
		if (policy.backend.kind !== 'mcp_provider') {
			const managedOperations: Readonly<Record<string, ManagedCapabilityOperation>> =
				policy.backend.operations;
			for (const [name, operation] of Object.entries(managedOperations)) {
				operations[name] = {
					cliPolicy:
						operation.kind === 'configured_cli'
							? configuredCliPolicySchema.parse({
									calls: operation.calls,
									commands: operation.commands,
									deniedPatterns: operation.deniedPatterns,
									stdin: operation.stdin,
									timeout: operation.timeout,
								})
							: null,
					googleCommands:
						operation.kind === 'configured_cli' && operation.targetKind === 'ephemeral_managed_vm'
							? (operation.compiledGoogle ?? null)
							: null,
				};
			}
		}
		namespaces[namespace] = {
			backendKind: policy.backend.kind,
			tools: policy.tools,
			calls:
				'source' in policy.calls
					? { kind: 'account-policy' }
					: { kind: 'selectors', ...policy.calls },
			operations,
		};
	}
	return accessProfileProjection.parse({ profileId: props.profileId, namespaces });
}
