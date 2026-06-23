import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import {
	secretTargetsToolVmAgent,
	selectToolVmMediatedSecretNamesForAgent,
} from './tool-vm-secret-selection.js';

type ZoneConfig = SystemConfig['zones'][number];
type ZoneSecretConfig = ZoneConfig['secrets'][string];

function toolSecret(options: {
	readonly agentAccess: 'all' | string[];
	readonly audience?: 'tool-vm' | 'both';
	readonly envVar?: string;
	readonly hosts?: string[];
}): ZoneSecretConfig {
	return {
		source: 'environment',
		envVar: options.envVar ?? 'TEST_TOKEN',
		injection: 'http-mediation',
		audience: options.audience ?? 'tool-vm',
		hosts: options.hosts ?? ['api.example.com'],
		agentAccess: options.agentAccess,
	};
}

function gatewaySecret(): ZoneSecretConfig {
	return {
		source: 'environment',
		envVar: 'GATEWAY_TOKEN',
		injection: 'http-mediation',
		audience: 'gateway',
		hosts: ['gateway.example.com'],
	};
}

function rawGatewayEnvSecret(): ZoneSecretConfig {
	return {
		source: 'environment',
		envVar: 'OPENCLAW_GATEWAY_TOKEN',
		injection: 'env',
		audience: 'gateway',
	};
}

function createZoneWithSecrets(secrets: Record<string, ZoneSecretConfig>): ZoneConfig {
	return {
		id: 'sunfam',
		agents: [{ id: 'sun' }, { id: 'mak' }],
		gateway: {
			type: 'openclaw',
			controlAuth: {
				mode: 'token',
				secret: 'OPENCLAW_GATEWAY_TOKEN',
			},
			imageProfile: 'openclaw',
			memory: '2G',
			cpus: 2,
			port: 18791,
			config: './config/sunfam/openclaw.json',
			stateDir: './state/sunfam',
			zoneFilesDir: './zone-files/sunfam',
		},
		secrets,
		egressHosts: [],
		defaultToolVmProfile: 'standard',
		agentToolVmProfiles: {},
	};
}

describe('Tool VM secret selection', () => {
	it('selects all-agent and matching scoped Tool VM mediated secrets', () => {
		const selected = selectToolVmMediatedSecretNamesForAgent({
			agentId: 'sun',
			zone: createZoneWithSecrets({
				OPENCLAW_GATEWAY_TOKEN: rawGatewayEnvSecret(),
				SHARED_TOKEN: toolSecret({ agentAccess: 'all', envVar: 'SHARED_TOKEN' }),
				SUN_TOKEN: toolSecret({ agentAccess: ['sun'], envVar: 'SUN_TOKEN' }),
				MAK_TOKEN: toolSecret({ agentAccess: ['mak'], envVar: 'MAK_TOKEN' }),
				GATEWAY_TOKEN: gatewaySecret(),
			}),
		});

		expect([...selected].toSorted()).toEqual(['SHARED_TOKEN', 'SUN_TOKEN']);
	});

	it('selects shared audience secrets when the agent is allowed on the Tool VM side', () => {
		const selected = selectToolVmMediatedSecretNamesForAgent({
			agentId: 'sun',
			zone: createZoneWithSecrets({
				GITHUB_TOKEN: toolSecret({
					agentAccess: ['sun'],
					audience: 'both',
					envVar: 'GITHUB_TOKEN',
					hosts: ['api.github.com'],
				}),
			}),
		});

		expect([...selected]).toEqual(['GITHUB_TOKEN']);
	});

	it('rejects Tool VM mediated secret selection for undeclared agents', () => {
		expect(() =>
			selectToolVmMediatedSecretNamesForAgent({
				agentId: 'ember',
				zone: createZoneWithSecrets({
					SHARED_TOKEN: toolSecret({ agentAccess: 'all', envVar: 'SHARED_TOKEN' }),
				}),
			}),
		).toThrow(
			"Tool VM mediated secrets in zone 'sunfam' require declared agent 'ember' in zones[].agents before secret access can be selected.",
		);
	});

	it('returns false for non-Tool-VM secret targets', () => {
		expect(
			secretTargetsToolVmAgent({
				agentId: 'sun',
				agentIsDeclared: true,
				secret: gatewaySecret(),
				secretName: 'GATEWAY_TOKEN',
				zoneId: 'sunfam',
			}),
		).toBe(false);
	});

	it('throws when a Tool VM mediated secret reaches runtime without agentAccess', () => {
		// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- defensive runtime guard test for stale configs that bypass Zod.
		const legacySecret = {
			source: 'environment',
			envVar: 'LEGACY_TOKEN',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.example.com'],
		} as unknown as ZoneSecretConfig;

		expect(() =>
			secretTargetsToolVmAgent({
				agentId: 'sun',
				agentIsDeclared: true,
				secret: legacySecret,
				secretName: 'LEGACY_TOKEN',
				zoneId: 'sunfam',
			}),
		).toThrow(
			"Tool VM mediated secret 'LEGACY_TOKEN' in zone 'sunfam' is missing required agentAccess.",
		);
	});
});
