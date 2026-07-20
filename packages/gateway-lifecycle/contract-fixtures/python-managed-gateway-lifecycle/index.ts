import type {
	BuildGatewayVmRequirementsOptions,
	BuildManagedFrameworkServiceBootInputsOptions,
	GatewayVmRequirements,
	GatewayZoneConfig,
	ManagedGatewayLifecycle,
	ManagedFrameworkServiceBootInputs,
	ManagedHermesServiceBootMetadata,
} from '../../src/index.js';

function buildPythonManagedVmRequirements(): GatewayVmRequirements {
	return {
		allowedHosts: ['controller.internal'],
		environment: {},
		mediatedSecrets: {},
		mounts: {
			'/work': { kind: 'memory' },
		},
		rootfsMode: 'cow',
		sessionLabel: 'fixture:python-managed:gateway',
		tcpHosts: {},
	};
}

export const pythonManagedGatewayLifecycleFixture = {
	executionModel: 'managed-gateway',
	buildFrameworkServiceBootInputs(
		_options: BuildManagedFrameworkServiceBootInputsOptions,
	): Promise<ManagedFrameworkServiceBootInputs> {
		return Promise.resolve({
			configuration: { gateway: { port: 18789 } },
			environment: { HOME: '/home/hermes' },
			kind: 'hermes-managed-scope',
			managedConfigurationSource: 'plugins:\n  enabled: [agent-vm-tool-portal]\n  disabled: []\n',
		});
	},
	buildFrameworkServiceBootMetadata(_zone: GatewayZoneConfig): ManagedHermesServiceBootMetadata {
		return {
			bootEntry: 'hermes-gateway',
			configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
			environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
			framework: 'hermes',
			ingress: { guestPort: 18789, kind: 'framework-http' },
			logIdentity: {
				guestPath: '/var/log/agent-vm/hermes-service.log',
				serviceName: 'agent-vm-hermes',
			},
			readiness: { guestPort: 18789, kind: 'framework-http', path: '/readyz' },
			role: 'framework-service',
		};
	},
	buildVmRequirements(_options: BuildGatewayVmRequirementsOptions): GatewayVmRequirements {
		return buildPythonManagedVmRequirements();
	},
} satisfies ManagedGatewayLifecycle;

type ManagedLifecycleCannotBuildDirectProcess =
	'buildProcessSpec' extends keyof typeof pythonManagedGatewayLifecycleFixture ? false : true;

export const managedLifecycleCannotBuildDirectProcess: ManagedLifecycleCannotBuildDirectProcess = true;
