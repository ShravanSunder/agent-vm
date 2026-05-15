import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { ensureZoneGitRepository } from '../controller/zone-git/zone-git-operations.js';
import { resolveZoneGitPaths } from '../controller/zone-git/zone-git-paths.js';
import { collectZoneGitDoctorChecks } from './zone-git-doctor.js';

const createdDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-zone-git-doctor-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

function createSystemConfig(options: {
	readonly remoteUrl: string;
	readonly rootPath: string;
}): LoadedSystemConfig {
	return {
		schemaVersion: 1,
		cacheDir: path.join(options.rootPath, 'cache'),
		runtimeDir: path.join(options.rootPath, 'runtime'),
		systemConfigPath: path.join(options.rootPath, 'config', 'system.json'),
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm-test',
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
		tcpPool: { basePort: 19000, size: 5 },
		toolVmProfiles: {
			standard: { cpus: 1, imageProfile: 'default', memory: '1G' },
		},
		zones: [
			{
				egressHosts: [{ host: 'api.openai.com', audience: 'gateway' }],
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
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

describe('collectZoneGitDoctorChecks', () => {
	afterEach(async () => {
		await Promise.all(
			createdDirectories.splice(0).map(async (directoryPath) => {
				await rm(directoryPath, { recursive: true, force: true });
			}),
		);
	});

	it('reports missing GitHub token and uninitialized zone Git metadata', async () => {
		const rootPath = await createTemporaryDirectory();
		const systemConfig = createSystemConfig({
			remoteUrl: 'https://github.com/shravansunder/zone-files.git',
			rootPath,
		});

		const checks = await collectZoneGitDoctorChecks({
			githubToken: null,
			systemConfig,
		});

		expect(checks.find((check) => check.name === 'zone-git-github-token-sunfam')).toMatchObject({
			ok: false,
		});
		expect(checks.find((check) => check.name === 'zone-git-initialized-sunfam')).toMatchObject({
			ok: false,
			hint: expect.stringContaining('agent-vm zone-git init --zone sunfam'),
		});
	});

	it('reports dirty and unpushed initialized zone Git metadata', async () => {
		const rootPath = await createTemporaryDirectory();
		const remoteUrl = path.join(rootPath, 'remote.git');
		const systemConfig = createSystemConfig({ remoteUrl, rootPath });
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		await mkdir(zone.gateway.zoneFilesDir, { recursive: true });
		await execa('git', ['init', '--bare', remoteUrl]);
		await ensureZoneGitRepository({
			branch: 'main',
			remoteUrl,
			runtimeDir: systemConfig.runtimeDir,
			zoneFilesDir: zone.gateway.zoneFilesDir,
			zoneId: 'sunfam',
		});
		const gitDir = resolveZoneGitPaths({
			runtimeDir: systemConfig.runtimeDir,
			zoneId: 'sunfam',
		}).hostGitDir;
		await execa(
			'git',
			buildHostGitArgs({
				args: ['config', 'user.name', 'Agent VM'],
				gitDir,
				workTree: zone.gateway.zoneFilesDir,
			}),
		);
		await execa(
			'git',
			buildHostGitArgs({
				args: ['config', 'user.email', 'agent-vm@example.com'],
				gitDir,
				workTree: zone.gateway.zoneFilesDir,
			}),
		);
		await writeFile(path.join(zone.gateway.zoneFilesDir, 'AGENTS.md'), 'committed\n');
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
		await writeFile(path.join(zone.gateway.zoneFilesDir, 'scratch.md'), 'dirty\n');

		const checks = await collectZoneGitDoctorChecks({
			githubToken: 'controller-token',
			systemConfig,
		});

		expect(checks.find((check) => check.name === 'zone-git-initialized-sunfam')).toMatchObject({
			ok: true,
		});
		expect(checks.find((check) => check.name === 'zone-git-clean-sunfam')).toMatchObject({
			ok: false,
			hint: expect.stringContaining('git status'),
		});
		expect(checks.find((check) => check.name === 'zone-git-pushed-sunfam')).toMatchObject({
			ok: false,
			hint: expect.stringContaining('1 unpushed commit'),
		});
	});
});
