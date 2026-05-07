import { describe, expect, it } from 'vitest';

import { resolveManagedImageRelease } from './managed-image-dockerfile.js';

describe('managed image release', () => {
	it('keeps managed image tags separate from npm package versions', async () => {
		const release = await resolveManagedImageRelease();

		expect(release.baseImages['openclaw-gateway']).toEqual({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base',
			tag: '2026.05.07.1',
		});
		expect(release.baseImages['worker-gateway']).toEqual({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
			tag: '2026.05.07.1',
		});
		expect(release.baseImages['tool-vm']).toEqual({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
			tag: '2026.05.07.1',
		});
		expect(release.openClawAgentVmPluginVersion).toBe('0.0.49');
		expect(release.baseImages['tool-vm'].tag).not.toMatch(/^0\.0\.\d+$/u);
	});
});
