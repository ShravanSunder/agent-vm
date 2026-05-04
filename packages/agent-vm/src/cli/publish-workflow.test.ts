import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('publish workflow', () => {
	it('publishes managed base images as multi-arch manifest lists', async () => {
		const workflow = await fs.readFile(
			path.join(process.cwd(), '.github', 'workflows', 'publish.yml'),
			'utf8',
		);

		expect(workflow).toContain('docker/setup-qemu-action@v4');
		expect(workflow).toContain('docker/setup-buildx-action@v4');
		expect(workflow).toContain('docker buildx build');
		expect(workflow).toContain('--platform linux/amd64,linux/arm64');
		expect(workflow).toContain('--push');
		expect(workflow).toContain('docker buildx imagetools inspect --raw');
		expect(workflow.indexOf('Publish managed base images to GHCR')).toBeLessThan(
			workflow.indexOf('Publish to npm via OIDC'),
		);
		expect(workflow).not.toMatch(/docker build -t/u);
		expect(workflow).not.toMatch(/docker push "ghcr\.io\/shravansunder\/agent-vm-/u);
	});
});
