import { writeImageArtifactFixture } from '../../../../scripts/test-fixtures/image-artifact-fixture.js';
import { buildImage } from '../build-pipeline.js';

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
			await writeImageArtifactFixture(outputDirectory, `${publisherId}\n`);
			if (publisherId === 'failing') throw new Error('publisher failed before publication');
		},
		gondolinVersion: 'cross-process-publication-proof',
	},
);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.disconnect?.();
