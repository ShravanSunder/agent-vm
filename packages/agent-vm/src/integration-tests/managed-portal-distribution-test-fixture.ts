import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { expect } from 'vitest';
import { z } from 'zod';

import type { GatewayZoneVmOperations } from '#agent-vm/gateway/gateway-zone-support';

import { readPackedLocalPackageFile } from './e2e-harness.js';

const portalNodeArtifacts = [
	{
		directory: 'tool-access',
		packageName: '@agent-collaboration/tool-access',
		specifier: '@agent-collaboration/tool-access/authorization',
		file: 'dist/authorization/index.js',
	},
	{
		directory: 'tool-engine',
		packageName: '@agent-collaboration/tool-engine',
		specifier: '@agent-collaboration/tool-engine/capability-dispatch',
		file: 'dist/capability-dispatch/index.js',
	},
	{
		directory: 'tool-host-node',
		packageName: '@agent-collaboration/tool-host-node',
		specifier: '@agent-collaboration/tool-host-node/catalog-typescript',
		file: 'dist/catalog-typescript/index.js',
	},
	{
		directory: 'gateway-runtime',
		packageName: '@agent-vm/gateway-runtime',
		specifier: '@agent-vm/gateway-runtime',
		file: 'dist/index.js',
	},
	{
		directory: 'agent-portal-sdk',
		packageName: '@agent-vm/agent-portal-sdk',
		specifier: '@agent-vm/agent-portal-sdk',
		file: 'dist/index.js',
	},
] as const;

export const portalNodeArtifactSchema = z.object({
	packageName: z.string(),
	specifier: z.string(),
	version: z.string(),
	sha256: z.string(),
});
export const installedPortalNodeArtifactSchema = portalNodeArtifactSchema.extend({
	resolvedPath: z.string(),
});
export const installedPortalNodeArtifactsSchema = z.array(installedPortalNodeArtifactSchema);

export async function expectedPortalNodeArtifacts(
	artifactDirectory: string,
): Promise<readonly z.infer<typeof portalNodeArtifactSchema>[]> {
	const archives = await Promise.all(
		(await readdir(artifactDirectory))
			.filter((name) => name.endsWith('.tgz'))
			.map(async (fileName) => ({
				fileName,
				manifest: z
					.object({ name: z.string(), version: z.string() })
					.parse(
						JSON.parse(
							(
								await readPackedLocalPackageFile(
									path.join(artifactDirectory, fileName),
									'package/package.json',
								)
							).toString('utf8'),
						),
					),
			})),
	);
	return await Promise.all(
		portalNodeArtifacts.map(async (entry) => {
			const selected = archives.find((archive) => archive.manifest.name === entry.packageName);
			if (selected === undefined)
				throw new Error(`Selected image inputs omit ${entry.packageName}`);
			return {
				packageName: selected.manifest.name,
				version: selected.manifest.version,
				specifier: entry.specifier,
				sha256: createHash('sha256')
					.update(
						await readPackedLocalPackageFile(
							path.join(artifactDirectory, selected.fileName),
							`package/${entry.file}`,
						),
					)
					.digest('hex'),
			};
		}),
	);
}

export async function expectedPortalPythonSources(
	repoRoot: string,
): Promise<{ readonly sdkSourceSha256: string; readonly udsSourceSha256: string }> {
	const sourceRoot = path.join(
		repoRoot,
		'python/agent-vm-agent-portal-sdk/src/agent_vm_agent_portal_sdk',
	);
	return {
		sdkSourceSha256: createHash('sha256')
			.update(await readFile(path.join(sourceRoot, 'standard_mcp_transport.py')))
			.digest('hex'),
		udsSourceSha256: createHash('sha256')
			.update(await readFile(path.join(sourceRoot, 'gateway_runtime_uds_transport.py')))
			.digest('hex'),
	};
}

/** Run from the installed package directory, including in the managed image. */
export function portalNodeInstallationProbe(): string {
	return [
		"import { createHash } from 'node:crypto';",
		"import { readFile, realpath } from 'node:fs/promises';",
		"import { fileURLToPath } from 'node:url';",
		`const entries = ${JSON.stringify(portalNodeArtifacts)};`,
		'const artifacts = await Promise.all(entries.map(async (entry) => {',
		'  const resolvedPath = await realpath(fileURLToPath(import.meta.resolve(entry.specifier)));',
		'  await import(entry.specifier);',
		'  const manifest = JSON.parse(await readFile("node_modules/" + entry.packageName + "/package.json", "utf8"));',
		'  return { packageName: manifest.name, version: manifest.version, specifier: entry.specifier, resolvedPath, sha256: createHash("sha256").update(await readFile(resolvedPath)).digest("hex") };',
		'}));',
		'console.log(JSON.stringify(artifacts));',
	].join('\n');
}

