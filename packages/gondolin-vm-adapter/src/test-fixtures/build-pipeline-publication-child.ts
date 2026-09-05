import fs from 'node:fs/promises';
import path from 'node:path';

import { buildImage, buildImageAssetFileNames } from '../build-pipeline.js';

const [cacheDir, publisherId] = process.argv.slice(2);
if (cacheDir === undefined || publisherId === undefined) {
	throw new Error('Expected cache directory and publisher id.');
}

const result = await buildImage(
	{
		buildConfig: { arch: 'aarch64', distro: 'alpine' },
		cacheDir,
	},
	{
		buildAssets: async (_buildConfig, outputDirectory) => {
			process.send?.({ publisherId, type: 'ready' });
			await new Promise<void>((resolve) => {
				process.once('message', (message: unknown) => {
					if (
						typeof message !== 'object' ||
						message === null ||
						!('type' in message) ||
						message.type !== 'release'
					) {
						throw new Error('Expected publication release message.');
					}
					resolve();
				});
			});
			await Promise.all(
				buildImageAssetFileNames.map(async (fileName) => {
					await fs.writeFile(path.join(outputDirectory, fileName), `${publisherId}\n`, 'utf8');
				}),
			);
		},
		gondolinVersion: 'cross-process-publication-proof',
	},
);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.disconnect?.();
