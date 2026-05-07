import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('publish workflow', () => {
	it('caches Gondolin Zig tarballs in CI and publish workflows', async () => {
		const workflowPaths = [
			path.join(process.cwd(), '.github', 'workflows', 'ci.yml'),
			path.join(process.cwd(), '.github', 'workflows', 'publish.yml'),
		];
		const workflows = await Promise.all(
			workflowPaths.map(async (workflowPath: string): Promise<string> => {
				return fs.readFile(workflowPath, 'utf8');
			}),
		);

		for (const workflow of workflows) {
			expect(workflow).toContain('Resolve Gondolin Zig version');
			expect(workflow).toContain('Cache Zig tarballs');
			expect(workflow).toContain('path: .cache/zig');
			expect(workflow).toContain(
				'key: ${{ runner.os }}-zig-${{ steps.zig-version.outputs.arch }}-${{ steps.zig-version.outputs.version }}',
			);
			expect(workflow).toContain('--continue-at -');
			expect(workflow).toContain('--speed-limit 1024');
			expect(workflow).toContain('xz --test "${ZIG_ARCHIVE}"');
			expect(workflow).toContain('sudo tar -xJf "${ZIG_ARCHIVE}" -C /opt');
			expect(workflow).not.toContain('curl -fsSL "https://ziglang.org');
			expect(workflow).not.toContain('-o /tmp/zig.tar.xz');
		}
	});

	it('ensures managed base images exist as multi-arch manifest lists before optional npm publish', async () => {
		const workflow = await fs.readFile(
			path.join(process.cwd(), '.github', 'workflows', 'publish.yml'),
			'utf8',
		);

		expect(workflow).toContain('base_images_mode');
		expect(workflow).toContain('managed_image_tag');
		expect(workflow).toContain('source_managed_image_tag');
		expect(workflow).toContain('default: false');
		expect(workflow).toContain('Cache apt packages');
		expect(workflow).toContain('Install Zig for Gondolin smoke tests');
		expect(workflow).toContain('Detect managed base image changes');
		expect(workflow).toContain(
			"PUBLISH_NPM: ${{ github.event_name == 'workflow_dispatch' && inputs.publish_npm }}",
		);
		expect(workflow).toContain('MANAGED_IMAGE_TAG="$(node -e');
		expect(workflow).toContain(
			'Cannot publish npm with managed_image_tag override; update packages/agent-vm/managed-images.json instead.',
		);
		expect(workflow).not.toContain(
			'IMAGE_VERSION="${REQUESTED_IMAGE_VERSION:-${PACKAGE_VERSION}}"',
		);
		expect(workflow).toContain('AUTO_MODE="skip"');
		expect(workflow).toContain('docker/setup-qemu-action@v4');
		expect(workflow).toContain('docker/setup-buildx-action@v4');
		expect(workflow).toContain('Retag managed base images in GHCR');
		expect(workflow).toContain('agent-vm-managed-openclaw-gateway-base');
		expect(workflow).toContain('agent-vm-managed-worker-gateway-base');
		expect(workflow).toContain('agent-vm-managed-tool-vm-base');
		expect(workflow).toContain('docker buildx build');
		expect(workflow).toContain('--platform linux/amd64,linux/arm64');
		expect(workflow).toContain('--push');
		expect(workflow).toContain('docker buildx imagetools inspect --raw');
		expect(workflow.indexOf('Verify managed base image tags')).toBeLessThan(
			workflow.indexOf('Publish to npm via OIDC'),
		);
		expect(workflow).not.toMatch(/docker build -t/u);
		expect(workflow).not.toMatch(/docker push "ghcr\.io\/shravansunder\/agent-vm-/u);
	});
});