export const installedPortalPythonSchema = z.object({
	versions: z.record(z.string(), z.string()),
	requiresDist: z.array(z.string()),
	sdkSourceSha256: z.string(),
	udsSourceSha256: z.string(),
	sdkModulePath: z.string(),
	interpreter: z.string(),
});

/** Metadata and bytes belong to the assembled image's installed wheel, not the mounted source. */
export function portalPythonInstallationProbe(): string {
	return [
		'import hashlib, importlib.metadata as metadata, json, pathlib, sys',
		'import agent_vm_agent_portal_sdk.standard_mcp_transport as standard',
		'import agent_vm_agent_portal_sdk.gateway_runtime_uds_transport as uds',
		'import agent_vm_hermes_adapter',
		'print(json.dumps({',
		'    "versions": {name: metadata.version(name) for name in ["agent-vm-agent-portal-sdk", "agent-vm-hermes-adapter", "hermes-agent", "mcp", "httpx2"]},',
		'    "requiresDist": metadata.requires("agent-vm-agent-portal-sdk"),',
		'    "sdkSourceSha256": hashlib.sha256(pathlib.Path(standard.__file__).read_bytes()).hexdigest(),',
		'    "udsSourceSha256": hashlib.sha256(pathlib.Path(uds.__file__).read_bytes()).hexdigest(),',
		'    "sdkModulePath": standard.__file__, "interpreter": sys.executable,',
		'}, sort_keys=True))',
	].join('\n');
}

export async function assertManagedPortalImageInstallation(props: {
	readonly vm: Pick<GatewayZoneVmOperations, 'exec'>;
	readonly repoRoot: string;
	readonly artifactDirectory: string;
}): Promise<void> {
	const nodeResult = await props.vm.exec(
		['node', '--input-type=module', '--eval', portalNodeInstallationProbe()],
		{ cwd: '/opt/agent-vm/local-packages' },
	);
	expect(nodeResult.exitCode, nodeResult.stderr.toString()).toBe(0);
	const nodeArtifacts = installedPortalNodeArtifactsSchema.parse(
		JSON.parse(nodeResult.stdout.toString()),
	);
	expect(nodeArtifacts.map(({ resolvedPath: _resolvedPath, ...artifact }) => artifact)).toEqual(
		await expectedPortalNodeArtifacts(props.artifactDirectory),
	);
	expect(
		nodeArtifacts.every((artifact) =>
			artifact.resolvedPath.startsWith('/opt/agent-vm/local-packages/'),
		),
	).toBe(true);
	const pythonResult = await props.vm.exec([
		'/opt/hermes/.venv/bin/python',
		'-I',
		'-c',
		portalPythonInstallationProbe(),
	]);
	expect(pythonResult.exitCode, pythonResult.stderr.toString()).toBe(0);
	const pythonArtifacts = installedPortalPythonSchema.parse(
		JSON.parse(pythonResult.stdout.toString()),
	);
	const sdkVersion = nodeArtifacts.find(
		(entry) => entry.packageName === '@agent-vm/agent-portal-sdk',
	)?.version;
	if (sdkVersion === undefined) throw new Error('Selected package closure omitted the SDK');
	expect(pythonArtifacts.versions).toMatchObject({
		'agent-vm-agent-portal-sdk': sdkVersion,
		'agent-vm-hermes-adapter': sdkVersion,
		'hermes-agent': '0.21.5',
		mcp: '2.0.0',
	});
	expect(pythonArtifacts.versions.httpx2?.split('.')[0]).toBe('2');
	expect(pythonArtifacts.requiresDist).toContain('mcp==2.0.0');
	expect(pythonArtifacts).toMatchObject(await expectedPortalPythonSources(props.repoRoot));
	expect(pythonArtifacts.sdkModulePath).toContain('/opt/hermes/.venv/');
	expect(pythonArtifacts.interpreter).toBe('/opt/hermes/.venv/bin/python');
	process.stdout.write(
		`portal-composition-installed-image-inputs ${JSON.stringify({ nodeArtifacts, pythonArtifacts })}\n`,
	);
}
