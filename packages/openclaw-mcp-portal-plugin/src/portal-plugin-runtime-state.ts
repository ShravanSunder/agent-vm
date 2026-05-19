import { join } from 'node:path';

import { loadMcpPortalConfig, type McpPortalConfig } from '@agent-vm/config-contracts';

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
	const portalConfigPath = join(props.configDir, 'mcp-portal.config.jsonc');

	function loadPortalConfig(): Promise<McpPortalConfig> {
		if (portalConfigPromise !== null) {
			return portalConfigPromise;
		}
		const nextPromise = loadPortalConfigFile(portalConfigPath)
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
