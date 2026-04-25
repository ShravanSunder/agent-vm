import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function openClawPluginVendorDirectory(profileName: string): string {
	return `vm-images/gateways/${profileName}/vendor/gondolin`;
}

async function resolveBundledOpenClawPluginDistDirectory(): Promise<string> {
	const pluginEntrypointPath = fileURLToPath(
		import.meta.resolve('@agent-vm/openclaw-agent-vm-plugin'),
	);
	const pluginDistDirectory = path.dirname(pluginEntrypointPath);
	try {
		await fs.access(path.join(pluginDistDirectory, 'openclaw.plugin.json'));
	} catch (error) {
		throw new Error(
			`Bundled gondolin plugin dist is missing at '${pluginDistDirectory}'. Run \`pnpm build\` before using the OpenClaw gateway scaffold/build path.`,
			{ cause: error },
		);
	}
	return pluginDistDirectory;
}

export async function syncBundledOpenClawPluginBundle(
	targetDir: string,
	profileName: string,
	dependencies: {
		readonly access?: typeof fs.access;
		readonly copyDirectory?: typeof fs.cp;
		readonly createDirectory?: typeof fs.mkdir;
		readonly removeDirectory?: typeof fs.rm;
		readonly resolveBundledDistDirectory?: () => Promise<string>;
	} = {},
): Promise<'created' | 'skipped'> {
	const access = dependencies.access ?? fs.access;
	const copyDirectory = dependencies.copyDirectory ?? fs.cp;
	const createDirectory = dependencies.createDirectory ?? fs.mkdir;
	const removeDirectory = dependencies.removeDirectory ?? fs.rm;
	const resolveBundledDistDirectory =
		dependencies.resolveBundledDistDirectory ?? resolveBundledOpenClawPluginDistDirectory;
	const pluginTargetDirectory = path.join(targetDir, openClawPluginVendorDirectory(profileName));
	try {
		await access(path.join(pluginTargetDirectory, 'openclaw.plugin.json'));
	} catch {
		// Target does not exist yet — nothing to clean.
	}
	await removeDirectory(pluginTargetDirectory, { force: true, recursive: true });

	const pluginDistDirectory = await resolveBundledDistDirectory();
	await createDirectory(path.dirname(pluginTargetDirectory), { recursive: true });
	await copyDirectory(pluginDistDirectory, pluginTargetDirectory, { recursive: true });
	return 'created';
}
