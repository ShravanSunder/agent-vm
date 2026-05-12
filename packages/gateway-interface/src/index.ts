export {
	buildGatewaySessionLabel,
	buildToolSessionLabel,
	gatewayTypeValues,
} from './gateway-runtime-contract.js';
export {
	controllerVmHost,
	egressHostsForAudience,
	gatewayVmAllowedHosts,
	targetsAudience,
	vmAudienceValues,
} from './audience.js';
export type { EgressHostConfig, RuntimeVmAudience, VmAudience } from './audience.js';
export type { GatewayType } from './gateway-runtime-contract.js';
export type {
	BuildGatewayVmSpecOptions,
	GatewayAuthConfig,
	GatewayLifecycle,
	GatewaySecretConfig,
	GatewayZoneConfig,
	EnvInjectedGatewaySecretConfig,
	HttpMediatedGatewaySecretConfig,
} from './gateway-lifecycle.js';
export type { GatewayHealthCheck, GatewayProcessSpec } from './gateway-process-spec.js';
export type { GatewayVmSpec } from './gateway-vm-spec.js';
export {
	splitResolvedGatewaySecrets,
	splitResolvedSecretsByInjection,
} from './split-resolved-gateway-secrets.js';
export type {
	SecretInjectionConfig,
	SplitResolvedGatewaySecretsResult,
	SplitResolvedSecretsResult,
} from './split-resolved-gateway-secrets.js';
