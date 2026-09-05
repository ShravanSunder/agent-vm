import {
	createManagedToolPortalCapabilityCore,
	type CreateManagedToolPortalCapabilityCoreProps,
	type ToolPortalApprovalPort,
	type ToolPortalBackendPort,
} from '@agent-vm/tool-portal';

import {
	createGatewayRuntimeArtifactCurrentAuthorityRegistry,
	createGatewayRuntimeArtifactReadAuthorityResolver,
	type GatewayRuntimeArtifactCurrentAuthorityRegistry,
} from './artifacts/artifact-read-authority.js';
import {
	createGatewayRuntimeArtifactStore,
	type GatewayRuntimeArtifactStore,
	type GatewayRuntimeArtifactStoreLimits,
} from './artifacts/artifact-store.js';
import { createGatewayRuntimeFileArtifactStorageBackend } from './artifacts/runtime-file-artifact-storage.js';
import {
	createGatewayRuntimeManagedToolPortalService,
	type GatewayRuntimeManagedToolPortalService,
} from './runtime/managed-tool-portal-service.js';
import {
	createGatewayRuntimeToolPortalComposition,
	type CreateGatewayRuntimeToolPortalCompositionProps,
	type GatewayRuntimeToolPortalComposition,
} from './tool-portal-projections.js';

export interface GatewayRuntimeManagedToolPortalArtifactRuntimeProps {
	readonly artifactsDirectoryPath: string;
	readonly epochId: string;
	readonly limits: GatewayRuntimeArtifactStoreLimits;
	readonly now: () => number;
}

export interface GatewayRuntimeManagedToolPortalBackendFactoryRuntime {
	readonly artifactStore: GatewayRuntimeArtifactStore;
	readonly registerArtifactAuthority: GatewayRuntimeArtifactCurrentAuthorityRegistry['register'];
}

export interface GatewayRuntimeManagedToolPortalBackendPortFactories {
	readonly controllerExecution: (
		runtime: GatewayRuntimeManagedToolPortalBackendFactoryRuntime,
	) => ToolPortalBackendPort<'controller_execution'>;
	readonly mcpProvider: (
		runtime: GatewayRuntimeManagedToolPortalBackendFactoryRuntime,
	) => ToolPortalBackendPort<'mcp_provider'>;
	readonly toolVmRunner: (
		runtime: GatewayRuntimeManagedToolPortalBackendFactoryRuntime,
	) => ToolPortalBackendPort<'tool_vm_runner'>;
}

export interface CreateGatewayRuntimeManagedToolPortalCompositionProps<TUdsProjection> extends Omit<
	CreateGatewayRuntimeToolPortalCompositionProps<TUdsProjection>,
	'artifactReader' | 'createToolPortalCapabilityCore'
> {
	readonly artifactRuntime: GatewayRuntimeManagedToolPortalArtifactRuntimeProps;
	readonly backendPortFactories: GatewayRuntimeManagedToolPortalBackendPortFactories;
	readonly oauthAvailabilityPort?: CreateManagedToolPortalCapabilityCoreProps['oauthAvailabilityPort'];
	readonly toolPortalConfig: CreateManagedToolPortalCapabilityCoreProps['config'];
}

export interface GatewayRuntimeManagedToolPortalOwnedComponents<
	TUdsProjection,
> extends GatewayRuntimeToolPortalComposition<TUdsProjection> {
	readonly artifactStore: GatewayRuntimeArtifactStore;
	readonly registerArtifactAuthority: GatewayRuntimeArtifactCurrentAuthorityRegistry['register'];
	readonly retireArtifactAuthority: GatewayRuntimeArtifactCurrentAuthorityRegistry['retire'];
	readonly retireEpoch: () => Promise<void>;
}

export interface GatewayRuntimeManagedToolPortalComposition<
	TUdsProjection,
> extends GatewayRuntimeManagedToolPortalOwnedComponents<TUdsProjection> {
	readonly service: GatewayRuntimeManagedToolPortalService<
		GatewayRuntimeManagedToolPortalOwnedComponents<TUdsProjection>
	>;
}

/** Build the one production Tool Portal service and its epoch-local artifact authority. */
export async function createGatewayRuntimeManagedToolPortalComposition<TUdsProjection>(
	props: CreateGatewayRuntimeManagedToolPortalCompositionProps<TUdsProjection>,
): Promise<GatewayRuntimeManagedToolPortalComposition<TUdsProjection>> {
	const storageBackend = await createGatewayRuntimeFileArtifactStorageBackend({
		artifactsDirectoryPath: props.artifactRuntime.artifactsDirectoryPath,
	});
	const artifactAuthorityRegistry = createGatewayRuntimeArtifactCurrentAuthorityRegistry();
	const artifactStore = createGatewayRuntimeArtifactStore({
		authorityResolver: createGatewayRuntimeArtifactReadAuthorityResolver({
			currentAuthority: artifactAuthorityRegistry.currentAuthority,
		}),
		epochId: props.artifactRuntime.epochId,
		limits: props.artifactRuntime.limits,
		now: props.artifactRuntime.now,
		storageBackend,
	});
	const backendFactoryRuntime = {
		artifactStore,
		registerArtifactAuthority: artifactAuthorityRegistry.register,
	} satisfies GatewayRuntimeManagedToolPortalBackendFactoryRuntime;
	const backendPorts = {
		controllerExecution: props.backendPortFactories.controllerExecution(backendFactoryRuntime),
		mcpProvider: props.backendPortFactories.mcpProvider(backendFactoryRuntime),
		toolVmRunner: props.backendPortFactories.toolVmRunner(backendFactoryRuntime),
	} satisfies CreateManagedToolPortalCapabilityCoreProps['backendPorts'];
	const composition = createGatewayRuntimeToolPortalComposition({
		approvalPort: props.approvalPort,
		artifactReader: artifactStore,
		authenticatedPrivateUdsOperationGroups: props.authenticatedPrivateUdsOperationGroups,
		createPrivateUdsProjection: props.createPrivateUdsProjection,
		createToolPortalCapabilityCore: (serviceProps: {
			readonly approvalPort: ToolPortalApprovalPort;
			readonly semanticSnapshot: CreateManagedToolPortalCapabilityCoreProps['semanticSnapshot'];
		}) =>
			createManagedToolPortalCapabilityCore({
				approvalPort: serviceProps.approvalPort,
				backendPorts,
				config: props.toolPortalConfig,
				...(props.oauthAvailabilityPort === undefined
					? {}
					: { oauthAvailabilityPort: props.oauthAvailabilityPort }),
				semanticSnapshot: serviceProps.semanticSnapshot,
			}),
		managedPluginAttachment: props.managedPluginAttachment,
		semanticSnapshot: props.semanticSnapshot,
	});

	const ownedComponents: GatewayRuntimeManagedToolPortalOwnedComponents<TUdsProjection> = {
		...composition,
		artifactStore,
		registerArtifactAuthority: artifactAuthorityRegistry.register,
		retireArtifactAuthority: artifactAuthorityRegistry.retire,
		retireEpoch: artifactStore.retireEpoch,
	};
	return {
		...ownedComponents,
		service: createGatewayRuntimeManagedToolPortalService({
			capabilityCore: ownedComponents.capabilityCore,
			ownedComponents,
		}),
	};
}
