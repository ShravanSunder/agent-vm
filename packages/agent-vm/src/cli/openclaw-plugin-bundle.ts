import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const openClawPluginVendorDirectory = 'images/gateway/vendor/gondolin';

async function resolveBundledOpenClawPluginDistDirectory(): Promise<string> {
	const pluginEntrypointPath = fileURLToPath(
		import.meta.resolve('@shravansunder/openclaw-agent-vm-plugin'),
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
): Promise<'created' | 'skipped'> {
	const pluginTargetDirectory = path.join(targetDir, openClawPluginVendorDirectory);
	try {
		await fs.access(path.join(pluginTargetDirectory, 'openclaw.plugin.json'));
		await fs.rm(pluginTargetDirectory, { force: true, recursive: true });
	} catch {
		// continue
	}

	const pluginDistDirectory = await resolveBundledOpenClawPluginDistDirectory();
	await fs.mkdir(path.dirname(pluginTargetDirectory), { recursive: true });
	await fs.cp(pluginDistDirectory, pluginTargetDirectory, { recursive: true });
	return 'created';
}
