import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';

function fingerprint(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

const packageRoot = path.resolve(import.meta.dirname, '..');
const assetsDirectory = path.join(packageRoot, 'dist', 'assets');
await mkdir(assetsDirectory, { recursive: true });

const browserBuild = await build({
	bundle: true,
	entryPoints: [path.join(packageRoot, 'src', 'browser', 'entry.tsx')],
	format: 'esm',
	jsx: 'automatic',
	jsxImportSource: 'hono/jsx/dom',
	minify: true,
	platform: 'browser',
	sourcemap: false,
	write: false,
});
const browserOutput = browserBuild.outputFiles[0];
if (browserOutput === undefined) throw new Error('OAuth browser asset build produced no output.');
const javascriptAssetName = `oauth.${fingerprint(browserOutput.contents)}.js`;
await writeFile(path.join(assetsDirectory, javascriptAssetName), browserOutput.contents);

const unhashedStylesheetPath = path.join(assetsDirectory, 'oauth.css');
const stylesheetBytes = await readFile(unhashedStylesheetPath);
const stylesheetAssetName = `oauth.${fingerprint(stylesheetBytes)}.css`;
await rename(unhashedStylesheetPath, path.join(assetsDirectory, stylesheetAssetName));

await writeFile(
	path.join(assetsDirectory, 'manifest.json'),
	`${JSON.stringify({ css: stylesheetAssetName, javascript: javascriptAssetName }, undefined, 2)}\n`,
	{ encoding: 'utf8', mode: 0o644 },
);
