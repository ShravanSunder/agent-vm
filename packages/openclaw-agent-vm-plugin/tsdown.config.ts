import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: 'src/index.ts',
	external: ['/opt/openclaw-sdk/sandbox.js'],
	format: 'esm',
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
