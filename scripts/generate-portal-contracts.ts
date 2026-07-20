import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
	createPortableContractSchemaManifest,
	PORTABLE_REFINEMENT_DESCRIPTORS,
} from '../packages/agent-portal-sdk/src/portable-contracts/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const pythonTemplatePath = path.join(
	repositoryRoot,
	'scripts/templates/portal-contracts/contracts.py.template',
);
const generatedManifestRelativePath =
	'packages/agent-portal-sdk/portable-contract-schema-manifest.json';
const generatedPythonContractsRelativePath =
	'python/agent-vm-agent-portal-sdk/src/agent_vm_agent_portal_sdk/contracts.py';

interface GeneratedPortalContractArtifacts {
	readonly manifestJson: string;
	readonly pythonContracts: string;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaIdsFromManifest(manifest: Readonly<Record<string, unknown>>): readonly string[] {
	const schemas = manifest['schemas'];
	if (!isUnknownRecord(schemas)) {
		throw new Error('Portable contract manifest must contain a schemas object.');
	}
	return Object.keys(schemas).toSorted((leftSchemaId, rightSchemaId) =>
		leftSchemaId.localeCompare(rightSchemaId),
	);
}

function renderPythonTupleItems(values: readonly string[]): string {
	return values.map((value) => `    ${JSON.stringify(value)},`).join('\n');
}

async function generatePortalContractArtifacts(): Promise<GeneratedPortalContractArtifacts> {
	const manifest = createPortableContractSchemaManifest();
	const schemaIds = schemaIdsFromManifest(manifest);
	const refinementIdentities = PORTABLE_REFINEMENT_DESCRIPTORS.map(
		(descriptor) => descriptor.identity,
	).toSorted((leftIdentity, rightIdentity) => leftIdentity.localeCompare(rightIdentity));
	const pythonTemplate = await readFile(pythonTemplatePath, 'utf8');
	const pythonContracts = pythonTemplate
		.replace(
			'__GENERATED_PORTABLE_REFINEMENT_IDENTITIES__',
			renderPythonTupleItems(refinementIdentities),
		)
		.replace('__GENERATED_PORTABLE_SCHEMA_IDS__', renderPythonTupleItems(schemaIds))
		.replace(
			'__GENERATED_PORTABLE_REFINEMENT_DESCRIPTORS_JSON__',
			JSON.stringify(PORTABLE_REFINEMENT_DESCRIPTORS),
		)
		.replace('__GENERATED_PORTABLE_SCHEMA_MANIFEST_JSON__', JSON.stringify(manifest));
	if (pythonContracts.includes('__GENERATED_PORTABLE_')) {
		throw new Error('Python portable contract template contains an unresolved placeholder.');
	}
	return {
		manifestJson: `${JSON.stringify(manifest, null, '\t')}\n`,
		pythonContracts,
	};
}

async function writeGeneratedArtifacts(props: {
	readonly artifacts: GeneratedPortalContractArtifacts;
	readonly outputRoot: string;
}): Promise<void> {
	await Promise.all(
		(
			[
				[generatedManifestRelativePath, props.artifacts.manifestJson],
				[generatedPythonContractsRelativePath, props.artifacts.pythonContracts],
			] as const
		).map(async ([relativePath, content]) => {
			const outputPath = path.join(props.outputRoot, relativePath);
			await mkdir(path.dirname(outputPath), { recursive: true });
			await writeFile(outputPath, content, 'utf8');
		}),
	);
	await execFileAsync(path.join(repositoryRoot, 'node_modules/.bin/oxfmt'), [
		path.join(props.outputRoot, generatedManifestRelativePath),
	]);
	await execFileAsync('uv', [
		'run',
		'ruff',
		'format',
		path.join(props.outputRoot, generatedPythonContractsRelativePath),
	]);
}

async function assertGeneratedArtifactsAreClean(
	artifacts: GeneratedPortalContractArtifacts,
): Promise<void> {
	const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-portal-contracts-'));
	try {
		await writeGeneratedArtifacts({ artifacts, outputRoot: temporaryRoot });
		const comparisons = await Promise.all(
			([generatedManifestRelativePath, generatedPythonContractsRelativePath] as const).map(
				async (relativePath) => {
					const [expectedContent, generatedContent] = await Promise.all([
						readFile(path.join(repositoryRoot, relativePath), 'utf8'),
						readFile(path.join(temporaryRoot, relativePath), 'utf8'),
					]);
					return { expectedContent, generatedContent, relativePath };
				},
			),
		);
		for (const comparison of comparisons) {
			if (comparison.expectedContent !== comparison.generatedContent) {
				throw new Error(
					`Generated portal contract artifact is stale: ${comparison.relativePath}. Run pnpm generate:portal-contracts.`,
				);
			}
		}
	} finally {
		await rm(temporaryRoot, { force: true, recursive: true });
	}
}

async function main(): Promise<void> {
	const artifacts = await generatePortalContractArtifacts();
	if (process.argv.includes('--check-clean')) {
		await assertGeneratedArtifactsAreClean(artifacts);
		return;
	}
	await writeGeneratedArtifacts({ artifacts, outputRoot: repositoryRoot });
}

await main();
