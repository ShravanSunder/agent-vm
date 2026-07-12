import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildImage } from './build-pipeline.js';
import type { BuildConfig } from './build-pipeline.js';
import { shouldRunGondolinBuildPipelineE2e } from './e2e-test-gates.js';
import { createManagedVm, type ManagedVm } from './vm-adapter.js';

const temporaryDirectories: string[] = [];
const describeGondolinBuildPipelineSmoke = shouldRunGondolinBuildPipelineE2e()
	? describe
	: describe.skip;

async function createTemporaryDirectory(prefix: string): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

function resolveHostCompatibleGuestArchitecture(): 'aarch64' | 'x86_64' {
	if (process.arch === 'arm64') {
		return 'aarch64';
	}
	if (process.arch === 'x64') {
		return 'x86_64';
	}

	throw new Error(`Unsupported e2e test host architecture: ${process.arch}`);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (temporaryDirectory) => {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}),
	);
});

describeGondolinBuildPipelineSmoke('smoke: Gondolin image build rootfs init', () => {
	it('boots an OCI-backed image with /dev/fd available for fd-number script paths', async () => {
		const cacheDirectory = await createTemporaryDirectory('agent-vm-dev-fd-smoke-cache-');
		const buildConfig = {
			arch: resolveHostCompatibleGuestArchitecture(),
			distro: 'alpine',
			alpine: {
				version: '3.23.0',
				kernelPackage: 'linux-virt',
				kernelImage: 'vmlinuz-virt',
				rootfsPackages: [],
				initramfsPackages: [],
			},
			oci: {
				image: 'alpine:3.23',
				pullPolicy: 'if-not-present',
			},
			rootfs: {
				label: 'dev-fd-smoke-root',
				sizeMb: 1024,
			},
		} satisfies BuildConfig;
		let vm: ManagedVm | undefined;

		try {
			const image = await buildImage(
				{
					buildConfig,
					cacheDir: cacheDirectory,
					fullReset: true,
				},
				{ gondolinVersion: 'dev-fd-smoke' },
			);
			vm = await createManagedVm({
				imagePath: image.imagePath,
				memory: '512M',
				cpus: 1,
				rootfsMode: 'memory',
				allowedHosts: [],
				secrets: {},
				vfsMounts: {},
				sessionLabel: 'agent-vm-dev-fd-smoke',
			});

			const result = await vm.exec(`set -eu
printf 'fd=%s\\n' "$(readlink /dev/fd)"
/bin/sh /dev/fd/3 3<<'SH'
echo fd-3-script-ok
SH
`);

			expect(result).toMatchObject({
				exitCode: 0,
				stderr: '',
			});
			expect(result.stdout).toContain('fd=/proc/self/fd');
			expect(result.stdout).toContain('fd-3-script-ok');
		} finally {
			await vm?.close();
		}
	}, 180_000);
});
