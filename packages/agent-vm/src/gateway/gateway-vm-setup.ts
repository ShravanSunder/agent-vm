import path from 'node:path';

import {
	createManagedVm as createManagedVmFromCore,
	type ManagedVm,
	type SecretResolver,
} from 'gondolin-core';

import type { SystemConfig } from '../controller/system-config.js';

import type {
	GatewayManagedVmFactoryOptions,
	GatewayZone,
} from './gateway-zone-support.js';
import {
	buildGatewayVmFactoryOptions,
	prepareGatewayHostDirectories,
} from './gateway-vm-configuration.js';

export interface GatewayVmSetupDependencies {
	readonly createManagedVm?: (
		options: GatewayManagedVmFactoryOptions,
	) => Promise<ManagedVm>;
}

export async function createGatewayVm(
	options: {
		readonly controllerPort: number;
		readonly gatewayImagePath: string;
		readonly pluginSourceDir?: string;
		readonly resolvedSecrets: Record<string, string>;
		readonly secretResolver: SecretResolver;
		readonly systemConfig: SystemConfig;
		readonly zone: GatewayZone;
	},
	dependencies: GatewayVmSetupDependencies = {},
): Promise<ManagedVm> {
	const createManagedVm =
		dependencies.createManagedVm ?? createManagedVmFromCore;
	await prepareGatewayHostDirectories({
		secretResolver: options.secretResolver,
		zone: options.zone,
	});

	return await createManagedVm(buildGatewayVmFactoryOptions(options));
}

export async function setupGatewayVmRuntime(
	options: {
		readonly managedVm: ManagedVm;
		readonly openClawConfigPath: string;
		readonly pluginSourceDir?: string;
	},
): Promise<void> {
	await options.managedVm.exec(
		'ln -sf /proc/self/fd /dev/fd 2>/dev/null || true',
	);
	await options.managedVm.exec(
		'update-ca-certificates > /dev/null 2>&1',
	);

	const gatewayEnvironmentProfile =
		'export OPENCLAW_HOME=/home/openclaw\n' +
		`export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/config/${path.basename(options.openClawConfigPath)}\n` +
		'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state\n' +
		'export OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN\n' +
		'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt\n';

	await options.managedVm.exec(
		'mkdir -p /etc/profile.d && cat > /etc/profile.d/openclaw.sh << ENVEOF\n' +
			gatewayEnvironmentProfile +
			'ENVEOF\n' +
			'chmod 644 /etc/profile.d/openclaw.sh && ' +
			'cat /etc/profile.d/openclaw.sh >> /root/.bashrc',
	);

	if (!options.pluginSourceDir) {
		return;
	}

	const openClawExtensionsDirectory =
		'/usr/local/lib/node_modules/openclaw/dist/extensions';
	await options.managedVm.exec(
		`mkdir -p ${openClawExtensionsDirectory}/gondolin && ` +
			`cp -a /opt/gondolin-plugin-src/. ${openClawExtensionsDirectory}/gondolin/ && ` +
			`chown -R root:root ${openClawExtensionsDirectory}/gondolin`,
	);
}
