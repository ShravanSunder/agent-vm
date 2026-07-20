import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const sdkDistributionName = 'agent-vm-agent-portal-sdk';
const sdkImportPackageName = 'agent_vm_agent_portal_sdk';
const expectedRequiresDist = [
	'httpx<1,>=0.27.1',
	'mcp<2,>=1.28.1',
	'pydantic-core<3,>=2.41.5',
	'pydantic<3,>=2.12.0',
] as const;
const requiredWheelMembers = [
	`${sdkImportPackageName}/__init__.py`,
	`${sdkImportPackageName}/contracts.py`,
	`${sdkImportPackageName}/gateway_runtime_client.py`,
	`${sdkImportPackageName}/gateway_runtime_sandbox_operations.py`,
	`${sdkImportPackageName}/gateway_runtime_uds_transport.py`,
	`${sdkImportPackageName}/py.typed`,
	`${sdkImportPackageName}/standard_mcp_transport.py`,
	`${sdkImportPackageName}/tool_portal_mcp_client.py`,
] as const;
const publicImportModuleNames = [
	sdkImportPackageName,
	`${sdkImportPackageName}.gateway_runtime_client`,
	`${sdkImportPackageName}.tool_portal_mcp_client`,
	`${sdkImportPackageName}.standard_mcp_transport`,
] as const;

interface PythonSdkWheelFixture {
	readonly importedModuleFiles: Readonly<Record<string, string>>;
	readonly installedVersion: string;
	readonly metadataName: string;
	readonly metadataRequiresDist: readonly string[];
	readonly metadataRequiresPython: string;
	readonly metadataVersion: string;
	readonly wheelMembers: readonly string[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, fieldName: string): string {
	if (typeof value !== 'string') {
		throw new Error(`Expected ${fieldName} to be a string.`);
	}
	return value;
}

function requireStringArray(value: unknown, fieldName: string): readonly string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
		throw new Error(`Expected ${fieldName} to be an array of strings.`);
	}
	return value;
}

function requireStringRecord(value: unknown, fieldName: string): Readonly<Record<string, string>> {
	if (!isObjectRecord(value) || !Object.values(value).every((entry) => typeof entry === 'string')) {
		throw new Error(`Expected ${fieldName} to be a string-valued object.`);
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, requireString(entry, `${fieldName}.${key}`)]),
	);
}

function isolatedPythonEnvironment(rootDirectory: string): NodeJS.ProcessEnv {
	return {
		HOME: rootDirectory,
		LANG: 'C.UTF-8',
		PATH: process.env['PATH'],
	};
}

