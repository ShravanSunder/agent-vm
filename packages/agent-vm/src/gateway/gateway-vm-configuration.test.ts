import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SecretResolver } from 'gondolin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareGatewayHostDirectories } from './gateway-vm-configuration.js';
import type { GatewayZone } from './gateway-zone-support.js';

const createdDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

describe('prepareGatewayHostDirectories', () => {
	it('does not use sync filesystem helpers inside the async preparation path', async () => {
		const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-gateway-host-prep-'));
		createdDirectories.push(tempDirectory);
		const zone: GatewayZone = {
			allowedHosts: ['api.openai.com'],
			gateway: {
				authProfilesRef: 'op://vault/item/auth-profiles',
				cpus: 2,
				memory: '2G',
				openclawConfig: path.join(tempDirectory, 'config', 'openclaw.json'),
				port: 18791,
				stateDir: path.join(tempDirectory, 'state'),
				type: 'openclaw',
				workspaceDir: path.join(tempDirectory, 'workspace'),
			},
			id: 'shravan',
			secrets: {},
			toolProfile: 'standard',
			websocketBypass: [],
		};
		const secretResolver: SecretResolver = {
			resolve: async () => '{"profiles":[]}',
			resolveAll: async () => ({}),
		};
		const mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync');
		const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');

		await prepareGatewayHostDirectories({
			secretResolver,
			zone,
		});

		expect(mkdirSyncSpy).not.toHaveBeenCalled();
		expect(writeFileSyncSpy).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(zone.gateway.stateDir, 'agents', 'main', 'agent'))).toBe(true);
		expect(
			fs.readFileSync(
				path.join(zone.gateway.stateDir, 'agents', 'main', 'agent', 'auth-profiles.json'),
				'utf8',
			),
		).toBe('{"profiles":[]}');
	});
});
