import type {
	DirectProcessGatewayLifecycle,
	GatewayProcessSpec,
	GatewayVmRequirements,
	GatewayZoneConfig,
} from '../../src/index.js';

function buildPythonGuestVmRequirements(): GatewayVmRequirements {
	return {
		allowedHosts: ['controller.internal'],
		environment: {
			GUEST_RUNTIME: 'python',
		},
		mediatedSecrets: {},
		mounts: {
			'/work': { kind: 'memory' },
		},
		rootfsMode: 'cow',
		sessionLabel: 'fixture:python-guest:gateway',
		tcpHosts: {},
	};
}

function buildPythonGuestProcessSpec(): GatewayProcessSpec {
	return {
		bootstrapCommand: 'python -m gateway.bootstrap',
		guestListenPort: 8787,
		healthCheck: { path: '/health', port: 8787, type: 'http' },
		logPath: '/var/log/python-guest-gateway.log',
		startCommand: 'python -m gateway',
	};
}

export const pythonGuestGatewayLifecycleFixture = {
	executionModel: 'direct-process',
	buildProcessSpec(_zone: GatewayZoneConfig): GatewayProcessSpec {
		return buildPythonGuestProcessSpec();
	},
	buildVmRequirements(): GatewayVmRequirements {
		return buildPythonGuestVmRequirements();
	},
} satisfies DirectProcessGatewayLifecycle;
