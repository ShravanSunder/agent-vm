import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isForbiddenToolHostNodeImport } from './tool-host-node-architecture.ts';
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export async function inventoryInstalledPackages(
	consumer: string,
	evidence: string,
): Promise<void> {
	const canonicalConsumer = await realpath(consumer);
	const records = new Map<
		string,
		{ readonly name: string; readonly version: string; readonly resolution: string }
	>();
	const visitedModules = new Set<string>();
	async function inspectPackage(location: string): Promise<void> {
		const resolved = await realpath(location);
		if (!resolved.startsWith(canonicalConsumer + path.sep))
			throw new Error('tool-host-node inventory workspace fallback ' + resolved);
		if (records.has(resolved)) return;
		let manifest: unknown;
		try {
			manifest = JSON.parse(await readFile(path.join(resolved, 'package.json'), 'utf8'));
		} catch (error) {
			if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
				return;
			throw error;
		}
		if (
			!isRecord(manifest) ||
			typeof manifest.name !== 'string' ||
			typeof manifest.version !== 'string'
		)
			throw new Error('Installed package lacks name/version: ' + resolved);
		records.set(resolved, { name: manifest.name, version: manifest.version, resolution: resolved });
		await inspectModules(path.join(resolved, 'node_modules'));
	}
	async function inspectModules(directory: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
				return;
			throw error;
		}
		const resolved = await realpath(directory);
		if (visitedModules.has(resolved)) return;
		visitedModules.add(resolved);
		await Promise.all(
			entries.map(async (entry): Promise<void> => {
				if (entry.name === '.pnpm') {
					const storeEntries = await readdir(path.join(directory, entry.name), {
						withFileTypes: true,
					});
					await Promise.all(
						storeEntries
							.filter((storeEntry) => storeEntry.isDirectory())
							.map(async (storeEntry) =>
								inspectModules(path.join(directory, entry.name, storeEntry.name, 'node_modules')),
							),
					);
					return;
				}
				if (entry.name.startsWith('.')) return;
				if (entry.name.startsWith('@')) {
					const scopeEntries = await readdir(path.join(directory, entry.name), {
						withFileTypes: true,
					});
					await Promise.all(
						scopeEntries.map(async (scopeEntry) =>
							inspectPackage(path.join(directory, entry.name, scopeEntry.name)),
						),
					);
					return;
				}
				if (entry.isDirectory() || entry.isSymbolicLink())
					await inspectPackage(path.join(directory, entry.name));
			}),
		);
	}
	await inspectModules(path.join(canonicalConsumer, 'node_modules'));
	const inventory = [...records.values()].toSorted((left, right) =>
		left.resolution.localeCompare(right.resolution),
	);
	await writeFile(
		path.join(evidence, 'installed-packages.json'),
		JSON.stringify(inventory, null, 2) + '\n',
	);
	if (inventory.length === 0) throw new Error('Empty installed package inventory');
	const forbidden = inventory.filter((record) => isForbiddenToolHostNodeImport(record.name));
	if (forbidden.length > 0)
		throw new Error(
			'tool-host-node forbidden installed package ' +
				forbidden.map((record) => record.name).join(','),
		);
	process.stdout.write(
		'installed inventory: ' +
			inventory.length +
			' packages by name/version/resolution; exact @agent-vm allowlist oauth-broker-contracts,agent-portal-sdk; no workspace fallback\n',
	);
}
