import type { OpenClawToolPortalClient } from './tool-portal-native-tools.js';

const OPENCLAW_GATEWAY_RUNTIME_CLIENT_BINDING_KEY = Symbol.for(
	'agent-vm.openclawGatewayRuntimeClientBinding',
);

interface OpenClawGatewayRuntimeClientBinding {
	readonly client: OpenClawToolPortalClient;
	readonly identity: symbol;
}

interface OpenClawGatewayRuntimeClientBindingStore {
	[OPENCLAW_GATEWAY_RUNTIME_CLIENT_BINDING_KEY]?: OpenClawGatewayRuntimeClientBinding;
}

function bindingStore(): typeof globalThis & OpenClawGatewayRuntimeClientBindingStore {
	return globalThis as typeof globalThis & OpenClawGatewayRuntimeClientBindingStore;
}

export function getOpenClawGatewayRuntimeClient(): OpenClawToolPortalClient | undefined {
	return bindingStore()[OPENCLAW_GATEWAY_RUNTIME_CLIENT_BINDING_KEY]?.client;
}

export function publishOpenClawGatewayRuntimeClient(client: OpenClawToolPortalClient): () => void {
	const store = bindingStore();
	const binding = {
		client,
		identity: Symbol('openclaw-gateway-runtime-client-binding'),
	} satisfies OpenClawGatewayRuntimeClientBinding;
	store[OPENCLAW_GATEWAY_RUNTIME_CLIENT_BINDING_KEY] = binding;
	return (): void => {
		if (store[OPENCLAW_GATEWAY_RUNTIME_CLIENT_BINDING_KEY]?.identity === binding.identity) {
			delete store[OPENCLAW_GATEWAY_RUNTIME_CLIENT_BINDING_KEY];
		}
	};
}
