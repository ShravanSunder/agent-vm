import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
	findPackageJsonPathFromStart,
	formatRuntimeBuildVersionTag,
	readRuntimePackageVersions,
	resolveRuntimeBuildVersionTag,
} from './runtime-versions.js';

describe('runtime build versions', () => {
	it('formats a stable runtime build version tag', () => {
		expect(
			formatRuntimeBuildVersionTag({
				agentVm: '0.0.19',
				gondolinAdapter: '0.0.19',
				gondolinPackage: '@earendil-works/gondolin@0.8.0',
			}),
		).toBe(
			'agent-vm@0.0.19+gondolin-adapter@0.0.19+gondolin@@earendil-works/gondolin@0.8.0',
		);
	});

	it('finds the nearest package.json walking up from a resolved module path', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-runtime-'));
		const packageRootPath = path.join(temporaryDirectoryPath, 'node_modules', 'pkg');
		const modulePath = path.join(packageRootPath, 'dist', 'index.js');
		await fs.mkdir(path.dirname(modulePath), { recursive: true });
		await fs.writeFile(modulePath, 'export {};', 'utf8');
		await fs.writeFile(
			path.join(packageRootPath, 'package.json'),
			JSON.stringify({ name: 'pkg', version: '1.2.3' }),
			'utf8',
		);

		await expect(findPackageJsonPathFromStart(modulePath)).resolves.toBe(
			path.join(packageRootPath, 'package.json'),
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('surfaces package lookup access failures that are not missing files', async () => {
		const accessSpy = vi.spyOn(fs, 'access').mockRejectedValue(
			Object.assign(new Error('permission denied'), { code: 'EACCES' }),
		);

		await expect(findPackageJsonPathFromStart('/tmp/pkg/dist/index.js')).rejects.toThrow(
			'permission denied',
		);

		accessSpy.mockRestore();
	});

	it('reads runtime package versions from package json files', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-runtime-'));
		const agentVmPackagePath = path.join(temporaryDirectoryPath, 'agent-vm', 'package.json');
		const gondolinAdapterPackagePath = path.join(
			temporaryDirectoryPath,
			'gondolin-adapter',
			'package.json',
		);
		await fs.mkdir(path.dirname(agentVmPackagePath), { recursive: true });
		await fs.mkdir(path.dirname(gondolinAdapterPackagePath), { recursive: true });
		await fs.writeFile(
			agentVmPackagePath,
			JSON.stringify({ name: '@agent-vm/agent-vm', version: '0.0.19' }),
			'utf8',
		);
		await fs.writeFile(
			gondolinAdapterPackagePath,
			JSON.stringify({
				name: '@agent-vm/gondolin-adapter',
				version: '0.0.19',
				dependencies: {
					'@earendil-works/gondolin': 'npm:@example/gondolin@0.8.0',
				},
			}),
			'utf8',
		);

		await expect(
			readRuntimePackageVersions({
				agentVmPackageJsonPath: agentVmPackagePath,
				gondolinAdapterPackageJsonPath: gondolinAdapterPackagePath,
			}),
		).resolves.toEqual({
			agentVm: '0.0.19',
			gondolinAdapter: '0.0.19',
			gondolinPackage: '@earendil-works/gondolin@0.8.0',
		});

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('resolves the runtime build version tag from the actual dependency tree', async () => {
		const tag = await resolveRuntimeBuildVersionTag();

		expect(tag).toMatch(
			/^agent-vm@\d+\.\d+\.\d+\+gondolin-adapter@\d+\.\d+\.\d+\+gondolin@/u,
		);
	});
});
