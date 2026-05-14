import { join } from 'node:path';

import { loadMcpPortalConfig, type McpPortalConfig } from '@agent-vm/config-contracts';

import type { HmacKeyRegistry } from './hmac-key-registry.js';

export interface PortalPluginRuntimeState {
	readonly configDir: string;
	readonly getKeyRegistry: () => HmacKeyRegistry;
	readonly loadPortalConfig: () => Promise<McpPortalConfig>;
	readonly setKeyRegistry: (registry: HmacKeyRegistry) => void;
}

export function createPortalPluginRuntimeState(props: {
	readonly configDir: string;
	readonly loadPortalConfig?: (path: string) => Promise<McpPortalConfig>;
}): PortalPluginRuntimeState {
	let keyRegistry: HmacKeyRegistry | null = null;
	let portalConfigPromise: Promise<McpPortalConfig> | null = null;
	const loadPortalConfigFile = props.loadPortalConfig ?? loadMcpPortalConfig;
	const portalConfigPath = join(props.configDir, 'mcp-portal.config.jsonc');

	return {
		configDir: props.configDir,
		getKeyRegistry: () => {
			if (keyRegistry === null) {
				throw new Error('MCP Portal HMAC key registry is not initialized.');
			}
			return keyRegistry;
		},
		loadPortalConfig: () => {
			portalConfigPromise ??= loadPortalConfigFile(portalConfigPath);
			return portalConfigPromise;
		},
		setKeyRegistry: (registry) => {
			keyRegistry = registry;
		},
	};
}