async function buildAndInstallPythonSdkWheel(
	rootDirectory: string,
): Promise<PythonSdkWheelFixture> {
	const distributionDirectory = path.join(rootDirectory, 'dist');
	const virtualEnvironmentDirectory = path.join(rootDirectory, 'venv');
	const virtualEnvironmentPythonPath = path.join(virtualEnvironmentDirectory, 'bin', 'python');

	await execa(
		'uv',
		[
			'build',
			'--offline',
			'--no-python-downloads',
			'--wheel',
			'--clear',
			'--package',
			sdkDistributionName,
			'--out-dir',
			distributionDirectory,
		],
		{ cwd: repositoryRoot, timeout: 120_000 },
	);

	const wheelNames = (await readdir(distributionDirectory)).filter((fileName) =>
		fileName.endsWith('.whl'),
	);
	if (wheelNames.length !== 1) {
		throw new Error(`Expected one Python SDK wheel; found ${String(wheelNames.length)}.`);
	}
	const wheelPath = path.join(distributionDirectory, wheelNames[0] ?? '');

	await execa(
		'uv',
		['venv', '--offline', '--no-python-downloads', '--python', '3.13', virtualEnvironmentDirectory],
		{ cwd: rootDirectory, timeout: 60_000 },
	);
	await execa(
		'uv',
		[
			'pip',
			'install',
			'--offline',
			'--no-python-downloads',
			'--no-sources',
			'--strict',
			'--link-mode',
			'copy',
			'--python',
			virtualEnvironmentPythonPath,
			wheelPath,
		],
		{ cwd: rootDirectory, timeout: 120_000 },
	);

	const inspectionScript = `
import importlib
import importlib.metadata
import json
import pathlib
import sysconfig
import zipfile

wheel_path = pathlib.Path(${JSON.stringify(wheelPath)}).resolve()
repository_root = pathlib.Path(${JSON.stringify(repositoryRoot)}).resolve()
site_packages = pathlib.Path(sysconfig.get_paths()["purelib"]).resolve()
module_names = ${JSON.stringify(publicImportModuleNames)}

with zipfile.ZipFile(wheel_path) as wheel:
    wheel_members = sorted(wheel.namelist())
    metadata_members = [name for name in wheel_members if name.endswith(".dist-info/METADATA")]
    if len(metadata_members) != 1:
        raise RuntimeError(f"Expected one wheel METADATA member; found {len(metadata_members)}.")
    metadata_text = wheel.read(metadata_members[0]).decode("utf-8")

from email.parser import Parser

wheel_metadata = Parser().parsestr(metadata_text)
imported_module_files = {}
for module_name in module_names:
    module = importlib.import_module(module_name)
    module_file = pathlib.Path(module.__file__).resolve()
    if not module_file.is_relative_to(site_packages):
        raise RuntimeError(f"{module_name} imported outside the clean environment: {module_file}")
    if module_file.is_relative_to(repository_root):
        raise RuntimeError(f"{module_name} imported from the workspace source tree: {module_file}")
    imported_module_files[module_name] = str(module_file)

installed_distribution = importlib.metadata.distribution(${JSON.stringify(sdkDistributionName)})
print(json.dumps({
    "importedModuleFiles": imported_module_files,
    "installedVersion": installed_distribution.version,
    "metadataName": wheel_metadata["Name"],
    "metadataRequiresDist": sorted(wheel_metadata.get_all("Requires-Dist", [])),
    "metadataRequiresPython": wheel_metadata["Requires-Python"],
    "metadataVersion": wheel_metadata["Version"],
    "wheelMembers": wheel_members,
}))
`;
	const inspection = await execa(virtualEnvironmentPythonPath, ['-I', '-c', inspectionScript], {
		cwd: rootDirectory,
		env: isolatedPythonEnvironment(rootDirectory),
		extendEnv: false,
		timeout: 60_000,
	});
	const parsedInspection = JSON.parse(inspection.stdout) as unknown;
	if (!isObjectRecord(parsedInspection)) {
		throw new Error('Python SDK wheel inspection must produce a JSON object.');
	}

	return {
		importedModuleFiles: requireStringRecord(
			parsedInspection['importedModuleFiles'],
			'importedModuleFiles',
		),
		installedVersion: requireString(parsedInspection['installedVersion'], 'installedVersion'),
		metadataName: requireString(parsedInspection['metadataName'], 'metadataName'),
		metadataRequiresDist: requireStringArray(
			parsedInspection['metadataRequiresDist'],
			'metadataRequiresDist',
		),
		metadataRequiresPython: requireString(
			parsedInspection['metadataRequiresPython'],
			'metadataRequiresPython',
		),
		metadataVersion: requireString(parsedInspection['metadataVersion'], 'metadataVersion'),
		wheelMembers: requireStringArray(parsedInspection['wheelMembers'], 'wheelMembers'),
	};
}

describe('packed Python Agent Portal SDK wheel', () => {
	let fixture: PythonSdkWheelFixture;
	let rootDirectory: string | undefined;

	beforeAll(async () => {
		rootDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-python-sdk-wheel-'));
		fixture = await buildAndInstallPythonSdkWheel(rootDirectory);
	}, 300_000);

	afterAll(async () => {
		if (rootDirectory !== undefined) {
			await rm(rootDirectory, { force: true, recursive: true });
		}
	});

	it('contains the complete public client modules and bounded dependency metadata', () => {
		for (const requiredWheelMember of requiredWheelMembers) {
			expect(fixture.wheelMembers).toContain(requiredWheelMember);
		}
		expect(fixture.metadataName).toBe(sdkDistributionName);
		expect(fixture.metadataRequiresPython).toBe('>=3.13');
		expect(fixture.metadataRequiresDist).toEqual(expectedRequiresDist);
		expect(fixture.metadataVersion).toBe(fixture.installedVersion);
	});

	it('imports every public client module only from the clean wheel installation', () => {
		expect(Object.keys(fixture.importedModuleFiles).toSorted()).toEqual(
			publicImportModuleNames.toSorted(),
		);
		for (const importedModuleFile of Object.values(fixture.importedModuleFiles)) {
			expect(importedModuleFile).toContain(`${path.sep}venv${path.sep}`);
			expect(importedModuleFile).not.toContain(repositoryRoot);
		}
	});
});
