import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SystemConfig } from '../../config/system-config.js';
import {
	type ControllerSelectedToolVmDirectoryValidationError,
	validateControllerSelectedToolVmDirectory,
} from './lease-work-mount-paths.js';

type ZoneConfig = SystemConfig['zones'][number];

describe('validateControllerSelectedToolVmDirectory', () => {
	let agentWorkspaceDirectory: string;
	let stateDirectory: string;
	let temporaryDirectory: string;
	let zone: ZoneConfig;
	let zoneFilesDirectory: string;
	let zoneRuntimeDirectory: string;

	beforeAll(async () => {
		temporaryDirectory = await mkdtemp(
			path.join(tmpdir(), 'agent-vm-controller-selected-tool-directory-'),
		);
		zoneFilesDirectory = path.join(temporaryDirectory, 'test-zone', 'zone-files');
		stateDirectory = path.join(temporaryDirectory, 'test-zone', 'state');
		zoneRuntimeDirectory = path.join(temporaryDirectory, 'test-zone', 'runtime');
		agentWorkspaceDirectory = path.join(zoneFilesDirectory, 'agents', 'main');
		await mkdir(agentWorkspaceDirectory, { recursive: true });
		await mkdir(stateDirectory, { recursive: true });
		zone = {
			agentToolVmProfiles: {},
			defaultToolVmProfile: 'standard',
			egressHosts: [],
			gateway: {
				config: path.join(temporaryDirectory, 'openclaw.json'),
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				cpus: 2,
				imageProfile: 'openclaw',
				memory: '2G',
				port: 18_791,
				stateDir: stateDirectory,
				type: 'openclaw',
				zoneFilesDir: zoneFilesDirectory,
				zoneRuntimeDir: zoneRuntimeDirectory,
			},
			id: 'test-zone',
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					audience: 'gateway',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					source: 'environment',
				},
			},
		};
	});

	afterAll(async () => {
		await rm(temporaryDirectory, { force: true, recursive: true });
	});

	it('accepts the exact controller-selected managed agent workspace', async () => {
		await expect(
			validateControllerSelectedToolVmDirectory({
				agentId: 'main',
				hostDirectory: agentWorkspaceDirectory,
				kind: 'managed-agent-workspace',
				zone,
			}),
		).resolves.toBe(await realpath(agentWorkspaceDirectory));
	});

	it('accepts the exact controller-selected zone files directory', async () => {
		await expect(
			validateControllerSelectedToolVmDirectory({
				hostDirectory: zoneFilesDirectory,
				kind: 'zone-files',
				zone,
			}),
		).resolves.toBe(await realpath(zoneFilesDirectory));
	});

	it('uses the same controller-selected workspace authority for Hermes', async () => {
		const hermesZone = {
			...zone,
			gateway: {
				config: path.join(temporaryDirectory, 'hermes.yaml'),
				cpus: 2,
				imageProfile: 'hermes',
				memory: '2G',
				port: 18_793,
				profilesByAgent: { main: 'researcher' },
				profileSecretProjectionsByAgent: {
					main: { DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN' },
				},
				stateDir: stateDirectory,
				type: 'hermes' as const,
				zoneFilesDir: zoneFilesDirectory,
				zoneRuntimeDir: zoneRuntimeDirectory,
			},
		} satisfies ZoneConfig;

		await expect(
			validateControllerSelectedToolVmDirectory({
				agentId: 'main',
				hostDirectory: agentWorkspaceDirectory,
				kind: 'managed-agent-workspace',
				zone: hermesZone,
			}),
		).resolves.toBe(await realpath(agentWorkspaceDirectory));
		await expect(
			validateControllerSelectedToolVmDirectory({
				hostDirectory: zoneFilesDirectory,
				kind: 'zone-files',
				zone: hermesZone,
			}),
		).resolves.toBe(await realpath(zoneFilesDirectory));
	});

	it.each([
		['another agent', 'other-agent'],
		['an agent workspace child', 'workspace-child'],
		['gateway state', 'gateway-state'],
	] as const)('rejects %s as managed agent workspace authority', async (_label, candidateKind) => {
		const hostDirectory =
			candidateKind === 'other-agent'
				? path.join(zoneFilesDirectory, 'agents', 'other')
				: candidateKind === 'workspace-child'
					? path.join(agentWorkspaceDirectory, 'project')
					: stateDirectory;
		await mkdir(hostDirectory, { recursive: true });

		await expect(
			validateControllerSelectedToolVmDirectory({
				agentId: 'main',
				hostDirectory,
				kind: 'managed-agent-workspace',
				zone,
			}),
		).rejects.toMatchObject({
			kind: 'not-controller-selected',
		} satisfies Partial<ControllerSelectedToolVmDirectoryValidationError>);
	});

	it('rejects a symlink at the selected workspace leaf', async () => {
		const realDirectory = path.join(temporaryDirectory, 'symlink-target');
		const linkedWorkspace = path.join(zoneFilesDirectory, 'agents', 'linked');
		await mkdir(realDirectory);
		await symlink(realDirectory, linkedWorkspace);

		await expect(
			validateControllerSelectedToolVmDirectory({
				agentId: 'linked',
				hostDirectory: linkedWorkspace,
				kind: 'managed-agent-workspace',
				zone,
			}),
		).rejects.toMatchObject({
			kind: 'not-real-directory',
		} satisfies Partial<ControllerSelectedToolVmDirectoryValidationError>);
	});

	it('rejects relative and parent-traversal paths before filesystem access', async () => {
		await expect(
			validateControllerSelectedToolVmDirectory({
				agentId: 'main',
				hostDirectory: 'agents/main',
				kind: 'managed-agent-workspace',
				zone,
			}),
		).rejects.toMatchObject({ kind: 'not-absolute' });
		await expect(
			validateControllerSelectedToolVmDirectory({
				agentId: 'main',
				hostDirectory: `${zoneFilesDirectory}/agents/../agents/main`,
				kind: 'managed-agent-workspace',
				zone,
			}),
		).rejects.toMatchObject({ kind: 'parent-traversal' });
	});

	it('rejects gateway types without managed Tool VM directory semantics', async () => {
		await expect(
			validateControllerSelectedToolVmDirectory({
				agentId: 'main',
				hostDirectory: agentWorkspaceDirectory,
				kind: 'managed-agent-workspace',
				zone: {
					...zone,
					gateway: {
						config: path.join(temporaryDirectory, 'worker.json'),
						cpus: 2,
						imageProfile: 'worker',
						memory: '2G',
						port: 18_792,
						stateDir: stateDirectory,
						type: 'worker',
						zoneRuntimeDir: zoneRuntimeDirectory,
					},
				},
			}),
		).rejects.toMatchObject({ kind: 'unsupported-gateway' });
	});
});
