import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	deps: {
		neverBundle: ['/opt/openclaw-sdk/sandbox.js'],
	},
	dts: true,
	entry: 'src/index.ts',
	format: 'esm',
	outExtensions: () => ({
		dts: '.d.ts',
		js: '.js',
	}),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
