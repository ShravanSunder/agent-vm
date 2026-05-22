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
	GatewayZoneAgentConfig,
	GatewayZoneConfig,
	GatewayZoneMcpPortalConfig,
	EnvInjectedGatewaySecretConfig,
	HttpMediatedGatewaySecretConfig,
} from './gateway-lifecycle.js';
export type { GatewayHealthCheck, GatewayProcessSpec } from './gateway-process-spec.js';
export type { GatewayVmSpec } from './gateway-vm-spec.js';
export {
	mergeRuntimeGatewaySecrets,
	splitResolvedGatewaySecrets,
	splitResolvedSecretsByInjection,
} from './split-resolved-gateway-secrets.js';
export {
	createToolVmActiveUseHandle,
	createToolVmActiveUseId,
	isToolVmActiveUseId,
} from './tool-vm-active-use.js';
export { isToolVmLeasePeek, isToolVmSshLease } from './tool-vm-lease.js';
export {
	isVmCapabilityLease,
	isVmSshEndpoint,
	isVmSshPublicEndpoint,
} from './vm-capability-lease.js';
export type {
	SecretInjectionConfig,
	SplitResolvedGatewaySecretsResult,
	SplitResolvedSecretsResult,
} from './split-resolved-gateway-secrets.js';
export type {
	CreateToolVmActiveUseHandleOptions,
	EndToolVmActiveUseRequest,
	HeartbeatToolVmActiveUseResponse,
	StartToolVmActiveUseRequest,
	StartToolVmActiveUseResponse,
	ToolVmActiveUseCorrelation,
	ToolVmActiveUseHandle,
	ToolVmActiveUseOutcome,
} from './tool-vm-active-use.js';
export type { ToolVmLeasePeek, ToolVmSshLease } from './tool-vm-lease.js';
export type {
	VmCapabilityLease,
	VmSshEndpoint,
	VmSshLease,
	VmSshPublicEndpoint,
} from './vm-capability-lease.js';
