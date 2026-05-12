import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { resolveZoneGitPaths } from '../controller/zone-git/zone-git-paths.js';
import { defaultCliDependencies, type CliIo } from './agent-vm-cli-support.js';
import { runZoneGitCommand } from './zone-git-commands.js';

const createdDirectories: string[] = [];

function createIo(outputs: string[]): CliIo {
	return {
		stderr: { write: () => true },
		stdout: {
			write: (chunk: string | Uint8Array) => {
				outputs.push(String(chunk));
				return true;
			},
		},
	};
}

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-zone-git-cli-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

function createSystemConfig(options: {
	readonly remoteUrl: string;
	readonly rootPath: string;
}): LoadedSystemConfig {
	return {
		cacheDir: path.join(options.rootPath, 'cache'),
		runtimeDir: path.join(options.rootPath, 'runtime'),
		systemConfigPath: path.join(options.rootPath, 'config', 'system.json'),
		host: {
			controllerPort: 18800,
			projectNamespace: 'claw-tests-a1b2c3d4',
		},
		imageProfiles: {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: './vm-images/gateways/openclaw/build-config.json',
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: './vm-images/tool-vms/default/build-config.json',
				},
			},
		},
		tcpPool: {
			basePort: 19000,
			size: 5,
		},
		toolVmProfiles: {
			standard: {
				cpus: 1,
				imageProfile: 'default',
				memory: '1G',
			},
		},
		zones: [
			{
				egressHosts: [{ host: 'api.openai.com', audience: 'gateway' }],
				gateway: {
					type: 'openclaw',
					imageProfile: 'openclaw',
					cpus: 2,
					memory: '2G',
					config: path.join(options.rootPath, 'config', 'openclaw.json'),
					port: 18791,
					stateDir: path.join(options.rootPath, 'state', 'sunfam'),
					zoneFilesDir: path.join(options.rootPath, 'zone-files', 'sunfam'),
					zoneGit: {
						remote: {
							repoUrl: options.remoteUrl,
							branch: 'main',
						},
					},
				},
				id: 'sunfam',
				secrets: {},
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
				websocketBypass: [],
			},
		],
	};
}

function buildHostGitArgs(props: {
	readonly args: readonly string[];
	readonly gitDir: string;
	readonly workTree: string;
}): readonly string[] {
	return [`--git-dir=${props.gitDir}`, `--work-tree=${props.workTree}`, ...props.args];
}

async function configureGitUser(props: {
	readonly gitDir: string;
	readonly workTree: string;
}): Promise<void> {
	await execa('git', buildHostGitArgs({ ...props, args: ['config', 'user.name', 'Agent VM'] }));
	await execa(
		'git',
		buildHostGitArgs({ ...props, args: ['config', 'user.email', 'agent-vm@example.com'] }),
	);
}

describe('runZoneGitCommand', () => {
	afterEach(async () => {
		await Promise.all(
			createdDirectories.splice(0).map(async (directoryPath) => {
				await rm(directoryPath, { recursive: true, force: true });
			}),
		);
	});

	it('initializes, reports, and pushes an OpenClaw zone Git repository', async () => {
		const previousGithubToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'controller-token';
		const outputs: string[] = [];
		const rootPath = await createTemporaryDirectory();
		const remoteUrl = path.join(rootPath, 'remote.git');
		const systemConfig = createSystemConfig({ remoteUrl, rootPath });
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		await mkdir(zone.gateway.zoneFilesDir, { recursive: true });
		await writeFile(path.join(zone.gateway.zoneFilesDir, 'AGENTS.md'), 'commit locally\n');
		await execa('git', ['init', '--bare', remoteUrl]);

		try {
			await runZoneGitCommand({
				action: 'init',
				dependencies: defaultCliDependencies,
				io: createIo(outputs),
				json: false,
				systemConfig,
				zoneId: 'sunfam',
			});
			expect(outputs.join('')).toContain('zone git sunfam');
			outputs.length = 0;

			const gitDir = resolveZoneGitPaths({
				runtimeDir: systemConfig.runtimeDir,
				zoneId: 'sunfam',
			}).hostGitDir;
			await configureGitUser({ gitDir, workTree: zone.gateway.zoneFilesDir });
			await execa(
				'git',
				buildHostGitArgs({ args: ['add', '.'], gitDir, workTree: zone.gateway.zoneFilesDir }),
			);
			await execa(
				'git',
				buildHostGitArgs({
					args: ['commit', '-m', 'docs: seed zone files'],
					gitDir,
					workTree: zone.gateway.zoneFilesDir,
				}),
			);

			await runZoneGitCommand({
				action: 'status',
				dependencies: defaultCliDependencies,
				io: createIo(outputs),
				json: true,
				systemConfig,
				zoneId: 'sunfam',
			});
			const statusPayload = JSON.parse(outputs.join('')) as {
				readonly status: { readonly aheadOfRemote: number };
			};
			expect(statusPayload.status.aheadOfRemote).toBe(1);
			outputs.length = 0;

			await runZoneGitCommand({
				action: 'push',
				dependencies: defaultCliDependencies,
				io: createIo(outputs),
				json: true,
				systemConfig,
				zoneId: 'sunfam',
			});
			const pushPayload = JSON.parse(outputs.join('')) as {
				readonly result: { readonly localHead: string };
			};
			expect(pushPayload.result.localHead).toMatch(/^[0-9a-f]{40}$/u);
		} finally {
			if (previousGithubToken === undefined) {
				delete process.env.GITHUB_TOKEN;
			} else {
				process.env.GITHUB_TOKEN = previousGithubToken;
			}
		}
	});

	it('rejects zones without zoneGit configured', async () => {
		const rootPath = await createTemporaryDirectory();
		const systemConfig = {
			...createSystemConfig({ remoteUrl: path.join(rootPath, 'remote.git'), rootPath }),
			zones: createSystemConfig({
				remoteUrl: path.join(rootPath, 'remote.git'),
				rootPath,
			}).zones.map((zone) => ({
				...zone,
				gateway:
					zone.gateway.type === 'openclaw'
						? {
								...zone.gateway,
								zoneGit: undefined,
							}
						: zone.gateway,
			})),
		} satisfies LoadedSystemConfig;

		await expect(
			runZoneGitCommand({
				action: 'status',
				dependencies: defaultCliDependencies,
				io: createIo([]),
				json: false,
				systemConfig,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow("Zone 'sunfam' does not have OpenClaw zoneGit configured.");
	});
});
