import path from 'node:path';

import {
	createManagedVm as createManagedVmFromCore,
	type ManagedVm,
	type SecretResolver,
} from 'gondolin-core';

import type { SystemConfig } from '../controller/system-config.js';
import {
	buildGatewayVmFactoryOptions,
	prepareGatewayHostDirectories,
} from './gateway-vm-configuration.js';
import type { GatewayManagedVmFactoryOptions, GatewayZone } from './gateway-zone-support.js';

export interface GatewayVmSetupDependencies {
	readonly createManagedVm?: (options: GatewayManagedVmFactoryOptions) => Promise<ManagedVm>;
}

export async function createGatewayVm(
	options: {
		readonly controllerPort: number;
		readonly gatewayImagePath: string;
		readonly resolvedSecrets: Record<string, string>;
		readonly secretResolver: SecretResolver;
		readonly systemConfig: SystemConfig;
		readonly zone: GatewayZone;
	},
	dependencies: GatewayVmSetupDependencies = {},
): Promise<ManagedVm> {
	const createManagedVm = dependencies.createManagedVm ?? createManagedVmFromCore;
	await prepareGatewayHostDirectories({
		secretResolver: options.secretResolver,
		zone: options.zone,
	});

	return await createManagedVm(buildGatewayVmFactoryOptions(options));
}

export async function setupGatewayVmRuntime(options: {
	readonly gatewayToken?: string;
	readonly managedVm: ManagedVm;
	readonly openClawConfigPath: string;
}): Promise<void> {
	const gatewayEnvironmentProfile =
		'export OPENCLAW_HOME=/home/openclaw\n' +
		`export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/config/${path.basename(options.openClawConfigPath)}\n` +
		'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state\n' +
		(options.gatewayToken
			? `export OPENCLAW_GATEWAY_TOKEN='${options.gatewayToken.replace(/'/gu, "'\\''")}'\n`
			: '') +
		'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt\n';

	await options.managedVm.exec(
		'mkdir -p /root && cat > /root/.openclaw-env << ENVEOF\n' +
			gatewayEnvironmentProfile +
			'ENVEOF\n' +
			'chmod 600 /root/.openclaw-env && ' +
			'touch /root/.bashrc && ' +
			"grep -qxF 'source /root/.openclaw-env' /root/.bashrc || echo 'source /root/.openclaw-env' >> /root/.bashrc",
	);
}
