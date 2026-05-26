import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SystemConfig } from '../../config/system-config.js';
import {
	resolveLeaseWorkMountDir,
	type LeaseWorkMountValidationError,
	type LeaseWorkMountValidationErrorKind,
	validateResolvedToolWorkMountDir,
} from './lease-work-mount-paths.js';

type ZoneConfig = SystemConfig['zones'][number];

describe('resolveLeaseWorkMountDir', () => {
	let tempDir: string;
	let runtimeDir: string;
	let zoneFilesDir: string;
	let stateDir: string;
	let zone: ZoneConfig;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), 'agent-vm-lease-work-mount-'));
		runtimeDir = path.join(tempDir, 'runtime');
		zoneFilesDir = path.join(tempDir, 'zone-files', 'shravan');
		stateDir = path.join(tempDir, 'state', 'shravan');
		await mkdir(path.join(zoneFilesDir, 'project'), { recursive: true });
		await mkdir(path.join(stateDir, 'sandboxes', 'agent', 'work'), { recursive: true });
		zone = {
			egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
			gateway: {
				type: 'openclaw',
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				imageProfile: 'openclaw',
				cpus: 2,
				memory: '2G',
				config: path.join(tempDir, 'openclaw.json'),
				port: 18791,
				stateDir,
				zoneFilesDir,
			},
			id: 'shravan',
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
			websocketBypass: [],
		};
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('maps OpenClaw gateway sandbox paths to host stateDir sandboxes', async () => {
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
				zone,
			}),
		).resolves.toEqual({
			guestWorkdir: '/workspace',
			hostWorkMountDir: await realpath(path.join(stateDir, 'sandboxes', 'agent', 'work')),
		});
	});

	it('rejects exact OpenClaw gateway work mount roots', async () => {
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes',
				zone,
			}),
		).rejects.toThrow(/must name a child path under/u);
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/',
				zone,
			}),
		).rejects.toThrow(/must name a child path under/u);
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/zone',
				zone,
			}),
		).rejects.toThrow(/must name a child path under/u);
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/zone/',
				zone,
			}),
		).rejects.toThrow(/must name a child path under/u);
	});

	it('maps OpenClaw gateway /zone paths to host zoneFilesDir', async () => {
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/zone/project',
				zone,
			}),
		).resolves.toEqual({
			guestWorkdir: '/workspace',
			hostWorkMountDir: await realpath(path.join(zoneFilesDir, 'project')),
		});
	});

	it('returns zone Git mount metadata for configured OpenClaw /zone leases', async () => {
		if (zone.gateway.type !== 'openclaw') {
			throw new Error('test fixture must use an OpenClaw gateway');
		}
		const zoneWithZoneGit = {
			...zone,
			gateway: {
				...zone.gateway,
				zoneGit: {
					remote: {
						repoUrl: 'https://github.com/shravansunder/sunfam-zone-files.git',
						branch: 'main',
					},
				},
			},
		} satisfies ZoneConfig;

		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/zone/project',
				zone: zoneWithZoneGit,
			}),
		).resolves.toEqual({
			guestWorkdir: '/zone/project',
			hostWorkMountDir: await realpath(path.join(zoneFilesDir, 'project')),
			zoneGitMount: {
				hostZoneFilesDir: zoneFilesDir,
				hostZoneGitRoot: path.join(runtimeDir, 'zones', 'shravan', 'zone-git'),
			},
		});
	});

	it('rejects traversal before path translation', async () => {
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/../../../etc',
				zone,
			}),
		).rejects.toThrow(/must not contain '\.\.' path segments/u);
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/zone/../../../etc',
				zone,
			}),
		).rejects.toThrow(/must not contain '\.\.' path segments/u);
	});

	it('rejects symlinks that resolve outside allowed roots', async () => {
		const sensitiveDir = path.join(tempDir, 'sensitive');
		const linkPath = path.join(stateDir, 'sandboxes', 'agent', 'ssh-link');
		await mkdir(sensitiveDir, { recursive: true });
		await symlink(sensitiveDir, linkPath);

		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/ssh-link',
				zone,
			}),
		).rejects.toThrow(/outside allowed OpenClaw tool work mount roots/u);
	});

	it('rejects host paths even when they are inside allowed roots', async () => {
		const hostWorkMountDir = path.join(zoneFilesDir, 'project');

		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: hostWorkMountDir,
				zone,
			}),
		).rejects.toMatchObject({
			kind: 'work-mount-unknown-runtime-path',
		} satisfies Partial<LeaseWorkMountValidationError>);
	});

	it.each([
		{ kind: 'work-mount-unknown-runtime-path', workMountDir: '/workspace' },
		{ kind: 'work-mount-unknown-runtime-path', workMountDir: '/workspace/app' },
		{ kind: 'work-mount-unknown-runtime-path', workMountDir: '/work' },
		{ kind: 'work-mount-unknown-runtime-path', workMountDir: '/work/tmp' },
	] satisfies readonly {
		readonly kind: LeaseWorkMountValidationErrorKind;
		readonly workMountDir: string;
	}[])(
		'rejects Tool VM guest path %s as controller lease workMountDir',
		async ({ kind, workMountDir }) => {
			await expect(
				resolveLeaseWorkMountDir({
					runtimeDir,
					workMountDir,
					zone,
				}),
			).rejects.toMatchObject({
				kind,
			} satisfies Partial<LeaseWorkMountValidationError>);
		},
	);

	it('allows direct lifecycle validation of resolved host work mount paths', async () => {
		const hostWorkMountDir = path.join(zoneFilesDir, 'project');

		await expect(
			validateResolvedToolWorkMountDir({
				hostWorkMountDir,
				zone,
			}),
		).resolves.toBe(await realpath(hostWorkMountDir));
	});

	it('rejects cache runtime and unrelated host paths', async () => {
		const unrelatedPath = path.join(tempDir, 'cache', 'project');
		await mkdir(unrelatedPath, { recursive: true });

		await expect(
			validateResolvedToolWorkMountDir({
				hostWorkMountDir: unrelatedPath,
				zone,
			}),
		).rejects.toThrow(/outside allowed OpenClaw tool work mount roots/u);
	});

	it('rejects non-absolute work mount paths', async () => {
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: 'relative/work',
				zone,
			}),
		).rejects.toThrow(/Lease workMountDir 'relative\/work' must be absolute/u);
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: 'relative/work',
				zone,
			}),
		).rejects.toMatchObject({
			kind: 'work-mount-not-absolute',
		} satisfies Partial<LeaseWorkMountValidationError>);
	});

	it('rejects non-OpenClaw zones', async () => {
		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/zone/project',
				zone: {
					...zone,
					gateway: {
						type: 'worker',
						imageProfile: 'worker',
						cpus: 2,
						memory: '2G',
						config: path.join(tempDir, 'worker.json'),
						port: 18791,
						stateDir,
					},
				},
			}),
		).rejects.toThrow(/does not support OpenClaw tool VM leases/u);
	});

	it('rejects when no allowed work mount roots exist', async () => {
		const missingRootZone = {
			...zone,
			gateway: {
				...zone.gateway,
				stateDir: path.join(tempDir, 'missing-state'),
				zoneFilesDir: path.join(tempDir, 'missing-zone-files'),
			},
		};

		await expect(
			resolveLeaseWorkMountDir({
				runtimeDir,
				workMountDir: '/zone/project',
				zone: missingRootZone,
			}),
		).rejects.toThrow(/failed directory realpath check/u);
	});
});
