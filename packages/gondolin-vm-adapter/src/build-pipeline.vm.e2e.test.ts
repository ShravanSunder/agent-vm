import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { buildImage } from './build-pipeline.js';
import type { BuildConfig } from './build-pipeline.js';
import { shouldRunGondolinBuildPipelineE2e } from './e2e-test-gates.js';
import { createManagedVm, type ManagedVm, type VfsMountSpec } from './vm-adapter.js';

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

describeGondolinBuildPipelineSmoke('Gondolin 0.13 published-helper qualification', () => {
	it.each(['missing', 'corrupt'] as const)(
		'rejects %s helper inputs without publishing an image',
		async (failureKind) => {
			const temporaryRoot = await createTemporaryDirectory('agent-vm-gondolin-helper-failure-');
			const helperDirectory = path.join(temporaryRoot, 'helpers');
			await mkdir(path.join(helperDirectory, 'bin'), { recursive: true });
			if (failureKind === 'corrupt') {
				await Promise.all(
					['sandboxd', 'sandboxfs', 'sandboxssh', 'sandboxingress'].map(async (binaryName) => {
						await writeFile(path.join(helperDirectory, 'bin', binaryName), 'invalid-helper', {
							mode: 0o755,
						});
					}),
				);
				await writeFile(
					path.join(helperDirectory, 'manifest.json'),
					JSON.stringify({ schema: 999 }),
				);
			}
			const previousHelperDirectory = process.env.GONDOLIN_SANDBOX_HELPERS_DIR;
			const cacheDirectory = path.join(temporaryRoot, 'unpublished-images');
			await mkdir(cacheDirectory);
			try {
				process.env.GONDOLIN_SANDBOX_HELPERS_DIR = helperDirectory;
				const preparation = buildImage({
					cacheDir: cacheDirectory,
					buildConfig: {
						arch: resolveHostCompatibleGuestArchitecture(),
						distro: 'alpine',
						rootfs: { label: 'invalid-helper-proof', sizeMb: 1024 },
					},
				});
				if (failureKind === 'missing')
					await expect(preparation).rejects.toMatchObject({ code: 'ENOENT' });
				else await expect(preparation).rejects.toThrow(/invalid sandbox helper manifest schema/u);
				expect(await readdir(cacheDirectory)).toEqual([]);
			} finally {
				if (previousHelperDirectory === undefined) delete process.env.GONDOLIN_SANDBOX_HELPERS_DIR;
				else process.env.GONDOLIN_SANDBOX_HELPERS_DIR = previousHelperDirectory;
			}
		},
	);

	it('assembles without Zig and preserves long mounts, TLS, defaults and terminal close', async () => {
		const runHostCommand = promisify(execFile);
		const temporaryRoot = await createTemporaryDirectory('agent-vm-gondolin-013-proof-');
		const commandDirectory = path.join(temporaryRoot, 'host-commands');
		await mkdir(commandDirectory);
		const commandNames = [
			'docker',
			'qemu-system-aarch64',
			'qemu-system-x86_64',
			'qemu-img',
			'mke2fs',
			'mkfs.ext4',
			'debugfs',
			'lz4',
			'cpio',
			'python3',
			'pnpm',
		];
		await Promise.all(
			commandNames.map(async (commandName) => {
				try {
					const result = await runHostCommand('/bin/sh', ['-c', 'command -v ' + commandName]);
					await symlink(result.stdout.trim(), path.join(commandDirectory, commandName));
				} catch {
					// Optional architecture/tool aliases are not present on every host.
				}
			}),
		);
		await symlink(process.execPath, path.join(commandDirectory, 'node'));
		const previousPath = process.env.PATH;
		const controlledPath = [
			commandDirectory,
			'/usr/local/bin',
			'/usr/bin',
			'/bin',
			'/usr/sbin',
			'/sbin',
		].join(path.delimiter);
		const hostEnvironment = { ...process.env, PATH: controlledPath };
		await expect(
			runHostCommand('/bin/sh', ['-c', 'command -v zig'], { env: hostEnvironment }),
		).rejects.toMatchObject({ code: 1 });
		await expect(
			runHostCommand('/bin/sh', ['-lc', 'command -v zig'], { env: hostEnvironment }),
		).rejects.toMatchObject({ code: 1 });
		expect(process.env.GONDOLIN_SANDBOX_HELPERS_DIR).toBeUndefined();
		expect(process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE ?? '').not.toMatch(
			/^(1|true|yes|on)$/iu,
		);
		const cacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		if (!cacheRoot)
			throw new Error('Live qualification requires the explicit shared E2E cache root');
		await mkdir(cacheRoot, { recursive: true });
		const capacity = await statfs(cacheRoot);
		const freeBytes = capacity.bavail * capacity.bsize;
		let receivedAuthorization: string | undefined;
		let receivedExplicitMarker: string | undefined;
		const upstream = http.createServer((request, response) => {
			receivedAuthorization = request.headers.authorization;
			const explicitHeader = request.headers['x-explicit-token'];
			receivedExplicitMarker = typeof explicitHeader === 'string' ? explicitHeader : undefined;
			response.end('tls-ca-through-long-bind-list');
		});
		let vm: ManagedVm | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				upstream.once('error', reject);
				upstream.listen(0, '127.0.0.1', () => resolve());
			});
			const address = upstream.address();
			if (!address || typeof address === 'string') throw new Error('Expected local upstream port');
			const upstreamPort = address.port;
			const mountEntries = await Promise.all(
				Array.from({ length: 128 }, async (_, mountIndex) => {
					const hostPath = path.join(temporaryRoot, 'mount-' + String(mountIndex));
					await mkdir(hostPath);
					await writeFile(path.join(hostPath, 'marker'), 'mounted-' + String(mountIndex) + '\n');
					return {
						guestPath:
							'/qualification/' + String(mountIndex) + '-' + 'x'.repeat(60) + ' space,comma',
						hostPath,
						marker: 'mounted-' + String(mountIndex),
					};
				}),
			);
			expect(mountEntries.map((entry) => entry.guestPath).join(',').length).toBeGreaterThan(8192);
			const mounts: Record<string, VfsMountSpec> = Object.fromEntries(
				mountEntries.map((entry) => [
					entry.guestPath,
					{ kind: 'realfs-readonly', hostPath: entry.hostPath } satisfies VfsMountSpec,
				]),
			);
			process.env.PATH = controlledPath;
			const buildOutput: string[] = [];
			const image = await buildImage({
				cacheDir: path.join(cacheRoot, 'gondolin-013-qualification'),
				output: {
					write: (chunk: string | Uint8Array): boolean => {
						buildOutput.push(
							typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
						);
						return true;
					},
				},
				buildConfig: {
					arch: resolveHostCompatibleGuestArchitecture(),
					distro: 'alpine',
					alpine: {
						version: '3.23.0',
						kernelPackage: 'linux-virt',
						kernelImage: 'vmlinuz-virt',
						rootfsPackages: ['linux-virt', 'bash', 'ca-certificates', 'curl'],
						initramfsPackages: [],
					},
					rootfs: { label: 'gondolin-013-proof', sizeMb: 1024 },
				},
			}).finally(() => {
				process.stdout.write(buildOutput.join(''));
			});
			process.stdout.write(
				JSON.stringify({ qualification: 'no-zig-image', ...image, freeBytesBefore: freeBytes }) +
					'\n',
			);
			vm = await createManagedVm({
				imagePath: image.imagePath,
				memory: '512M',
				cpus: 1,
				rootfsMode: 'cow',
				allowedHosts: ['mount-proof.example', '127.0.0.1'],
				secrets: {
					PROOF_TOKEN: {
						hosts: ['mount-proof.example', '127.0.0.1'],
						value: 'host-only-generated-proof',
					},
					EXPLICIT_TOKEN: {
						hosts: ['mount-proof.example', '127.0.0.1'],
						placeholder: 'controller-exact-proof-marker',
						value: 'host-only-explicit-proof',
					},
				},
				vfsMounts: mounts,
				tcpHosts: { ['127.0.0.1:' + String(upstreamPort)]: '127.0.0.1:' + String(upstreamPort) },
				onRequest: async (request: Request): Promise<Request | void> => {
					if (new URL(request.url).hostname !== 'mount-proof.example') return;
					return new Request('http://127.0.0.1:' + String(upstreamPort) + '/proof', {
						headers: request.headers,
					});
				},
			});
			await vm.start();
			const mountedMarkers = await vm.exec(
				mountEntries.map((entry) => "cat '" + entry.guestPath + "/marker'").join(' && '),
			);
			expect(mountedMarkers.exitCode).toBe(0);
			expect(mountedMarkers.stdout.trim().split('\n')).toEqual(
				mountEntries.map((entry) => entry.marker),
			);
			const environment = await vm.exec(
				'printf "marker=%s\nexplicit=%s\nxdg=%s\nuv=%s\n" "$PROOF_TOKEN" "$EXPLICIT_TOKEN" "${XDG_CACHE_HOME-unset}" "${UV_CACHE_DIR-unset}"',
			);
			expect(environment.exitCode).toBe(0);
			expect(environment.stdout).toMatch(/marker=GONDOLIN_SECRET_[a-f0-9]{48}\n/u);
			expect(environment.stdout).toContain('explicit=controller-exact-proof-marker\n');
			expect(environment.stdout).toContain('xdg=unset\nuv=unset\n');
			expect(environment.stdout).not.toContain('host-only-');
			const tls = await vm.exec(
				'test -s /etc/gondolin/mitm/ca.crt && curl --fail --silent --show-error --max-time 10 --cacert /etc/gondolin/mitm/ca.crt -H "Authorization: Bearer $PROOF_TOKEN" -H "X-Explicit-Token: $EXPLICIT_TOKEN" https://mount-proof.example/proof',
			);
			expect(tls).toMatchObject({ exitCode: 0, stdout: 'tls-ca-through-long-bind-list' });
			expect(receivedAuthorization).toBe('Bearer host-only-generated-proof');
			expect(receivedExplicitMarker).toBe('host-only-explicit-proof');
			const backing = await vm.exec('awk \'$2 == "/tmp" || $2 == "/" { print $3 }\' /proc/mounts');
			process.stdout.write(
				JSON.stringify({
					qualification: 'guest-backing',
					exitCode: backing.exitCode,
					stdout: backing.stdout,
					stderr: backing.stderr,
				}) + '\n',
			);
			expect(backing.exitCode).toBe(0);
			expect(backing.stdout.trim().split('\n')).toEqual(expect.arrayContaining(['ext4', 'tmpfs']));
			const hostPid = vm.getHostPid();
			expect(hostPid).not.toBeNull();
			const ingress = await vm.enableIngress();
			await vm.close();
			if (hostPid === null) throw new Error('Expected captured VM runner');
			expect(() => process.kill(hostPid, 0)).toThrow();
			const closedVm = vm;
			await expect(closedVm.start()).rejects.toThrow(/closed/iu);
			await expect(async () => await closedVm.exec('echo forbidden-resurrection')).rejects.toThrow(
				/closed/iu,
			);
			expect(closedVm.getHostPid()).toBeNull();
			const ingressError: unknown = await fetch('http://127.0.0.1:' + String(ingress.port), {
				signal: AbortSignal.timeout(2000),
			}).catch((error: unknown) => error);
			expect(ingressError).toMatchObject({ cause: { code: 'ECONNREFUSED' } });
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			try {
				await vm?.close();
			} finally {
				if (upstream.listening) {
					await new Promise<void>((resolve, reject) =>
						upstream.close((error) => (error ? reject(error) : resolve())),
					);
				}
			}
		}
	}, 180_000);
});
