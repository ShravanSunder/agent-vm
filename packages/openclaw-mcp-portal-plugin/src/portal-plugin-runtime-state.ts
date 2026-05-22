import { loadMcpPortalConfig, type McpPortalConfig } from '@agent-vm/config-contracts';

import { resolveEffectiveConfigPaths } from './effective-config-manifest.js';

export interface PortalPluginRuntimeState {
	readonly configDir: string;
	readonly getLoadedPortalConfig: () => McpPortalConfig | null;
	readonly getPortalUnavailableReason: () => string | null;
	readonly loadPortalConfig: () => Promise<McpPortalConfig>;
	readonly markPortalAvailable: () => void;
	readonly markPortalUnavailable: (reason: string) => void;
}

export function createPortalPluginRuntimeState(props: {
	readonly configDir: string;
	readonly loadPortalConfig?: (path: string) => Promise<McpPortalConfig>;
}): PortalPluginRuntimeState {
	let loadedPortalConfig: McpPortalConfig | null = null;
	let portalConfigPromise: Promise<McpPortalConfig> | null = null;
	let portalUnavailableReason: string | null = null;
	const loadPortalConfigFile = props.loadPortalConfig ?? loadMcpPortalConfig;

	function loadPortalConfig(): Promise<McpPortalConfig> {
		if (portalConfigPromise !== null) {
			return portalConfigPromise;
		}
		const nextPromise = resolveEffectiveConfigPaths(props.configDir)
			.then((effectiveConfigPaths) => loadPortalConfigFile(effectiveConfigPaths.portalConfigPath))
			.then((portalConfig) => {
				loadedPortalConfig = portalConfig;
				return portalConfig;
			})
			.catch((error: unknown) => {
				if (portalConfigPromise === nextPromise) {
					portalConfigPromise = null;
				}
				throw error;
			});
		portalConfigPromise = nextPromise;
		return portalConfigPromise;
	}

	return {
		configDir: props.configDir,
		getLoadedPortalConfig: () => loadedPortalConfig,
		getPortalUnavailableReason: () => portalUnavailableReason,
		loadPortalConfig,
		markPortalAvailable: () => {
			portalUnavailableReason = null;
		},
		markPortalUnavailable: (reason) => {
			portalUnavailableReason = reason;
		},
	};
}
