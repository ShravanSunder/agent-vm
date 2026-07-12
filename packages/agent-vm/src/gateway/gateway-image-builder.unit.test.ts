import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildGatewayImage } from './gateway-image-builder.js';

describe('buildGatewayImage', () => {
	it('delegates image preparation exclusively through the managed VM capability', async () => {
		const cacheDir = path.join(os.tmpdir(), 'agent-vm-gateway-image');
		const buildConfigPath = path.join(cacheDir, 'build-config.jsonc');
		const prepareImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'managed-fingerprint',
			imageReference: path.join(cacheDir, 'managed-fingerprint'),
		}));

		const result = await buildGatewayImage(
			{ buildConfigPath, cacheDir },
			{ managedVmImages: { prepareImage } },
		);

		expect(prepareImage).toHaveBeenCalledOnce();
		expect(prepareImage).toHaveBeenCalledWith({
			cacheDirectory: cacheDir,
			recipePath: buildConfigPath,
		});
		expect(result).toEqual({
			built: true,
			fingerprint: 'managed-fingerprint',
			imageReference: path.join(cacheDir, 'managed-fingerprint'),
		});
	});
});
