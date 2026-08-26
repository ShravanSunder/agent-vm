import { createServer } from 'node:net';
import path from 'node:path';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import type { ManagedGatewayZoneRuntime } from '../zone-runtimes/zone-runtime-types.js';

type CredentialedRuntimeTestGateway = Pick<
	ManagedGatewayZoneRuntime,
	| 'destroy'
	| 'enableSsh'
	| 'exec'
	| 'getHealth'
	| 'getLogs'
	| 'getServiceHealth'
	| 'refreshCredentials'
	| 'upgrade'
>;

export async function findAvailableCredentialedRuntimeTestPort(): Promise<number> {
	const reservation = createServer();
	await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
	const address = reservation.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Port reservation did not expose a TCP port.');
	}
	await new Promise<void>((resolve, reject) =>
		reservation.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

export function createCredentialedRuntimeRetirementTestSystemConfig(options: {
	readonly adminToken: string;
	readonly port: number;
	readonly testRoot: string;
}): LoadedSystemConfig {
	return {
		schemaVersion: 2,
		storageRootDir: options.testRoot,
		cacheDir: path.join(options.testRoot, 'cache'),
		controllerStateDir: path.join(options.testRoot, 'controller-state'),
		controllerRuntimeDir: path.join(options.testRoot, 'controller-runtime'),
		systemConfigPath: path.join(options.testRoot, 'config', 'system.json'),
		host: {
			controllerPort: options.port,
			projectNamespace: 'credential-runtime-integration',
		},
		imageProfiles: {
			gateways: {
				hermes: {
					type: 'hermes',
					buildConfig: './vm-images/gateways/hermes/build-config.json',
				},
			},
			toolVms: {},
		},
		zones: [
			{
				id: 'zone-a',
				adminAccess: {
					mode: 'secret',
					secret: { source: 'config', value: options.adminToken },
				},
				gateway: {
					type: 'hermes',
					imageProfile: 'hermes',
					memory: '2G',
					cpus: 2,
					port: 18_793,
					config: './config/hermes/config.yaml',
					profilesByAgent: {},
					profileSecretProjectionsByAgent: {},
					stateDir: path.join(options.testRoot, 'zone-a', 'state'),
					zoneFilesDir: path.join(options.testRoot, 'zone-a', 'zone-files'),
					zoneRuntimeDir: path.join(options.testRoot, 'zone-a', 'runtime'),
				},
				secrets: {},
				egressHosts: [{ host: 'www.googleapis.com', audience: 'gateway' }],
			},
		],
		toolVmProfiles: {},
		tcpPool: { basePort: 19_000, size: 2 },
	};
}

export function createUnavailableCredentialedRuntimeTestGateway(): CredentialedRuntimeTestGateway {
	return {
		destroy: async () => ({ ok: true as const, purged: false, zoneId: 'zone-a' }),
		enableSsh: async () => {
			throw new Error('not used');
		},
		exec: async () => {
			throw new Error('not used');
		},
		getHealth: async () => ({ ok: true, observation: 'not used', zoneId: 'zone-a' }),
		getLogs: async () => ({ output: '', zoneId: 'zone-a' }),
		getServiceHealth: async () => ({ ok: true, observation: 'not used', zoneId: 'zone-a' }),
		refreshCredentials: async () => ({ ok: true as const, zoneId: 'zone-a' }),
		upgrade: async () => ({ ok: true as const, zoneId: 'zone-a' }),
	};
}
