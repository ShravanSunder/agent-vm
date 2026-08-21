import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: {
		'cli-allowances/index': 'src/cli-allowances/index.ts',
		index: 'src/index.ts',
		'standalone-entrypoint/index': 'src/standalone-entrypoint/index.ts',
		'testing/index': 'src/testing/index.ts',
	},
	format: 'esm',
	hash: false,
	outExtensions: () => ({
		dts: '.d.ts',
		js: '.js',
	}),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
