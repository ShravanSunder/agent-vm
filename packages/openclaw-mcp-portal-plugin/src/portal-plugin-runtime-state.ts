import { randomBytes } from 'node:crypto';

import { loadMcpPortalConfig, type McpPortalConfig } from '@agent-vm/config-contracts';

import { resolveEffectiveConfigPaths } from './effective-config-manifest.js';

export interface PortalPluginRuntimeState {
	readonly consumeApprovalTokenId: (
		agentId: string,
		jti: string,
		expiresAtMs: number,
	) =>
		| { readonly ok: true }
		| { readonly ok: false; readonly reason: 'replay-cache-full' | 'replayed' };
	readonly configDir: string;
	readonly getApprovalHmacKey: () => Buffer;
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
	const approvalHmacKey = randomBytes(32);
	const consumedApprovalTokenIds = new Map<string, number>();
	const replayCacheLimit = 4096;
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
		consumeApprovalTokenId: (agentId, jti, expiresAtMs) => {
			const nowMs = Date.now();
			for (const [tokenKey, tokenExpiresAtMs] of consumedApprovalTokenIds) {
				if (tokenExpiresAtMs <= nowMs) {
					consumedApprovalTokenIds.delete(tokenKey);
				}
			}
			const tokenKey = `${agentId}\n${jti}`;
			if (consumedApprovalTokenIds.has(tokenKey)) {
				return { ok: false, reason: 'replayed' };
			}
			if (consumedApprovalTokenIds.size >= replayCacheLimit) {
				return { ok: false, reason: 'replay-cache-full' };
			}
			consumedApprovalTokenIds.set(tokenKey, expiresAtMs);
			return { ok: true };
		},
		configDir: props.configDir,
		getApprovalHmacKey: () => approvalHmacKey,
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
