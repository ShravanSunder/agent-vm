import { join } from 'node:path';

import { loadMcpPortalConfig, type McpPortalConfig } from '@agent-vm/config-contracts';

import type { HmacKeyRegistry } from './hmac-key-registry.js';

export interface PortalPluginRuntimeState {
	readonly configDir: string;
	readonly getPortalUnavailableReason: () => string | null;
	readonly getKeyRegistry: () => HmacKeyRegistry;
	readonly loadPortalConfig: () => Promise<McpPortalConfig>;
	readonly markPortalAvailable: () => void;
	readonly markPortalUnavailable: (reason: string) => void;
	readonly setKeyRegistry: (registry: HmacKeyRegistry) => void;
}

export function createPortalPluginRuntimeState(props: {
	readonly configDir: string;
	readonly loadPortalConfig?: (path: string) => Promise<McpPortalConfig>;
}): PortalPluginRuntimeState {
	let keyRegistry: HmacKeyRegistry | null = null;
	let portalConfigPromise: Promise<McpPortalConfig> | null = null;
	let portalUnavailableReason: string | null = null;
	const loadPortalConfigFile = props.loadPortalConfig ?? loadMcpPortalConfig;
	const portalConfigPath = join(props.configDir, 'mcp-portal.config.jsonc');

	function loadPortalConfig(): Promise<McpPortalConfig> {
		if (portalConfigPromise !== null) {
			return portalConfigPromise;
		}
		const nextPromise = loadPortalConfigFile(portalConfigPath).catch((error: unknown) => {
			if (portalConfigPromise === nextPromise) {
				portalConfigPromise = null;
			}
			throw error;
		});
		portalConfigPromise = nextPromise;
		return nextPromise;
	}

	return {
		configDir: props.configDir,
		getPortalUnavailableReason: () => portalUnavailableReason,
		getKeyRegistry: () => {
			if (keyRegistry === null) {
				throw new Error('MCP Portal HMAC key registry is not initialized.');
			}
			return keyRegistry;
		},
		loadPortalConfig,
		markPortalAvailable: () => {
			portalUnavailableReason = null;
		},
		markPortalUnavailable: (reason) => {
			portalUnavailableReason = reason;
		},
		setKeyRegistry: (registry) => {
			keyRegistry = registry;
		},
	};
}
