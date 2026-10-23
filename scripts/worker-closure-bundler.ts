import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function isManifest(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readManifest(location: string): Promise<Readonly<Record<string, unknown>>> {
	const value: unknown = JSON.parse(await readFile(location, 'utf8'));
	if (!isManifest(value)) throw new Error(`Invalid bundler manifest: ${location}`);
	return value;
}

export interface WorkerClosureBundler {
	readonly esbuildUrl: string;
	readonly esbuildVersion: string;
	readonly esbuildPackagePath: string;
	readonly wranglerVersion: string;
	readonly wranglerPackagePath: string;
}

/** Resolve through the installed host dependency so the guard uses Wrangler's own bundler. */
export async function resolveWorkerClosureBundler(
	repositoryRoot: string,
): Promise<WorkerClosureBundler> {
	const hostRequire = createRequire(
		path.join(repositoryRoot, 'packages/tool-host-cloudflare/package.json'),
	);
	const wranglerPackagePath = await realpath(hostRequire.resolve('wrangler/package.json'));
	const wrangler = await readManifest(wranglerPackagePath);
	if (
		wrangler.name !== 'wrangler' ||
		wrangler.version !== '4.124.0' ||
		!isManifest(wrangler.dependencies) ||
		wrangler.dependencies.esbuild !== '0.28.1'
	)
		throw new Error('Worker closure Wrangler dependency drift');
	const wranglerRequire = createRequire(wranglerPackagePath);
	const esbuildPackagePath = await realpath(wranglerRequire.resolve('esbuild/package.json'));
	const esbuild = await readManifest(esbuildPackagePath);
	if (esbuild.name !== 'esbuild' || esbuild.version !== '0.28.1')
		throw new Error('Worker closure esbuild dependency drift');
	return {
		esbuildUrl: pathToFileURL(await realpath(wranglerRequire.resolve('esbuild'))).href,
		esbuildVersion: esbuild.version,
		esbuildPackagePath,
		wranglerVersion: wrangler.version,
		wranglerPackagePath,
	};
}
